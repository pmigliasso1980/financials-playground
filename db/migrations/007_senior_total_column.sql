-- El sénior pasa a preferir la columna publicada sobre la suma.
--
-- POR QUÉ ESTA MIGRACIÓN EXISTE
--
-- `db:identities` cambió su definición de sénior: si el Annex publica el total
-- en una columna propia usa esa, y solo si no está suma trust + pari passu.
-- Esta vista tenía la definición vieja escrita a mano.
--
-- Dos definiciones del mismo concepto en dos archivos divergen en silencio: las
-- identidades cerrarían al 97% mientras `db:outcomes` compararía el NOI contra
-- otro denominador, y nada avisaría. El hallazgo del proyecto —proyectado contra
-- entregado por añada— se calcula con esta vista, así que la divergencia no
-- sería cosmética.
--
-- DE DÓNDE SALIÓ LA COLUMNA NUEVA
--
-- No de leer encabezados. El reconciliador buscó, para cada préstamo cuyo debt
-- yield no cierra, qué celda sin mapear de esa misma fila vale el saldo
-- implícito por la identidad. "Total Cut-off Date Pari Passu Debt" coincidió en
-- 33 préstamos de 4 emisiones dentro del 1% —1.001,0M contra 1.001,3M—, y se
-- identificó por su valor.
--
-- Es preferible a la suma cuando está: no depende de que las dos partes se hayan
-- mapeado bien, ni de que el emisor las publique por separado.
--
-- NO se usa `balance_total_debt`: eso incluye subordinada y mezzanine, y en un
-- préstamo con B-note daría un denominador inflado. Coinciden solo cuando no hay
-- deuda junior.
--
-- La vista se recrea entera —DROP + CREATE— porque CREATE OR REPLACE VIEW no
-- puede cambiar la definición de una columna existente.

DROP VIEW IF EXISTS corpus.underwriting_outcomes;

CREATE VIEW corpus.underwriting_outcomes AS
SELECT
  l.id                       AS loan_id,
  l.accession,
  f.company_name,
  f.filed_at                 AS originated_at,
  l.loan_ref,
  l.property_type,
  l.state,
  uw.value::numeric          AS noi_underwritten,
  mr.value::numeric          AS noi_trailing,
  p.annualized_noi           AS noi_actual,
  -- La porción de este trust.
  amt.value::numeric         AS loan_amount,
  -- Lo que debe el prestatario sobre el inmueble en el tramo senior. Es el
  -- denominador que usa el emisor para debt yield, LTV y DSCR, y por lo tanto
  -- el que corresponde para comparar contra cualquier NOI de la propiedad.
  --
  -- La columna publicada gana sobre la suma; ver el encabezado de esta
  -- migración. Tiene que coincidir con `SENIOR` en db/identities.ts.
  coalesce(
    sen.value::numeric,
    amt.value::numeric + coalesce(npp.value::numeric, 0)
  )                          AS loan_amount_senior,
  wl.value::numeric          AS loan_amount_whole,
  p.noi_start,
  p.noi_end,
  p.is_full_year,
  -- Negativo significa que el período reportado empieza ANTES del cierre: solapa
  -- con el histórico que el suscriptor ya tenía a la vista, así que la brecha
  -- contra él no mide un resultado.
  (p.noi_start - f.filed_at) AS days_after_origination,
  uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap_vs_trailing,
  uw.value::numeric / NULLIF(p.annualized_noi, 0)  - 1 AS gap_vs_actual,
  p.annualized_noi / NULLIF(mr.value::numeric, 0)  - 1 AS growth_delivered
FROM corpus.performance p
JOIN corpus.loans   l ON l.id = p.loan_id
JOIN corpus.filings f ON f.accession = l.accession
LEFT JOIN corpus.facts uw  ON uw.loan_id  = l.id AND uw.metric_key  = 'noi_underwritten'
                           AND uw.value  ~ '^-?[0-9.]+$'
LEFT JOIN corpus.facts mr  ON mr.loan_id  = l.id AND mr.metric_key  = 'noi_most_recent'
                           AND mr.value  ~ '^-?[0-9.]+$'
LEFT JOIN corpus.facts amt ON amt.loan_id = l.id AND amt.metric_key = 'loan_amount'
                           AND amt.value ~ '^-?[0-9.]+$'
LEFT JOIN corpus.facts npp ON npp.loan_id = l.id
                           AND npp.metric_key = 'balance_pari_passu_non_trust'
                           AND npp.value ~ '^-?[0-9.]+$'
LEFT JOIN corpus.facts sen ON sen.loan_id = l.id
                           AND sen.metric_key = 'balance_senior_total'
                           AND sen.value ~ '^-?[0-9.]+$'
LEFT JOIN corpus.facts wl  ON wl.loan_id  = l.id AND wl.metric_key  = 'balance_whole_loan'
                           AND wl.value  ~ '^-?[0-9.]+$';

COMMENT ON VIEW corpus.underwriting_outcomes IS
  'Promesa, historia y resultado en una fila. Para cualquier ratio contra el NOI usar loan_amount_senior: es el denominador que usa el emisor. Su definición tiene que coincidir con SENIOR en db/identities.ts.';

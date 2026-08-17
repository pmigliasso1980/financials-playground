-- El saldo senior en la vista de resultados.
--
-- POR QUÉ HACE FALTA
--
-- Las identidades aritméticas determinaron contra qué saldo publica el emisor
-- sus ratios, y no es ninguno de los dos que la vista tenía. Sobre 3.528
-- préstamos:
--
--   denominador                     debt yield        LTV
--   trust (cut-off)                    75%           75%
--   whole loan                         72%           72%
--   trust + pari passu no-trust        99%           99%   ← este
--   whole loan + subordinada           72%           72%
--
-- El "senior" es lo que debe el prestatario sobre el inmueble con la prioridad
-- de cobro más alta: la porción que compró este trust más las notas pari passu
-- que quedaron en otras emisiones. No incluye la deuda subordinada ni la
-- mezzanine, que son las que hacen que "whole loan LTV" sea mayor.
--
-- QUÉ ANÁLISIS ESTABA MAL
--
-- `db:outcomes` calculaba el debt yield real como NOI del servicer sobre
-- `loan_amount` —la rebanada del trust— mientras que el NOI es de la propiedad
-- entera. En los préstamos repartidos eso infla el debt yield por el factor de
-- reparto, que llega a 288x.
--
-- Ese cálculo es el bloque B2, el control que descartó la hipótesis de que el
-- optimismo al originar predice el resultado. La conclusión fue "el debt yield
-- real es parejo entre tramos"; con el denominador corregido hay que rehacerla
-- antes de darla por buena.

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
  (amt.value::numeric + coalesce(npp.value::numeric, 0)) AS loan_amount_senior,
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
LEFT JOIN corpus.facts wl  ON wl.loan_id  = l.id AND wl.metric_key  = 'balance_whole_loan'
                           AND wl.value  ~ '^-?[0-9.]+$';

COMMENT ON VIEW corpus.underwriting_outcomes IS
  'Promesa, historia y resultado en una fila. Para cualquier ratio contra el NOI usar loan_amount_senior: es el denominador que usa el emisor, verificado al 99% por las identidades aritméticas.';

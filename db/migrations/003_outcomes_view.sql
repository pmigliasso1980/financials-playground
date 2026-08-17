-- Vista de resultados, versión con saldo y días desde la originación.
--
-- POR QUÉ ESTO ES UNA MIGRACIÓN NUEVA Y NO UNA EDICIÓN DE LA 002
--
-- `db:migrate` solo aplica migraciones pendientes. Cuando editamos la 002 para
-- agregarle dos columnas a la vista, la única forma de que el cambio tomara
-- efecto era `db:reset` —que borra el corpus entero.
--
-- Eso salió mal de la peor manera posible: el reset destruyó 100 filings y
-- 233.000 observations, y la recosecha inmediata falló porque la SEC había
-- empezado a estrangular por exceso de pedidos. Destruir primero y descubrir
-- después que no se puede reconstruir, cuando la reconstrucción depende de un
-- servicio externo que puede negarse, es un orden de operaciones inaceptable.
--
-- La regla, de acá en adelante: una migración aplicada no se toca. Los cambios
-- de vista van en un archivo nuevo con CREATE OR REPLACE, que corre sobre datos
-- existentes sin borrar nada.

-- DROP + CREATE, no CREATE OR REPLACE.
--
-- `CREATE OR REPLACE VIEW` solo admite AGREGAR columnas al final: no deja
-- renombrar ni reordenar las existentes. Como esta versión intercala
-- `loan_amount` y `loan_amount_whole` en el medio, Postgres rechaza con
-- "cannot change name of view column noi_start to loan_amount_whole".
--
-- La vista no tiene dependientes, así que borrarla y recrearla es seguro y no
-- toca ni una fila de datos.
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
  -- El saldo del trust. Para los ratios que publica el emisor suele
  -- corresponder el del préstamo completo; ver `balance_whole_loan`.
  amt.value::numeric         AS loan_amount,
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
LEFT JOIN corpus.facts wl  ON wl.loan_id  = l.id AND wl.metric_key  = 'balance_whole_loan'
                           AND wl.value  ~ '^-?[0-9.]+$';

COMMENT ON VIEW corpus.underwriting_outcomes IS
  'Promesa, historia y resultado en una fila. gap_vs_actual es la medición de Griffin; gap_vs_trailing es la que se puede hacer solo con el Annex A.';

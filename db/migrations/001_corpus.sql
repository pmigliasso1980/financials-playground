-- Corpus cosechado de SEC EDGAR.
--
-- Alcance deliberado: solo lo que viene de documentos reales. El seed sintético
-- del mock sigue en memoria, porque no hay nada que acumular ahí.
--
-- DECISIONES QUE VALE EXPLICAR
--
-- 1. La clave natural de un filing es el accession number de SEC. Es único,
--    estable y público, así que lo usamos como identidad en vez de un id
--    sintético. Recosechar el mismo filing actualiza en vez de duplicar.
--
-- 2. Las observations guardan el header original de la columna. Cuando el mapeo
--    mejora —y esta semana mejoró cuatro veces— se puede reprocesar el corpus
--    sin volver a bajar los documentos.
--
-- 3. Los facts canónicos se derivan de las observations, no se cargan sueltos.
--    Se recalculan al reprocesar. Guardarlos igual evita recomputar la
--    promoción en cada lectura.
--
-- 4. Todo valor va como TEXT. Un Annex A mezcla monedas, porcentajes, ratios y
--    fechas en la misma columna según la fila, y el tipo lo determina la
--    métrica, no la celda. Castear en la base perdería información.

CREATE SCHEMA IF NOT EXISTS corpus;

-- ---------------------------------------------------------------------------
-- Filings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.filings (
  accession        TEXT PRIMARY KEY,
  cik              TEXT        NOT NULL,
  company_name     TEXT        NOT NULL,
  form_type        TEXT        NOT NULL,
  filed_at         DATE,
  file_name        TEXT        NOT NULL,
  file_url         TEXT        NOT NULL,

  -- Trazabilidad del procesamiento: con qué versión del mapeo se cosechó.
  harvested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  columns_mapped   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  columns_unmapped JSONB       NOT NULL DEFAULT '[]'::jsonb,
  stats            JSONB       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON COLUMN corpus.filings.columns_unmapped IS
  'Encabezados que el mapeo no reconoció. Revisarlos es la forma más directa de encontrar métricas que se están perdiendo.';

CREATE INDEX IF NOT EXISTS filings_cik_idx        ON corpus.filings (cik);
CREATE INDEX IF NOT EXISTS filings_filed_at_idx   ON corpus.filings (filed_at DESC);

-- ---------------------------------------------------------------------------
-- Préstamos
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.loans (
  id             BIGSERIAL PRIMARY KEY,
  accession      TEXT   NOT NULL REFERENCES corpus.filings(accession) ON DELETE CASCADE,

  -- Índice de la fila dentro del Annex A. Junto al accession identifica al
  -- préstamo de forma estable entre recosechas.
  row_index      INTEGER NOT NULL,
  -- El "Loan ID Number" que publica el emisor, cuando existe.
  loan_ref       TEXT,

  property_name  TEXT,
  address        TEXT,
  city           TEXT,
  state          TEXT,
  zip            TEXT,
  property_type  TEXT,

  UNIQUE (accession, row_index)
);

CREATE INDEX IF NOT EXISTS loans_accession_idx ON corpus.loans (accession);
CREATE INDEX IF NOT EXISTS loans_state_idx     ON corpus.loans (state);
CREATE INDEX IF NOT EXISTS loans_type_idx      ON corpus.loans (property_type);

-- ---------------------------------------------------------------------------
-- Observations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.observations (
  id             BIGSERIAL PRIMARY KEY,
  loan_id        BIGINT  NOT NULL REFERENCES corpus.loans(id) ON DELETE CASCADE,

  metric_key     TEXT    NOT NULL,
  metric_label   TEXT    NOT NULL,
  unit           TEXT    NOT NULL,
  entity_type    TEXT    NOT NULL,

  -- Valor normalizado y valor crudo de la celda. El crudo permite auditar el
  -- parseo sin volver al documento.
  value          TEXT    NOT NULL,
  raw_value      TEXT,

  confidence     NUMERIC(4,3) NOT NULL,

  -- Provenance: qué columna del documento originó este valor.
  source_header  TEXT    NOT NULL,
  source_column  INTEGER,

  -- Un préstamo no puede tener dos observations de la misma métrica desde la
  -- misma columna: eso sería un duplicado de procesamiento, no dos fuentes.
  UNIQUE (loan_id, metric_key, source_header)
);

CREATE INDEX IF NOT EXISTS observations_loan_idx   ON corpus.observations (loan_id);
CREATE INDEX IF NOT EXISTS observations_metric_idx ON corpus.observations (metric_key);

-- ---------------------------------------------------------------------------
-- Facts canónicos
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.facts (
  id             BIGSERIAL PRIMARY KEY,
  loan_id        BIGINT  NOT NULL REFERENCES corpus.loans(id) ON DELETE CASCADE,

  metric_key     TEXT    NOT NULL,
  entity_ref     TEXT    NOT NULL,
  value          TEXT    NOT NULL,

  -- De qué observation salió. NULL cuando un usuario lo pisó a mano.
  observation_id BIGINT  REFERENCES corpus.observations(id) ON DELETE SET NULL,
  is_manual_override BOOLEAN NOT NULL DEFAULT false,

  -- Por qué ganó este valor. No existe en la API de Lev; acá lo guardamos
  -- porque en underwriting la pregunta "¿por qué le creemos a este dato?" es
  -- tan importante como el dato.
  promotion_rationale TEXT,

  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (loan_id, metric_key, entity_ref)
);

CREATE INDEX IF NOT EXISTS facts_loan_idx   ON corpus.facts (loan_id);
CREATE INDEX IF NOT EXISTS facts_metric_idx ON corpus.facts (metric_key);

-- ---------------------------------------------------------------------------
-- Vistas de conveniencia
-- ---------------------------------------------------------------------------

-- Cobertura por métrica: la forma más rápida de ver si un cambio en el mapeo
-- mejoró o empeoró el corpus.
CREATE OR REPLACE VIEW corpus.metric_coverage AS
SELECT
  o.metric_key,
  o.metric_label,
  o.unit,
  count(DISTINCT o.loan_id)                          AS loans,
  count(*)                                           AS observations,
  round(avg(o.confidence), 3)                        AS avg_confidence,
  count(DISTINCT o.source_header)                    AS distinct_headers
FROM corpus.observations o
GROUP BY o.metric_key, o.metric_label, o.unit
ORDER BY loans DESC;

COMMENT ON VIEW corpus.metric_coverage IS
  'distinct_headers > 1 significa que varios emisores nombran distinto la misma métrica: útil para saber qué patrones están cargando el peso.';

-- Encabezados que ningún filing supo mapear, con cuántos los traen.
CREATE OR REPLACE VIEW corpus.unmapped_headers AS
SELECT
  header,
  count(*) AS filings
FROM corpus.filings f,
     LATERAL jsonb_array_elements_text(f.columns_unmapped) AS header
GROUP BY header
ORDER BY filings DESC, header;

COMMENT ON VIEW corpus.unmapped_headers IS
  'Cola de trabajo del mapeo: los encabezados de arriba son los que más filings desaprovechan.';

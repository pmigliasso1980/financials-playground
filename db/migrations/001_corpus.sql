-- Corpus harvested from SEC EDGAR.
--
-- Deliberate scope: only what comes from real documents. The mock's synthetic
-- seed stays in memory, because there is nothing to accumulate there.
--
-- DECISIONS WORTH EXPLAINING
--
-- 1. The natural key of a filing is SEC's accession number. It is unique,
--    stable and public, so we use it as identity instead of a synthetic id.
--    Re-harvesting the same filing updates instead of duplicating.
--
-- 2. Observations store the original column header. When the mapping improves
--    —and this week it improved four times— the corpus can be reprocessed
--    without downloading the documents again.
--
-- 3. Canonical facts are derived from observations, they are not loaded on
--    their own. They get recomputed on reprocessing. Storing them anyway avoids
--    recomputing the promotion on every read.
--
-- 4. Every value goes in as TEXT. An Annex A mixes currencies, percentages,
--    ratios and dates in the same column depending on the row, and the type is
--    determined by the metric, not by the cell. Casting in the database would
--    lose information.

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

  -- Processing traceability: which version of the mapping harvested this.
  harvested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  columns_mapped   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  columns_unmapped JSONB       NOT NULL DEFAULT '[]'::jsonb,
  stats            JSONB       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON COLUMN corpus.filings.columns_unmapped IS
  'Headers the mapping did not recognise. Reviewing them is the most direct way to find metrics we are losing.';

CREATE INDEX IF NOT EXISTS filings_cik_idx        ON corpus.filings (cik);
CREATE INDEX IF NOT EXISTS filings_filed_at_idx   ON corpus.filings (filed_at DESC);

-- ---------------------------------------------------------------------------
-- Loans
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.loans (
  id             BIGSERIAL PRIMARY KEY,
  accession      TEXT   NOT NULL REFERENCES corpus.filings(accession) ON DELETE CASCADE,

  -- Index of the row within the Annex A. Together with the accession it
  -- identifies the loan stably across re-harvests.
  row_index      INTEGER NOT NULL,
  -- The "Loan ID Number" the issuer publishes, when it exists.
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

  -- Normalised value and raw cell value. The raw one allows auditing the
  -- parsing without going back to the document.
  value          TEXT    NOT NULL,
  raw_value      TEXT,

  confidence     NUMERIC(4,3) NOT NULL,

  -- Provenance: which column of the document produced this value.
  source_header  TEXT    NOT NULL,
  source_column  INTEGER,

  -- A loan cannot have two observations of the same metric from the same
  -- column: that would be a processing duplicate, not two sources.
  UNIQUE (loan_id, metric_key, source_header)
);

CREATE INDEX IF NOT EXISTS observations_loan_idx   ON corpus.observations (loan_id);
CREATE INDEX IF NOT EXISTS observations_metric_idx ON corpus.observations (metric_key);

-- ---------------------------------------------------------------------------
-- Canonical facts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.facts (
  id             BIGSERIAL PRIMARY KEY,
  loan_id        BIGINT  NOT NULL REFERENCES corpus.loans(id) ON DELETE CASCADE,

  metric_key     TEXT    NOT NULL,
  entity_ref     TEXT    NOT NULL,
  value          TEXT    NOT NULL,

  -- Which observation it came from. NULL when a user overrode it by hand.
  observation_id BIGINT  REFERENCES corpus.observations(id) ON DELETE SET NULL,
  is_manual_override BOOLEAN NOT NULL DEFAULT false,

  -- Why this value won. It does not exist in Lev's API; we store it here
  -- because in underwriting the question "why do we believe this figure?" is
  -- as important as the figure.
  promotion_rationale TEXT,

  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (loan_id, metric_key, entity_ref)
);

CREATE INDEX IF NOT EXISTS facts_loan_idx   ON corpus.facts (loan_id);
CREATE INDEX IF NOT EXISTS facts_metric_idx ON corpus.facts (metric_key);

-- ---------------------------------------------------------------------------
-- Convenience views
-- ---------------------------------------------------------------------------

-- Coverage by metric: the fastest way to see whether a change in the mapping
-- improved or degraded the corpus.
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
  'distinct_headers > 1 means several issuers name the same metric differently: useful to know which patterns are carrying the weight.';

-- Headers no filing managed to map, with how many filings carry them.
CREATE OR REPLACE VIEW corpus.unmapped_headers AS
SELECT
  header,
  count(*) AS filings
FROM corpus.filings f,
     LATERAL jsonb_array_elements_text(f.columns_unmapped) AS header
GROUP BY header
ORDER BY filings DESC, header;

COMMENT ON VIEW corpus.unmapped_headers IS
  'Work queue for the mapping: the headers at the top are the ones wasting the most filings.';

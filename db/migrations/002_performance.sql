-- Post-origination performance, taken from the 10-D filings.
--
-- WHY THIS IS A SEPARATE TABLE AND NOT MORE observations
--
-- The Annex A observations describe the loan at closing: they are a snapshot,
-- which is why their key is (loan, metric, source header). Performance is a
-- series: the same loan has one NOI per reported period, and the period is part
-- of the identity of the datum, not a loose attribute.
--
-- Putting it in observations would force encoding the period inside the
-- metric_key —"noi_actual_2025"— and that breaks the metric catalogue, which is
-- precisely the piece that cost us the most to get in order.
--
-- WHERE THIS TABLE DEPARTS FROM THE CORPUS CONVENTION
--
-- In corpus.observations every value goes in as TEXT, because an Annex A mixes
-- currencies, percentages and dates in the same column and the type is
-- determined by the metric. Not here: annualized_noi is always annualised
-- money, with a single possible interpretation. Storing it as NUMERIC avoids
-- casting on every query and lets the database validate what goes in.

-- ---------------------------------------------------------------------------
-- Servicer reports
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.servicer_reports (
  accession        TEXT PRIMARY KEY,
  cik              TEXT        NOT NULL,
  company_name     TEXT        NOT NULL,
  filed_at         DATE,
  -- Distribution date reported by the 10-D.
  period_of_report DATE,
  file_name        TEXT        NOT NULL,
  file_url         TEXT        NOT NULL,

  harvested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  stats            JSONB       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE corpus.servicer_reports IS
  'EX-99.1 of the 10-D filings. One per trust and month; we normally harvest the April one, which is when the previous year is already consolidated.';

CREATE INDEX IF NOT EXISTS servicer_reports_cik_idx ON corpus.servicer_reports (cik);

-- ---------------------------------------------------------------------------
-- Actual NOI per loan
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corpus.performance (
  id               BIGSERIAL PRIMARY KEY,
  report_accession TEXT    NOT NULL REFERENCES corpus.servicer_reports(accession) ON DELETE CASCADE,
  loan_id          BIGINT  NOT NULL REFERENCES corpus.loans(id) ON DELETE CASCADE,

  -- Identifier exactly as the servicer publishes it, before normalising.
  -- Stored so the join can be audited without downloading the document again.
  pros_id          TEXT    NOT NULL,

  annualized_noi   NUMERIC NOT NULL,
  noi_start        DATE    NOT NULL,
  noi_end          DATE    NOT NULL,
  period_days      INTEGER NOT NULL,
  -- False means the value is extrapolated from a partial period. By harvester
  -- policy only complete ones get in today, but the column exists so the
  -- criterion can be loosened without a migration.
  is_full_year     BOOLEAN NOT NULL,
  -- How many pari passu tranches reported this same loan.
  tranches         INTEGER NOT NULL DEFAULT 1,

  UNIQUE (report_accession, loan_id)
);

CREATE INDEX IF NOT EXISTS performance_loan_idx ON corpus.performance (loan_id);
CREATE INDEX IF NOT EXISTS performance_end_idx  ON corpus.performance (noi_end);

-- ---------------------------------------------------------------------------
-- The view that asks Griffin's question
-- ---------------------------------------------------------------------------

-- Three figures per loan: what the property was producing, what the underwriter
-- said it was going to produce, and what it produced.
--
-- The case that motivated including all three: Benchmark 2024-V7, loan 8.
-- Underwritten 3.4% BELOW the historical figure —conservative by any measure of
-- origination— and actual NOI fell 62%. Looking only at underwritten against
-- historical, that loan appeared on the prudent side of the distribution.
-- The outcomes view lives in 003_outcomes_view.sql.
--
-- It used to be here and we edited it in place to add columns. Since
-- `db:migrate` only applies what is pending, the only way for the change to
-- take effect was `db:reset`, which wipes the corpus. We did it, and the
-- re-harvest failed because SEC had started throttling. An applied migration is
-- not touched.

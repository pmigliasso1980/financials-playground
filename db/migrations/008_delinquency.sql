-- Payment status and special servicing, from the "Delinquency Loan Detail"
-- block.
--
-- WHY THIS VARIABLE
--
-- NOI growth has a standard error of 2.4 points per vintage and no vintage in
-- the corpus is distinguishable from another (`db:power`). This one is a count:
-- with ~400 loans per vintage the noise floor drops to ~3 percentage points,
-- against observed base rates of 0% to 3%. It is the first variable in the
-- project where the expected effect exceeds the noise with margin.
--
-- THE TABLE LISTS ONLY THE AFFECTED LOANS
--
-- The 10-D does not publish the status of every loan: it publishes those that
-- are delinquent or in special servicing. The rows are the numerator; the
-- denominator is the Annex A pool, which is already in `corpus.loans`. There is
-- no need to parse the healthy ones.
--
-- DELINQUENCY AND SPECIAL SERVICING ARE NOT THE SAME THING
--
-- Benchmark 2020-B16 has a loan transferred to special servicing in January
-- that is paying on time: 0 months delinquent. The transfer is the early
-- signal; delinquency is the late symptom. Both are stored because they measure
-- different things.
--
-- `months_delinquent` and `paid_through` are the same fact by two routes —the
-- months should be ≈ (end of period − paid through)/30— and both are present so
-- they can be checked against each other. It is the class of verification we
-- discovered late in the Annex A.

CREATE TABLE IF NOT EXISTS corpus.delinquency (
  id                BIGSERIAL PRIMARY KEY,
  report_accession  TEXT    NOT NULL,
  loan_id           BIGINT  NOT NULL REFERENCES corpus.loans(id) ON DELETE CASCADE,
  period            DATE,
  paid_through      DATE,
  months_delinquent NUMERIC,
  status            TEXT,
  transfer_date     DATE,
  foreclosure_date  DATE,
  reo_date          DATE,
  UNIQUE (report_accession, loan_id)
);

-- The referencing side of a CASCADE needs an index: without it every loan
-- deleted in a re-harvest triggers a Seq Scan. It already happened with
-- facts.observation_id and it took a batch from minutes to hours.
CREATE INDEX IF NOT EXISTS delinquency_loan_idx ON corpus.delinquency (loan_id);

COMMENT ON TABLE corpus.delinquency IS
  'Loans delinquent or in special servicing according to the 10-D. The rows are the numerator; the denominator is the pool in corpus.loans.';

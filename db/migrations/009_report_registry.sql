-- Which issuance each servicer report covers.
--
-- THE CONFOUNDER THIS FIXES
--
-- `db:predictors` and `db:delinquency` restrict their base like this:
--
--     WHERE f.accession IN (SELECT accession FROM corpus.loans
--                            JOIN corpus.performance ON ...)
--
-- with the comment "only issuances that have a servicer report: in the others
-- the event is not observable". But `corpus.performance` is the NOI table. That
-- uses "we managed to parse the NOI" as a proxy for "there is a report", and
-- the two are not the same thing: the BANK shelf publishes its full delinquency
-- block —Months Delinquent, Servicing Transfer Date, Foreclosure Date— and
-- still falls out of the analysis because its NOI comes without a usable
-- period.
--
-- The delinquency question never needed the NOI. It was paying the cost of an
-- unrelated dependency.
--
-- WHY A COLUMN AND NOT A JOIN ON CIK
--
-- The trust and its report share a CIK, so the join could be made without
-- storing anything. We do not do that: `servicerBatch` inserts the CIK as
-- `String(Number(cik))` and `corpus.filings` stores it as it comes. Two
-- different normalisations of the same key is exactly the class of silent join
-- that already cost us a day with `Pros ID`. The issuance being harvested is
-- known at harvest time; storing it is cheaper than deducing it.
--
-- WHY NULLABLE
--
-- The already-harvested rows do not have it. They are backfilled below by CIK
-- —which is enough for the existing corpus— but the column stays nullable so
-- that an incomplete backfill shows up as NULL instead of breaking the
-- migration. A NULL here means "I do not know which issuance this is"; a zero
-- would be a lie.

ALTER TABLE corpus.servicer_reports
  ADD COLUMN IF NOT EXISTS deal_accession TEXT REFERENCES corpus.filings(accession) ON DELETE CASCADE;

-- The referencing side of a CASCADE needs its own index: Postgres does not
-- create it automatically and without it every filing deletion triggers a Seq
-- Scan.
CREATE INDEX IF NOT EXISTS servicer_reports_deal_idx
  ON corpus.servicer_reports (deal_accession);

-- Backfill. `String(Number(cik))` strips leading zeros, so both sides are
-- compared as numbers. Only where there is a single issuance per CIK: if a CIK
-- had two, guessing which one would be inventing.
UPDATE corpus.servicer_reports sr
   SET deal_accession = f.accession
  FROM (
    SELECT cik, min(accession) AS accession
      FROM corpus.filings
     GROUP BY cik
    HAVING count(*) = 1
  ) f
 WHERE sr.deal_accession IS NULL
   AND f.cik ~ '^[0-9]+$'
   AND sr.cik ~ '^[0-9]+$'
   AND f.cik::bigint = sr.cik::bigint;

COMMENT ON COLUMN corpus.servicer_reports.deal_accession IS
  'The issuance this report covers. It is the correct gate for "the event is observable": an issuance registered here has a parsed report, whether or not it yielded NOI.';

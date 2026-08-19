-- Which block of the 10-D each row came from.
--
-- THE EVENT WAS IN A DIFFERENT TABLE
--
-- `corpus.delinquency` was only filled from the "Delinquency Loan Detail"
-- block. But the 10-D also carries "Specially Serviced Loan Detail", with its
-- own `Servicing Transfer Date` column, and a loan can be in special servicing
-- while PAYING ON TIME — in which case it appears there and not among the
-- delinquent ones.
--
-- BANK 2021-BNK36 says "No delinquent loans this period" and has Pros ID 71
-- —multifamily in Illinois, transferred on 2025-02-12— in the other block. The
-- pipeline counted it as zero events.
--
-- WHY IT MATTERS MORE THAN IT LOOKS
--
-- The "BANK transfers 4 times less than BBCMS" gap survived eight attempts to
-- kill it: join coverage, listed population, format, filters, raw value across
-- twenty issuances, master servicer, special servicer, and composition by
-- property type × vintage.
--
-- All eight attacked the denominator or the controls. None asked whether the
-- NUMERATOR was complete. If one shelf has loans that enter special servicing
-- before they stop paying and another does not, the difference between their
-- rates measures which block each servicer filled in, not who underwrites
-- better.
--
-- THE CONSTRAINT DOES NOT CHANGE
--
-- It remains UNIQUE (report_accession, loan_id): a loan appearing in both
-- blocks is one loan, not two. `source` records where it was seen, and the
-- upsert from the special block does NOT overwrite `months_delinquent` —that
-- datum only exists in the delinquency block.

ALTER TABLE corpus.delinquency
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS resolution_code TEXT;

COMMENT ON COLUMN corpus.delinquency.source IS
  'Which block of the 10-D it came from: delinquency, special, or both. Without this, "there is no event" and "the event was in the table we were not reading" are the same absent row.';

-- The already-loaded rows all come from the delinquency block.
UPDATE corpus.delinquency SET source = 'delinquency' WHERE source IS NULL;

-- Who services each trust.
--
-- THE QUESTION THIS MAKES POSSIBLE
--
-- Adjusted by vintage and by DSCR tercile, BANK transfers to special servicing
-- 4 times less often than BBCMS (SIR 0.39 against 1.60, non-overlapping
-- intervals). That survived five attempts to kill it: the join, the listed
-- population, the format, the filters, and the raw value across twenty
-- issuances.
--
-- But the SIR correlates 0.73 with NOI coverage, and that correlation CANNOT be
-- causal: the numerator comes from the delinquency table, which joins at 97.7%
-- and does not depend on the NOI at all. A real correlation with no mechanism
-- calls for a common cause.
--
-- The master servicer builds BOTH tables in the report. If one publishes NOI
-- without a period AND lists fewer loans as delinquent, the two move together
-- without causing each other. BANK uses Trimont; Benchmark uses Midland.
--
-- If that is what is happening, "BANK underwrites better" becomes "Trimont
-- reports differently" — the finding changes subject and importance.
--
-- WHAT THIS TABLE MAY NOT BE ABLE TO ANSWER
--
-- If every shelf uses a different servicer and no servicer appears in two
-- shelves, issuer and servicer are the same column under two names and no datum
-- in the corpus separates them. That is why the first thing to look at is not
-- the result but the cross-tabulation: if there are no off-diagonal cells, the
-- question cannot be asked and that has to be said instead of answered anyway.

ALTER TABLE corpus.servicer_reports
  ADD COLUMN IF NOT EXISTS master_servicer  TEXT,
  ADD COLUMN IF NOT EXISTS special_servicer TEXT;

CREATE INDEX IF NOT EXISTS servicer_reports_master_idx
  ON corpus.servicer_reports (master_servicer);

COMMENT ON COLUMN corpus.servicer_reports.master_servicer IS
  'Master servicer per the 10-D cover page. It builds both the NOI table and the delinquency table: it is the candidate common cause for both degrading together.';

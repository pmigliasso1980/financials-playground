-- The raw Pros ID in the delinquency table.
--
-- WHY IT SHOWS UP NOW
--
-- The batch reported 341 delinquent loans persisted and the table had 282, out
-- of 349 parsed rows. Three numbers for what looked like a single thing:
--
--   349  delinquency rows in the 10-D
--   341  rows that found their loan in the corpus            (join: 97.7%)
--   282  distinct rows in the table                          (59 collapsed)
--
-- The 59 were not lost in the join: they were lost in the ON CONFLICT. Two rows
-- of the report landing on the same `loan_id` because `loanInt()` takes the
-- leading digits of the Pros ID, and the servicer numbers pari passu tranches
-- as `1`, `1A`, `1B`. Collapsing them is correct —one loan, several tranches—
-- but without storing the raw identifier there is no way to demonstrate it
-- without downloading the document again.
--
-- `corpus.performance` already stores `pros_id` with exactly that argument in
-- its comment. The delinquency table was created without it, and that is why a
-- 59-row difference was indistinguishable from a broken join.
--
-- THE CONSTRAINT DOES NOT CHANGE
--
-- It remains UNIQUE (report_accession, loan_id): payment status belongs to the
-- loan, not the tranche, and two tranches of the same loan are not two
-- delinquencies. `pros_id` remains the last tranche seen —useful for auditing,
-- not for identifying. Putting it in the key would inflate the delinquency
-- numerator with tranches, which is the opposite error and a worse one.

ALTER TABLE corpus.delinquency
  ADD COLUMN IF NOT EXISTS pros_id TEXT;

COMMENT ON COLUMN corpus.delinquency.pros_id IS
  'Identifier exactly as the servicer publishes it, before normalising. Join audit: if two report rows collapse into one loan_id, the last tranche seen is kept here.';

-- The delinquency source value, in English.
--
-- WHY THIS NEEDS A MIGRATION AND NOT JUST A CODE CHANGE
--
-- `corpus.delinquency.source` is not a comment: it is data. It records which
-- block of the 10-D each row came from —'delinquency', 'special', or both— and
-- the "both" case was written in Spanish as 'ambos'.
--
-- Changing the string in servicerBatch.ts only affects rows written from now on.
-- The rows already in the database keep the old value, and then a query filtering
-- `source = 'both'` silently misses every loan that appeared in both blocks —
-- which is precisely the population that matters, because it is the one that
-- exists in the delinquency table only thanks to the second block being read.
--
-- The same class of problem as the loan_states view, caught before it applied.
-- Here it was caught after, so it costs a migration.
--
-- IT IS IDEMPOTENT AND IT DOES NOT TOUCH ANYTHING ELSE
--
-- Only rows whose value is exactly 'ambos'. If the harvest has already been
-- re-run with the new code, this updates zero rows and that is the correct
-- outcome, not a sign that something failed.

UPDATE corpus.delinquency SET source = 'both' WHERE source = 'ambos';

COMMENT ON COLUMN corpus.delinquency.source IS
  'Which block of the 10-D it came from: delinquency, special, or both. Without this, "there is no event" and "the event was in the table we were not reading" are the same absent row.';

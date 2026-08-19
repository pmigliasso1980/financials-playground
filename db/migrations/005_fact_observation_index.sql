-- The missing index on the foreign key.
--
-- WHY A RE-HARVEST TOOK HOURS
--
-- `corpus.facts.observation_id` references `corpus.observations(id)` with
-- ON DELETE SET NULL, and had no index.
--
-- Postgres does not automatically index the referencing side of a foreign key
-- —only the referenced side, via the PK. Without an index, every deleted
-- observation forces a full Seq Scan of `facts` to find the rows pointing at it
-- and set them to NULL.
--
-- A re-harvest with `--refresh-stale` deletes the whole filing before rewriting
-- it (ON DELETE CASCADE), so over a corpus of ~600,000 observations and
-- ~500,000 facts that is 600,000 sequential scans of half a million rows. The
-- batch went from 18 minutes to hours as the corpus grew, and the time was not
-- in the network, nor the parsing, nor the inserts: it was here.
--
-- HOW TO SPOT THIS IN GENERAL
--
-- Every column that is the referencing side of a DELETE CASCADE or SET NULL
-- needs an index. It is a case where the cost does not show up with test data
-- —with a thousand rows the Seq Scan is instant— and blows up suddenly once the
-- corpus reaches a certain size. The schema's other foreign keys
-- (loans.accession, observations.loan_id, facts.loan_id) did have indexes; this
-- one was overlooked because it is not used by any read query.

CREATE INDEX IF NOT EXISTS facts_observation_idx
  ON corpus.facts (observation_id);

COMMENT ON INDEX corpus.facts_observation_idx IS
  'Not useful for reading: it exists so that the ON DELETE SET NULL on observations does not do a Seq Scan per deleted row.';

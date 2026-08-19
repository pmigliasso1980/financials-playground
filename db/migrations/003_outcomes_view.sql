-- Outcomes view, version with balance and days since origination.
--
-- WHY THIS IS A NEW MIGRATION AND NOT AN EDIT OF 002
--
-- `db:migrate` only applies pending migrations. When we edited 002 to add two
-- columns to the view, the only way for the change to take effect was
-- `db:reset` —which wipes the entire corpus.
--
-- That went wrong in the worst possible way: the reset destroyed 100 filings
-- and 233,000 observations, and the immediate re-harvest failed because SEC had
-- started throttling for excess requests. Destroying first and discovering
-- afterwards that you cannot rebuild, when the rebuild depends on an external
-- service that can refuse, is an unacceptable order of operations.
--
-- The rule, from here on: an applied migration is not touched. View changes go
-- in a new file with CREATE OR REPLACE, which runs over existing data without
-- deleting anything.

-- DROP + CREATE, not CREATE OR REPLACE.
--
-- `CREATE OR REPLACE VIEW` only allows ADDING columns at the end: it does not
-- allow renaming or reordering existing ones. Since this version interleaves
-- `loan_amount` and `loan_amount_whole` in the middle, Postgres rejects it with
-- "cannot change name of view column noi_start to loan_amount_whole".
--
-- The view has no dependents, so dropping and recreating it is safe and does
-- not touch a single row of data.
DROP VIEW IF EXISTS corpus.underwriting_outcomes;

CREATE VIEW corpus.underwriting_outcomes AS
SELECT
  l.id                       AS loan_id,
  l.accession,
  f.company_name,
  f.filed_at                 AS originated_at,
  l.loan_ref,
  l.property_type,
  l.state,
  uw.value::numeric          AS noi_underwritten,
  mr.value::numeric          AS noi_trailing,
  p.annualized_noi           AS noi_actual,
  -- The trust balance. For the ratios the issuer publishes, the whole-loan
  -- balance is usually the matching one; see `balance_whole_loan`.
  amt.value::numeric         AS loan_amount,
  wl.value::numeric          AS loan_amount_whole,
  p.noi_start,
  p.noi_end,
  p.is_full_year,
  -- Negative means the reported period starts BEFORE closing: it overlaps with
  -- the historical figures the underwriter already had in front of them, so the
  -- gap against those does not measure an outcome.
  (p.noi_start - f.filed_at) AS days_after_origination,
  uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap_vs_trailing,
  uw.value::numeric / NULLIF(p.annualized_noi, 0)  - 1 AS gap_vs_actual,
  p.annualized_noi / NULLIF(mr.value::numeric, 0)  - 1 AS growth_delivered
FROM corpus.performance p
JOIN corpus.loans   l ON l.id = p.loan_id
JOIN corpus.filings f ON f.accession = l.accession
LEFT JOIN corpus.facts uw  ON uw.loan_id  = l.id AND uw.metric_key  = 'noi_underwritten'
                           AND uw.value  ~ '^-?[0-9.]+$'
LEFT JOIN corpus.facts mr  ON mr.loan_id  = l.id AND mr.metric_key  = 'noi_most_recent'
                           AND mr.value  ~ '^-?[0-9.]+$'
LEFT JOIN corpus.facts amt ON amt.loan_id = l.id AND amt.metric_key = 'loan_amount'
                           AND amt.value ~ '^-?[0-9.]+$'
LEFT JOIN corpus.facts wl  ON wl.loan_id  = l.id AND wl.metric_key  = 'balance_whole_loan'
                           AND wl.value  ~ '^-?[0-9.]+$';

COMMENT ON VIEW corpus.underwriting_outcomes IS
  'Promise, history and outcome in one row. gap_vs_actual is Griffin''s measurement; gap_vs_trailing is the one you can make with the Annex A alone.';

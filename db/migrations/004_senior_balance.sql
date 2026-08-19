-- The senior balance in the outcomes view.
--
-- WHY IT IS NEEDED
--
-- The arithmetic identities determined which balance the issuer publishes its
-- ratios against, and it is neither of the two the view had. Over 3,528 loans:
--
--   denominator                     debt yield        LTV
--   trust (cut-off)                    75%           75%
--   whole loan                         72%           72%
--   trust + non-trust pari passu       99%           99%   ← this one
--   whole loan + subordinate           72%           72%
--
-- The "senior" balance is what the borrower owes on the property at the highest
-- payment priority: the slice this trust bought plus the pari passu notes that
-- ended up in other issuances. It does not include subordinate or mezzanine
-- debt, which are what make "whole loan LTV" larger.
--
-- WHICH ANALYSIS WAS WRONG
--
-- `db:outcomes` computed actual debt yield as servicer NOI over `loan_amount`
-- —the trust's slice— while the NOI is for the entire property. On split loans
-- that inflates the debt yield by the split factor, which reaches 288x.
--
-- That computation is block B2, the control that discarded the hypothesis that
-- optimism at origination predicts the outcome. The conclusion was "actual debt
-- yield is even across tranches"; with the denominator corrected it has to be
-- redone before being taken as good.

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
  -- This trust's portion.
  amt.value::numeric         AS loan_amount,
  -- What the borrower owes on the property in the senior tranche. It is the
  -- denominator the issuer uses for debt yield, LTV and DSCR, and therefore the
  -- right one to compare against any property-level NOI.
  (amt.value::numeric + coalesce(npp.value::numeric, 0)) AS loan_amount_senior,
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
LEFT JOIN corpus.facts npp ON npp.loan_id = l.id
                           AND npp.metric_key = 'balance_pari_passu_non_trust'
                           AND npp.value ~ '^-?[0-9.]+$'
LEFT JOIN corpus.facts wl  ON wl.loan_id  = l.id AND wl.metric_key  = 'balance_whole_loan'
                           AND wl.value  ~ '^-?[0-9.]+$';

COMMENT ON VIEW corpus.underwriting_outcomes IS
  'Promise, history and outcome in one row. For any ratio against NOI use loan_amount_senior: it is the denominator the issuer uses, verified at 99% by the arithmetic identities.';

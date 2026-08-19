-- Senior now prefers the published column over the sum.
--
-- WHY THIS MIGRATION EXISTS
--
-- `db:identities` changed its definition of senior: if the Annex publishes the
-- total in a column of its own it uses that, and only when it is absent does it
-- sum trust + pari passu. This view had the old definition written by hand.
--
-- Two definitions of the same concept in two files diverge silently: the
-- identities would close at 97% while `db:outcomes` compared NOI against a
-- different denominator, and nothing would warn. The project's finding
-- —projected against delivered, by vintage— is computed with this view, so the
-- divergence would not be cosmetic.
--
-- WHERE THE NEW COLUMN CAME FROM
--
-- Not from reading headers. For each loan whose debt yield does not close, the
-- reconciler searched which unmapped cell in that same row is worth the balance
-- implied by the identity. "Total Cut-off Date Pari Passu Debt" matched on 33
-- loans across 4 issuances within 1% —1,001.0M against 1,001.3M— and was
-- identified by its value.
--
-- It is preferable to the sum when present: it does not depend on both parts
-- having been mapped correctly, nor on the issuer publishing them separately.
--
-- `balance_total_debt` is NOT used: that includes subordinate and mezzanine
-- debt, and on a loan with a B-note it would give an inflated denominator. They
-- coincide only when there is no junior debt.
--
-- The view is recreated whole —DROP + CREATE— because CREATE OR REPLACE VIEW
-- cannot change the definition of an existing column.

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
  --
  -- The published column wins over the sum; see the header of this migration.
  -- It has to match `SENIOR` in db/identities.ts.
  coalesce(
    sen.value::numeric,
    amt.value::numeric + coalesce(npp.value::numeric, 0)
  )                          AS loan_amount_senior,
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
LEFT JOIN corpus.facts sen ON sen.loan_id = l.id
                           AND sen.metric_key = 'balance_senior_total'
                           AND sen.value ~ '^-?[0-9.]+$'
LEFT JOIN corpus.facts wl  ON wl.loan_id  = l.id AND wl.metric_key  = 'balance_whole_loan'
                           AND wl.value  ~ '^-?[0-9.]+$';

COMMENT ON VIEW corpus.underwriting_outcomes IS
  'Promise, history and outcome in one row. For any ratio against NOI use loan_amount_senior: it is the denominator the issuer uses. Its definition has to match SENIOR in db/identities.ts.';

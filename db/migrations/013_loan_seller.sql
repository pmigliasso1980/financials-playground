-- Who originated the loan, which is not who assembled the issuance.
--
-- THE CONFUSION THIS UNDOES
--
-- All the "issuer" analysis has been attributing to BANK or BBCMS what their
-- sellers did. A BANK deal groups loans originated by Bank of America, Morgan
-- Stanley and Wells Fargo: the shelf is the packager, not the underwriter.
-- Saying "BANK underwrites better" is like congratulating the box for what the
-- factory did.
--
-- WHY THIS VARIABLE AND NOT ONE MORE CONFOUNDER
--
-- The nine previous attacks were defensive: each one asked "is this an
-- artefact?" and the answer was "no". Nine "no"s do not make a "yes".
--
-- The seller is different because it can CONFIRM the effect. The same seller
-- places loans into several issuances, so the design ends up crossed without
-- anyone designing it: Wells Fargo sells into BANK (SIR 0.42) and into its own
-- shelf (1.20). If the seller drives it, holding it fixed has to flatten that
-- difference. If the shelf drives it, it will not.
--
-- WHAT CAN GO WRONG
--
-- That the column does not exist in most Annex A documents. `columnMap` already
-- knew that "Mortgage Loan Seller" appears in 9 filings —it was listed as an
-- exclusion for `loan_amount`— but nine out of 150 is not enough for anything.
-- Coverage has to be measured before running any analysis on top of it, and if
-- it is low the correct answer is "this corpus cannot tell".

ALTER TABLE corpus.loans
  ADD COLUMN IF NOT EXISTS loan_seller TEXT;

CREATE INDEX IF NOT EXISTS loans_seller_idx ON corpus.loans (loan_seller);

COMMENT ON COLUMN corpus.loans.loan_seller IS
  'Loan seller per the Annex A. This is the originator; the issuer is the vehicle that packages it. One seller places loans into several issuances, which makes the question "shelf or underwriter?" identifiable.';

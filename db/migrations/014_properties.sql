-- ---------------------------------------------------------------------------
-- Properties: the rows the harvester used to discard
-- ---------------------------------------------------------------------------
--
-- WHY
--
-- An Annex A carries two kinds of row: one per loan and one per property
-- securing it. The harvester kept the loan rows and counted the property rows
-- in order to throw them away.
--
-- Measured over the three fixtures: 138 discarded rows, 138 with a non-empty
-- state, city and property name. "101 45th Street, Munster, IN". "Extra Space
-- Brickell, Miami, FL". "Soho Grand Hotel, New York, NY". It was not residue.
--
-- That left 585 loans with no state at all —the ones securing properties in
-- more than one state, where the issuer leaves the cell blank because there is
-- no single state— and therefore invisible to every /comps query. It also lost
-- the addresses of the multi-property loans that DO have a stored state, which
-- are more numerous.
--
-- HOW EACH PROPERTY IS TIED TO ITS LOAN
--
-- By the issuer's numbering, which is consistent across families:
--
--   3.00 or 3  ← the loan
--   3.01       ← first property securing it
--   3.02       ← second
--
-- Verified over the three fixtures: 138 of 138 property rows have a decimal ID
-- whose integer part corresponds to a stored loan. None was left orphaned.
--
-- Both the resolved `loan_id` AND the raw `loan_ref` are stored: if some issuer
-- numbers differently, the row still goes in with loan_id NULL and gets counted
-- instead of lost.
--
-- WHAT THIS TABLE IS NOT
--
-- It does not replace `loans`. A loan is still the unit of credit and the
-- financial metrics —DSCR, LTV, balance— belong to the loan, not to each
-- property. What goes here is the geography and the physical identity, which is
-- what was being discarded.

CREATE TABLE IF NOT EXISTS corpus.properties (
  id            BIGSERIAL PRIMARY KEY,
  accession     TEXT    NOT NULL REFERENCES corpus.filings(accession) ON DELETE CASCADE,

  -- Index of the row within the Annex A. Together with the accession it
  -- identifies the property stably across re-harvests, same as in `loans`.
  row_index     INTEGER NOT NULL,

  -- The loan it secures. NULL if the issuer's ID could not be resolved: we
  -- prefer a property with no owner over not storing it.
  loan_id       BIGINT  REFERENCES corpus.loans(id) ON DELETE CASCADE,
  -- What the issuer publishes, raw: "3.01". Kept so the tie can be audited.
  property_ref  TEXT,
  -- The integer part, "3", which is what ties it. Stored so the link can be
  -- rebuilt without parsing again.
  loan_ref      TEXT,

  property_name TEXT,
  address       TEXT,
  city          TEXT,
  state         TEXT,
  zip           TEXT,
  property_type TEXT,

  UNIQUE (accession, row_index)
);

CREATE INDEX IF NOT EXISTS properties_accession_idx ON corpus.properties (accession);
CREATE INDEX IF NOT EXISTS properties_loan_idx      ON corpus.properties (loan_id);
CREATE INDEX IF NOT EXISTS properties_state_idx     ON corpus.properties (state);
CREATE INDEX IF NOT EXISTS properties_type_idx      ON corpus.properties (property_type);

-- ---------------------------------------------------------------------------
-- The geography of a loan, whether it has one property or twenty
-- ---------------------------------------------------------------------------
--
-- The loan's state if it has one, and otherwise the states of its properties.
-- One row per (loan, state) pair: a loan with properties in Texas and
-- California appears twice, and appears in both queries.
--
-- `origin` says where it came from, because they are not the same thing: 'loan'
-- is what the issuer put in the loan row, 'property' is what we deduced from
-- its collateral. Whoever queries can decide whether to accept the second.

CREATE OR REPLACE VIEW corpus.loan_states AS
  SELECT l.id AS loan_id, l.accession, btrim(l.state) AS state, 'loan'::text AS origin
    FROM corpus.loans l
   WHERE l.state IS NOT NULL AND btrim(l.state) <> ''
  UNION
  SELECT p.loan_id, p.accession, btrim(p.state), 'property'::text
    FROM corpus.properties p
   WHERE p.loan_id IS NOT NULL AND p.state IS NOT NULL AND btrim(p.state) <> '';

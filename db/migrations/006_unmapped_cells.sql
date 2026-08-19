-- The cells the mapping could not interpret, with their value.
--
-- WHY STORE WHAT WE DO NOT UNDERSTAND
--
-- `filings.columns_unmapped` already stored the unmapped HEADERS, and that was
-- enough for two fixes: searching there surfaced the real name of the
-- identifier column in the 2020 vintages, and produced the ranking of candidate
-- columns by affected loans.
--
-- But a header only lets you guess. For Tysons Corner Center we know, from two
-- independent identities, that the missing balance is 708,777,715: the one
-- implied by debt yield gives 708,777,715 and the one implied by LTV gives
-- 709,200,000, a 0.06% difference. With that figure in hand, finding the column
-- should not require reading eighty-seven names and picking the one that sounds
-- best — it should be a numeric comparison against the cells of that row.
--
-- That is what this table enables. The practical difference: during this
-- session I predicted three times which column a problem came from and got one
-- right. Each prediction cost a ten-minute re-harvest cycle.
--
-- WHAT IS STORED AND WHAT IS NOT
--
-- Only cells that parse as a number. Dates, descriptions and footnotes are no
-- use for reconciling and would triple the table.
--
-- `value_num` is the magnitude exactly as printed, without interpreting it by
-- unit: percentages are not converted to fractions and the "x" suffix is not
-- stripped. Comparing against an implied value needs the raw number; the
-- interpretation is precisely what we do not yet know how to do with this
-- column.
--
-- THE loan_id INDEX IS NOT OPTIONAL
--
-- It is the referencing side of a foreign key with ON DELETE CASCADE, and
-- Postgres does not index it on its own. Without it, every re-harvest —which
-- deletes the filing before rewriting it— would do a full Seq Scan of this
-- table for each deleted loan. It already happened to us with
-- `facts.observation_id` and it took a batch from minutes to hours.

CREATE TABLE IF NOT EXISTS corpus.unmapped_cells (
  id         BIGSERIAL PRIMARY KEY,
  loan_id    BIGINT  NOT NULL REFERENCES corpus.loans(id) ON DELETE CASCADE,
  header     TEXT    NOT NULL,
  raw_value  TEXT    NOT NULL,
  value_num  NUMERIC NOT NULL,
  UNIQUE (loan_id, header)
);

CREATE INDEX IF NOT EXISTS unmapped_cells_loan_idx
  ON corpus.unmapped_cells (loan_id);

-- The reconciler asks "which cell of this row is worth ~X", so the strong
-- filter is by loan_id and then by magnitude. This index serves the inverse
-- aggregate: which headers appear with values in a given range.
CREATE INDEX IF NOT EXISTS unmapped_cells_header_idx
  ON corpus.unmapped_cells (header);

COMMENT ON TABLE corpus.unmapped_cells IS
  'Numeric cells from columns the mapping did not interpret. They exist to reconcile implied values against candidate columns without guessing from the header name.';

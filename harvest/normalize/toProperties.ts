/**
 * The property rows, normalised.
 *
 * WHAT THEY ARE
 *
 * An Annex A carries one row per loan and one per property securing it.
 * `keepLoanRows` separates the latter so a portfolio of twenty properties does
 * not enter as twenty loans —that filter is right and is not touched— but until
 * now it counted them and threw them away.
 *
 * Measured over the three fixtures: 138 discarded, 138 with a non-empty state,
 * city and name. Real addresses, not residue.
 *
 * WHY IT REUSES `rowsToObservations` INSTEAD OF MAPPING AGAIN
 *
 * The property rows have the SAME headers as the loan rows: they are the same
 * table. Writing a second column mapping here would mean maintaining two
 * implementations of the same decision, and this session has already shown three
 * times what happens with that: they diverge at the first correction made to
 * only one of them.
 *
 * So a synthetic table is assembled —the original header plus the property rows—
 * and passed through the usual normaliser. State normalisation, discarding
 * absence markers and value parsing all come for free and cannot diverge.
 *
 * HOW EACH PROPERTY IS TIED TO ITS LOAN
 *
 * By the issuer's numbering: `3.01` and `3.02` secure loan `3`. Verified over
 * the three fixtures, 138 of 138 tie. If one does not tie, it still enters with
 * `loanRef: null` and is counted rather than lost — an issuer that numbers
 * differently has to show up in the monitor, not disappear.
 */

import { rowsToObservations, type SourceRef } from "./toObservations.js";

export interface HarvestedPropertyRow {
  /** Index of the row in the original Annex A, not in the synthetic table. */
  rowIndex: number;
  /** What the issuer publishes: "3.01". */
  propertyRef: string | null;
  /** The integer part, "3", which is what ties it to the loan. */
  loanRef: string | null;
  propertyName: string | null;
  address: string | null;
  city: string | null;
  /** Already normalised to a two-letter code by the shared normaliser. */
  state: string | null;
  zip: string | null;
  propertyType: string | null;
}

/** The issuer's property numbering: 3.01, 12.04, sometimes 3.1. */
const PROPERTY_REF = /^\d+\.\d+$/;

/**
 * Which column carries the `3.01` numbering, found by its SHAPE and not by the
 * column map.
 *
 * WHY `loan_id` FROM THE COLUMN MAP IS NOT USED
 *
 * I tried it and it fails on Benchmark 2020-B16: the map assigns `loan_id` to
 * the "Loan No." column, but the property numbering lives in another column
 * called "ID", which is empty on the loan rows. The result was 49 properties
 * tied to no loan, silently.
 *
 * The column map is tuned for the loan rows, which are the ones it looks at. The
 * property rows fill other cells, so inheriting its decisions is inheriting an
 * answer to a different question.
 *
 * The shape, by contrast, is unmistakable and does not depend on the issuer: it
 * is the only column where almost every row reads "integer dot integer". The one
 * satisfying the most rows is chosen and a majority is required; if none
 * reaches it, null is returned and the properties enter untied —counted, not
 * lost.
 */
function refColumn(rows: unknown[][]): number | null {
  if (rows.length === 0) return null;
  const width = Math.max(...rows.map((r) => r.length));
  let best = -1;
  let bestN = 0;
  for (let c = 0; c < width; c++) {
    let n = 0;
    for (const f of rows) if (PROPERTY_REF.test(String(f[c] ?? "").trim())) n++;
    if (n > bestN) { bestN = n; best = c; }
  }
  return bestN > rows.length / 2 ? best : null;
}

/** `3.01` → `{ propertyRef: "3.01", loanRef: "3" }`. */
function splitId(value: unknown): { propertyRef: string | null; loanRef: string | null } {
  const raw = String(value ?? "").trim();
  if (!raw) return { propertyRef: null, loanRef: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { propertyRef: raw, loanRef: null };
  return { propertyRef: raw, loanRef: String(Math.trunc(n)) };
}

export function toProperties(
  headerRows: unknown[][],
  headerRowIndex: number,
  dropped: Array<{ rowIndex: number; row: unknown[] }>,
  source: SourceRef,
): HarvestedPropertyRow[] {
  if (dropped.length === 0) return [];

  /**
   * The original header plus the property rows. Same width, same headers, same
   * header row: to the normaliser it is the usual table with different data
   * rows.
   */
  const sintetica = [...headerRows.slice(0, headerRowIndex + 1), ...dropped.map((d) => d.row)];
  const r = rowsToObservations(sintetica, headerRowIndex, source);
  const colRef = refColumn(dropped.map((d) => d.row));

  const out: HarvestedPropertyRow[] = [];
  for (const p of r.properties) {
    /**
     * `row_index` is the index WITHIN the data rows, starting at zero.
     *
     * The first version subtracted `headerRowIndex + 1` believing it referred to
     * the whole table. With that, the first property of each fixture landed in
     * `dropped[-1]` and disappeared, and all the others ended up with the
     * previous property's index: it did not lose data visibly, it tied it to the
     * wrong row. It was noticed because all three fixtures lost exactly one.
     *
     * The translation matters because `row_index` is the stable key across
     * re-harvests: if it shifts, two harvests of the same document produce
     * different rows.
     */
    const original = dropped[p.row_index];
    if (!original) continue;

    const { propertyRef, loanRef } = splitId(
      colRef === null ? null : original.row[colRef],
    );

    out.push({
      rowIndex: original.rowIndex,
      propertyRef,
      loanRef,
      propertyName: p.label.property_name,
      address: p.label.address,
      city: p.label.city,
      state: p.label.state,
      zip: p.observations.find((o) => o.metric_key === "zip")?.value ?? null,
      propertyType: p.label.property_type,
    });
  }
  return out;
}

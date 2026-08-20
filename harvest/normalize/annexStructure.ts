/**
 * The real structure of an Annex A.
 *
 * Discovered by inspecting Wells Fargo 2025-C64 on EDGAR. Two things the
 * synthetic version did not have, and that break the modelling if ignored:
 *
 * 1. EL ANNEX A VIENE PARTIDO EN BLOQUES HORIZONTALES
 *
 *    It is not one table: it is several, each with the same key columns
 *    (Loan ID, Flag, Property Name) plus a different set of data.
 *
 *      block 1: Loan ID | Flag | Property Name | Type | Year | Units | Balance | Rate
 *      block 2: Loan ID | Flag | Property Name | EGI  | Expenses | NOI | DSCR | Debt Yield
 *
 *    Keeping only one loses half the metrics. They have to be joined by
 *    Loan ID.
 *
 * 2. THERE ARE LOAN ROWS AND PROPERTY ROWS
 *
 *      3.00  Loan      Soho Grand & The Roxy Hotel   2 propiedades
 *      3.01  Property  Soho Grand Hotel
 *      3.02  Property  Roxy Hotel
 *
 *    A loan over several properties generates one row per property. Treating
 *    each row as an independent deal triples the portfolio and counts the same
 *    balance twice.
 *
 * PENDING (not MVP): today we keep the loan rows and discard the property ones.
 * The right model would be the loan as a deal with N properties hanging off it,
 * which is exactly what the store already supports.
 */

import { mapColumns, type MetricKey } from "./columnMap.js";

export interface AnnexTable {
  name: string;
  rows: unknown[][];
  headerRowIndex: number;
}

/** Finds the column index of a metric within a table. */
function columnOf(headers: string[], key: MetricKey): number | null {
  const { matches } = mapColumns(headers);
  return matches.find((m) => m.metric.key === key)?.columnIndex ?? null;
}

function headersOf(table: AnnexTable): string[] {
  return (table.rows[table.headerRowIndex] ?? []).map((c) =>
    c === null || c === undefined ? "" : String(c),
  );
}

// ---------------------------------------------------------------------------
// Loan rows vs. property rows
// ---------------------------------------------------------------------------

export type RowKind = "loan" | "property" | "unknown";

export function classifyRow(value: unknown): RowKind {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "loan") return "loan";
  if (s === "property") return "property";
  return "unknown";
}

export interface FlagFilterResult {
  rows: unknown[][];
  loanRows: number;
  propertyRows: number;
  /**
   * The property rows, which until now were counted and thrown away.
   *
   * WHY THEY ARE RETURNED NOW
   *
   * Each one carries the name, address, city and state of ONE property securing
   * the loan. Measured over the three fixtures: 138 rows discarded, 138 with a
   * non-empty state. It is not residue, it is the data.
   *
   * Throwing them away left 585 loans with no state at all —those securing
   * properties in more than one— invisible to every /comps query. And it also
   * lost the addresses of the multi-property loans that DO have a stored state.
   *
   * They are returned raw and with their original row index. Whoever wants them
   * normalises them; whoever does not keeps reading `rows` as before.
   */
  droppedPropertyRows: Array<{ rowIndex: number; row: unknown[] }>;
  /** true if the table had a flag column; if not, everything was returned untouched. */
  hadFlagColumn: boolean;
  /** Rows discarded for not being loans: no property name and no balance. */
  phantomRows: number;
}

/**
 * Maximum share of rows the structural filter may discard before abstaining.
 *
 * If it exceeds this, the likeliest explanation is that the name and balance
 * columns are not where we think —not that 20% of the pool are phantom rows—
 * and silently deleting half an Annex A is worse than letting a few extra rows
 * through.
 */
const MAX_PHANTOM_SHARE = 0.15;

/**
 * Discards the rows that are not loans.
 *
 * WHY THE FLAG FILTER AND THE LOAN ID FILTER ARE NOT ENOUGH
 *
 * Both of those separate loans from properties. Neither detects a row that is
 * neither: in the conduit Annex A, the first row after the header often numbers
 * the columns (1, 2, 3...) and was entering as a loan. Seven appeared in the
 * 2026 cohort, with `property_type = "2"` — the column number read as a
 * property type.
 *
 * WHY STRUCTURAL AND NOT BY OBSERVATION COUNT
 *
 * `rowsToObservations` already discards rows with fewer than 3 observations, and
 * the 7 phantoms had exactly 3. Raising that threshold does not help: across the
 * corpus's 9,751 rows the distribution is continuous from 3 —there are rows at
 * 3, 4, 5, 6, 7, 9 and 10— so any cut by count removes real loans. The gap that
 * appeared to exist was an artefact of looking at 28 issuances out of 233.
 *
 * A loan has a property name or has a balance. A row with neither is not a
 * loan, whether it has 3 observations or 30.
 */
function dropPhantomRows(
  data: unknown[][],
  headers: string[],
): { kept: unknown[][]; dropped: number } {
  const nameCol = columnOf(headers, "property_name");
  const amountCol = columnOf(headers, "loan_amount");

  // Without either column there is nothing to decide on: everything is kept.
  if (nameCol === null && amountCol === null) return { kept: data, dropped: 0 };

  const tiene = (row: unknown[], col: number | null, conDigito: boolean) => {
    if (col === null) return false;
    const v = String(row?.[col] ?? "").trim();
    if (!v) return false;
    return conDigito ? /\d/.test(v) : true;
  };

  /**
   * SECOND CRITERION, NO THRESHOLDS: a row without a single letter is not a loan.
   *
   * The first —empty name and empty balance— was not enough. The row that
   * numbers the columns carries a number in EVERY cell, so the name cell is not
   * empty: it holds "5", that column's number. In the database it appeared with
   * an empty name because downstream a purely numeric name is rejected on write,
   * and that made me believe the cell came empty from the document.
   *
   * Worse: the test I wrote first used the correct shape —numbers in every
   * column— it failed, and instead of fixing the filter I adjusted the test to
   * match what the filter did. Green test, live bug. The two rows of BMO
   * 2026-5C15 survived the re-harvest and put it in plain sight.
   *
   * An Annex A loan has a property name, type, city, state: text in several
   * columns. A numbering row is all digits. No number has to be chosen to tell
   * them apart.
   */
  const sinLetras = (row: unknown[]) =>
    !row?.some((c) => /[a-zA-Z]/.test(String(c ?? "")));

  const kept: unknown[][] = [];
  const fantasma: unknown[][] = [];
  for (const row of data) {
    const pareceLoan = tiene(row, nameCol, false) || tiene(row, amountCol, true);
    if (pareceLoan && !sinLetras(row)) kept.push(row);
    else fantasma.push(row);
  }

  if (data.length > 0 && fantasma.length / data.length > MAX_PHANTOM_SHARE) {
    // Too many: it is the hypothesis about the columns that is wrong.
    return { kept: data, dropped: 0 };
  }
  return { kept, dropped: fantasma.length };
}

/**
 * Keeps only the loan rows.
 *
 * If the table has no flag column —old Annex A documents, or issuers that do not
 * publish it— it returns everything unchanged. We prefer too much data to data
 * silently lost.
 */
export function keepLoanRows(rows: unknown[][], headerRowIndex: number): FlagFilterResult {
  const headers = (rows[headerRowIndex] ?? []).map((c) =>
    c === null || c === undefined ? "" : String(c),
  );
  const flagCol = columnOf(headers, "loan_property_flag");

  if (flagCol === null) {
    // Without a flag column, the Loan ID itself separates loans from properties.
    return keepLoanRowsByLoanId(rows, headerRowIndex, headers);
  }

  const header = rows.slice(0, headerRowIndex + 1);
  const data = rows.slice(headerRowIndex + 1);

  /**
   * The structural filter runs BEFORE classifying, not after.
   *
   * The first version subtracted the phantoms from `loanRows`, but a row that is
   * not a loan does not have the flag column populated either, so it had never
   * been counted: the deduction subtracted something that was not added and
   * returned a count that was low by one.
   *
   * Filtering first, `loanRows` counts what is left and needs no correction.
   */
  const limpio = dropPhantomRows(data, headers);

  let loanRows = 0;
  let propertyRows = 0;
  const kept: unknown[][] = [];
  const droppedPropertyRows: FlagFilterResult["droppedPropertyRows"] = [];

  for (const [i, row] of limpio.kept.entries()) {
    const kind = classifyRow(row?.[flagCol]);
    if (kind === "property") {
      propertyRows++;
      droppedPropertyRows.push({ rowIndex: headerRowIndex + 1 + i, row });
      continue;
    }
    if (kind === "loan") loanRows++;
    kept.push(row);
  }

  return {
    rows: [...header, ...kept],
    loanRows,
    propertyRows,
    droppedPropertyRows,
    hadFlagColumn: true,
    phantomRows: limpio.dropped,
  };
}

/**
 * Separates loans from properties using the Loan ID numbering.
 *
 * DISCOVERED WHILE REVIEWING CORPUS INTEGRITY
 *
 * The "Loan / Property Flag" column is only mapped in 79% of filings. In the
 * rest, `keepLoanRows` kept every row and each property of a portfolio entered
 * as a loan: BANK5 2026-5YR23 appeared with 173 loans when it has 33.
 *
 * The symptom was arithmetic: 173 distinct IDs with a maximum of 33. That only
 * happens if the identifiers are decimals.
 *
 * The convention is consistent across issuers:
 *
 *   3.00  ← the loan
 *   3.01  ← first property securing it
 *   3.02  ← second
 *
 * So the decimal part is enough to filter on. Filings that number with integers
 * (1, 2, 3) all pass, which is the correct behaviour: there are no property rows
 * there.
 */
function keepLoanRowsByLoanId(
  rows: unknown[][],
  headerRowIndex: number,
  headers: string[],
): FlagFilterResult {
  const loanIdCol = columnOf(headers, "loan_id");
  const header = rows.slice(0, headerRowIndex + 1);
  const data = rows.slice(headerRowIndex + 1);

  if (loanIdCol === null) {
    // Without a flag or a Loan ID there is no way to tell a loan from a
    // property, but the structural filter still applies: a row with no name and
    // no balance is neither.
    const limpio = dropPhantomRows(data, headers);
    return {
      rows: [...rows.slice(0, headerRowIndex + 1), ...limpio.kept],
      loanRows: data.length - limpio.dropped,
      propertyRows: 0,
      droppedPropertyRows: [],
      hadFlagColumn: false,
      phantomRows: limpio.dropped,
    };
  }

  const limpio = dropPhantomRows(data, headers);

  let loanRows = 0;
  let propertyRows = 0;
  const kept: unknown[][] = [];
  const droppedPropertyRows: FlagFilterResult["droppedPropertyRows"] = [];

  for (const [i, row] of limpio.kept.entries()) {
    const raw = String(row?.[loanIdCol] ?? "").trim();
    const n = Number(raw);

    if (!raw || !Number.isFinite(n)) {
      // With no readable ID we cannot classify it; we keep it.
      kept.push(row);
      continue;
    }

    // Tolerance for floating-point noise: 3.00 can arrive as 2.9999999.
    const fractional = Math.abs(n - Math.round(n));
    if (fractional > 0.001) {
      propertyRows++;
      droppedPropertyRows.push({ rowIndex: headerRowIndex + 1 + i, row });
      continue;
    }

    loanRows++;
    kept.push(row);
  }

  return {
    rows: [...header, ...kept],
    loanRows,
    propertyRows,
    droppedPropertyRows,
      // It was filtered, though not by the flag column.
    hadFlagColumn: propertyRows > 0,
    phantomRows: limpio.dropped,
  };
}

// ---------------------------------------------------------------------------
// Joining horizontal blocks
// ---------------------------------------------------------------------------

export interface JoinResult {
  rows: unknown[][];
  headerRowIndex: number;
  tablesJoined: number;
  /** Names of the tables that were joined. */
  sources: string[];
  /** Tables discarded for having no Loan ID. */
  skipped: string[];
  /** How many page groups were stacked before joining. */
  stackedGroups?: number;
}

/**
 * Adopts the continuation tables, which do not repeat the header.
 *
 * DISCOVERED WITH REAL DATA, SECOND ROUND
 *
 * The Wells Fargo Annex A has 126 tables, but only 18 with recognisable headers.
 * The other 108 are continuations: the first page of each block carries the
 * headers and the following ones only data rows.
 *
 * Filtering by "has headers" discarded those 108 tables and with them most of
 * the pool. The first real run returned 7 loans.
 *
 * The heuristic for adopting them: the same number of columns as the last table
 * with a header, and appearing after it in the document. Column width is a
 * fairly reliable signature because each block has its own set.
 *
 * When in doubt it does not adopt: adding rows to the wrong block misaligns the
 * data, which is worse than losing it.
 */
export function attachContinuationTables(
  allTables: Array<{ name: string; rows: unknown[][] }>,
  detectHeader: (rows: unknown[][]) => { rowIndex: number; matchCount: number } | null,
): { tables: AnnexTable[]; adopted: number; orphans: number; rejected: number } {
  const result: AnnexTable[] = [];
  let current: AnnexTable | null = null;
  let currentWidth = 0;
  /** The current block's Loan ID column, if it has one. */
  let currentLoanIdCol: number | null = null;
  /** Last Loan ID seen, to check the continuation follows the series. */
  let lastLoanId = -Infinity;
  let adopted = 0;
  let orphans = 0;
  let rejected = 0;

  const widthOf = (rows: unknown[][]) => {
    // Representative width: the mode of the data rows, not the maximum, which
    // gets distorted by separator rows or footnotes.
    const counts = new Map<number, number>();
    for (const row of rows) {
      const w = row.filter((c) => c !== null && c !== undefined).length;
      if (w > 0) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    let best = 0;
    let bestCount = 0;
    for (const [w, c] of counts) {
      if (c > bestCount) {
        best = w;
        bestCount = c;
      }
    }
    return best;
  };

  for (const table of allTables) {
    const header = detectHeader(table.rows);

    if (header) {
      current = { name: table.name, rows: table.rows, headerRowIndex: header.rowIndex };
      currentWidth = widthOf(table.rows.slice(header.rowIndex + 1));

      const headers = (table.rows[header.rowIndex] ?? []).map((c) =>
        c === null || c === undefined ? "" : String(c),
      );
      currentLoanIdCol = columnOf(headers, "loan_id");
      lastLoanId = maxLoanId(table.rows.slice(header.rowIndex + 1), currentLoanIdCol);

      result.push(current);
      continue;
    }

    if (!current) {
      orphans++;
      continue;
    }

    const width = widthOf(table.rows);
    // One-column tolerance: real rows sometimes carry one cell more or less
    // because of colspan at the edges.
    const widthOk = currentWidth > 0 && Math.abs(width - currentWidth) <= 1;

    if (!widthOk) {
      orphans++;
      continue;
    }

    /**
     * Width alone is not enough validation.
     *
     * Two different blocks of the same Annex A can have the same number of
     * columns, and adopting the wrong one glues rows on with the data shifted:
     * the header says "Interest Rate %" but the values come from another column.
     *
     * It happened with real data. In BANK 2026-BNK52 rates of 480% appeared
     * —which were really amortisation terms of 480 months— and the filing
     * returned 165 loans when a typical pool has between 25 and 50.
     *
     * When the block has a Loan ID column, we require the continuation to carry
     * IDs that follow the series. It is a cheap check and hard to pass by
     * accident.
     */
    if (currentLoanIdCol !== null) {
      const ids = loanIdsOf(table.rows, currentLoanIdCol);

      if (ids.length === 0) {
        // With no recognisable IDs in the expected position, it is not a continuation.
        rejected++;
        continue;
      }

      const minId = Math.min(...ids);
      // Annex A documents number loans in increasing order. A legitimate
      // continuation starts where the previous page ended; if it starts below,
      // it is another block starting again from loan 1.
      if (Number.isFinite(lastLoanId) && minId <= lastLoanId) {
        rejected++;
        continue;
      }

      lastLoanId = Math.max(lastLoanId, ...ids);
    }

    current.rows.push(...table.rows);
    adopted++;
  }

  return { tables: result, adopted, orphans, rejected };
}

/** Numeric Loan IDs from a column. "3.00" and "3" are the same loan. */
function loanIdsOf(rows: unknown[][], col: number): number[] {
  const ids: number[] = [];
  for (const row of rows) {
    const raw = String(row?.[col] ?? "").trim();
    if (!raw) continue;
    const n = Number(raw);
    // Loan IDs are small positive numbers; a balance or a rate in that
    // position gives away that the table is not a continuation.
    if (Number.isFinite(n) && n > 0 && n < 10_000) ids.push(n);
  }
  return ids;
}

function maxLoanId(rows: unknown[][], col: number | null): number {
  if (col === null) return -Infinity;
  const ids = loanIdsOf(rows, col);
  return ids.length > 0 ? Math.max(...ids) : -Infinity;
}

/**
 * Vertically stacks the tables that are pages of the same block.
 *
 * DISCOVERED WITH REAL DATA
 *
 * An Annex A does not have one table per column block: it has one per PAGE. The
 * Wells Fargo 2025-C64 document carries 126 tables for about 40 loans, because
 * each column block repeats page after page with the same headers and different
 * rows.
 *
 * Without this step, each page is taken as a different column block and the
 * horizontal join crosses them by Loan ID, keeping only the loans that appear on
 * the first page of every block. On the first real run that gave 7 loans out of
 * a pool that has many more.
 *
 * The rule: identical headers → same logical table, stack them. Different
 * headers → different column blocks, join horizontally afterwards.
 */
export function stackPagedTables(tables: AnnexTable[]): {
  tables: AnnexTable[];
  groups: number;
} {
  const groups = new Map<string, AnnexTable[]>();

  for (const table of tables) {
    const key = headersOf(table)
      .map((h) => h.replace(/\s+/g, " ").trim().toLowerCase())
      .filter(Boolean)
      .join("|");
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(table);
    else groups.set(key, [table]);
  }

  const stacked: AnnexTable[] = [];

  for (const [, pages] of groups) {
    const first = pages[0]!;
    if (pages.length === 1) {
      stacked.push(first);
      continue;
    }

    const header = first.rows.slice(0, first.headerRowIndex + 1);
    const data: unknown[][] = [];
    for (const page of pages) {
      data.push(...page.rows.slice(page.headerRowIndex + 1));
    }

    stacked.push({
      name: `${first.name}+${pages.length - 1}`,
      rows: [...header, ...data],
      headerRowIndex: first.headerRowIndex,
    });
  }

  return { tables: stacked, groups: stacked.length };
}

/**
 * Joins the Annex A's horizontal blocks by Loan ID.
 *
 * It takes the table with the most metrics as the base and attaches the columns
 * of the others that share a Loan ID. Repeated columns (Flag, Property Name) are
 * added only once.
 *
 * If no table has a Loan ID, it returns the best one alone: without a key there
 * is no reliable way to join, and joining by position would be inventing data.
 */
export function joinAnnexTables(rawTables: AnnexTable[]): JoinResult | null {
  if (rawTables.length === 0) return null;

  // First we stack the pages of the same block; only then do we join different
  // blocks by Loan ID.
  const { tables, groups: stackedGroups } = stackPagedTables(rawTables);
  if (tables.length === 0) return null;

  const withKey = tables
    .map((table) => {
      const headers = headersOf(table);
      return { table, headers, loanIdCol: columnOf(headers, "loan_id") };
    })
    .filter((t) => t.table.rows.length > t.table.headerRowIndex + 1);

  if (withKey.length === 0) return null;

  const joinable = withKey.filter((t) => t.loanIdCol !== null);

  // No common key: the best table alone.
  if (joinable.length < 2) {
    const best = withKey
      .map((t) => ({ ...t, score: mapColumns(t.headers).matches.length }))
      .sort((a, b) => b.score - a.score)[0]!;
    return {
      rows: best.table.rows,
      headerRowIndex: best.table.headerRowIndex,
      tablesJoined: 1,
      sources: [best.table.name],
      skipped: withKey.filter((t) => t !== best).map((t) => t.table.name),
      stackedGroups,
    };
  }

  const scored = joinable
    .map((t) => ({ ...t, score: mapColumns(t.headers).matches.length }))
    .sort((a, b) => b.score - a.score);

  const base = scored[0]!;
  const baseHeaders = [...base.headers];
  const baseData = base.table.rows.slice(base.table.headerRowIndex + 1);

  // We index the base rows by Loan ID.
  const byLoanId = new Map<string, unknown[]>();
  for (const row of baseData) {
    const id = normalizeLoanId(row?.[base.loanIdCol!]);
    if (id) byLoanId.set(id, row);
  }

  const seenHeaders = new Set(baseHeaders.map((h) => h.trim().toLowerCase()).filter(Boolean));
  const sources = [base.table.name];
  const skipped: string[] = [];

  for (const other of scored.slice(1)) {
    const otherData = other.table.rows.slice(other.table.headerRowIndex + 1);

    // Which columns it contributes that the base does not have.
    const newCols = other.headers
      .map((h, i) => ({ header: h, index: i }))
      .filter((c) => {
        const key = c.header.trim().toLowerCase();
        return key && !seenHeaders.has(key);
      });

    if (newCols.length === 0) {
      skipped.push(other.table.name);
      continue;
    }

    // We check that the keys overlap before joining.
    let overlap = 0;
    for (const row of otherData) {
      const id = normalizeLoanId(row?.[other.loanIdCol!]);
      if (id && byLoanId.has(id)) overlap++;
    }
    if (overlap < Math.min(baseData.length, otherData.length) * 0.5) {
      skipped.push(other.table.name);
      continue;
    }

    const offset = baseHeaders.length;
    for (const c of newCols) {
      baseHeaders.push(c.header);
      seenHeaders.add(c.header.trim().toLowerCase());
    }

    for (const row of otherData) {
      const id = normalizeLoanId(row?.[other.loanIdCol!]);
      if (!id) continue;
      const target = byLoanId.get(id);
      if (!target) continue;
      newCols.forEach((c, j) => {
        target[offset + j] = row[c.index] ?? null;
      });
    }

    sources.push(other.table.name);
  }

  return {
    rows: [baseHeaders, ...baseData],
    headerRowIndex: 0,
    tablesJoined: sources.length,
    sources,
    skipped,
    stackedGroups,
  };
}

/** "3.00" and "3" are the same loan. */
function normalizeLoanId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n)) return String(n);
  return s.toLowerCase();
}

/**
 * Parser for the servicer's monthly report (EX-99.1 of the 10-D).
 *
 * WHAT IT EXTRACTS
 *
 * The table with post-closing loan-level NOI, which depending on the
 * administrator is called "Mortgage Loan Detail (Part 2)" or "NOI Detail". The
 * rest of the document —certificate waterfall, prepayments, specially serviced
 * loans— is bond information, not property information.
 *
 * The template families and their differences are documented next to `SCHEMAS`,
 * below. The short version: looking for a section name or a fixed column name is
 * not enough, because two administrators use the label "Loan ID" for different
 * things.
 *
 * DECISIONS THAT LOOK LIKE DETAILS AND ARE NOT
 *
 * 1. Preferimos "Most Recent NOI" sobre "Most Recent Fiscal NOI".
 *
 *    The fiscal one comes with no date: there is no way to know which year it
 *    covers, and comparing it against the underwritten NOI without knowing the
 *    period is comparing anything to anything. The "Most Recent" one carries NOI
 *    Start Date and NOI End Date, so it can be dated and annualised. We store
 *    both, but the one that enters the calculations is the dated one.
 *
 * 2. An NOI without dates does not exist, even if it carries a number.
 *
 *    Unreported rows come as "0.00" with "--" dates. If you read the column
 *    without looking at the dates, those zeros enter as zero NOI and sink any
 *    average. Here a value without a valid pair of dates is discarded, full
 *    stop. It is the same error as the Annex A's "N/A" values, which already
 *    cost us a whole iteration.
 *
 * 3. Annualising has a floor.
 *
 *    Periods run from a quarter to twelve months. Multiplying a quarter by four
 *    assumes the year is flat, which is false in hospitality and arguable
 *    everywhere else. We annualise anyway because discarding the quarters would
 *    lose too much sample, but every row is marked with its real day count so it
 *    can be filtered later. `MIN_PERIOD_DAYS` discards what is too short to mean
 *    anything.
 *
 * 4. Pari passu tranches are deduplicated.
 *
 *    1A-1, 1A-4 and 1A-5 are pieces of the same loan and each reports the whole
 *    property's NOI. Without deduplicating, that property weighs triple. The
 *    Pros ID normalised to its leading integer solves both at once: it
 *    identifies the Annex A loan and collapses the tranches.
 *
 *    If two tranches of the same loan report different NOIs, that is a real
 *    anomaly and gets recorded rather than resolved silently.
 */

import { extractFromHtml, type ExtractedTable } from "./tables.js";
import { normalizeProsId } from "../edgar/servicer.js";

/** Minimum period for an annualised NOI to mean anything. */
export const MIN_PERIOD_DAYS = 80;

/** The period we consider a "full year", needing no extrapolation. */
export const FULL_YEAR_MIN_DAYS = 300;

export interface ServicerLoanRow {
  /** Exactly as it comes in the report: "1A-1", "14A-3-C1", "27". */
  prosId: string;
  /** The Annex A's Loan ID: the leading integer of the Pros ID. */
  loanId: string | null;
  /** Last closed fiscal year. No date of its own: reference only. */
  fiscalNoi: number | null;
  /** NOI of the dated period. Raw, not annualised. */
  recentNoi: number | null;
  noiStart: string | null;
  noiEnd: string | null;
  periodDays: number | null;
  /** recentNoi taken to an annual basis. Null if the period is too short. */
  annualizedNoi: number | null;
  /** True if the period already covered a year: the value was not extrapolated. */
  isFullYear: boolean;
  sourceTable: string;
}

export interface ServicerLoanFact {
  loanId: string;
  annualizedNoi: number;
  noiStart: string;
  noiEnd: string;
  periodDays: number;
  isFullYear: boolean;
  /** How many tranches reported this loan. */
  tranches: number;
}

/**
 * A loan's payment status, from the "Delinquency Loan Detail" block.
 *
 * WHY THIS VARIABLE AND NOT NOI
 *
 * NOI growth is a ratio between two numbers with fat tails: its annual median
 * has a standard error of 2.4 points and no vintage in the corpus is
 * distinguishable from another (see `db:power`). Delinquency is not: it is a
 * count, and with ~400 loans per vintage the noise floor drops to ~3 percentage
 * points, over rates that move between 1% and 10%.
 *
 * TWO COLUMNS FOR THE SAME FACT
 *
 * `Months Delinquent` and `Paid Through Date` say the same thing by different
 * routes: the months of arrears should be approximately (period end − paid
 * through) / 30. Both are stored precisely so they can be checked against each
 * other, just like the Annex A identities. It is the verification we discovered
 * late over there and that is available here from the start.
 *
 * The severity ladder —transfer to special servicing, foreclosure, REO— gives
 * more resolution than a binary and does not depend on how each administrator
 * encodes `Mortgage Loan Status`, which is proprietary.
 */
export interface ServicerDelinquencyRow {
  prosId: string;
  loanId: string;
  paidThrough: string | null;
  monthsDelinquent: number | null;
  status: string | null;
  transferDate: string | null;
  foreclosureDate: string | null;
  reoDate: string | null;
}

/**
 * The "Specially Serviced Loan Detail" block, which is not the delinquency one.
 *
 * WHY THIS INTERFACE EXISTS
 *
 * The parser was taking `transfer_date` only from the delinquency block. But a
 * loan can be in special servicing while PAYING ON TIME, and then it does not
 * appear among the delinquent: it appears here.
 *
 * BANK 2021-BNK36 says "No delinquent loans this period" in the delinquency
 * block, and in this block it has Pros ID 71 —multifamily in Illinois,
 * transferred on 12/02/2025. The pipeline counted it as zero events.
 *
 * That was not a random error: if one shelf has loans that enter
 */
export interface ServicerSpecialRow {
  prosId: string;
  loanId: string;
  transferDate: string | null;
  resolutionCode: string | null;
  propertyType: string | null;
  state: string | null;
}

export interface ServicerParseResult {
  delinquency: ServicerDelinquencyRow[];
  /** Loans in special servicing, whether or not they are in arrears. */
  specialServicing: ServicerSpecialRow[];
  rows: ServicerLoanRow[];
  /** One record per loan, already deduplicated. */
  loans: ServicerLoanFact[];
  diagnostics: {
    tablesScanned: number;
    tablesMatched: number;
    /** Template families recognised in the document. */
    families: string[];
    rowsFound: number;
    /** Rows with a number but no dates: not reported. */
    droppedNoDates: number;
    /** Rows with a period below the floor. */
    droppedShortPeriod: number;
    /** Rows with no recognisable Pros ID. */
    droppedNoProsId: number;
    /** Loans whose tranches reported different NOIs. */
    trancheConflicts: Array<{ loanId: string; values: number[] }>;
    fullYearShare: number;

    /**
     * Three different causes produce zero delinquency rows, and until now all
     * three came out with the same message: "table not found in this format".
     * That made me treat as confirmed a parsing bug that may not exist —an
     * issuance with no delinquent loans produces exactly the same output.
     *
     *   delinquencyTables = 0  → the locator did not find the block: format
     *   data rows = 0          → the block is there but has only a header:
     *                            the issuance has no delinquent loans
     *   dropped > 0            → there were rows and the filters ate them
     *
     * It is the same error the code already documents for the NOI block. It
     * happened again in the block next door.
     */
    delinquencyTables: number;
    delinquencyDataRows: number;
    delinquencyDropped: number;
    /**
     * The first discarded identifiers, raw.
     *
     * "12 issuances discarded everything" does not say whether what was
     * discarded was prose —the "No delinquent loans this period" notice, the
     * code legends— or delinquent loans the filter ate. I verified ONE by hand
     * and it was prose; from that I concluded about eleven more without looking
     * at them.
     *
     * The raw value is the only thing that separates the two, and it is what
     * gave the instrument away on every round today.
     */
    delinquencyDroppedSamples: string[];

    /** Same breakdown for the specially serviced block. */
    specialTables: number;
    specialDataRows: number;
    /**
     * Loans that appear in special servicing and NOT among the delinquent.
     *
     * It is the direct measure of what the parser used to lose: if this number
     * is zero across every document, the new block contributed nothing; if it is
     * large and uneven between shelves, it was the explanation for the gap.
     */
    specialSoloAqui: number;
  };
  issues: string[];
}

// ---------------------------------------------------------------------------
// Locating the table and its columns
// ---------------------------------------------------------------------------

interface ColumnIndex {
  prosId: number;
  fiscalNoi: number;
  recentNoi: number;
  noiStart: number;
  noiEnd: number;
  headerRow: number;
  /** Which template family was recognised. */
  family: string;
}

const norm = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim();

/**
 * FAMILIAS DE PLANTILLA
 *
 * Just as with the Annex A, there is no single format: there are families per
 * administrator. The two we found publish the same datum under different names
 * and in different places, and one of them has a trap that breaks everything
 * silently.
 *
 * Computershare — "Mortgage Loan Detail (Part 2)" section:
 *
 *   | Pros ID | Most Recent Fiscal NOI | Most Recent NOI | NOI Start | NOI End |
 *
 * Citigroup — its own "NOI Detail" section:
 *
 *   | Loan ID   | OMCR | ... | Preceding Fiscal Year NOI | Most Recent NOI |
 *   | 328061001 |   1  | ...
 *
 * THE TRAP: in Citigroup the column called "Loan ID" is the servicer's internal
 * identifier —328061001— and the prospectus number is in "OMCR". It is inverted
 * relative to Computershare, where the prospectus column is called precisely
 * "Pros ID". Anchoring on the name "Loan ID" would produce a join that matches
 * nothing, and worse: it would do so without an error, returning zero matches as
 * if the trust simply did not report.
 *
 * That is why the anchor is a list of patterns per family and not a fixed name.
 */
interface HeaderSchema {
  family: string;
  /** The column containing the prospectus loan number. */
  anchor: RegExp;
  /** Previous closed fiscal year's NOI. Optional: not every family carries it. */
  fiscal?: RegExp;
  recent: RegExp;
  recentExclude?: RegExp;
  start: RegExp;
  end: RegExp;
}

const SCHEMAS: HeaderSchema[] = [
  {
    family: "computershare",
    anchor: /^pros\s*id$/i,
    fiscal: /most\s*recent\s*fiscal\s*noi/i,
    recent: /most\s*recent\s*noi/i,
    recentExclude: /fiscal|date/i,
    start: /noi\s*start/i,
    end: /noi\s*end/i,
  },
  {
    family: "citigroup",
    anchor: /^omcr$/i,
    fiscal: /preceding\s*fiscal\s*year\s*noi/i,
    recent: /most\s*recent\s*noi/i,
    recentExclude: /fiscal|preceding|date/i,
    // "Most Recent Financial As of Start Date" / "... Asof End Date" —
    // the filer writes "As of" and "Asof" in the same table.
    start: /most\s*recent\s*financial\s*as\s*of\s*start\s*date/i,
    end: /most\s*recent\s*financial\s*as\s*of\s*end\s*date/i,
  },
];

/**
 * The delinquency table, identified by "Months Delinquent".
 *
 * "Paid Through Date" alone is not enough as an anchor: it also appears in the
 * loan detail block (Part 1). The combination with "Months Delinquent" is unique
 * in the document.
 */
interface DelinquencyIndex {
  prosId: number; loanId: number; paidThrough: number; months: number;
  status: number; transfer: number; foreclosure: number; reo: number;
  headerRow: number;
}

function locateDelinquency(rows: unknown[][]): DelinquencyIndex | null {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const prosId = row.findIndex((c) => /^pros\s*id$/i.test(norm(c)));
    if (prosId === -1) continue;

    const width = Math.max(...rows.slice(Math.max(0, r - 2), r + 1).map((x) => x.length));
    const merged: string[] = [];
    for (let col = 0; col < width; col++) {
      const parts: string[] = [];
      for (let back = 2; back >= 0; back--) {
        const text = norm(rows[r - back]?.[col]);
        if (text && !parts.includes(text)) parts.push(text);
      }
      merged.push(parts.join(" "));
    }

    const at = (re: RegExp) => merged.findIndex((h) => re.test(h));
    const months = at(/months\s*delinquent/i);
    if (months === -1) continue;

    const paidThrough = at(/paid\s*through\s*date/i);
    if (paidThrough === -1) continue;

    return {
      prosId,
      loanId: at(/^loan\s*id$/i),
      paidThrough,
      months,
      status: at(/mortgage\s*loan\s*status/i),
      transfer: at(/servicing\s*transfer\s*date/i),
      foreclosure: at(/foreclosure\s*date/i),
      reo: at(/^reo\s*date$/i),
      headerRow: r,
    };
  }
  return null;
}

/**
 * The specially serviced block, which shares columns with the delinquency one
 * and is not the same.
 *
 * Both have `Servicing Transfer Date` and `Resolution Strategy Code`. What
 * separates them is that the delinquency one carries `Months Delinquent` and
 * this one does not, and that this one carries `Special Servicing Comments`.
 * Anchoring only on the transfer date would make the parser read the same table
 * twice and count every delinquent loan double.
 */
interface SpecialIndex {
  prosId: number; loanId: number; transfer: number;
  resolution: number; propertyType: number; state: number;
  headerRow: number;
}

function locateSpecialServicing(rows: unknown[][]): SpecialIndex | null {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const prosId = row.findIndex((c) => /^pros\s*id$/i.test(norm(c)));
    if (prosId === -1) continue;

    const width = Math.max(...rows.slice(Math.max(0, r - 2), r + 1).map((x) => x.length));
    const merged: string[] = [];
    for (let col = 0; col < width; col++) {
      const parts: string[] = [];
      for (let back = 2; back >= 0; back--) {
        const text = norm(rows[r - back]?.[col]);
        if (text && !parts.includes(text)) parts.push(text);
      }
      merged.push(parts.join(" "));
    }

    const at = (re: RegExp) => merged.findIndex((h) => re.test(h));

    // If it carries months of arrears it is the delinquency block, not this one.
    if (at(/months\s*delinquent/i) !== -1) continue;

    const transfer = at(/servicing\s*transfer\s*date/i);
    if (transfer === -1) continue;

    return {
      prosId,
      loanId: at(/^loan\s*id$/i),
      transfer,
      resolution: at(/resolution\s*strategy/i),
      propertyType: at(/property\s*type/i),
      state: at(/^state$/i),
      headerRow: r,
    };
  }
  return null;
}

/**
 * Resolves the header by anchoring on the "Pros ID" cell.
 *
 * The header cannot be assumed to be at the very top: the table starts with the
 * section title and blank rows. And it comes split across three rows, with the
 * words distributed so that none is understandable alone —"Most Recent" above,
 * "Fiscal NOI" below. That is why the two rows before the "Pros ID" one are
 * merged column by column.
 */
function locateColumns(rows: unknown[][]): ColumnIndex | null {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;

    for (const schema of SCHEMAS) {
      const anchorCol = row.findIndex((c) => schema.anchor.test(norm(c)));
      if (anchorCol === -1) continue;

      const width = Math.max(...rows.slice(Math.max(0, r - 2), r + 1).map((x) => x.length));
      const merged: string[] = [];
      for (let col = 0; col < width; col++) {
        const parts: string[] = [];
        for (let back = 2; back >= 0; back--) {
          const src = rows[r - back];
          if (!src) continue;
          const text = norm(src[col]);
          // Avoids repeating the same token when the row above drags it along.
          if (text && !parts.includes(text)) parts.push(text);
        }
        merged.push(parts.join(" "));
      }

      const find = (re: RegExp | undefined, exclude?: RegExp): number =>
        re === undefined ? -1 : merged.findIndex((h) => re.test(h) && !(exclude && exclude.test(h)));

      // "Most Recent NOI" also matches inside "Most Recent Fiscal NOI", so the
      // generic pattern explicitly excludes the specific one.
      const fiscalNoi = find(schema.fiscal);
      const recentNoi = find(schema.recent, schema.recentExclude);
      const noiStart = find(schema.start);
      const noiEnd = find(schema.end);

      if (recentNoi === -1 || noiStart === -1 || noiEnd === -1) continue;

      return {
        prosId: anchorCol,
        fiscalNoi,
        recentNoi,
        noiStart,
        noiEnd,
        headerRow: r,
        family: schema.family,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/** "21,466,533.53" → 21466533.53 · "--" → null · "(1,234)" → -1234 */
export function parseMoney(raw: unknown): number | null {
  const s = norm(raw);
  // "Not Available" is what Citigroup uses where Computershare puts "--".
  if (!s || /^(-{1,2}|—|n\/?a|nap|nav|not\s+(available|applicable))$/i.test(s)) return null;

  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * "03/31/26" → "2026-03-31".
 *
 * The reports use two-digit years. The pivot at 70 is the usual convention; for
 * CMBS there is no real ambiguity because no reports exist from before the
 * 1990s.
 */
export function parseShortDate(raw: unknown): string | null {
  const s = norm(raw);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!m) return null;

  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (m[3]!.length === 2) year += year < 70 ? 2000 : 1900;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Rejects impossible dates like 02/31.
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== day) return null;

  return iso;
}

function daysBetween(startIso: string, endIso: string): number {
  const a = Date.parse(`${startIso}T00:00:00Z`);
  const b = Date.parse(`${endIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

// ---------------------------------------------------------------------------
// Parser principal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Combining several months
// ---------------------------------------------------------------------------

/**
 * A single report is not enough, and the reason is the business, not the parser.
 *
 * Borrowers send the annual operating statement between 90 and 120 days after
 * the fiscal year closes. That makes the same loan appear differently depending
 * on when you look:
 *
 *   July 2026 report → NOI for the quarter 01/01 to 31/03 (needs extrapolating)
 *   May 2026 report  → NOI for the full year 2025 (needs nothing)
 *
 * And they do not all report at the same time: in any given report there are
 * loans with dates and loans with "--", and they are not always the same ones.
 * Looking across several months recovers coverage and yields more complete
 * periods.
 *
 * The selection criterion, in order: full year first, then longest period, and
 * on a tie the one ending latest. Different periods are never averaged —that
 * would mix a quarter with a year.
 */
export interface MergeConflict {
  loanId: string;
  /** Valor elegido y su origen. */
  chosen: number;
  chosenLabel: string;
  chosenDays: number;
  /** Conflicting value from another report. */
  other: number;
  otherLabel: string;
  otherDays: number;
  /** Ratio between the two, always ≥ 1. */
  ratio: number;
}

/** Beyond this, two observations of the same loan cannot both be true. */
export const CONFLICT_RATIO = 1.5;

/**
 * Why extrapolation became forbidden by default.
 *
 * The cross-check over Benchmark 2024-V7 found four loans with incompatible
 * observations, and all four have a partial period on one side:
 *
 *   loan  chosen           against          ratio
 *
 *   loan  chosen           against          ratio
 *   2     19.9M   365 days  11.7M   90 days  1.7x
 *   4     12.9M   365 days  53.1M  181 days  4.1x
 *   8      3.1M   365 days   5.4M   90 days  1.8x
 *   17    24.6M   181 days  11.1M   90 days  2.2x
 *
 * The first three have a full year to arbitrate. Number 17 does not: both values
 * are extrapolated and differ by 2.2x, so there is no way to know which is
 * right. That case is what decides the policy —with no anchor, choosing is
 * inventing.
 *
 * With the April report, 78% of loans carry a measured full year. It is
 */
export function mergeServicerReports(
  reports: Array<{ label: string; loans: ServicerLoanFact[] }>,
  opts: { requireFullYear?: boolean } = {},
): {
  loans: Array<ServicerLoanFact & { sourceLabel: string }>;
  perReport: Array<{ label: string; loans: number; fullYear: number; newLoans: number }>;
  /** Same loan with incompatible NOIs across reports. */
  conflicts: MergeConflict[];
  /** Loans left out for having no full-year measurement at all. */
  excludedExtrapolated: string[];
} {
  const requireFullYear = opts.requireFullYear ?? true;
  const best = new Map<string, ServicerLoanFact & { sourceLabel: string }>();
  const seen = new Map<string, Array<ServicerLoanFact & { sourceLabel: string }>>();
  const perReport: Array<{ label: string; loans: number; fullYear: number; newLoans: number }> = [];

  for (const report of reports) {
    let newLoans = 0;

    for (const loan of report.loans) {
      const tagged = { ...loan, sourceLabel: report.label };
      const history = seen.get(loan.loanId) ?? [];
      history.push(tagged);
      seen.set(loan.loanId, history);

      const current = best.get(loan.loanId);
      if (!current) {
        best.set(loan.loanId, tagged);
        newLoans++;
        continue;
      }

      const better =
        (loan.isFullYear && !current.isFullYear) ||
        (loan.isFullYear === current.isFullYear && loan.periodDays > current.periodDays) ||
        (loan.isFullYear === current.isFullYear &&
          loan.periodDays === current.periodDays &&
          loan.noiEnd > current.noiEnd);

      if (better) best.set(loan.loanId, tagged);
    }

    perReport.push({
      label: report.label,
      loans: report.loans.length,
      fullYear: report.loans.filter((l) => l.isFullYear).length,
      newLoans,
    });
  }

  /**
   * Cross-check between reports.
   *
   * The same loan appears month after month. If two annualised observations
   * differ by more than 50%, one of them is wrong —and the usual suspect is the
   * extrapolated one: a partial period that was not really partial, or a half
   * year with a non-recurring item inside.
   *
   * This turned up with real data. Benchmark 2024-V7, loan 4: the April report
   * gave 53.1M annualising a half year, and the July one gave 12.9M over twelve
   * measured months. Over an 821M trust the first would imply an absurd debt
   * yield. The lesson is not to discard extrapolation in general, but not to
   * believe it when there is a full-year measurement contradicting it.
   */
  const conflicts: MergeConflict[] = [];
  for (const [loanId, history] of seen) {
    const chosen = best.get(loanId)!;
    for (const other of history) {
      if (other.sourceLabel === chosen.sourceLabel) continue;
      const hi = Math.max(chosen.annualizedNoi, other.annualizedNoi);
      const lo = Math.min(chosen.annualizedNoi, other.annualizedNoi);
      if (lo <= 0) continue;
      const ratio = hi / lo;
      if (ratio < CONFLICT_RATIO) continue;

      conflicts.push({
        loanId,
        chosen: chosen.annualizedNoi,
        chosenLabel: chosen.sourceLabel,
        chosenDays: chosen.periodDays,
        other: other.annualizedNoi,
        otherLabel: other.sourceLabel,
        otherDays: other.periodDays,
        ratio,
      });
      break;
    }
  }

  let loans = [...best.values()].sort((a, b) => Number(a.loanId) - Number(b.loanId));

  const excludedExtrapolated: string[] = [];
  if (requireFullYear) {
    const kept: typeof loans = [];
    for (const loan of loans) {
      if (loan.isFullYear) kept.push(loan);
      else excludedExtrapolated.push(loan.loanId);
    }
    loans = kept;
  }

  return { loans, perReport, conflicts, excludedExtrapolated };
}

/** Page-footer rows that are not data. */
function isFooterRow(row: unknown[]): boolean {
  const first = norm(row[0]);
  if (/^totals?$/i.test(first)) return true;
  const joined = row.map(norm).join(" ");
  return /computershare|all rights reserved|page \d+ of \d+/i.test(joined);
}

/**
 * The headers of the tables the parser recognises, exactly as written.
 *
 * WHY IT EXISTS
 *
 * `locateColumns` looks for five columns —Pros ID, NOI, dates— and discards the
 * rest without looking. A servicer report carries considerably more: payment
 * status, days in arrears, transfer to special servicing, watchlist. We never
 * listed them because the parser did not need them.
 *
 * That is the same trap that already cost us twice on the Annex A: looking for
 * what you expect to find leaves you blind to what is there. Before writing a
 * parser for delinquency you have to see what those columns are called in each
 * administrator family, not guess.
 *
 * It returns the merged header —the three rows the format splits— for each
 * recognised table.
 */
export function describeServicerHeaders(
  tables: ExtractedTable[],
): Array<{ family: string; headerRow: number; headers: string[]; rows: unknown[][] }> {
  const out: Array<{
    family: string; headerRow: number; headers: string[]; rows: unknown[][];
  }> = [];

  for (const table of tables) {
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r]!;
      const schema = SCHEMAS.find((sc) => row.some((c) => sc.anchor.test(norm(c))));
      if (!schema) continue;

      const width = Math.max(
        ...table.rows.slice(Math.max(0, r - 2), r + 1).map((x) => x.length),
      );
      const headers: string[] = [];
      for (let col = 0; col < width; col++) {
        const parts: string[] = [];
        for (let back = 2; back >= 0; back--) {
          const src = table.rows[r - back];
          if (!src) continue;
          const text = norm(src[col]);
          if (text && !parts.includes(text)) parts.push(text);
        }
        headers.push(parts.join(" "));
      }

      // The rows of THIS table are returned: without them, anyone wanting to
      // look at the values has to guess which table the headers came from.
      out.push({ family: schema.family, headerRow: r, headers, rows: table.rows });
      break;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// The trust's parties, from the cover page
// ---------------------------------------------------------------------------

/**
 * Who administers the trust, according to the 10-D's first page.
 *
 * WHY IT MATTERS
 *
 * The SIR by issuer says BANK transfers to special servicing 4 times less than
 * BBCMS, adjusted for vintage and leverage profile. That survived five attacks.
 * But the SIR correlates 0.73 with NOI coverage, and we already know that
 * correlation CANNOT be causal: the numerator comes from the delinquency table,
 * which matches at 97.7% and does not depend on NOI.
 *
 * A real correlation with no mechanism needs a common cause, and there is one in
 * plain sight: the master servicer assembles BOTH tables. If one administrator
 * publishes NOI without a period and also lists fewer loans as delinquent, the
 * two move together without either causing the other.
 *
 * If that is it, "BANK underwrites better" is really "Trimont reports
 * differently", and the finding changes its subject.
 *
 * WHY THIS FUNCTION DOES NOT GUESS
 *
 * It also returns the raw row each value came from. Today I built four times on
 * an imagined layout and all four came out wrong; the raw value next to the
 * parsed value is the only thing that made it visible.
 */
export interface TrustParty {
  role: string;
  name: string;
  /** The document row it came from, so the parsing can be distrusted. */
  raw: string;
}

const ROLES: Array<[string, RegExp]> = [
  ["master servicer", /^master\s*servicer\b/i],
  ["special servicer", /^special\s*servicer\b/i],
  ["certificate administrator", /^certificate\s*administrator\b/i],
  ["trustee", /^trustee\b/i],
];

/**
 * An administrator's name is that of a legal entity.
 *
 * Without this filter, `"Return Date"` entered as the master servicer of a BMO
 * issuance: a role label appearing in a table that is not the cover page, with
 * the neighbouring cell taken as the name. It is the same bug as `"Trustee Fee"
 * → "Fee"`.
 *
 * Preferring a candidate with a corporate form is more robust than adding
 * exclusions one at a time, because it does not depend on anticipating which
 * spurious text will show up in the next format.
 */
const CORPORATE_FORM =
  /\b(LLC|L\.L\.C|N\.A\.?|National Association|Bank|Banc|Inc\.?|Incorporated|Company|Corp\.?|Corporation|Services|Servicing|Trust Co|LP|L\.P|Ltd|Advisors|Management|Capital)\b/i;

/**
 * Midland was appearing as five different strings —"a Division of PNC Bank,
 * National Association", ", N.A.", " N.A.", and bare— which are the same
 * entity. Any rate per administrator computed over that comes out split across
 * five small-n cells, which is exactly how you manufacture a result that looks
 * like noise.
 *
 * The canonical form is applied on write, not on query: if it lives in the SQL,
 * the next query someone writes does not have it.
 */
export function canonicalParty(name: string | null): string | null {
  if (!name) return null;
  const s = name.trim();
  if (/midland/i.test(s)) return "Midland Loan Services";
  if (/keybank/i.test(s)) return "KeyBank N.A.";
  if (/trimont/i.test(s)) return "Trimont LLC";
  if (/wells\s*fargo/i.test(s)) return "Wells Fargo Bank, N.A.";
  if (/computershare/i.test(s)) return "Computershare Trust Company, N.A.";
  if (/rialto/i.test(s)) return "Rialto Capital Advisors, LLC";
  if (/k-?star/i.test(s)) return "K-Star Asset Management LLC";
  if (/argentic/i.test(s)) return "Argentic Services Company LP";
  if (/lnr/i.test(s)) return "LNR Partners, LLC";
  if (/situs/i.test(s)) return "Situs Holdings, LLC";
  if (/greystone/i.test(s)) return "Greystone Servicing Company LLC";
  return s.replace(/[,\s]+$/, "");
}

export function extractParties(tables: ExtractedTable[]): TrustParty[] {
  const out: TrustParty[] = [];
  const seen = new Set<string>();

  for (const table of tables) {
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r]!;
      for (let c = 0; c < row.length; c++) {
        const label = norm(row[c]);
        if (!label) continue;

        /**
         * "Trustee Fee | 290.00" in the shortfalls table made the `trustee`
         * role come out with the name "Fee". The pattern's `\b` is not enough:
         * there are accounting rows whose label starts with the role's name.
         */
        if (/\b(fee|advance|reimburs|expense)/i.test(label)) continue;

        const hit = ROLES.find(([, re]) => re.test(label));
        if (!hit) continue;
        const [role] = hit;
        if (seen.has(role)) continue;

        /**
         * The value can be in the same cell ("Master Servicer / Trimont LLC"),
         * to the right, or in the row below. They are tried in that order and
         * anything clearly not a name is discarded: emails, phone numbers and
         * the label repeated.
         */
        const candidates: string[] = [];
        const rest = label.replace(ROLES.find(([n]) => n === role)![1], "").trim();
        if (rest) candidates.push(rest);
        for (let k = c + 1; k < row.length; k++) candidates.push(norm(row[k]));
        const below = table.rows[r + 1];
        if (below) candidates.push(norm(below[c]));

        const cleaned = candidates
          .map((s) => s.replace(/^[\/:\-–\s]+/, "").trim())
          .filter(
            (s) =>
              s.length > 2 &&
              !/@|https?:|^\(?\d{3}\)?[\s.-]?\d{3}/.test(s) &&
              !ROLES.some(([, re]) => re.test(s)),
          );

        /**
         * Corporate form first. If none has it, it does NOT fall back to the
         * first candidate: the role is left unresolved. A `(no data)` is a
         * visible absence; `"Return Date"` is a false answer that slips into the
         * cross-tab and makes it look cleaner than it is.
         */
        const name = cleaned.find((s) => CORPORATE_FORM.test(s));
        if (!name) continue;
        seen.add(role);
        out.push({
          role: role,
          name: (canonicalParty(name) ?? name).slice(0, 80),
          raw: row.map((x) => norm(x)).filter(Boolean).join(" | ").slice(0, 120),
        });
      }
    }
  }

  return out;
}

export function parseServicerReport(html: string): ServicerParseResult {
  const tables = extractFromHtml(html, { mergeHeaders: false, minRows: 2 });
  return parseServicerTables(tables);
}

export function parseServicerTables(tables: ExtractedTable[]): ServicerParseResult {
  const rows: ServicerLoanRow[] = [];
  const issues: string[] = [];

  let tablesMatched = 0;
  const families = new Set<string>();
  let droppedNoDates = 0;
  let droppedShortPeriod = 0;
  let droppedNoProsId = 0;

  /**
   * The delinquency table is walked in the same pass.
   *
   * It is a different block from the NOI one —it shares neither columns nor
   * header row— so it cannot be resolved with the same locator. It is joined
   * afterwards by Pros ID, just as the Annex A's horizontal blocks are joined.
   */
  const delinquency: ServicerDelinquencyRow[] = [];
  let delinquencyTables = 0;
  let delinquencyDataRows = 0;
  let delinquencyDropped = 0;
  const delinquencyDroppedSamples: string[] = [];
  const sample = (raw: string) => {
    if (delinquencyDroppedSamples.length < 3) {
      delinquencyDroppedSamples.push(raw.slice(0, 60));
    }
  };
  for (const table of tables) {
    const delinq = locateDelinquency(table.rows);
    if (!delinq) continue;
    delinquencyTables++;

    for (let r = delinq.headerRow + 1; r < table.rows.length; r++) {
      const row = table.rows[r]!;
      if (isFooterRow(row)) continue;

      const prosId = norm(row[delinq.prosId]);
      if (!prosId) continue;
      delinquencyDataRows++;

      /**
       * Footnotes come in through the identifier's door.
       *
       * The column is titled "Mortgage Loan Status¹" and at the end of the table
       * the document explains the superscript with a row starting at "1". That
       * row has a number in its first cell, so `normalizeProsId` accepts it and
       * it appears as a loan.
       *
       * In Benchmark 2024-V7 it was the ONLY row: the deal has no delinquent
       * loans and the parser reported one. A count called it healthy; the raw
       * value —"1 Mortgage Loan Status"— gave it away.
       *
       * A Pros ID is a number with at most a short tranche suffix (12A,
       * 5-B). Two letters in a row is prose.
       */
      if (/[a-z]{2,}/i.test(prosId)) {
        delinquencyDropped++;
        sample(prosId);
        continue;
      }

      const loanId = normalizeProsId(prosId);
      if (!loanId) {
        delinquencyDropped++;
        sample(prosId);
        continue;
      }

      const cell = (i: number) => (i === -1 ? null : norm(row[i]) || null);
      const months = parseMoney(row[delinq.months]);

      delinquency.push({
        prosId,
        loanId,
        paidThrough: parseShortDate(row[delinq.paidThrough]),
        monthsDelinquent: months,
        status: cell(delinq.status),
        transferDate: delinq.transfer === -1 ? null : parseShortDate(row[delinq.transfer]),
        foreclosureDate:
          delinq.foreclosure === -1 ? null : parseShortDate(row[delinq.foreclosure]),
        reoDate: delinq.reo === -1 ? null : parseShortDate(row[delinq.reo]),
      });
    }
  }

  /**
   * Second pass: the specially serviced loans.
   *
   * It goes after the delinquency block on purpose, because it needs to know
   * which loans were already counted there in order to report how many appear
   * ONLY here —which is the measure of what the parser used to lose.
   */
  const specialServicing: ServicerSpecialRow[] = [];
  let specialTables = 0;
  let specialDataRows = 0;
  let specialSoloAqui = 0;
  const yaMorosos = new Set(delinquency.map((d) => d.loanId));

  for (const table of tables) {
    const esp = locateSpecialServicing(table.rows);
    if (!esp) continue;
    specialTables++;

    for (let r = esp.headerRow + 1; r < table.rows.length; r++) {
      const row = table.rows[r]!;
      if (isFooterRow(row)) continue;

      const prosId = norm(row[esp.prosId]);
      if (!prosId) continue;
      specialDataRows++;

      // Same guard as in delinquency: two letters in a row is prose, not an ID.
      if (/[a-z]{2,}/i.test(prosId)) continue;
      const loanId = normalizeProsId(prosId);
      if (!loanId) continue;

      const cell = (i: number) => (i === -1 ? null : norm(row[i]) || null);
      const transferDate =
        esp.transfer === -1 ? null : parseShortDate(row[esp.transfer]);

      /**
       * Without a transfer date the row does not carry the event we are after.
       * It may be a continuation row or an already-resolved loan.
       */
      if (!transferDate) continue;

      if (!yaMorosos.has(loanId)) specialSoloAqui++;

      specialServicing.push({
        prosId,
        loanId,
        transferDate,
        resolutionCode: cell(esp.resolution),
        propertyType: cell(esp.propertyType),
        state: cell(esp.state),
      });
    }
  }

  for (const table of tables) {
    const cols = locateColumns(table.rows);
    if (!cols) continue;
    tablesMatched++;
    families.add(cols.family);

    for (let r = cols.headerRow + 1; r < table.rows.length; r++) {
      const row = table.rows[r]!;
      if (isFooterRow(row)) continue;

      const prosId = norm(row[cols.prosId]);
      if (!prosId) continue;

      const loanId = normalizeProsId(prosId);
      if (!loanId) {
        droppedNoProsId++;
        continue;
      }

      const fiscalNoi = cols.fiscalNoi === -1 ? null : parseMoney(row[cols.fiscalNoi]);
      const recentNoiRaw = parseMoney(row[cols.recentNoi]);
      const noiStart = parseShortDate(row[cols.noiStart]);
      const noiEnd = parseShortDate(row[cols.noiEnd]);

      let periodDays: number | null = null;
      let annualizedNoi: number | null = null;
      let isFullYear = false;

      // A value without a pair of dates is "not reported", not an NOI of zero.
      if (recentNoiRaw !== null && noiStart && noiEnd) {
        periodDays = daysBetween(noiStart, noiEnd);
        if (periodDays >= MIN_PERIOD_DAYS) {
          isFullYear = periodDays >= FULL_YEAR_MIN_DAYS;
          annualizedNoi = isFullYear ? recentNoiRaw : (recentNoiRaw * 365) / periodDays;
        } else {
          droppedShortPeriod++;
        }
      } else if (recentNoiRaw !== null) {
        droppedNoDates++;
      }

      rows.push({
        prosId,
        loanId,
        fiscalNoi,
        recentNoi: recentNoiRaw,
        noiStart,
        noiEnd,
        periodDays,
        annualizedNoi,
        isFullYear,
        sourceTable: table.name,
      });
    }
  }

  // --- tranche deduplication ----------------------------------------------

  const byLoan = new Map<string, ServicerLoanRow[]>();
  for (const row of rows) {
    if (!row.loanId || row.annualizedNoi === null) continue;
    const list = byLoan.get(row.loanId) ?? [];
    list.push(row);
    byLoan.set(row.loanId, list);
  }

  const loans: ServicerLoanFact[] = [];
  const trancheConflicts: Array<{ loanId: string; values: number[] }> = [];

  for (const [loanId, group] of byLoan) {
    const distinct = [...new Set(group.map((g) => Math.round(g.annualizedNoi!)))];
    if (distinct.length > 1) {
      // Tranches of the same loan should carry the NOI of the same property.
      // Differing means the Pros ID normalisation joined loans that do not
      // belong together, or that the servicer reported inconsistently.
      trancheConflicts.push({ loanId, values: distinct });
      continue;
    }

    // On a tie the longer period is preferred: less extrapolation.
    const best = group.reduce((a, b) => ((b.periodDays ?? 0) > (a.periodDays ?? 0) ? b : a));
    loans.push({
      loanId,
      annualizedNoi: best.annualizedNoi!,
      noiStart: best.noiStart!,
      noiEnd: best.noiEnd!,
      periodDays: best.periodDays!,
      isFullYear: best.isFullYear,
      tranches: group.length,
    });
  }

  loans.sort((a, b) => Number(a.loanId) - Number(b.loanId));

  const fullYear = loans.filter((l) => l.isFullYear).length;
  const fullYearShare = loans.length ? fullYear / loans.length : 0;

  if (tablesMatched === 0) {
    issues.push(
      'The "Mortgage Loan Detail (Part 2)" table was not found. ' +
        "It may be another format family: review the document by hand.",
    );
  }
  if (loans.length === 0 && tablesMatched > 0) {
    issues.push(
      `The table was located but no loan was left with a usable NOI ` +
        `(${droppedNoDates} with no dates, ${droppedShortPeriod} with a short period).`,
    );
  }
  if (trancheConflicts.length > 0) {
    issues.push(
      `${trancheConflicts.length} loan(s) with tranches reporting different NOIs: ` +
        trancheConflicts.slice(0, 3).map((c) => c.loanId).join(", "),
    );
  }
  /**
   * That most values come extrapolated is not a defect of the parser but of the
   * month chosen: a July report covers the current quarter, and a March or April
   * one usually carries the previous full fiscal year. If this warning appears
   * repeatedly, the fix is to change which filing is harvested, not to tolerate
   * the extrapolation.
   */
  if (loans.length > 0 && fullYearShare < 0.5) {
    issues.push(
      `Only ${(fullYearShare * 100).toFixed(0)}% of loans carry a full year. ` +
        "The rest were annualised from partial periods: try a filing from another month.",
    );
  }

  return {
    delinquency,
    specialServicing,
    rows,
    loans,
    diagnostics: {
      tablesScanned: tables.length,
      tablesMatched,
      families: [...families],
      rowsFound: rows.length,
      droppedNoDates,
      droppedShortPeriod,
      droppedNoProsId,
      delinquencyTables,
      delinquencyDataRows,
      delinquencyDropped,
      delinquencyDroppedSamples,
      specialTables,
      specialDataRows,
      specialSoloAqui,
      trancheConflicts,
      fullYearShare,
    },
    issues,
  };
}

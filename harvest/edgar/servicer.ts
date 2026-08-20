/**
 * Servicer report (10-D) discovery on EDGAR.
 *
 * WHAT THIS IS AND WHY IT MATTERS
 *
 * Everything harvested so far comes from the Annex A, which is a snapshot at
 * closing: it says what the underwriter promised. It never says what happened
 * afterwards. With that you can measure how far underwriting departed from the
 * trailing figures, but not whether it was wrong.
 *
 * The 10-D is the periodic report CMBS trusts file every month. Its EX-99.1 is
 * the certificate administrator's report, and inside it is a table called
 * "Mortgage Loan Detail (Part 2)" with post-closing loan-level NOI. That is what
 * Griffin measures.
 *
 * WHAT THE REAL DATA SHOWED
 *
 * Benchmark 2024-V7 (CIK 2016841), 10-D from July 2026, EX-99.1:
 *
 *   | Pros ID | Most Recent Fiscal NOI | Most Recent NOI | NOI Start | NOI End |
 *   | 1A-1    |          21,466,533.53 |    6,590,191.56 | 01/01/26  | 03/31/26 |
 *   | 4A-2    |          12,379,213.40 |   12,854,060.24 | 04/01/25  | 03/31/26 |
 *   | 5       |           5,065,434.64 |            0.00 |    --     |    --    |
 *
 * Four traps, all visible in those three rows:
 *
 *   1. "Most Recent NOI" is NOT annualised. Row 1A-1 covers a quarter (01/01 to
 *      31/03) and 4A-2 covers twelve months. Without looking at the dates,
 *      comparing those two numbers is comparing a quarter against a year.
 *
 *   2. 0.00 with "--" dates means NOT REPORTED, not zero NOI. Taking it as zero
 *      sinks any average. It is the same error as the "N/A" columns in the
 *      Annex A.
 *
 *   3. Pari passu tranches repeat. 1A-1, 1A-4 and 1A-5 are tranches of the same
 *      loan and carry the whole property's NOI, repeated. Summing without
 *      deduplicating counts the same property three times —in fact the report's
 *      "Fiscal NOI" total gives 438M against an 821M trust, which would be a
 *      debt yield of 53% if you believed it.
 *
 *   4. "Most Recent Fiscal NOI" has no date column of its own. There is no way
 *      to know which fiscal year it covers. That is why we prefer "Most Recent
 *      NOI", which is dated, even though it has to be annualised.
 *
 * The "Pros ID" is the loan number from the prospectus, that is, the Annex A's
 * Loan ID with a tranche suffix. That is the join key that makes all of this
 * possible.
 *
 * FORMATO
 *
 * The two trusts we inspected —Benchmark 2024-V7 and BANK5 2024-5YR5— use the
 * same Computershare template, 27 pages, with "Mortgage Loan Detail (Part 2)" on
 * page 16. We do not assume it is universal: just as with the Annex A, there
 * will be format families. That is why the table is located by header content
 * and not by position.
 */

import { fetchJson, type FetchOptions } from "./client.js";
import { archiveBase } from "./discover.js";

const SUBMISSIONS = "https://data.sec.gov/submissions";

export interface ServicerReportRef {
  cik: string;
  accession: string;
  companyName: string;
  /** The 10-D's filing date. */
  filedAt: string;
  /** The period being reported (distribution date). */
  periodOfReport: string;
  /** The EX-99.1 document with the servicer's report. */
  documentName: string;
  documentUrl: string;
  sizeBytes: number;
}

interface SubmissionsResponse {
  name?: string;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      form?: string[];
      filingDate?: string[];
      reportDate?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
      size?: number[];
    };
  };
}

/** A filing's file listing, to locate the exhibit. */
interface DirectoryListing {
  directory?: {
    item?: Array<{ name?: string; size?: string; type?: string }>;
  };
}

/**
 * Scores a filing's file as a servicer report candidate.
 *
 * The name is the primary signal, just as with the Annex A. Filers use
 * "ex991", "ex-99_1" and "ex99-1" interchangeably.
 */
export function scoreServicerExhibit(f: { name: string; sizeBytes: number }): number {
  const name = f.name.toLowerCase();

  if (!/\.(htm|html|txt)$/.test(name)) return 0;
  // The 10-D's main document is the cover page, not the report.
  if (/_10-?d[-_.]/.test(name)) return 0;

  let score = 0;
  if (/ex-?99[._-]?1(?![0-9])/.test(name)) score += 0.6;
  else if (/ex-?99/.test(name)) score += 0.4;
  else if (/exh?[-_]?99/.test(name)) score += 0.35;

  if (score === 0) return 0;

  // A complete monthly report weighs tens of KB. The compliance certificates
  // that also go out as EX-99 are small.
  if (f.sizeBytes > 200_000) score += 0.3;
  else if (f.sizeBytes > 40_000) score += 0.2;
  else if (f.sizeBytes < 8_000) score -= 0.3;

  return Math.max(0, Math.min(1, score));
}

/**
 * Finds a trust's 10-D filings and locates each one's EX-99.1.
 *
 * The submissions API gives the 10-D but not its exhibits, so each filing's
 * index has to be requested. To avoid spending one request per month of the
 * trust's life, `pickMonths` selects first and only then resolves the exhibits
 * of the chosen ones.
 */
export async function findServicerReports(
  cik: string,
  opts: {
    /** Only filings submitted from this date onwards (YYYY-MM-DD). */
    since?: string;
    /** How many reports to resolve. Default 1. */
    max?: number;
    /**
     * Preferred months (1-12), in order. Filings whose period falls in the first
     * of the list are resolved before the rest.
     *
     * This comes from the data, not from intuition. Over Benchmark 2024-V7 we
     * measured how many loans carry a full-year NOI by report month:
     *
     *   febrero  8 · marzo 12 · ABRIL 21 · mayo 0 · junio 1 · julio 2
     *
     * The reason is the accounting cycle: borrowers deliver the annual
     * operating statement between 90 and 120 days after the fiscal year closes,
     * so by April it is consolidated. In May the servicer blanks the fields to
     * start the new cycle —34 rows, none with dates— and from then on there are
     * only partials of the current year.
     *
     * Downloading six months per trust does not pay off: April alone already
     * brings 21 of the 22 full years that combining everything gives.
     */
    preferMonths?: number[];
    minScore?: number;
    /**
     * Temporal sampling: instead of preferring April, take one report every N
     * months going back from the most recent.
     *
     * WHY IT EXISTS
     *
     * The default ordering works for NOI, where April is the only month that
     * carries closed fiscal years. For delinquency it is the opposite: what
     * matters is the history, because the 10-D's table lists the loans that are
     * in special servicing TODAY and loses those that entered and were resolved.
     *
     * A loan that transferred in 2022 and was resolved in 2023 is invisible in
     * the 2026 report, but appears in those months' reports with its
     * `transfer_date`. Since a case usually stays six months or more in special
     * servicing, sampling every six months catches almost all of them without
     * downloading each trust's sixty reports.
     */
    everyMonths?: number;
    fetchOpts?: FetchOptions;
  } = {},
): Promise<ServicerReportRef[]> {
  const max = opts.max ?? 1;
  const preferMonths = opts.preferMonths ?? [4, 3, 5, 2];
  const minScore = opts.minScore ?? 0.5;
  const padded = String(Number(cik)).padStart(10, "0");

  const data = await fetchJson<SubmissionsResponse>(
    `${SUBMISSIONS}/CIK${padded}.json`,
    opts.fetchOpts,
  );

  const recent = data.filings?.recent;
  if (!recent?.accessionNumber) return [];

  const companyName = data.name ?? "(desconocido)";
  const candidates: Array<{
    accession: string; filedAt: string; periodOfReport: string;
  }> = [];

  for (let i = 0; i < recent.accessionNumber.length; i++) {
    // 10-D/A are corrections; they are accepted because they usually replace bad data.
    if (!/^10-D/.test(recent.form?.[i] ?? "")) continue;

    const filedAt = recent.filingDate?.[i] ?? "";
    if (opts.since && filedAt < opts.since) continue;

    candidates.push({
      accession: recent.accessionNumber[i]!,
      filedAt,
      periodOfReport: recent.reportDate?.[i] ?? "",
    });
  }

  /**
   * Order: month preference first, then most recent.
   *
   * An April report from this year is worth more than one from April of the
   * previous year, and both are worth more than any July.
   */
  const monthRank = (periodOrFiled: string): number => {
    const m = Number(periodOrFiled.slice(5, 7));
    const idx = preferMonths.indexOf(m);
    return idx === -1 ? preferMonths.length : idx;
  };

  if (opts.everyMonths && opts.everyMonths > 0) {
    /**
     * Chronological descending, then one every N months.
     *
     * The filter is by real distance between periods, not "one out of every N in
     * the list": trusts do not publish every month and counting positions would
     * give different spacings depending on how many reports are missing.
     */
    candidates.sort((a, b) =>
      (b.periodOfReport || b.filedAt).localeCompare(a.periodOfReport || a.filedAt),
    );
    const spaced: typeof candidates = [];
    let last: Date | null = null;
    for (const c of candidates) {
      const f = new Date(c.periodOfReport || c.filedAt);
      if (Number.isNaN(f.getTime())) continue;
      if (
        last === null ||
        (last.getTime() - f.getTime()) / 86_400_000 >= opts.everyMonths * 30.44 - 10
      ) {
        spaced.push(c);
        last = f;
      }
    }
    candidates.length = 0;
    candidates.push(...spaced);
  } else {
    candidates.sort((a, b) => {
      const ra = monthRank(a.periodOfReport || a.filedAt);
      const rb = monthRank(b.periodOfReport || b.filedAt);
      if (ra !== rb) return ra - rb;
      return b.filedAt.localeCompare(a.filedAt);
    });
  }

  const picks: ServicerReportRef[] = [];
  for (const c of candidates) {
    if (picks.length >= max) break;

    const base = archiveBase(cik, c.accession);
    let listing: DirectoryListing;
    try {
      listing = await fetchJson<DirectoryListing>(`${base}/index.json`, opts.fetchOpts);
    } catch {
      continue;
    }

    const items = listing.directory?.item ?? [];
    let best: { name: string; sizeBytes: number; score: number } | null = null;
    for (const item of items) {
      const name = item.name ?? "";
      const sizeBytes = Number(item.size ?? 0);
      const score = scoreServicerExhibit({ name, sizeBytes });
      if (score >= minScore && (!best || score > best.score)) {
        best = { name, sizeBytes, score };
      }
    }

    if (!best) continue;

    picks.push({
      cik: String(Number(cik)),
      accession: c.accession,
      companyName,
      filedAt: c.filedAt,
      periodOfReport: c.periodOfReport,
      documentName: best.name,
      documentUrl: `${base}/${best.name}`,
      sizeBytes: best.sizeBytes,
    });
  }

  return picks;
}

/**
 * Normalises a servicer "Pros ID" to the Annex A's Loan ID.
 *
 *   "1A-1"      → "1"     (pari passu tranche of loan 1)
 *   "14A-3-C1"  → "14"
 *   "20A-1-3"   → "20"
 *   "27"        → "27"
 *
 * The Annex A numbers loans with integers; the servicer adds the tranche
 * suffix. Since the tranches of the same loan report the whole property's NOI
 * repeated, keeping the leading integer also deduplicates.
 */
export function normalizeProsId(prosId: string): string | null {
  const m = /^\s*(\d+)/.exec(prosId);
  return m ? m[1]! : null;
}

/** True if the Pros ID carries a tranche suffix (that is, there is pari passu). */
export function hasTrancheSuffix(prosId: string): boolean {
  return /^\s*\d+\s*[A-Za-z-]/.test(prosId);
}

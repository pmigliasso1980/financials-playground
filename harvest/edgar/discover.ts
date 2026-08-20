/**
 * Annex A discovery on EDGAR.
 *
 * HOW THIS DESIGN WAS ARRIVED AT
 *
 * The first version looked for .xlsx attachments inside the prospectus, because
 * 2000s-era CMBS filings published the Annex A as an Excel spreadsheet. Against
 * modern filings that returns zero: today the Annex A is a **FWP filing of its
 * own** whose main document is a multi-MB .htm full of tables.
 *
 * Ejemplo real (Wells Fargo Commercial Mortgage Trust 2025-C64, CIK 2053102):
 *
 *   accession 0001539497-25-000290
 *   form      FWP
 *   documento n4801_x5-annexa1.htm
 *   description "ANNEX A-1"
 *   size        4,088,848 bytes
 *
 * The other FWPs in the same deal weigh between 8 KB and 25 KB. Size is the most
 * reliable signal, because the name and the description vary between issuers.
 *
 * That is why discovery goes through the submissions API (data.sec.gov), which
 * returns the form, document, description and size of every filing — everything
 * needed to choose, without downloading anything.
 */

import { fetchJson, type FetchOptions } from "./client.js";

const SUBMISSIONS = "https://data.sec.gov/submissions";
const FTS = "https://efts.sec.gov/LATEST/search-index";

export interface FilingRef {
  cik: string;
  accession: string;
  companyName: string;
  formType: string;
  filedAt: string;
  /** The filing's main document. */
  documentName: string;
  documentDescription: string;
  sizeBytes: number;
  /** URL directa al documento. */
  documentUrl: string;
  baseUrl: string;
}

export function archiveBase(cik: string, accession: string): string {
  const bare = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}`;
}

// ---------------------------------------------------------------------------
// Step 1: find CMBS trusts
// ---------------------------------------------------------------------------

interface FtsResponse {
  hits?: {
    hits?: Array<{
      _id?: string;
      _source?: { ciks?: string[]; display_names?: string[] };
    }>;
  };
}

/**
 * Searches for CMBS trust CIKs by full text.
 *
 * Returns unique CIKs, not filings: the correct filing is chosen later with the
 * submissions API, which gives much more information.
 */
export async function findCmbsTrusts(opts: {
  query?: string;
  limit?: number;
  /** Date window, to reach older issuances. */
  dateFrom?: string;
  dateTo?: string;
  fetchOpts?: FetchOptions;
} = {}): Promise<Array<{ cik: string; name: string }>> {
  const query = opts.query ?? '"Commercial Mortgage Trust"';
  const limit = opts.limit ?? 10;

  const seen = new Map<string, string>();

  /**
   * EDGAR's search returns 10 results per page. To gather dozens of trusts you
   * have to paginate with `from`.
   *
   * The cap of 100 is not arbitrary: EDGAR cuts off there for a single query.
   * To go further you have to vary the query or the date window, which is what
   * the batch command does.
   */
  const MAX_OFFSET = 100;
  const PAGE = 10;

  for (let from = 0; from < MAX_OFFSET && seen.size < limit; from += PAGE) {
    const params = new URLSearchParams({ q: query, forms: "FWP" });
    if (from > 0) params.set("from", String(from));
    if (opts.dateFrom) params.set("startdt", opts.dateFrom);
    if (opts.dateTo) params.set("enddt", opts.dateTo);

    let data: FtsResponse;
    try {
      data = await fetchJson<FtsResponse>(`${FTS}?${params.toString()}`, opts.fetchOpts);
    } catch (err) {
      /**
       * A page that fails halfway does not invalidate the previous ones: we
       * keep what we gathered. But if the FIRST one fails there is nothing, and
       * returning an empty list turns a rejection from the SEC into something
       * indistinguishable from "no trusts exist".
       *
       * That actually happened: after several consecutive batch runs, EDGAR
       * started rejecting and the batch reported "Found 0 of 100", which sends
       * you to check the query when the problem is the rate limit. A failure
       * that looks identical to an absence is the worst kind of failure, and it
       * is the same error that already cost us iterations on the data side.
       */
      if (seen.size === 0) {
        /**
         * The error propagates as-is, with no diagnosis added.
         *
         * The first version of this attached a paragraph explaining the SEC's
         * request limit, because that was my hypothesis. The real cause was
         * something else —SEC_USER_AGENT was missing— and the true message was
         * buried under my conjecture, repeated fifteen times.
         *
         * An error that already explains itself does not need help. Guessing
         * the cause in the message is worse than saying nothing: it sends you
         * looking where the problem is not.
         */
        throw err;
      }
      break;
    }

    const hits = data.hits?.hits ?? [];
    if (hits.length === 0) break;

    const before = seen.size;
    for (const hit of hits) {
      const cik = hit._source?.ciks?.[0];
      if (!cik) continue;
      const normalized = String(Number(cik));
      if (!seen.has(normalized)) {
        seen.set(normalized, hit._source?.display_names?.[0] ?? "(desconocido)");
      }
      if (seen.size >= limit) break;
    }

    // If a whole page contributed no new CIKs, continuing will not change that:
    // the remaining filings are from the same handful of issuers.
    if (seen.size === before) break;
  }

  return [...seen].map(([cik, name]) => ({ cik, name }));
}

// ---------------------------------------------------------------------------
// Step 2: choose the Annex A among a trust's filings
// ---------------------------------------------------------------------------

interface SubmissionsResponse {
  cik?: string;
  name?: string;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      form?: string[];
      size?: number[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
    };
  };
}

/**
 * Scores a filing as an Annex A candidate.
 *
 * WEIGHTS DERIVED FROM REAL DATA
 *
 * Three issuer families were compared on EDGAR (August 2026):
 *
 *   Wells Fargo 2025-C64   n4801_x5-annexa1.htm   "ANNEX A-1"                 4,1 MB
 *   Benchmark 2026-B42     n5676_x3-annexa.htm    "FWP"                       8,9 MB
 *   BANK5 2026-5YR20       n5543_x4-annexa1.htm   "FREE WRITING PROSPECTUS"  15,8 MB
 *
 * Conclusiones:
 *
 *   - The NAME is the only reliable signal: all three carry "annexa", with or
 *     without a digit. That is why it weighs more than everything else.
 *   - The DESCRIPTION is noise: three different values for the same document.
 *     It adds if it says "annex", but it cannot be relied on.
 *   - SIZE does not discriminate on its own. The term sheets of the same deal
 *     weigh 6-8 MB, so a size threshold would let them through. It is only
 *     useful for discarding the small FWPs (15-30 KB) for pricing and
 *     announcements.
 */
export function scoreAnnexFiling(f: {
  form: string;
  documentName: string;
  documentDescription: string;
  sizeBytes: number;
}): number {
  // The Annex A is published as an FWP or inside the prospectus.
  if (!/^(FWP|424B[0-9]?|424H)$/i.test(f.form)) return 0;

  const name = f.documentName.toLowerCase();
  const desc = f.documentDescription.toLowerCase();

  let score = 0;

  /**
   * Primary signal: the file name.
   *
   * Issuers use three families of abbreviation, discovered by reviewing 107
   * real trusts:
   *
   *   annexa1, annexa    → la forma completa
   *   anxa1, anxa, anx1  → "annex" abreviado a "anx"
   *   a1                 → just the annex number
   *
   * Without the last two, 17 of 36 trusts were being lost.
   */
  if (/annex[-_]?a/.test(name)) score += 0.55;
  else if (/anx\s*a?-?\d?/.test(name)) score += 0.5;
  else if (/annex/.test(name)) score += 0.3;
  /**
   * Plain "a1" is the weakest signal, so the pattern is strict: separator, "a",
   * optional digit, and end of name before the extension. That way it is not
   * confused with the "xa" pricing and launch documents of the same deal, which
   * also weigh 15-25 KB.
   */
  else if (/[-_]a-?1?(?=\.[a-z]+$)/.test(name)) score += 0.45;

  // Secondary signal: the description. When present, it confirms.
  if (/annex\s*_?-?a/.test(desc)) score += 0.2;
  else if (/annex/.test(desc)) score += 0.1;

  // Size filter: discards the small FWPs, does not promote the large ones.
  if (f.sizeBytes > 500_000) score += 0.2;
  else if (f.sizeBytes < 100_000) score -= 0.4;

  return Math.min(Math.max(score, 0), 1);
}

/** A 15 MB Annex A is normal; beyond that it is worth warning. */
export const LARGE_DOCUMENT_WARN_BYTES = 20_000_000;

export interface AnnexPick {
  filing: FilingRef;
  score: number;
  alternatives: Array<{ document: string; description: string; size: number; score: number }>;
}

/**
 * Looks for the Annex A among a trust's recent filings.
 * Returns every candidate above the threshold, best to worst.
 */
/**
 * Scores a prospectus as a fallback.
 *
 * Some issuers do not publish the Annex A as a filing of its own: they include
 * it as a section of the prospectus (424B2 or 424H), documents of 15-22 MB. In a
 * review of 36 failed trusts, 11 were in this situation.
 *
 * It is worth trying because the parser is format-agnostic: it looks for tables
 * whose headers map to known metrics, and those tables are inside the prospectus
 * just the same. The cost is downloading and parsing a document five times
 * larger, so it is only used when there is no dedicated Annex.
 */
export function scoreProspectusFallback(f: {
  form: string;
  documentName: string;
  sizeBytes: number;
}): number {
  if (!/^(424B[0-9]?|424H)$/i.test(f.form)) return 0;
  // A prospectus with the full pool does not come in under several MB.
  if (f.sizeBytes < 5_000_000) return 0;
  // The preliminary (424H) usually carries the same annex as the final and
  // weighs the same; we prefer the final as the definitive one.
  return /424b/i.test(f.form) ? 0.4 : 0.35;
}

export async function findAnnexFilings(
  cik: string,
  opts: {
    minScore?: number;
    max?: number;
    /** Allows falling back to the prospectus if there is no dedicated Annex. Default true. */
    allowProspectusFallback?: boolean;
    fetchOpts?: FetchOptions;
  } = {},
): Promise<AnnexPick[]> {
  const minScore = opts.minScore ?? 0.5;
  const padded = String(Number(cik)).padStart(10, "0");

  const data = await fetchJson<SubmissionsResponse>(
    `${SUBMISSIONS}/CIK${padded}.json`,
    opts.fetchOpts,
  );

  const recent = data.filings?.recent;
  if (!recent?.accessionNumber) return [];

  const companyName = data.name ?? "(desconocido)";
  const n = recent.accessionNumber.length;

  const scored: Array<{ filing: FilingRef; score: number }> = [];

  for (let i = 0; i < n; i++) {
    const accession = recent.accessionNumber[i]!;
    const form = recent.form?.[i] ?? "";
    const documentName = recent.primaryDocument?.[i] ?? "";
    const documentDescription = recent.primaryDocDescription?.[i] ?? "";
    const sizeBytes = recent.size?.[i] ?? 0;

    const score = scoreAnnexFiling({ form, documentName, documentDescription, sizeBytes });
    if (score <= 0) continue;

    const base = archiveBase(cik, accession);
    scored.push({
      score,
      filing: {
        cik: String(Number(cik)),
        accession,
        companyName,
        formType: form,
        filedAt: recent.filingDate?.[i] ?? "",
        documentName,
        documentDescription,
        sizeBytes,
        documentUrl: `${base}/${documentName}`,
        baseUrl: base,
      },
    });
  }

  scored.sort((a, b) => b.score - a.score);

  let picks = scored.filter((s) => s.score >= minScore).slice(0, opts.max ?? 3);

  // No dedicated Annex: we try the prospectus, where the annex usually sits.
  if (picks.length === 0 && opts.allowProspectusFallback !== false) {
    const fallbacks: Array<{ filing: FilingRef; score: number }> = [];

    for (let i = 0; i < n; i++) {
      const form = recent.form?.[i] ?? "";
      const documentName = recent.primaryDocument?.[i] ?? "";
      const sizeBytes = recent.size?.[i] ?? 0;

      const score = scoreProspectusFallback({ form, documentName, sizeBytes });
      if (score <= 0) continue;

      const accession = recent.accessionNumber[i]!;
      const base = archiveBase(cik, accession);
      fallbacks.push({
        score,
        filing: {
          cik: String(Number(cik)),
          accession,
          companyName,
          formType: form,
          filedAt: recent.filingDate?.[i] ?? "",
          documentName,
          documentDescription: recent.primaryDocDescription?.[i] ?? "",
          sizeBytes,
          documentUrl: `${base}/${documentName}`,
          baseUrl: base,
        },
      });
    }

    fallbacks.sort((a, b) => b.score - a.score || b.filing.sizeBytes - a.filing.sizeBytes);
    picks = fallbacks.slice(0, 1);
  }

  return picks.map((p) => ({
    filing: p.filing,
    score: p.score,
    alternatives: scored
      .filter((s) => s.filing.accession !== p.filing.accession)
      .slice(0, 4)
      .map((s) => ({
        document: s.filing.documentName,
        description: s.filing.documentDescription,
        size: s.filing.sizeBytes,
        score: Number(s.score.toFixed(2)),
      })),
  }));
}

/** Lists a trust's filings, for manual inspection when something does not add up. */
export async function listRecentFilings(
  cik: string,
  opts: { limit?: number; fetchOpts?: FetchOptions } = {},
): Promise<Array<{
  accession: string; form: string; filedAt: string;
  document: string; description: string; sizeBytes: number; score: number;
}>> {
  const padded = String(Number(cik)).padStart(10, "0");
  const data = await fetchJson<SubmissionsResponse>(
    `${SUBMISSIONS}/CIK${padded}.json`,
    opts.fetchOpts,
  );

  const recent = data.filings?.recent;
  if (!recent?.accessionNumber) return [];

  const rows = recent.accessionNumber.map((accession, i) => {
    const form = recent.form?.[i] ?? "";
    const document = recent.primaryDocument?.[i] ?? "";
    const description = recent.primaryDocDescription?.[i] ?? "";
    const sizeBytes = recent.size?.[i] ?? 0;
    return {
      accession,
      form,
      filedAt: recent.filingDate?.[i] ?? "",
      document,
      description,
      sizeBytes,
      score: Number(scoreAnnexFiling({ form, documentName: document, documentDescription: description, sizeBytes }).toFixed(2)),
    };
  });

  return rows.slice(0, opts.limit ?? 40);
}

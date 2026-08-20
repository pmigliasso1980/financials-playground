/**
 * Batch harvesting, to build a corpus where distributions can be seen.
 *
 *   npm run harvest:batch -- --limit 30
 *   npm run harvest:batch -- --cik 2053102,2110410,2104049
 *   npm run harvest:batch -- --limit 300 --years 7
 *   npm run harvest:batch -- --limit 300 --refresh-stale
 *
 * A single filing says nothing: 32 loans are not enough to tell a median from
 * an accident. With twenty or thirty trusts —between 600 and 2000 loans— the
 * distributions by asset type start to make sense.
 *
 * It respects the SEC limit (the client caps at 8 req/s) and skips the trusts
 * that fail rather than aborting: in a batch of thirty, one or two will have
 * their Annex in a format we do not handle yet.
 */

import { EdgarError, preflight } from "./edgar/client.js";
import { TAXONOMY_VERSION } from "./normalize/definitions.js";
import { findAnnexFilings, findCmbsTrusts } from "./edgar/discover.js";
import { fetchBuffer } from "./edgar/client.js";
import { extractTables } from "./parse/tables.js";
import { findHeaderRow } from "./normalize/columnMap.js";
import { attachContinuationTables, joinAnnexTables, keepLoanRows } from "./normalize/annexStructure.js";
import { toProperties } from "./normalize/toProperties.js";
import { checkSanity, rowsToObservations, type SourceRef } from "./normalize/toObservations.js";
import { saveHarvest } from "../db/corpus.js";
import { closePool, ping } from "../db/client.js";
import { query } from "../db/client.js";

const args = process.argv.slice(2);

function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

const limit = Number(flag("limit")) || 20;
/**
 * How many years back to search.
 *
 * EDGAR cuts off pagination for a single query at around 100 results, and those
 * 100 are the most recent. Without date windows, asking for 300 trusts returns
 * the same 100 every time.
 *
 * The default of 4 covers 2023-2026, which is what was needed to have vintages
 * with reported performance. To join up with Griffin's window —which ends in
 * 2019— you have to go further back:
 *
 *   npm run harvest:batch -- --limit 300 --years 7
 */
const years = Number(flag("years")) || 4;
const explicitCiks = flag("cik")?.split(",").map((c) => c.trim()).filter(Boolean) ?? [];

/**
 * Several queries because one is not enough.
 *
 * EDGAR's full-text search returns results biased towards the most frequent
 * issuers. Rotating the phrasing reaches different families —Benchmark, BANK,
 * BBCMS, Wells Fargo, Morgan Stanley— and the corpus ends up less concentrated
 * in a single originator, which is what would ruin the medians.
 */
const DISCOVERY_QUERIES = [
  '"Commercial Mortgage Trust"',
  '"Mortgage Trust" "ANNEX A-1"',
  '"Commercial Mortgage Pass-Through Certificates"',
  '"Multifamily Mortgage Trust"',
];

try {
  await main();
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  await closePool();
  process.exit(1);
}
await closePool();

// ---------------------------------------------------------------------------

async function main() {
  const health = await ping();
  if (!health.ok) {
    console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
    process.exit(1);
  }
  if (!health.schemaReady) {
    console.error(`\n✗ The corpus schema does not exist.\n\n    npm run db:migrate\n`);
    process.exit(1);
  }

  /**
   * Check EDGAR before starting, not on the first query.
   *
   * The batch checked the database and started, so a missing SEC_USER_AGENT was
   * only discovered inside the discovery loop and manifested as fifteen
   * consecutive failures. A precondition is checked once, at the start, with one
   * message.
   */
  const edgar = await preflight();
  if (!edgar.ok) {
    console.error(`\n✗ ${edgar.message.split("\n").join("\n  ")}\n`);
    process.exit(1);
  }

  const ciks = explicitCiks.length > 0 ? explicitCiks : await discover(limit);

  if (ciks.length === 0) {
    console.error("\n✗ No trusts found. Try --cik.\n");
    process.exit(1);
  }

  // Those already in the corpus are skipped: the batch is resumable.
  const { rows: existing } = await query<{ cik: string }>("SELECT DISTINCT cik FROM corpus.filings");
  const already = new Set(existing.map((r) => r.cik));

  /**
   * Targeted re-harvest when the mapping improves.
   *
   * The problem: the batch skips what is already there, so a new mapping never
   * reaches the old filings. The obvious option —delete everything and
   * re-harvest— takes twenty minutes, spends a thousand requests against the SEC
   * and has already left us with no corpus once.
   *
   * `--refresh-missing-id` downloads only the issuances whose loans have no
   * USABLE identifier, which are the ones the new mapping can fix. The load is
   * idempotent (ON CONFLICT DO UPDATE), so re-harvesting an issuance updates it
   * rather than duplicating it.
   *
   * WHY "USABLE" AND NOT "PRESENT"
   *
   * The first version asked for `loan_ref IS NOT NULL`. Then I added a pattern
   * that mapped the flag column as the identifier, and those filings ended up
   * with loan_ref values of "Loan" and "Property" —present, useless. The
   * selector judged them healthy and skipped them: the tool built to find the
   * problem went blind to precisely that problem.
   *
   * The criterion is now what the join actually needs: that it starts with a
   * digit. An identifier you cannot use is the same as not having one.
   */
  /**
   * `--refresh-stale`: re-harvests what was harvested with an old mapping.
   *
   * It is the criterion that should have been used from the start. The previous
   * three —"no identifier", "no usable identifier", "disjoint ranges"— defined
   * the re-harvest by a symptom, and every mapping fix changed the symptom.
   * Benchmark 2020-B16 escaped the selector three times running: first because
   * it had junk loan_ref, then because the junk was numeric, then because a
   * single loan with a numeric id was enough to look healthy.
   *
   * The taxonomy version something was harvested with does not depend on
   * whether the result looks good. It is the only predicate that does not move
   * when you fix something.
   */
  const refreshStale = args.includes("--refresh-stale");
  const refreshMissingId = args.includes("--refresh-missing-id");
  let refresh = new Set<string>();

  if (refreshStale) {
    const { rows } = await query<{ cik: string; version: string | null; loans: string }>(
      `SELECT f.cik,
              f.stats->>'taxonomyVersion' AS version,
              count(l.id)::text AS loans
         FROM corpus.filings f
         LEFT JOIN corpus.loans l ON l.accession = f.accession
        WHERE coalesce(f.stats->>'taxonomyVersion', '') <> $1
        GROUP BY f.cik, f.stats->>'taxonomyVersion'`,
      [TAXONOMY_VERSION],
    );
    /**
     * Normalised, because that is how it is queried below.
     *
     * `f.cik` can come with leading zeros and the `pending` filter uses
     * `String(Number(c))`. Storing the raw value made the `has` never match —
     * the set was computed, announced, and selected nothing.
     */
    refresh = new Set(rows.map((r) => String(Number(r.cik))));
    const affected = rows.reduce((a, r) => a + Number(r.loans), 0);
    console.log(
      `\n\x1b[33m--refresh-stale:\x1b[0m ${refresh.size} issuances harvested with a mapping ` +
        `older than ${TAXONOMY_VERSION} (${affected} loans).`,
    );

    /**
     * Warn that the re-harvest takes the performance data with it.
     *
     * Re-harvesting deletes the whole filing before rewriting it, and
     * `corpus.performance` references `loans(id)` with ON DELETE CASCADE. Those
     * loans' performance disappears with them.
     *
     * It is not recoverable from here: the 10-D files have to be downloaded from
     * EDGAR again. And it is not noticeable afterwards —the identities still
     * close, the corpus still looks complete— so the only useful moment to say
     * it is BEFORE.
     */
    const { rows: perf } = await query<{ rows_n: string; loans_n: string }>(
      `SELECT count(*)::text AS rows_n, count(DISTINCT p.loan_id)::text AS loans_n
         FROM corpus.performance p
         JOIN corpus.loans l ON l.id = p.loan_id
         JOIN corpus.filings f ON f.accession = l.accession
        WHERE f.cik = ANY($1)`,
      [[...refresh]],
    );

    const lost = Number(perf[0]?.loans_n ?? 0);
    if (lost > 0) {
      console.log(
        `\x1b[31m  ${Number(perf[0]!.rows_n).toLocaleString("en-US")} performance rows from ` +
          `${lost.toLocaleString("en-US")} loans will be deleted.\x1b[0m`,
      );
      console.log(
        `\x1b[90m  The CASCADE comes from loans(id). Rebuild afterwards with:\x1b[0m ` +
          `\x1b[1mnpm run db:performance\x1b[0m`,
      );
    }
  }

  if (refreshMissingId) {
    const { rows } = await query<{ cik: string; loans: string }>(
      `SELECT f.cik, count(l.id)::text AS loans
         FROM corpus.filings f
         JOIN corpus.loans l ON l.accession = f.accession
        WHERE f.accession NOT IN (
                SELECT DISTINCT accession FROM corpus.loans
                 WHERE loan_ref ~ '^[0-9]'
              )
        GROUP BY f.cik`,
    );
    for (const r of rows) refresh.add(r.cik);
    const affected = rows.reduce((a, r) => a + Number(r.loans), 0);
    console.log(
      `\n\x1b[33m--refresh-missing-id:\x1b[0m ${refresh.size} issuances with no usable identifier ` +
        `(${affected} loans) will be re-harvested.`,
    );
  }

  /**
   * What was discovered PLUS what has to be re-harvested, not what was
   * discovered FILTERED.
   *
   * This line read `ciks.filter(... || refresh.has(...))`. Since `ciks` comes
   * from discovery —which by definition looks for trusts NOT in the corpus— an
   * old issuance never appeared there and the `||` had nothing to act on. The
   * flag computed 222 stale issuances, printed a red warning about deleting
   * 2,213 performance rows, and then harvested something else entirely: twenty
   * new trusts from 2011-2014.
   *
   * It is the worst form of this error. It did not fail silently: it failed
   * while announcing loudly that it was doing the right thing.
   */
  const norm = (c: string) => String(Number(c));
  const discovered = ciks.filter((c) => !already.has(norm(c)));
  const enLista = new Set(discovered.map(norm));

  /**
   * `--refresh-limit N`: re-harvest N issuances and stop.
   *
   * Re-harvesting 222 issuances is ~30 minutes and deletes the performance of
   * 2,213 loans by CASCADE. The code that selects them had just had a bug that
   * made it select none while announcing the opposite.
   *
   * Running five first costs a minute and answers whether the fix works. It is
   * the same logic as the seller probe: verify before the expensive operation,
   * not after the result surprises you.
   */
  const refreshLimitFlag = args.indexOf("--refresh-limit");
  const refreshLimit =
    refreshLimitFlag === -1 ? Infinity : Number(args[refreshLimitFlag + 1] ?? Infinity);

  const toReharvest = [...refresh]
    .filter((c) => !enLista.has(c))
    .slice(0, refreshLimit);
  const pending = [...discovered, ...toReharvest];
  const skipped = ciks.length - discovered.length;

  console.log(
    `\n${ciks.length} trusts discovered · ${discovered.length} new to harvest` +
      `${skipped ? ` · ${skipped} already in the corpus` : ""}` +
      `${toReharvest.length ? ` · \x1b[33m${toReharvest.length} to re-harvest for an old mapping\x1b[0m` : ""}\n`,
  );

  const started = Date.now();
  let ok = 0;
  let failed = 0;
  let loans = 0;
  let observations = 0;
  const problems: Array<{ cik: string; reason: string }> = [];

  for (const [i, cik] of pending.entries()) {
    const prefix = `[${String(i + 1).padStart(2)}/${pending.length}]`;

    try {
      const result = await harvestOne(cik);
      if (!result) {
        failed++;
        problems.push({ cik, reason: "no identifiable Annex A" });
        console.log(`${prefix} \x1b[33m—\x1b[0m cik ${cik}: no Annex A`);
        continue;
      }

      const report = await saveHarvest(result);
      ok++;
      loans += report.loans;
      observations += report.observations;

      const issues = checkSanity(result);
      const errors = issues.filter((s) => s.severity === "error").length;
      const mark = errors > 0 ? "\x1b[33m⚠\x1b[0m" : "\x1b[32m✓\x1b[0m";

      console.log(
        `${prefix} ${mark} ${result.source.companyName.slice(0, 44).padEnd(44)} ` +
          `${String(report.loans).padStart(3)} loans · ${String(report.observations).padStart(4)} obs` +
          `${errors > 0 ? ` · \x1b[33m${errors} sanity error(s)\x1b[0m` : ""}`,
      );
    } catch (err) {
      failed++;
      const reason = err instanceof EdgarError ? `EDGAR ${err.status}` : String(err).slice(0, 60);
      problems.push({ cik, reason });
      console.log(`${prefix} \x1b[31m✗\x1b[0m cik ${cik}: ${reason}`);
    }
  }

  const mins = ((Date.now() - started) / 60_000).toFixed(1);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  ${ok} harvested · ${failed} failed · ${mins} min`);
  console.log(`  ${loans} loans · ${observations} observations added`);

  if (problems.length > 0) {
    console.log(`\n  Could not be harvested:`);
    for (const p of problems) {
      console.log(`    cik ${p.cik.padEnd(9)} ${p.reason}`);
    }
    console.log(`\n  \x1b[90mInspect one with: npm run harvest -- filings <cik>\x1b[0m`);
  }

  const { rows: totals } = await query<{ filings: string; loans: string }>(
    "SELECT (SELECT count(*) FROM corpus.filings) AS filings, (SELECT count(*) FROM corpus.loans) AS loans",
  );
  console.log(
    `\n  Corpus: ${totals[0]!.filings} filings · ${totals[0]!.loans} loans\n`,
  );
  console.log(`  Siguiente:  npm run db:analyze\n`);
}

// ---------------------------------------------------------------------------

/**
 * Yearly windows to reach further back.
 *
 * EDGAR cuts off pagination for a single query at around 100 results, and those
 * 100 are the most recent. To gather hundreds of trusts you have to combine
 * different queries with different date windows.
 */
function yearWindows(years: number): Array<{ from: string; to: string }> {
  const currentYear = new Date().getFullYear();
  const windows: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < years; i++) {
    const y = currentYear - i;
    windows.push({ from: `${y}-01-01`, to: `${y}-12-31` });
  }
  return windows;
}

async function discover(target: number): Promise<string[]> {
  const span = target > 40 ? yearWindows(years) : [];
  const range = span.length
    ? ` · ${span[span.length - 1]!.from.slice(0, 4)}-${span[0]!.to.slice(0, 4)}`
    : "";
  console.log(`\nDiscovering CMBS trusts (target ${target}${range})...`);

  const found = new Map<string, string>();
  // With few trusts the current year is enough; for hundreds you have to go back.
  const windows = target > 40 ? yearWindows(years) : [{ from: "", to: "" }];

  for (const win of windows) {
    for (const q of DISCOVERY_QUERIES) {
      if (found.size >= target) break;

      try {
        const trusts = await findCmbsTrusts({
          query: q,
          limit: target,
          ...(win.from ? { dateFrom: win.from, dateTo: win.to } : {}),
        });

        const before = found.size;
        for (const t of trusts) {
          if (!found.has(t.cik)) found.set(t.cik, t.name);
          if (found.size >= target) break;
        }

        const added = found.size - before;
        if (added > 0) {
          const label = win.from ? `${win.from.slice(0, 4)} · ` : "";
          console.log(`  ${label}${q.slice(0, 46).padEnd(46)} +${String(added).padStart(3)} → ${found.size}`);
        }
      } catch (err) {
        /**
         * A configuration problem is not retried.
         *
         * This catch treated everything the same: if SEC_USER_AGENT was
         * missing, all fifteen combinations of query and year failed for the
         * same reason and the same message printed fifteen times, ending in a
         * "no trusts found" that suggested checking the query. Retrying
         * something that cannot work is not robustness, it is noise that hides
         * the cause.
         */
        const msg = err instanceof Error ? err.message : String(err);
        if (/SEC_USER_AGENT/.test(msg)) throw err;
        console.log(`  \x1b[90m${q} failed: ${msg}\x1b[0m`);
      }
    }
    if (found.size >= target) break;
  }

  if (found.size < target) {
    console.log(
      `\n  \x1b[33mFound ${found.size} of ${target}.\x1b[0m EDGAR limits pagination per query;`,
    );
    console.log(
      `  \x1b[90mfor more, add queries to DISCOVERY_QUERIES or pass CIKs with --cik.\x1b[0m`,
    );
  }

  return [...found.keys()].slice(0, target);
}

async function harvestOne(cik: string) {
  const picks = await findAnnexFilings(cik, { max: 1 });
  if (picks.length === 0) return null;

  const { filing } = picks[0]!;
  const buffer = await fetchBuffer(filing.documentUrl, { timeoutMs: 180_000 });
  const tables = extractTables(buffer, filing.documentName);

  const { tables: annexTables } = attachContinuationTables(tables, (rows) => findHeaderRow(rows));
  if (annexTables.length === 0) return null;

  const joined = joinAnnexTables(annexTables);
  if (!joined) return null;

  const filtered = keepLoanRows(joined.rows, joined.headerRowIndex);

  const source: SourceRef = {
    cik: filing.cik,
    accession: filing.accession,
    companyName: filing.companyName,
    formType: filing.formType,
    filedAt: filing.filedAt,
    fileName: filing.documentName,
    fileUrl: filing.documentUrl,
  };

  const result = rowsToObservations(filtered.rows, joined.headerRowIndex, source);
  /**
   * How many property rows `keepLoanRows` threw away.
   *
   * An Annex A carries one row per loan and one per property securing it, with
   * each one's address, city and state. We keep the loan rows, so the geography
   * of multi-property portfolios is discarded here — and until now there was no
   * record of how much.
   *
   * I tried to estimate it by subtraction over `stats` and got ~0, because
   * `dataRows` is counted AFTER this filter. The proxy measured something else
   * and answered confidently: it nearly closed a line of investigation that was
   * correct.
   */
  result.stats.propertyRowsDropped = filtered.propertyRows;
  /**
   * And now they are stored, not just counted. See `toProperties`: over the
   * three fixtures that is 138 rows with address, city and state, each tied to
   * its loan by the issuer's 3.01 numbering.
   */
  result.propertyRows = toProperties(
    joined.rows, joined.headerRowIndex, filtered.droppedPropertyRows, source,
  );
  return result.properties.length > 0 ? result : null;
}

/**
 * Batch harvest of servicer performance.
 *
 *   npm run db:performance
 *   npm run db:performance -- --before 2025-07-01
 *
 * SCOPE: ONLY WHAT HAS ALREADY MATURED
 *
 * Comparing underwriting against outcome needs a full year of operation after
 * closing. A 2026 deal does not have one yet, so trying only burns requests
 * against SEC.
 *
 * The default cutoff is 1 January 2025: trusts originated before that date have
 * the 2025 financial year closed and reported in the April 2026 statement. Over
 * the current corpus that is the ~31 trusts of the 2024 vintage.
 *
 * WHAT IS STORED AND WHAT IS NOT
 *
 * Only loans with a measured full-year NOI, joined to a loan already in the
 * corpus. A servicer loan that does not join against the Annex A is not invented:
 * it is counted as unmatched and reported.
 */

import { closePool, ping, query } from "./client.js";
import { fetchText, preflight } from "../harvest/edgar/client.js";
import { findServicerReports } from "../harvest/edgar/servicer.js";
import { extractParties, parseServicerReport } from "../harvest/parse/servicerReport.js";
import { extractFromHtml } from "../harvest/parse/tables.js";

const args = process.argv.slice(2);
const beforeFlag = args.indexOf("--before");
const ORIGINATED_BEFORE = beforeFlag === -1 ? "2025-01-01" : args[beforeFlag + 1]!;
const limitFlag = args.indexOf("--limit");
const LIMIT = limitFlag === -1 ? 500 : Number(args[limitFlag + 1] ?? 500);

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}
const edgar = await preflight();
if (!edgar.ok) {
  console.error(`\n✗ ${edgar.message}\n`);
  await closePool();
  process.exit(1);
}

function loanInt(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^\s*(\d+)/.exec(raw);
  return m ? String(Number(m[1])) : null;
}

const { rows: targets } = await query<{
  accession: string; cik: string; company_name: string; filed_at: string | null;
}>(
  `SELECT accession, cik, company_name, filed_at::text
     FROM corpus.filings
    WHERE filed_at IS NOT NULL AND filed_at < $1
    ORDER BY filed_at
    LIMIT $2`,
  [ORIGINATED_BEFORE, LIMIT],
);

console.log(`\nServicer performance`);
console.log(`  ${targets.length} trusts originated before ${ORIGINATED_BEFORE}\n`);

if (targets.length === 0) {
  console.log(`  Nothing to harvest. Try --before with a later date.\n`);
  await closePool();
  process.exit(0);
}

const started = Date.now();
let ok = 0;
let failed = 0;
/** Report parsed and registered, with no full-year NOI. Observable, not failed. */
let withoutNoi = 0;
let totalDelinquent = 0;
/** Delinquency rows from the report that found no loan: lost coverage. */
let totalUnjoined = 0;
/** Rows landing on an already-seen loan: pari passu tranches, not a loss. */
let totalCollapsed = 0;
/**
 * Loans in special servicing that were NOT among the delinquent ones.
 *
 * It is the direct measure of what the parser was losing: if it is zero, the new
 * block added nothing; if it is large and uneven across shelves, it was the
 * explanation for BANK flagging 4 times fewer transfers than BBCMS.
 */
let totalSpecialOnly = 0;
let totalMatched = 0;
let totalUnmatched = 0;
const problems: string[] = [];

for (const [i, t] of targets.entries()) {
  const tag = `[${String(i + 1).padStart(2)}/${targets.length}]`;
  const name = t.company_name.slice(0, 38).padEnd(38);

  try {
    /**
     * Several months are tried until the yield is decent.
     *
     * April is the best month on average, but not for every trust: the borrower's
     * fiscal year does not always close in December, and servicers do not all
     * consolidate in the same month. On the first run, fourteen of thirty-one
     * trusts returned between one and four loans while thirteen returned more
     * than twenty — two different behaviours a single attempt cannot tell apart.
     *
     * We stop as soon as a month yields well; only the poor yielders pay for
     * extra requests.
     */
    const reports = await findServicerReports(t.cik, { max: 3 });
    if (reports.length === 0) {
      console.log(`${tag} — ${name} no 10-D`);
      failed++;
      problems.push(`${t.company_name}: no 10-D with an EX-99.1`);
      continue;
    }

    let report = reports[0]!;
    /**
     * The chosen report's HTML is kept: the trust's parties come from the cover
     * page, which `parseServicerReport` does not return, and downloading it again
     * would be a request to SEC for something already in memory.
     */
    let html = await fetchText(report.documentUrl);
    let parsed = parseServicerReport(html);
    let usable = parsed.loans.filter((l) => l.isFullYear);
    let attempts = 1;

    const GOOD_YIELD = 0.5;
    const yieldOf = (p: typeof parsed, u: typeof usable) =>
      p.diagnostics.rowsFound ? u.length / p.diagnostics.rowsFound : 0;

    for (const alt of reports.slice(1)) {
      if (yieldOf(parsed, usable) >= GOOD_YIELD) break;
      attempts++;
      const altHtml = await fetchText(alt.documentUrl);
      const altParsed = parseServicerReport(altHtml);
      const altUsable = altParsed.loans.filter((l) => l.isFullYear);
      if (altUsable.length > usable.length) {
        report = alt;
        html = altHtml;
        parsed = altParsed;
        usable = altUsable;
      }
    }

    /**
     * `minRows: 1` and not 2: the cover page has loose rows that the table
     * parser's threshold discards. Same extraction, different floor.
     */
    const parties = extractParties(
      extractFromHtml(html, { mergeHeaders: false, minRows: 1 }),
    );
    const roleOf = (r: string) => parties.find((p) => p.role === r)?.name ?? null;

    /**
     * The report is registered BEFORE checking whether it yielded NOI.
     *
     * Until now the INSERT into `servicer_reports` and the delinquency one sat
     * after the "no full years" `continue`. Consequence: an issuance whose report
     * parsed fine but yielded no usable NOI came out unregistered and with its
     * delinquency unsaved —even though the delinquency block was parsed, in
     * memory, two variables away.
     *
     * Since the analyses gate on `JOIN corpus.performance` to say "the event is
     * observable here", the entire BANK shelf fell out of the delinquency
     * question for having no NOI. One question paying another's dependency.
     *
     * Always registering is what separates "there was no event" from "we did not
     * observe it". Without that the two are the same absent row, which is the
     * confounder that already bit us with the special servicing stock and with
     * the young vintages.
     */
    if (parsed.diagnostics.tablesMatched === 0) {
      failed++;
      console.log(`${tag} — ${name} \x1b[31mformato\x1b[0m`);
      problems.push(
        `${t.company_name} [${report.periodOfReport}, ${attempts} intento(s)]: ` +
          `TABLE NOT FOUND across ${parsed.diagnostics.tablesScanned} tables — different format`,
      );
      continue;
    }

    // Index of the corpus loans by their normalised Loan ID.
    const { rows: corpusLoans } = await query<{ id: string; loan_ref: string | null }>(
      `SELECT id::text, loan_ref FROM corpus.loans WHERE accession = $1`,
      [t.accession],
    );
    const byInt = new Map<string, string>();
    for (const l of corpusLoans) {
      const key = loanInt(l.loan_ref);
      if (key && !byInt.has(key)) byInt.set(key, l.id);
    }

    await query(
      `INSERT INTO corpus.servicer_reports
         (accession, cik, company_name, filed_at, period_of_report,
          file_name, file_url, deal_accession, master_servicer, special_servicer, stats)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (accession) DO UPDATE SET
         harvested_at = now(), stats = EXCLUDED.stats,
         deal_accession = EXCLUDED.deal_accession,
         master_servicer = EXCLUDED.master_servicer,
         special_servicer = EXCLUDED.special_servicer`,
      [
        report.accession,
        String(Number(t.cik)),
        report.companyName,
        report.filedAt || null,
        report.periodOfReport || null,
        report.documentName,
        report.documentUrl,
        t.accession,
        roleOf("master servicer"),
        roleOf("special servicer"),
        JSON.stringify({
          rowsFound: parsed.diagnostics.rowsFound,
          loansParsed: parsed.loans.length,
          fullYear: usable.length,
          droppedNoDates: parsed.diagnostics.droppedNoDates,
          delinquencyRows: parsed.delinquency.length,
          delinquencyMatched: parsed.delinquency.filter(
            (d) => byInt.has(loanInt(d.loanId) ?? ""),
          ).length,
          /**
           * So the question "how many issuances declare zero delinquencies?"
           * can be asked over all 148 rather than over the one I had to hand.
           *
           * BANK 2021-BNK36 says "No delinquent loans this period" in the
           * document; from that I concluded something about a shelf of 24
           * issuances. With these three numbers the conclusion can be drawn from
           * the whole corpus.
           */
          delinquencyTables: parsed.diagnostics.delinquencyTables,
          delinquencyDataRows: parsed.diagnostics.delinquencyDataRows,
          delinquencyDropped: parsed.diagnostics.delinquencyDropped,
          delinquencyDroppedSamples: parsed.diagnostics.delinquencyDroppedSamples,
          specialTables: parsed.diagnostics.specialTables,
          specialDataRows: parsed.diagnostics.specialDataRows,
          specialSoloAqui: parsed.diagnostics.specialSoloAqui,
          poolLoans: corpusLoans.length,
          trancheConflicts: parsed.diagnostics.trancheConflicts.length,
        }),
      ],
    );

    /**
     * Delinquency and special servicing, from the same report.
     *
     * It goes before the NOI on purpose: it does not depend on it, and putting it
     * after already cost the BANK shelf its place in the analysis.
     *
     * Unlike the NOI, there is NO filter here for a period after closing: payment
     * status is as of the report date, not over a range.
     */
    /**
     * Three counters, not one.
     *
     * The batch reported 341 delinquencies and the table had 282, out of 349
     * parsed. A single counter does not distinguish "did not join against the
     * corpus" from "joined onto a loan that already had a row" —pari passu
     * tranches the servicer numbers 1, 1A, 1B and `loanInt` collapses on
     * purpose. The difference matters: the first is lost coverage, the second is
     * correct deduplication.
     */
    let delinquent = 0;
    let unjoined = 0;
    const seen = new Set<string>();
    for (const d of parsed.delinquency) {
      const corpusId = byInt.get(loanInt(d.loanId) ?? "");
      if (!corpusId) {
        unjoined++;
        continue;
      }
      await query(
        `INSERT INTO corpus.delinquency
           (report_accession, loan_id, pros_id, period, paid_through, months_delinquent,
            status, transfer_date, foreclosure_date, reo_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (report_accession, loan_id) DO UPDATE SET
           pros_id = EXCLUDED.pros_id,
           paid_through = EXCLUDED.paid_through,
           months_delinquent = EXCLUDED.months_delinquent,
           status = EXCLUDED.status,
           transfer_date = EXCLUDED.transfer_date,
           foreclosure_date = EXCLUDED.foreclosure_date,
           reo_date = EXCLUDED.reo_date,
           source = 'delinquency'`,
        [
          report.accession, corpusId, d.prosId, report.periodOfReport || null,
          d.paidThrough, d.monthsDelinquent, d.status,
          d.transferDate, d.foreclosureDate, d.reoDate,
        ],
      );
      delinquent++;
      seen.add(corpusId);
    }
    totalDelinquent += delinquent;
    totalUnjoined += unjoined;
    totalCollapsed += delinquent - seen.size;

    /**
     * The specially serviced block, which the parser was not reading.
     *
     * A loan can be in special servicing while paying on time: it appears here and
     * not among the delinquent ones. The upsert does NOT overwrite
     * `months_delinquent` because that datum only exists in the other block — if
     * it overwrote it with NULL, fixing the numerator would break the identity
     * that validates the whole table.
     */
    let specialOnly = 0;
    for (const s of parsed.specialServicing) {
      const corpusId = byInt.get(loanInt(s.loanId) ?? "");
      if (!corpusId) continue;
      await query(
        `INSERT INTO corpus.delinquency
           (report_accession, loan_id, pros_id, period, transfer_date,
            resolution_code, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'special')
         ON CONFLICT (report_accession, loan_id) DO UPDATE SET
           transfer_date = coalesce(EXCLUDED.transfer_date, corpus.delinquency.transfer_date),
           resolution_code = coalesce(EXCLUDED.resolution_code, corpus.delinquency.resolution_code),
           source = CASE WHEN corpus.delinquency.source = 'delinquency'
                         THEN 'both' ELSE 'special' END`,
        [
          report.accession, corpusId, s.prosId, report.periodOfReport || null,
          s.transferDate, s.resolutionCode,
        ],
      );
      if (!seen.has(corpusId)) specialOnly++;
      seen.add(corpusId);
    }
    totalSpecialOnly += specialOnly;

    /**
     * No usable NOI is no longer a failure: it is a registered report that
     * contributes delinquency and does not contribute NOI. It is still reported
     * —a low yield may be a format worth supporting— but the issuance stays
     * observable.
     */
    if (usable.length === 0) {
      withoutNoi++;
      console.log(
        `${tag} \x1b[90m○\x1b[0m ${name} \x1b[90msin NOI\x1b[0m  ` +
          `${String(delinquent).padStart(3)} delinquent of ${String(corpusLoans.length).padStart(3)} in the pool` +
          `${attempts > 1 ? ` \x1b[90m(${attempts} meses)\x1b[0m` : ""}`,
      );
      problems.push(
        `${t.company_name} [${report.periodOfReport}, ${attempts} intento(s)]: ` +
          `table located, ${parsed.diagnostics.rowsFound} rows, none with a full year ` +
          `(${parsed.diagnostics.droppedNoDates} with no dates) — registered anyway, ${delinquent} delinquency rows`,
      );
      continue;
    }

    let matched = 0;
    let unmatched = 0;
    for (const loan of usable) {
      const corpusId = byInt.get(loanInt(loan.loanId) ?? "");
      if (!corpusId) {
        unmatched++;
        continue;
      }
      await query(
        `INSERT INTO corpus.performance
           (report_accession, loan_id, pros_id, annualized_noi,
            noi_start, noi_end, period_days, is_full_year, tranches)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (report_accession, loan_id) DO UPDATE SET
           annualized_noi = EXCLUDED.annualized_noi,
           noi_start = EXCLUDED.noi_start, noi_end = EXCLUDED.noi_end,
           period_days = EXCLUDED.period_days, tranches = EXCLUDED.tranches`,
        [
          report.accession, corpusId, loan.loanId, loan.annualizedNoi,
          loan.noiStart, loan.noiEnd, loan.periodDays, loan.isFullYear, loan.tranches,
        ],
      );
      matched++;
    }

    totalMatched += matched;
    totalUnmatched += unmatched;
    ok++;

    /**
     * A failing join has to say WHY.
     *
     * "33 unmatched" is a symptom with at least three different causes and a
     * different fix for each:
     *
     *   - the corpus has no Loan ID for that filing  → the column needs mapping
     *   - the ranges do not overlap                   → a different numbering
     *   - they overlap partially                      → loans paid off or removed
     *
     * Without distinguishing them, twenty trusts contributing zero all look the
     * same and you end up chasing the wrong hypothesis. It is the same problem we
     * had with "no trusts found" when the User-Agent was missing.
     */
    const rate = usable.length ? matched / usable.length : 0;
    let diagnosis = "";
    if (matched === 0 && usable.length > 0) {
      if (byInt.size === 0) {
        /**
         * Two different causes produce an empty index, and the first version
         * confused them: it said "the corpus has no Loan ID (83 of 83 rows with
         * loan_ref)", which contradicts itself.
         *
         * Either there is no identifier, or there is one but it does not start
         * with a number —the servicer numbers 1, 2, 3 and the Annex A may use
         * codes like "B16-01" or "A-1". The second needs to see the real values,
         * not a count.
         */
        const withRef = corpusLoans.filter((l) => l.loan_ref?.trim());
        if (withRef.length === 0) {
          diagnosis =
            ` \x1b[31m✗ no identifier\x1b[0m ` +
            `\x1b[90m(0 of ${corpusLoans.length} rows)\x1b[0m`;
        } else {
          const sample = withRef.slice(0, 3).map((l) => `"${l.loan_ref}"`).join(", ");
          diagnosis =
            ` \x1b[31m✗ non-numeric identifier\x1b[0m ` +
            `\x1b[90m(${withRef.length} rows: ${sample})\x1b[0m`;
        }
      } else {
        const corpusKeys = [...byInt.keys()].map(Number).sort((a, b) => a - b);
        const servKeys = usable
          .map((l) => Number(loanInt(l.loanId)))
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        diagnosis =
          ` \x1b[31m✗ disjoint ranges\x1b[0m \x1b[90m(corpus ${corpusKeys[0]}-${corpusKeys[corpusKeys.length - 1]}, ` +
          `servicer ${servKeys[0]}-${servKeys[servKeys.length - 1]})\x1b[0m`;
      }
      problems.push(`${t.company_name}: empty join —${diagnosis.replace(/\x1b\[[0-9;]*m/g, "").trim()}`);
    }
    const flag = diagnosis || (rate < 0.9 ? " \x1b[33m⚠ partial join\x1b[0m" : "");
    // The yield —how many report rows ended up usable— is what separates the
    // trusts that return 20 from those that return 2.
    const y = parsed.diagnostics.rowsFound
      ? Math.round((usable.length / parsed.diagnostics.rowsFound) * 100)
      : 0;
    const yieldTag = y < 50 ? `\x1b[33m${String(y).padStart(3)}%\x1b[0m` : `\x1b[90m${String(y).padStart(3)}%\x1b[0m`;
    console.log(
      `${tag} ✓ ${name} ${String(matched).padStart(3)} loans  ` +
        `${yieldTag} of ${String(parsed.diagnostics.rowsFound).padStart(3)} rows` +
        `${attempts > 1 ? ` \x1b[90m(${attempts} months)\x1b[0m` : ""}` +
        `${unmatched > 0 ? ` · ${unmatched} unmatched` : ""}${flag}`,
    );
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${tag} ✗ ${name} ${msg.slice(0, 30)}`);
    problems.push(`${t.company_name}: ${msg.slice(0, 120)}`);
  }
}

const mins = ((Date.now() - started) / 60_000).toFixed(1);

console.log(`\n${"─".repeat(70)}`);
console.log(
  `  ${ok} with NOI · ${withoutNoi} registered without NOI · ${failed} failed · ${mins} min`,
);
console.log(`  ${totalMatched} loans with actual NOI${totalUnmatched > 0 ? ` · ${totalUnmatched} unmatched` : ""}`);
console.log(
  `  ${totalDelinquent} delinquency rows joined` +
    `${totalUnjoined > 0 ? ` · ${totalUnjoined} unmatched \x1b[90m(lost coverage)\x1b[0m` : ""}` +
    `${totalCollapsed > 0 ? ` · ${totalCollapsed} collapsed \x1b[90m(tranches of the same loan)\x1b[0m` : ""}`,
);
console.log(
  `  \x1b[90mthe table ends up with ${totalDelinquent - totalCollapsed} rows from the delinquency block\x1b[0m`,
);
console.log(
  `  ${totalSpecialOnly > 0 ? "\x1b[1m" : ""}${totalSpecialOnly} loans in special servicing that were NOT among the delinquent ones\x1b[0m` +
    `\n  \x1b[90m← events the pipeline counted as zero before reading the second block\x1b[0m`,
);

if (problems.length > 0) {
  console.log(`\n  Could not be harvested:`);
  for (const p of problems.slice(0, 12)) console.log(`    ${p}`);
  if (problems.length > 12) console.log(`    ... and ${problems.length - 12} more`);
}

const { rows: coverage } = await query<{ total: string; with_uw: string; with_all: string }>(
  `SELECT count(*) AS total,
          count(*) FILTER (WHERE noi_underwritten IS NOT NULL) AS with_uw,
          count(*) FILTER (WHERE noi_underwritten IS NOT NULL AND noi_trailing IS NOT NULL) AS with_all
     FROM corpus.underwriting_outcomes`,
);
const c = coverage[0];
if (c) {
  console.log(`\n  In the outcomes view:`);
  console.log(`    ${c.total} loans with actual NOI`);
  console.log(`    ${c.with_uw} also with underwritten NOI  \x1b[90m(Griffin's measurement)\x1b[0m`);
  console.log(`    ${c.with_all} with all three figures      \x1b[90m(projected vs delivered)\x1b[0m`);
}

console.log(`\n  Next:  npm run db:outcomes\n`);

await closePool();

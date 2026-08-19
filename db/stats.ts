/**
 * State of the accumulated corpus.
 *
 *   npm run db:stats
 *
 * The two sections that matter most:
 *
 *   COVERAGE BY METRIC — how many loans carry each metric. If a change to the
 *   mapping improved or degraded things, it shows here before anywhere else.
 *
 *   UNMAPPED HEADERS — the work queue. The ones at the top waste the most
 *   filings, so they are the ones worth attacking first.
 */

import { closePool, ping, query } from "./client.js";
import { corpusStats } from "./corpus.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}
if (!health.schemaReady) {
  console.error(`\n✗ The corpus schema does not exist.\n\n    npm run db:migrate\n`);
  await closePool();
  process.exit(1);
}

const stats = await corpusStats();

console.log(`\n${"═".repeat(70)}`);
console.log("Corpus");
console.log(`${"═".repeat(70)}\n`);

console.log(
  `  ${stats.filings} filings · ${stats.loans} loans · ` +
    `${stats.observations} observations · ${stats.facts} facts\n`,
);

if (stats.filings === 0) {
  console.log("  Empty. Harvest with:\n");
  console.log("    npm run harvest -- fetch 2053102 --persist\n");
  await closePool();
  process.exit(0);
}

console.log("Coverage by metric");
console.log(`  ${"metric".padEnd(26)} ${"loans".padStart(9)} ${"headers".padStart(8)}`);
console.log(`  ${"─".repeat(46)}`);

/**
 * Padding that ignores colour codes.
 *
 * `String.padStart` counts ANSI escapes as visible characters, so colouring a
 * value eats the column width and misaligns the table.
 */
function pad(text: string, width: number, color?: string): string {
  const padding = " ".repeat(Math.max(0, width - text.length));
  return color ? `${padding}${color}${text}\x1b[0m` : `${padding}${text}`;
}

/**
 * The coverage below which the mapping deserves suspicion.
 *
 * Some metrics are legitimately partial —a multifamily does not report square
 * footage, a portfolio carries "Various" as its year— but others should be on
 * almost every loan of a CMBS pool: LTV, DSCR, balance.
 */
const EXPECTED_UNIVERSAL = new Set([
  "loan_amount", "ltv", "dscr", "noi_underwritten", "property_name", "interest_rate",
]);

const suspicious: string[] = [];

for (const m of stats.byMetric) {
  const pct = stats.loans > 0 ? Math.round((m.loans / stats.loans) * 100) : 0;
  const bar = "█".repeat(Math.round(pct / 10)).padEnd(10, "·");

  // distinct_headers > 1 means several issuers name the same metric
  // differently: a good sign that the patterns are doing their job.
  const headersCell = pad(
    String(m.distinct_headers),
    8,
    m.distinct_headers > 1 ? "\x1b[36m" : undefined,
  );

  const low = EXPECTED_UNIVERSAL.has(m.metric_key) && pct < 90;
  if (low) suspicious.push(`${m.metric_key} (${pct}%)`);

  const nameCell = low
    ? `\x1b[33m${m.metric_key.padEnd(26)}\x1b[0m`
    : m.metric_key.padEnd(26);

  console.log(
    `  ${nameCell} ${pad(String(m.loans), 9)} ${headersCell}  \x1b[90m${bar} ${pct}%\x1b[0m`,
  );
}

if (suspicious.length > 0) {
  console.log(
    `\n  \x1b[33m⚠ Low coverage on metrics a CMBS pool usually carries in full:\x1b[0m`,
  );
  console.log(`    ${suspicious.join(", ")}`);
  console.log(
    `    \x1b[90mProbably a missing pattern, or the column is in a block that was not joined.\x1b[0m`,
  );
  console.log(`    \x1b[90mInspect with: npm run harvest:inspect\x1b[0m`);
}

/**
 * Corpus integrity.
 *
 * An Annex A numbers its loans consecutively, so the loan count, the count of
 * distinct IDs and the maximum ID should all agree. When they do not, rows from
 * one block are sitting under another block's header and that filing's data is
 * shifted.
 *
 * This check exists because that bug produced interest rates of 480% —which were
 * really amortisation terms in months— and a pool with 165 loans where there were
 * 82. The individual values looked valid; what did not add up was the arithmetic
 * of the identifiers.
 */
const { rows: integrity } = await query<{
  company_name: string; accession: string; loans: string;
  distinct_ids: string; max_id: string | null;
}>(
  `SELECT fi.company_name, fi.accession,
          count(*) AS loans,
          count(DISTINCT l.loan_ref) AS distinct_ids,
          max(l.loan_ref::numeric)::text AS max_id
     FROM corpus.loans l
     JOIN corpus.filings fi ON fi.accession = l.accession
    WHERE l.loan_ref ~ '^[0-9.]+$'
    GROUP BY 1, 2`,
);

const suspect = integrity.filter((r) => {
  const loans = Number(r.loans);
  const ids = Number(r.distinct_ids);
  const max = Number(r.max_id);
  if (!Number.isFinite(max) || loans < 5) return false;
  // Repeated IDs, or far more loans than the highest ID.
  return ids < loans || loans > max * 1.3;
});

if (suspect.length > 0) {
  console.log(`\n\x1b[31mIntegrity: ${suspect.length} filing(s) with inconsistent identifiers\x1b[0m`);
  console.log(`  ${"filing".padEnd(40)} ${"loans".padStart(9)} ${"ids".padStart(6)} ${"max id".padStart(7)}`);
  for (const r of suspect.slice(0, 12)) {
    console.log(
      `  ${r.company_name.slice(0, 40).padEnd(40)} ${String(r.loans).padStart(9)} ` +
        `${String(r.distinct_ids).padStart(6)} ${String(r.max_id ?? "—").padStart(7)}`,
    );
  }
  console.log(
    `\n  \x1b[90mMore loans than distinct IDs means duplicated rows from another block.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mThose filings' data is shifted: do not use them until it is fixed.\x1b[0m`,
  );
} else if (integrity.length > 0) {
  console.log(
    `\n\x1b[32mIntegrity: all ${integrity.length} filings have consecutive identifiers.\x1b[0m`,
  );
}

if (stats.topUnmapped.length > 0) {
  console.log(`\nUnmapped headers \x1b[90m(work queue)\x1b[0m`);
  console.log(`  ${"filings".padStart(7)}  header`);
  console.log(`  ${"─".repeat(60)}`);
  for (const u of stats.topUnmapped) {
    console.log(`  ${String(u.filings).padStart(7)}  ${u.header}`);
  }
  console.log(
    `\n  \x1b[90mTo capture one: add its pattern to METRIC_SPECS in\x1b[0m`,
  );
  console.log(`  \x1b[90mharvest/normalize/columnMap.ts and re-harvest with --persist.\x1b[0m`);
}

console.log();
await closePool();

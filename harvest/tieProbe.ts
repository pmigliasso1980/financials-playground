/**
 * Which metrics are decided by column order?
 *
 *   npm run harvest:ties
 *   npm run harvest:ties -- --issuances 10
 *
 * WHAT IT LOOKS FOR
 *
 * `scoreHeader` scores by the position of the matching pattern, and
 * `mapColumns` resolves ties by column order. When two different headers tie at
 * a metric's maximum score, the winner is decided by the order the blocks ended
 * up in after `joinAnnexTables` — which varies by issuance.
 *
 * That is how two quantities got mixed under `occupancy` for three weeks:
 * `Leased Occupancy (%)` and `Most Recent Hotel Occupancy (%)` tied at 0.76,
 * and in 7 of the 2026 issuances the hotel one won. Coverage looked like 76%
 * and inside it were two different metrics.
 *
 * The conduit Annex A has historical series in several metrics —NOI, income,
 * expenses, occupancy— so there is no reason to think occupancy was the only
 * case.
 *
 * IT IS A TEST, NOT A REPORT
 *
 * It exits with code 1 if it finds ties. A tie at the winning score is not a
 * fact about the document: it is a hole in the taxonomy, and the taxonomy is
 * ours.
 *
 * WHAT IT DOES NOT DETECT
 *
 * Whether the winning column is the right one. If a metric has a single
 * candidate and it is the wrong one, this passes green. It detects ambiguity,
 * not error.
 */

import { fetchBuffer, preflight } from "./edgar/client.js";
import { findAnnexFilings } from "./edgar/discover.js";
import { extractTables } from "./parse/tables.js";
import { findHeaderRow, METRIC_SPECS, scoreHeader } from "./normalize/columnMap.js";
import { attachContinuationTables, joinAnnexTables } from "./normalize/annexStructure.js";
import { closePool, ping, query } from "../db/client.js";

const args = process.argv.slice(2);
const i = args.indexOf("--issuances");
const N = i === -1 ? 6 : Number(args[i + 1] ?? 6);

const health = await preflight();
if (!health.ok) {
  console.error(`\n✗ ${health.message}\n`);
  process.exit(1);
}
const db = await ping();
if (!db.ok) {
  console.error(`\n✗ ${db.message.split("\n").join("\n  ")}\n`);
  process.exit(1);
}

/**
 * One issuance per vintage, the one with the largest pool.
 *
 * Criterion fixed before looking: more loans makes it likelier the Annex
 * carries every block, and sampling by vintage covers template changes over
 * time. It depends on no result.
 */
const { rows: issuances } = await query<{ cik: string; name: string; vintage: string }>(
  `WITH r AS (
     SELECT f.cik, f.company_name AS name,
            extract(year FROM f.filed_at)::int::text AS vintage,
            row_number() OVER (
              PARTITION BY extract(year FROM f.filed_at)
              ORDER BY count(l.id) DESC, f.accession
            ) AS rn
       FROM corpus.filings f
       JOIN corpus.loans l ON l.accession = f.accession
      WHERE f.filed_at IS NOT NULL
      GROUP BY f.cik, f.company_name, f.accession, f.filed_at
   )
   SELECT cik, name, vintage FROM r WHERE rn = 1 ORDER BY vintage DESC`,
);
await closePool();

console.log(`\n${"═".repeat(78)}`);
console.log("Which metrics are decided by column order?");
console.log(`${"═".repeat(78)}\n`);

interface Empate {
  metric: string;
  score: number;
  headers: string[];
  issuance: string;
}
const empates: Empate[] = [];
let reviewed = 0;

for (const e of issuances.slice(0, N)) {
  try {
    const picks = await findAnnexFilings(e.cik, { max: 1 });
    if (picks.length === 0) {
      console.log(`  ${e.name.slice(0, 40).padEnd(42)} \x1b[33msin Annex A\x1b[0m`);
      continue;
    }
    const { filing } = picks[0]!;
    const buffer = await fetchBuffer(filing.documentUrl, { timeoutMs: 180_000 });
    const tables = extractTables(buffer, filing.documentName);
    const { tables: annexTables } = attachContinuationTables(tables, (rows) =>
      findHeaderRow(rows),
    );
    const joined = joinAnnexTables(annexTables);
    if (!joined) {
      console.log(`  ${e.name.slice(0, 40).padEnd(42)} \x1b[33msin join\x1b[0m`);
      continue;
    }

    /**
     * The JOINED headers, which is where the columns really compete.
     *
     * Looking table by table is no use: the tie appears precisely because the
     * join brings together blocks that separately had a single candidate each.
     */
    const headers = (joined.rows[joined.headerRowIndex] ?? []).map((c) =>
      c === null || c === undefined ? "" : String(c).replace(/\s+/g, " ").trim(),
    );

    reviewed++;
    const own: Empate[] = [];

    for (const spec of METRIC_SPECS) {
      const puntuadas = headers
        .map((h) => ({ h, s: scoreHeader(h, spec) }))
        .filter((x) => x.s > 0);
      if (puntuadas.length < 2) continue;

      const max = Math.max(...puntuadas.map((x) => x.s));
      /**
       * Repeated headers are not ambiguity: they are the same column in two
       * blocks. The comparison ignores whitespace and case because the Annex A
       * carries "# of Properties" in one block and "#of Properties" in another —
       * one space of difference that the probe reported as an ambiguous metric.
       *
       * That is a false positive of mine, not a defect in the taxonomy: the two
       * columns contain the same thing and it does not matter which wins.
       */
      const clave = (h: string) => h.replace(/\s+/g, "").toLowerCase();
      const porClave = new Map<string, string>();
      for (const x of puntuadas.filter((x) => x.s === max)) {
        if (!porClave.has(clave(x.h))) porClave.set(clave(x.h), x.h);
      }
      const winners = [...porClave.values()];
      if (winners.length < 2) continue;

      own.push({ metric: spec.key, score: max, headers: winners, issuance: e.name });
    }

    empates.push(...own);
    console.log(
      `  ${e.name.slice(0, 40).padEnd(42)} ${String(headers.length).padStart(3)} cols · ` +
        (own.length === 0
          ? `\x1b[32msin empates\x1b[0m`
          : `\x1b[31m${own.length} ambiguous metric(s)\x1b[0m`),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${e.name.slice(0, 40).padEnd(42)} \x1b[31m${msg.slice(0, 30)}\x1b[0m`);
  }
}

console.log(`\n${"─".repeat(78)}\n`);

if (reviewed === 0) {
  console.log(`  \x1b[33mNo issuance could be reviewed. No conclusion.\x1b[0m\n`);
  process.exit(1);
}

if (empates.length === 0) {
  console.log(
    `  \x1b[32mNo ambiguous metric across ${reviewed} issuances.\x1b[0m Each has a\n` +
      `  single column at its maximum score.\n`,
  );
  process.exit(0);
}

/** Grouped by metric: the same ambiguity appears across many issuances. */
const byMetric = new Map<string, Empate[]>();
for (const x of empates) {
  const l = byMetric.get(x.metric) ?? [];
  l.push(x);
  byMetric.set(x.metric, l);
}

console.log(
  `  \x1b[31m${byMetric.size} metric(s) tied at the winning score\x1b[0m` +
    ` \x1b[90m(${reviewed} issuances reviewed)\x1b[0m\n`,
);

for (const [metric, cases] of [...byMetric].sort((a, b) => b[1].length - a[1].length)) {
  console.log(
    `  \x1b[1m${metric}\x1b[0m \x1b[90m· ties in ${cases.length} of ${reviewed} issuances · score ${cases[0]!.score.toFixed(2)}\x1b[0m`,
  );
  for (const h of cases[0]!.headers) console.log(`      \x1b[36m"${h.slice(0, 60)}"\x1b[0m`);

  /**
   * If the tied columns change between issuances, the candidate set depends on
   * the document and not only on the taxonomy.
   */
  const signatures = new Set(cases.map((c) => [...c.headers].sort().join("|")));
  if (signatures.size > 1) {
    console.log(`      \x1b[90m(${signatures.size} different combinations across issuances)\x1b[0m`);
  }
  console.log();
}

console.log(
  `  \x1b[90mThe fix is the same one used on occupancy: a more specific pattern\x1b[0m`,
);
console.log(
  `  \x1b[90mfirst for the column you want, or an exclude for the ones you do not.\x1b[0m`,
);
console.log(
  `  \x1b[90mLeaving it makes the stored value depend on the block order.\x1b[0m\n`,
);

process.exit(1);

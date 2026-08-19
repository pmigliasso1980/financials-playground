/**
 * A snapshot of the corpus, and what moved since the previous one.
 *
 *   npm run db:snapshot            compares against the last one and saves
 *   npm run db:snapshot -- --dry   compares without saving
 *
 * WHAT PROBLEM IT SOLVES
 *
 * The most valuable findings in this project did not come from reasoning: they
 * came from a number coming back different from what was expected.
 *
 *   3,579 → 3,566 loans          revealed that the horizontal join had changed
 *   52% → 41% in the share       revealed we were averaging two markets
 *   73% → 95% in the identities  confirmed the debt-service scaling
 *
 * None of them needs judgement to be DETECTED. All three need it to be
 * interpreted. That asymmetry is the one worth automating: the machine says
 * something moved, the person decides whether it matters.
 *
 * WHY IT IS NOT A TEST
 *
 * A test asserts that a value is correct. Here we do not know what the correct
 * value is —if we did, the corpus would be unnecessary. The only thing that can
 * be asserted is that it changed, and that nobody explained it.
 *
 * That is why it does not fail. It prints. A threshold that breaks the pipeline
 * over a three-tenths variation ends up disabled within a week.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, ping, query } from "./client.js";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../.snapshots");
const dry = process.argv.includes("--dry");

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

interface Metric {
  /** Human-readable label. */
  label: string;
  value: number | null;
  /** How to format: integer, percentage, ratio. */
  kind: "count" | "pct" | "ratio";
  /**
   * Relative variation above which it is worth looking.
   *
   * It is not an error threshold: it is an attention threshold. A loan count
   * that moves 1% after changing the mapping is expected; one that moves 1% with
   * nobody having touched anything is not.
   */
  notable: number;
}

interface Snapshot {
  at: string;
  metrics: Record<string, Metric>;
}

// ---------------------------------------------------------------------------
// What is measured
// ---------------------------------------------------------------------------

const metrics: Record<string, Metric> = {};

const add = (key: string, label: string, value: number | null, kind: Metric["kind"], notable: number) => {
  metrics[key] = { label, value, kind, notable };
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// --- corpus size --------------------------------------------------------------

const { rows: size } = await query<{
  filings: string; loans: string; observations: string; facts: string; metrics: string;
}>(
  `SELECT (SELECT count(*) FROM corpus.filings)      AS filings,
          (SELECT count(*) FROM corpus.loans)        AS loans,
          (SELECT count(*) FROM corpus.observations) AS observations,
          (SELECT count(*) FROM corpus.facts)        AS facts,
          (SELECT count(DISTINCT metric_key) FROM corpus.facts) AS metrics`,
);
const sz = size[0]!;
add("filings", "issuances", num(sz.filings), "count", 0.001);
add("loans", "loans", num(sz.loans), "count", 0.002);
add("observations", "observations", num(sz.observations), "count", 0.01);
add("metrics", "distinct metrics", num(sz.metrics), "count", 0.001);

/**
 * Identifier coverage.
 *
 * It is the metric that degrades most silently: the loans harvest fine, nobody
 * sees an error, and then they join against nothing. It sat at 72% for an entire
 * session without us noticing.
 */
const { rows: ids } = await query<{ share: number | null }>(
  `SELECT 1.0 * count(*) FILTER (WHERE loan_ref IS NOT NULL AND loan_ref <> '')
          / NULLIF(count(*), 0) AS share
     FROM corpus.loans`,
);
add("loan_ref_coverage", "loans with an identifier", num(ids[0]?.share), "pct", 0.02);

const { rows: typed } = await query<{ share: number | null }>(
  `SELECT 1.0 * count(*) FILTER (WHERE property_type IS NOT NULL AND property_type <> '')
          / NULLIF(count(*), 0) AS share
     FROM corpus.loans`,
);
add("property_type_coverage", "loans with a type", num(typed[0]?.share), "pct", 0.02);

// --- arithmetic identities ------------------------------------------------------

const TOL = 0.01;
const fact = (a: string, k: string) =>
  `LEFT JOIN corpus.facts ${a} ON ${a}.loan_id = l.id AND ${a}.metric_key = '${k}' ` +
  `AND ${a}.value ~ '^-?[0-9.]+$'`;
const SENIOR = "(amt.value::numeric + coalesce(npp.value::numeric, 0))";
const SENIOR_J = `${fact("amt", "loan_amount")} ${fact("npp", "balance_pari_passu_non_trust")}`;

async function identityShare(joins: string, expected: string, actual: string): Promise<number | null> {
  const { rows } = await query<{ share: number | null }>(
    `WITH p AS (
       SELECT ${expected} AS e, ${actual} AS a FROM corpus.loans l ${joins}
        WHERE ${expected} IS NOT NULL AND ${actual} IS NOT NULL AND ${actual} <> 0
     )
     SELECT 1.0 * count(*) FILTER (WHERE abs(e / a - 1) <= ${TOL}) / NULLIF(count(*), 0) AS share
       FROM p`,
  );
  return num(rows[0]?.share);
}

add(
  "id_debt_yield",
  "identity · debt yield",
  await identityShare(
    `${fact("dy", "debt_yield")} ${fact("noi", "noi_underwritten")} ${SENIOR_J}`,
    `noi.value::numeric / NULLIF(${SENIOR}, 0)`,
    "dy.value::numeric",
  ),
  "pct",
  0.03,
);
add(
  "id_ltv",
  "identity · LTV",
  await identityShare(
    `${fact("v", "ltv")} ${SENIOR_J} ${fact("val", "appraised_value")}`,
    `${SENIOR} / NULLIF(val.value::numeric, 0)`,
    "v.value::numeric",
  ),
  "pct",
  0.03,
);
add(
  "id_ncf",
  "identity · NCF",
  await identityShare(
    `${fact("ncf", "net_cash_flow")} ${fact("noi", "noi_underwritten")} ` +
      `${fact("rep", "underwritten_replacement_reserve")} ${fact("tilc", "underwritten_tilc")}`,
    "noi.value::numeric - coalesce(rep.value::numeric, 0) - coalesce(tilc.value::numeric, 0)",
    "ncf.value::numeric",
  ),
  "pct",
  0.03,
);

// --- performance and finding -----------------------------------------------------

const { rows: perf } = await query<{ n: string }>(
  `SELECT count(*) AS n FROM corpus.performance`,
);
add("performance_loans", "loans with actual NOI", num(perf[0]?.n), "count", 0.02);

const POST = "gap_vs_actual IS NOT NULL AND days_after_origination >= 0";
const { rows: outcome } = await query<{
  n: string; median: number | null; share: number | null;
}>(
  `SELECT count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_actual) AS median,
          1.0 * count(*) FILTER (WHERE gap_vs_actual >= 0.05) / NULLIF(count(*), 0) AS share
     FROM corpus.underwriting_outcomes WHERE ${POST}`,
);
add("outcome_n", "sample behind the finding", num(outcome[0]?.n), "count", 0.02);
add("outcome_median", "median gap vs actual", num(outcome[0]?.median), "pct", 0.15);
add("outcome_share", "share ≥5%", num(outcome[0]?.share), "pct", 0.05);

/**
 * The two vintages that anchor the contrast.
 *
 * The finding says projected growth held steady while delivered growth
 * collapsed. If any of these four figures moves without explanation, the document
 * has to be rewritten.
 */
for (const year of [2021, 2024]) {
  const { rows } = await query<{ projected: number | null; growth: number | null; n: string }>(
    `SELECT count(*) AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_trailing) AS projected,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY growth_delivered) AS growth
       FROM corpus.underwriting_outcomes
      WHERE ${POST} AND extract(year FROM originated_at) = ${year}`,
  );
  add(`v${year}_n`, `${year} vintage · n`, num(rows[0]?.n), "count", 0.05);
  add(`v${year}_projected`, `${year} vintage · projected`, num(rows[0]?.projected), "pct", 0.15);
  add(`v${year}_growth`, `${year} vintage · delivered`, num(rows[0]?.growth), "pct", 0.15);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const current: Snapshot = { at: new Date().toISOString(), metrics };

mkdirSync(DIR, { recursive: true });
const previousFiles = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const previous: Snapshot | null = previousFiles.length
  ? JSON.parse(readFileSync(join(DIR, previousFiles[previousFiles.length - 1]!), "utf8"))
  : null;

const fmt = (m: Metric): string => {
  if (m.value === null) return "—";
  if (m.kind === "pct") return `${(m.value * 100).toFixed(1)}%`;
  if (m.kind === "ratio") return m.value.toFixed(2);
  return Math.round(m.value).toLocaleString("en-US");
};

console.log(`\n${"═".repeat(78)}`);
console.log("Corpus snapshot");
console.log(`${"═".repeat(78)}`);

if (!previous) {
  console.log(`\n  \x1b[90mFirst snapshot: there is nothing to compare against.\x1b[0m\n`);
  for (const m of Object.values(metrics)) {
    console.log(`  ${m.label.padEnd(32)} ${fmt(m).padStart(12)}`);
  }
} else {
  console.log(`\n  Against ${previous.at.slice(0, 16).replace("T", " ")}\n`);

  const moved: Array<{ m: Metric; before: number; after: number; rel: number }> = [];
  const stable: Metric[] = [];

  for (const [key, m] of Object.entries(metrics)) {
    const before = previous.metrics[key]?.value;
    if (before === undefined || before === null || m.value === null) {
      console.log(`  ${m.label.padEnd(32)} ${fmt(m).padStart(12)}   \x1b[90mnew\x1b[0m`);
      continue;
    }
    const rel = before === 0 ? (m.value === 0 ? 0 : 1) : Math.abs(m.value - before) / Math.abs(before);
    if (rel >= m.notable) moved.push({ m, before, after: m.value, rel });
    else stable.push(m);
  }

  if (moved.length === 0) {
    console.log(`  \x1b[32mNothing moved above its attention threshold.\x1b[0m`);
  } else {
    console.log(`  \x1b[33m${moved.length} moved:\x1b[0m\n`);
    for (const { m, before, after, rel } of moved) {
      const dir = after > before ? "↑" : "↓";
      const b: Metric = { ...m, value: before };
      console.log(
        `  ${m.label.padEnd(32)} ${fmt(b).padStart(12)} ${dir} ${fmt(m).padStart(12)}   ` +
          `\x1b[90m${(rel * 100).toFixed(1)}%\x1b[0m`,
      );
    }
    console.log(
      `\n  \x1b[90mA number that moves with nobody having explained it is a question,\x1b[0m`,
    );
    console.log(`  \x1b[90mnot an error. This week's three findings all came from here.\x1b[0m`);
  }

  console.log(`\n  \x1b[90m${stable.length} stable\x1b[0m`);
}

if (!dry) {
  const name = `${current.at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(join(DIR, name), JSON.stringify(current, null, 2) + "\n");
  console.log(`\n  → .snapshots/${name}`);

  /**
   * There is no cleanup of old files, deliberately.
   *
   * The first version "cleaned up" by writing empty files, because I did not want
   * to deal with delete permissions. That leaves rubbish the script itself later
   * tries to parse as JSON and breaks on. Worse than doing nothing.
   *
   * A snapshot is a couple of KB. When they get annoying, `rm .snapshots/*.json`.
   */
}

console.log();
await closePool();

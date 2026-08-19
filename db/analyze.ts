/**
 * Corpus distributions.
 *
 *   npm run db:analyze
 *   npm run db:analyze -- --type Multifamily
 *
 * WHAT IT IS FOR
 *
 * It is the smallest possible test before deciding on a product: if these numbers
 * say nothing to someone who underwrites CRE deals, no interface will save it.
 * And if they do say something, we already know what needs packaging.
 *
 * Four cuts:
 *
 *   1. DSCR, LTV and debt yield quartiles by asset type. This is the "am I in
 *      market?" a broker answers today by intuition or by calling three lenders.
 *
 *   2. THE UNDERWRITING GAP: how much the originator projects above the NOI the
 *      property actually produced. Nobody publishes this and it comes straight
 *      from comparing two columns of the same Annex A. A high average means the
 *      market is underwriting aggressively.
 *
 *   3. Implied cap rate (NOI / appraised value) by type and market.
 *
 *   4. Evolution by issuance date: whether leverage or DSCR moved over time.
 */

import { closePool, ping, query } from "./client.js";

const args = process.argv.slice(2);
const typeFilter = args.includes("--type") ? args[args.indexOf("--type") + 1] : null;
const MIN_SAMPLE = 5;

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const { rows: totals } = await query<{ filings: string; loans: string }>(
  "SELECT (SELECT count(*) FROM corpus.filings) AS filings, (SELECT count(*) FROM corpus.loans) AS loans",
);
const filings = Number(totals[0]!.filings);
const loans = Number(totals[0]!.loans);

console.log(`\n${"═".repeat(76)}`);
console.log(`Distributions · ${filings} filings · ${loans} loans`);
console.log(`${"═".repeat(76)}`);

if (loans < 30) {
  console.log(
    `\n  \x1b[33mSmall sample.\x1b[0m With fewer than 30 loans the medians are noise.\n`,
  );
  console.log(`  Harvest more:  npm run harvest:batch -- --limit 25\n`);
}

// ---------------------------------------------------------------------------
// 1. Underwriting ratios by asset type
// ---------------------------------------------------------------------------

interface RatioRow {
  property_type: string;
  n: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
}

async function ratiosByType(metric: string): Promise<RatioRow[]> {
  const { rows } = await query<RatioRow>(
    `SELECT
       l.property_type,
       count(*) AS n,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY f.value::numeric) AS p25,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY f.value::numeric) AS p50,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY f.value::numeric) AS p75
     FROM corpus.facts f
     JOIN corpus.loans l ON l.id = f.loan_id
     WHERE f.metric_key = $1
       AND l.property_type IS NOT NULL
       AND f.value ~ '^-?[0-9.]+$'
       ${typeFilter ? "AND l.property_type = $2" : ""}
     GROUP BY l.property_type
     HAVING count(*) >= ${MIN_SAMPLE}
     ORDER BY count(*) DESC`,
    typeFilter ? [metric, typeFilter] : [metric],
  );
  return rows;
}

function fmt(v: number | null, unit: "pct" | "x"): string {
  if (v === null) return "—";
  return unit === "pct" ? `${(v * 100).toFixed(1)}%` : `${v.toFixed(2)}x`;
}

console.log(`\n\x1b[1mUnderwriting ratios by asset type\x1b[0m`);
console.log(`\x1b[90m  p25 / median / p75 — the range where the market is\x1b[0m\n`);

for (const [metric, label, unit] of [
  ["dscr", "DSCR", "x"],
  ["ltv", "LTV", "pct"],
  ["debt_yield", "Debt yield", "pct"],
] as const) {
  const rows = await ratiosByType(metric);
  if (rows.length === 0) continue;

  console.log(`  ${label}`);
  console.log(`    ${"type".padEnd(20)} ${"n".padStart(4)}  ${"p25".padStart(8)} ${"median".padStart(8)} ${"p75".padStart(8)}`);
  for (const r of rows) {
    console.log(
      `    ${r.property_type.slice(0, 20).padEnd(20)} ${String(r.n).padStart(4)}  ` +
        `${fmt(r.p25, unit).padStart(8)} \x1b[1m${fmt(r.p50, unit).padStart(8)}\x1b[0m ${fmt(r.p75, unit).padStart(8)}`,
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
// 2. The underwriting gap
// ---------------------------------------------------------------------------

/**
 * How much the originator projects above the actual NOI.
 *
 * It comes from two columns of the same Annex A: `Underwritten NOI` against
 * `Most Recent NOI`. It is a direct measure of underwriting aggressiveness, by
 * asset type, computable from public data alone.
 *
 * Reading it: +8% means that at the median an NOI is being projected 8% above
 * what the property produced in the last closed period. A high value is not
 * necessarily bad —a property in lease-up will legitimately produce more— but
 * sustained and rising it is a sign of an overheated market.
 */
interface GapRow {
  property_type: string;
  n: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  share_above: string;
}

const { rows: gaps } = await query<GapRow>(
  `WITH pairs AS (
     SELECT
       l.property_type,
       uw.value::numeric AS uw_noi,
       mr.value::numeric AS mr_noi
     FROM corpus.loans l
     JOIN corpus.facts uw ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten'
     JOIN corpus.facts mr ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'
     WHERE l.property_type IS NOT NULL
       AND uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$'
       AND mr.value::numeric > 0
       ${typeFilter ? "AND l.property_type = $1" : ""}
   )
   SELECT
     property_type,
     count(*) AS n,
     percentile_cont(0.25) WITHIN GROUP (ORDER BY uw_noi / mr_noi - 1) AS p25,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY uw_noi / mr_noi - 1) AS p50,
     percentile_cont(0.75) WITHIN GROUP (ORDER BY uw_noi / mr_noi - 1) AS p75,
     round(100.0 * count(*) FILTER (WHERE uw_noi > mr_noi) / count(*), 0) AS share_above
   FROM pairs
   GROUP BY property_type
   HAVING count(*) >= ${MIN_SAMPLE}
   ORDER BY count(*) DESC`,
  typeFilter ? [typeFilter] : [],
);

if (gaps.length > 0) {
  console.log(`\x1b[1mUnderwriting gap\x1b[0m`);
  console.log(
    `\x1b[90m  How much the originator projects over the actual NOI of the last period.\x1b[0m`,
  );
  console.log(
    `\x1b[90m  It comes from comparing two columns of the same Annex A. Nobody publishes it.\x1b[0m\n`,
  );
  console.log(`  ${"type".padEnd(20)} ${"n".padStart(4)}  ${"p25".padStart(8)} ${"median".padStart(8)} ${"p75".padStart(8)}  % above`);
  for (const g of gaps) {
    const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
    const median = g.p50 ?? 0;
    const color = median > 0.15 ? "\x1b[33m" : median > 0 ? "" : "\x1b[36m";
    console.log(
      `  ${g.property_type.slice(0, 20).padEnd(20)} ${String(g.n).padStart(4)}  ` +
        `${pct(g.p25).padStart(8)} ${color}${pct(g.p50).padStart(8)}\x1b[0m ${pct(g.p75).padStart(8)}  ${String(g.share_above).padStart(9)}%`,
    );
  }
  console.log(
    `\n  \x1b[90mA +8% median means an NOI is being underwritten 8% above what the\x1b[0m`,
  );
  console.log(
    `  \x1b[90mproperty produced. High and sustained = aggressive market.\x1b[0m\n`,
  );
}

// ---------------------------------------------------------------------------
// 3. Implied cap rate
// ---------------------------------------------------------------------------

const { rows: capRates } = await query<RatioRow>(
  `WITH pairs AS (
     SELECT
       l.property_type,
       noi.value::numeric / NULLIF(val.value::numeric, 0) AS cap
     FROM corpus.loans l
     JOIN corpus.facts noi ON noi.loan_id = l.id AND noi.metric_key = 'noi_underwritten'
     JOIN corpus.facts val ON val.loan_id = l.id AND val.metric_key = 'appraised_value'
     WHERE l.property_type IS NOT NULL
       AND noi.value ~ '^-?[0-9.]+$' AND val.value ~ '^-?[0-9.]+$'
       ${typeFilter ? "AND l.property_type = $1" : ""}
   )
   SELECT property_type, count(*) AS n,
     percentile_cont(0.25) WITHIN GROUP (ORDER BY cap) AS p25,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY cap) AS p50,
     percentile_cont(0.75) WITHIN GROUP (ORDER BY cap) AS p75
   FROM pairs
   WHERE cap BETWEEN 0.01 AND 0.25
   GROUP BY property_type
   HAVING count(*) >= ${MIN_SAMPLE}
   ORDER BY count(*) DESC`,
  typeFilter ? [typeFilter] : [],
);

if (capRates.length > 0) {
  console.log(`\x1b[1mImplied cap rate\x1b[0m \x1b[90m(underwritten NOI / appraised value)\x1b[0m\n`);
  console.log(`  ${"type".padEnd(20)} ${"n".padStart(4)}  ${"p25".padStart(8)} ${"median".padStart(8)} ${"p75".padStart(8)}`);
  for (const r of capRates) {
    console.log(
      `  ${r.property_type.slice(0, 20).padEnd(20)} ${String(r.n).padStart(4)}  ` +
        `${fmt(r.p25, "pct").padStart(8)} \x1b[1m${fmt(r.p50, "pct").padStart(8)}\x1b[0m ${fmt(r.p75, "pct").padStart(8)}`,
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
// 4. Evolution over time
// ---------------------------------------------------------------------------

/**
 * BE CAREFUL WITH THE TIME SERIES
 *
 * A median aggregated by quarter is confounded by the asset mix. Multifamily has
 * the lowest DSCR and the highest LTV of any category, so a quarter dominated by
 * a multifamily pool shows high leverage and low coverage **without any
 * underwriting standard having changed**.
 *
 * With 99 filings, a single large deal can be half a quarter: BANK 2026-BNK52
 * contributed 165 loans, BBCMS 2025-C35 contributed 103.
 *
 * That is why we also show the composition and the series within multifamily,
 * which is the category with a large enough sample to be read on its own.
 */
const { rows: overTime } = await query<{
  period: string; n: string; deals: string; dscr: number | null; ltv: number | null;
  dy: number | null; mf_share: number | null;
}>(
  `SELECT
     to_char(date_trunc('quarter', fi.filed_at), 'YYYY-"Q"Q') AS period,
     count(DISTINCT l.id) AS n,
     count(DISTINCT fi.accession) AS deals,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY d.value::numeric) AS dscr,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY v.value::numeric) AS ltv,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY y.value::numeric) AS dy,
     1.0 * count(*) FILTER (WHERE l.property_type = 'Multifamily') / NULLIF(count(*), 0) AS mf_share
   FROM corpus.filings fi
   JOIN corpus.loans l ON l.accession = fi.accession
   LEFT JOIN corpus.facts d ON d.loan_id = l.id AND d.metric_key = 'dscr'  AND d.value ~ '^-?[0-9.]+$'
   LEFT JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = 'ltv'   AND v.value ~ '^-?[0-9.]+$'
   LEFT JOIN corpus.facts y ON y.loan_id = l.id AND y.metric_key = 'debt_yield' AND y.value ~ '^-?[0-9.]+$'
   WHERE fi.filed_at IS NOT NULL
   GROUP BY 1
   HAVING count(DISTINCT l.id) >= ${MIN_SAMPLE}
   ORDER BY 1`,
);

if (overTime.length > 1) {
  console.log(`\x1b[1mEvolution by quarter\x1b[0m \x1b[90m(medians, ALL assets)\x1b[0m\n`);
  console.log(
    `  ${"period".padEnd(10)} ${"n".padStart(5)} ${"deals".padStart(6)}  ${"DSCR".padStart(8)} ${"LTV".padStart(8)} ${"debt yield".padStart(11)}  ${"% multif.".padStart(9)}`,
  );
  for (const r of overTime) {
    const n = Number(r.n);
    const deals = Number(r.deals);
    // A quarter with one or two deals is not a market reading.
    const thin = deals <= 2 || n < 100;
    const mark = thin ? "\x1b[33m" : "";
    console.log(
      `  ${mark}${r.period.padEnd(10)}\x1b[0m ${String(n).padStart(5)} ${String(deals).padStart(6)}  ` +
        `${fmt(r.dscr, "x").padStart(8)} ${fmt(r.ltv, "pct").padStart(8)} ${fmt(r.dy, "pct").padStart(11)}  ` +
        `${fmt(r.mf_share, "pct").padStart(9)}${thin ? " \x1b[33m⚠\x1b[0m" : ""}`,
    );
  }

  const thin = overTime.filter((r) => Number(r.deals) <= 2 || Number(r.n) < 100);
  if (thin.length > 0) {
    console.log(
      `\n  \x1b[33m⚠ ${thin.map((r) => r.period).join(", ")}: small sample or few deals.\x1b[0m`,
    );
    console.log(
      `  \x1b[90mA single pool can dominate the quarter. Do not read them as market signal.\x1b[0m`,
    );
  }
  console.log(
    `\n  \x1b[90mThe "% multifamily" column exists because that category has the lowest\x1b[0m`,
  );
  console.log(
    `  \x1b[90mDSCR and the highest LTV: if its share rises, the aggregates move\x1b[0m`,
  );
  console.log(`  \x1b[90mwithout any underwriting standard changing.\x1b[0m\n`);

  // --- the same series, within a single asset type -------------------------
  //
  // Controlling for composition is the only way to read the series as market
  // signal rather than as a reflection of what was securitised that quarter.

  const { rows: mfSeries } = await query<{
    period: string; n: string; dscr: number | null; ltv: number | null; dy: number | null;
  }>(
    `SELECT
       to_char(date_trunc('quarter', fi.filed_at), 'YYYY-"Q"Q') AS period,
       count(DISTINCT l.id) AS n,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY d.value::numeric) AS dscr,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY v.value::numeric) AS ltv,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY y.value::numeric) AS dy
     FROM corpus.filings fi
     JOIN corpus.loans l ON l.accession = fi.accession
     LEFT JOIN corpus.facts d ON d.loan_id = l.id AND d.metric_key = 'dscr'  AND d.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = 'ltv'   AND v.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts y ON y.loan_id = l.id AND y.metric_key = 'debt_yield' AND y.value ~ '^-?[0-9.]+$'
     WHERE fi.filed_at IS NOT NULL AND l.property_type = 'Multifamily'
     GROUP BY 1
     HAVING count(DISTINCT l.id) >= 20
     ORDER BY 1`,
  );

  if (mfSeries.length > 2) {
    console.log(`\x1b[1mEvolution within multifamily\x1b[0m \x1b[90m(composition controlled)\x1b[0m\n`);
    console.log(`  ${"period".padEnd(10)} ${"n".padStart(5)}  ${"DSCR".padStart(8)} ${"LTV".padStart(8)} ${"debt yield".padStart(11)}`);
    for (const r of mfSeries) {
      console.log(
        `  ${r.period.padEnd(10)} ${String(r.n).padStart(5)}  ` +
          `${fmt(r.dscr, "x").padStart(8)} ${fmt(r.ltv, "pct").padStart(8)} ${fmt(r.dy, "pct").padStart(11)}`,
      );
    }
    console.log(
      `\n  \x1b[90mThis series CAN be read as signal: if LTV rises and DSCR falls here,\x1b[0m`,
    );
    console.log(`  \x1b[90mit is underwriting, not asset mix.\x1b[0m\n`);
  }
} else if (filings > 0) {
  console.log(
    `\x1b[90mThe time series needs filings from several quarters. Harvest more:\x1b[0m`,
  );
  console.log(`  npm run harvest:batch -- --limit 30\n`);
}

// ---------------------------------------------------------------------------

console.log(`${"─".repeat(76)}`);
console.log(
  `\n  \x1b[90mIf any of these numbers catches the eye of someone who underwrites\x1b[0m`,
);
console.log(
  `  \x1b[90mdeals, that is the product. If not, better to know before building.\x1b[0m\n`,
);

await closePool();

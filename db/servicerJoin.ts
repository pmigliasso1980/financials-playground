/**
 * Joins the servicer's performance with the Annex A's underwriting.
 *
 *   npm run db:join -- 2016841
 *   npm run db:join -- 2016841 --months 6
 *
 * WHY THIS SCRIPT EXISTS BEFORE THE PIPELINE
 *
 * Everything built in the last few hours rests on an assumption we have not
 * verified: that the servicer report's "Pros ID" and the Annex A's "Loan ID"
 * number the same loans the same way. It is plausible —both come from the
 * prospectus— but plausible is not verified, and if the numbering differs the
 * whole parser is worth nothing.
 *
 * There is a concrete reason to doubt it. In the Annex A the IDs carry a decimal
 * part, and that part means something: "3.00" is the loan and "3.01", "3.02" are
 * its properties. On the servicer's side the same loan is "3", and its pari passu
 * tranches are "3A-1", "3A-2". Two different suffix schemes over the same
 * integer. We normalise both to the integer and check that the sets coincide.
 *
 * WHAT TO LOOK AT IN THE OUTPUT
 *
 * The match percentage comes first. If it is high, the join works. If it is low,
 * we need to understand why before scaling to 31 trusts.
 *
 * Then comes the first Griffin-style measurement on one deal: underwritten NOI
 * against actual NOI for the first full year. A single trust proves nothing, but
 * if the numbers are absurd it shows here and not after harvesting thirty.
 */

import { closePool, ping, query } from "./client.js";
import { fetchText, preflight } from "../harvest/edgar/client.js";
import { findServicerReports } from "../harvest/edgar/servicer.js";
import { mergeServicerReports, parseServicerReport } from "../harvest/parse/servicerReport.js";

const [, , cikArg, ...rest] = process.argv;

if (!cikArg) {
  console.error("\nUso: npm run db:join -- <cik> [--months N]\n");
  process.exit(1);
}

const monthsFlag = rest.indexOf("--months");
const months = monthsFlag === -1 ? 1 : Number(rest[monthsFlag + 1] ?? 1);

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

/**
 * Normalises a loan identifier to the integer that designates it.
 *
 *   Annex A:   "3.00" → 3   ·  "3.01" → 3 (property of loan 3)
 *   Servicer:  "3A-1" → 3   ·  "3"    → 3
 *
 * Note: on the Annex A side the property rows are already filtered out before
 * reaching here, so a "3.01" should not appear. If it does, the duplicate count
 * will give it away.
 */
function loanInt(raw: string | null): number | null {
  if (!raw) return null;
  const m = /^\s*(\d+)/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

const pct = (v: number | null, d = 1) => (v === null ? "—" : `${(v * 100).toFixed(d)}%`);
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// Lado corpus
// ---------------------------------------------------------------------------

const { rows: filings } = await query<{
  accession: string; company_name: string; filed_at: string | null; loans: string;
}>(
  `SELECT f.accession, f.company_name, f.filed_at::text,
          count(l.id) AS loans
     FROM corpus.filings f
     LEFT JOIN corpus.loans l ON l.accession = f.accession
    WHERE f.cik = $1
    GROUP BY 1, 2, 3
    ORDER BY f.filed_at DESC NULLS LAST`,
  [String(Number(cikArg))],
);

if (filings.length === 0) {
  console.error(
    `\n✗ CIK ${cikArg} is not in the corpus.\n` +
      `  Harvest it first:  npm run harvest -- run ${cikArg}\n`,
  );
  await closePool();
  process.exit(1);
}

const filing = filings[0]!;

console.log(`\n${"═".repeat(78)}`);
console.log(`${filing.company_name}`);
console.log(`${"═".repeat(78)}`);
console.log(`\n  Annex A     ${filing.accession} · ${filing.filed_at ?? "?"} · ${filing.loans} loans`);

const { rows: corpusLoans } = await query<{
  loan_ref: string | null; property_type: string | null;
  uw_noi: string | null; trailing_noi: string | null; balance: string | null;
}>(
  `SELECT l.loan_ref, l.property_type,
          uw.value AS uw_noi,
          mr.value AS trailing_noi,
          amt.value AS balance
     FROM corpus.loans l
     LEFT JOIN corpus.facts uw  ON uw.loan_id  = l.id AND uw.metric_key  = 'noi_underwritten'
     LEFT JOIN corpus.facts mr  ON mr.loan_id  = l.id AND mr.metric_key  = 'noi_most_recent'
     LEFT JOIN corpus.facts amt ON amt.loan_id = l.id AND amt.metric_key = 'loan_amount'
    WHERE l.accession = $1
    ORDER BY l.row_index`,
  [filing.accession],
);

// ---------------------------------------------------------------------------
// Lado servicer
// ---------------------------------------------------------------------------

const reports = await findServicerReports(cikArg, { max: months });
if (reports.length === 0) {
  console.error(`\n✗ No 10-D with an identifiable EX-99.1 for this trust.\n`);
  await closePool();
  process.exit(1);
}

const collected: Array<{ label: string; loans: ReturnType<typeof parseServicerReport>["loans"] }> = [];
for (const report of reports) {
  const html = await fetchText(report.documentUrl);
  collected.push({
    label: report.periodOfReport || report.filedAt,
    loans: parseServicerReport(html).loans,
  });
}

const merged = mergeServicerReports(collected);

console.log(
  `  Servicer    ${reports[0]!.accession} · ${reports[0]!.periodOfReport} · ` +
    `${merged.loans.length} loans with full-year NOI`,
);

// ---------------------------------------------------------------------------
// The check that decides everything
// ---------------------------------------------------------------------------

const corpusByInt = new Map<number, (typeof corpusLoans)[number]>();
let corpusNoRef = 0;
let corpusDupes = 0;

for (const l of corpusLoans) {
  const key = loanInt(l.loan_ref);
  if (key === null) {
    corpusNoRef++;
    continue;
  }
  if (corpusByInt.has(key)) corpusDupes++;
  else corpusByInt.set(key, l);
}

const servicerByInt = new Map<number, (typeof merged.loans)[number]>();
for (const l of merged.loans) {
  const key = loanInt(l.loanId);
  if (key !== null) servicerByInt.set(key, l);
}

const matched: number[] = [];
const servicerOnly: number[] = [];
for (const key of servicerByInt.keys()) {
  if (corpusByInt.has(key)) matched.push(key);
  else servicerOnly.push(key);
}
const corpusOnly = [...corpusByInt.keys()].filter((k) => !servicerByInt.has(k));

console.log(`\n${"─".repeat(78)}`);
console.log(`Correspondencia de identificadores`);
console.log(`${"─".repeat(78)}\n`);

console.log(`  corpus with Loan ID       ${String(corpusByInt.size).padStart(4)}`);
if (corpusNoRef > 0) console.log(`  corpus without Loan ID    ${String(corpusNoRef).padStart(4)}  \x1b[33m⚠\x1b[0m`);
if (corpusDupes > 0) console.log(`  corpus with repeated ID   ${String(corpusDupes).padStart(4)}  \x1b[33m⚠ unfiltered property rows\x1b[0m`);
console.log(`  servicer usable           ${String(servicerByInt.size).padStart(4)}`);
console.log(`  \x1b[1mmatched                   ${String(matched.length).padStart(4)}\x1b[0m`);
if (servicerOnly.length > 0) {
  console.log(`  solo en servicer          ${String(servicerOnly.length).padStart(4)}  \x1b[90m(${servicerOnly.slice(0, 10).join(", ")})\x1b[0m`);
}
if (corpusOnly.length > 0) {
  console.log(`  corpus only               ${String(corpusOnly.length).padStart(4)}  \x1b[90m(${corpusOnly.slice(0, 10).join(", ")})\x1b[0m`);
}

const matchRate = servicerByInt.size ? matched.length / servicerByInt.size : 0;
console.log();
if (matchRate >= 0.9) {
  console.log(`  \x1b[32mThe numbering matches (${pct(matchRate, 0)}). The join works.\x1b[0m`);
} else if (matchRate >= 0.6) {
  console.log(`  \x1b[33mPartial match (${pct(matchRate, 0)}). Review the ones that do not join before scaling.\x1b[0m`);
} else {
  console.log(`  \x1b[31mThe numbering does NOT match (${pct(matchRate, 0)}).\x1b[0m`);
  console.log(`  The assumption that Pros ID = Loan ID is false for this issuer.`);
  console.log(`  We would have to join on another key —property name, balance— before continuing.`);
}

// ---------------------------------------------------------------------------
// First Griffin-style measurement
// ---------------------------------------------------------------------------

interface Pair {
  key: number;
  type: string;
  uw: number;
  actual: number;
  trailing: number | null;
  gap: number;
}

const pairs: Pair[] = [];
for (const key of matched) {
  const c = corpusByInt.get(key)!;
  const s = servicerByInt.get(key)!;
  const uw = Number(c.uw_noi);
  if (!Number.isFinite(uw) || uw <= 0) continue;
  if (!(s.annualizedNoi > 0)) continue;

  const trailingRaw = Number(c.trailing_noi);
  pairs.push({
    key,
    type: c.property_type ?? "—",
    uw,
    actual: s.annualizedNoi,
    trailing: Number.isFinite(trailingRaw) && trailingRaw > 0 ? trailingRaw : null,
    gap: uw / s.annualizedNoi - 1,
  });
}

if (pairs.length === 0) {
  console.log(`\n  \x1b[33mNo loan has both an underwritten NOI and an actual NOI.\x1b[0m\n`);
} else {
  pairs.sort((a, b) => b.gap - a.gap);

  console.log(`\n${"─".repeat(78)}`);
  console.log(`Underwritten against actual — first Griffin-style measurement`);
  console.log(`${"─".repeat(78)}\n`);

  /**
   * The historical column is what separates a finding from an artefact.
   *
   * A 200% gap against the outcome can be two very different things: an
   * aggressive projection that did not materialise, or a scale problem in the
   * data. They are told apart by looking at the trailing figure: if the
   * underwritten number was also far above the historical one, it was a bet on
   * growth and it lost. If the underwritten number hugged the historical one and
   * only the actual came out far away, the property collapsed —or we are
   * comparing different things.
   */
  console.log(`  loan  type             underwritten NOI  historical   actual NOI 2025     gap`);
  const show = [...pairs.slice(0, 5), ...(pairs.length > 10 ? pairs.slice(-5) : [])];
  const shown = new Set<number>();
  for (const p of show) {
    if (shown.has(p.key)) continue;
    shown.add(p.key);
    const color = p.gap >= 0.05 ? "\x1b[33m" : p.gap < 0 ? "\x1b[32m" : "";
    console.log(
      `  ${String(p.key).padEnd(5)} ${p.type.slice(0, 14).padEnd(15)} ` +
        `${money(p.uw).padStart(13)} ${(p.trailing === null ? "—" : money(p.trailing)).padStart(13)} ` +
        `${money(p.actual).padStart(16)}   ${color}${pct(p.gap).padStart(7)}\x1b[0m`,
    );
  }
  if (pairs.length > 10) console.log(`  \x1b[90m  ... ${pairs.length - 10} in between\x1b[0m`);

  /**
   * The extremes are separated from the rest.
   *
   * With a two-digit n, two loans with a 200% gap move any aggregate. We do not
   * discard them —they may be real— but they are listed separately with their
   * trailing figure alongside, so someone can look at them one by one before they
   * enter a conclusion.
   */
  const extreme = pairs.filter((p) => Math.abs(p.gap) >= 1);
  if (extreme.length > 0) {
    console.log(
      `\n  \x1b[33m${extreme.length} loan(s) with a gap ≥100%: check by hand before believing them\x1b[0m`,
    );
    for (const p of extreme) {
      const vsHist = p.trailing ? p.uw / p.trailing - 1 : null;
      const growth = p.trailing ? p.actual / p.trailing - 1 : null;
      console.log(
        `    loan ${p.key} (${p.type}): underwritten ${pct(vsHist)} above the historical figure, ` +
          `and the property ${growth === null ? "?" : growth >= 0 ? `grew ${pct(growth)}` : `fell ${pct(Math.abs(growth))}`}`,
      );
    }
    const medianExGap = (() => {
      const g = pairs.filter((p) => Math.abs(p.gap) < 1).map((p) => p.gap).sort((a, b) => a - b);
      return g.length ? g[Math.floor(g.length / 2)]! : null;
    })();
    if (medianExGap !== null) {
      console.log(
        `    \x1b[90mWithout them the median is ${pct(medianExGap)} (n=${pairs.length - extreme.length}).\x1b[0m`,
      );
    }
  }

  const gaps = pairs.map((p) => p.gap).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  const above5 = gaps.filter((g) => g >= 0.05).length;

  console.log(`\n  n                    ${String(pairs.length).padStart(6)}`);
  console.log(`  median gap           ${pct(median).padStart(6)}`);
  console.log(
    `  with a gap ≥5%       ${pct(above5 / pairs.length, 0).padStart(6)}  ` +
      `\x1b[90m(Griffin 2013-2019: 29%)\x1b[0m`,
  );

  /**
   * The contrast that one trust does allow.
   *
   * Against the trailing figure we already knew office pulls away. What is new is
   * against the outcome: if the gap vs actual is similar to the gap vs
   * historical, the underwriter was right and was only projecting contractual
   * growth. If it is much larger, the projection did not materialise.
   */
  const withTrailing = pairs.filter((p) => p.trailing !== null);
  if (withTrailing.length >= 5) {
    const vsTrailing = withTrailing
      .map((p) => p.uw / p.trailing! - 1)
      .sort((a, b) => a - b);
    const vsActual = withTrailing.map((p) => p.gap).sort((a, b) => a - b);
    const mT = vsTrailing[Math.floor(vsTrailing.length / 2)]!;
    const mA = vsActual[Math.floor(vsActual.length / 2)]!;

    /**
     * The number both gaps imply, and that neither shows on its own.
     *
     * If the underwriter projected X% over the historical figure and the outcome
     * came in Y% below what was underwritten, then the property grew
     * (1+X)/(1+Y) − 1. That is the business figure: how much it actually grew
     * against how much it was expected to grow. The two gaps separately do not
     * say it.
     */
    const realGrowth = (1 + mT) / (1 + mA) - 1;

    console.log(`\n  Over the ${withTrailing.length} loans with all three figures:`);
    console.log(`    underwritten vs historical ${pct(mT).padStart(7)}   \x1b[90m(projected growth)\x1b[0m`);
    console.log(`    underwritten vs actual     ${pct(mA).padStart(7)}   \x1b[90m(what Griffin measures)\x1b[0m`);
    console.log(`    \x1b[1mactual vs historical       ${pct(realGrowth).padStart(7)}\x1b[0m   \x1b[90m(delivered growth)\x1b[0m`);
    console.log();
    if (mT > 0.02 && realGrowth < mT / 2) {
      console.log(
        `    \x1b[33m${pct(mT)} of growth was projected and ${pct(realGrowth)} was delivered.\x1b[0m`,
      );
      console.log(`    The properties ended up essentially where they started.`);
    } else if (realGrowth >= mT) {
      console.log(`    \x1b[32mThe properties grew at least as much as projected.\x1b[0m`);
      console.log(`    The gap against the historical figure was a correct projection.`);
    } else {
      console.log(
        `    \x1b[90m${pct(mT)} projected and ${pct(realGrowth)} delivered: partially met.\x1b[0m`,
      );
    }
  }

  console.log(
    `\n  \x1b[90mOne trust proves nothing. It is for checking the numbers are plausible\x1b[0m`,
  );
  console.log(`  \x1b[90mbefore harvesting thirty.\x1b[0m\n`);
}

await closePool();

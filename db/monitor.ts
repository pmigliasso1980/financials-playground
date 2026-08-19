/**
 * The monitor: what used to be a list of scripts to run by hand, running itself.
 *
 *   npm run db:monitor
 *
 * WHAT IT REPLACES
 *
 * The whole construction of the corpus ran on a manual loop: run a diagnostic
 * script, paste the output, read it together. That was good for DISCOVERING
 * —each run asked a new question— but it is the worst possible way to WATCH,
 * because it depends on someone remembering.
 *
 * The questions are already settled. What is left is for someone to ask them
 * every day without being told, and speak up only when something changed.
 *
 * THE RULE THAT MAKES A MONITOR GET READ
 *
 * **It only prints what changed.** A monitor that reports everything every time
 * teaches you to ignore it, and two weeks later nobody looks. If the corpus is
 * unchanged, this is three lines.
 *
 * IT COMPARES AGAINST THE PREVIOUS RUN, NOT AGAINST INVENTED THRESHOLDS
 *
 * "DSCR coverage is 78%" says nothing without a reference: it could be normal
 * for this corpus or a twenty-point drop. What matters is the change, so each
 * run saves its snapshot to `out/health.json` and the next one compares.
 *
 * The first run cannot alert on anything —there is nothing to compare against—
 * and it says so instead of pretending everything is fine.
 *
 * IT EXITS 1 IF THERE IS SOMETHING TO LOOK AT
 *
 * So it works in cron: `npm run db:monitor || send-mail`. A monitor that always
 * exits 0 is a log.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { closePool, ping, query } from "./client.js";
import { corpusState, provenanceStamp } from "./provenance.js";
import { STATE_CODES } from "../harvest/normalize/states.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** How far a coverage figure can fall before it is news. */
const DROP_ALERT = 0.02;

const FILE = new URL("../out/health.json", import.meta.url).pathname;
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

interface Snapshot {
  date: string;
  taxonomy: string;
  loans: number;
  issuances: number;
  coverage: Record<string, number>;
  withoutType: number;
  unmappedHeaders: string[];
}

/**
 * The metrics the product uses. If coverage of one of these falls, `/comps`
 * starts answering with less backing and nothing says so.
 */
const KEY_METRICS = ["loan_amount", "dscr", "ltv", "debt_yield", "interest_rate"];

/**
 * THE FIELD WE NEVER AUDITED.
 *
 * `/comps` filters on four fields: state, type, amount and date. Of the four,
 * three had been reviewed —type has its own diagnostic, amount and the metrics
 * have watched coverage— and state never had.
 *
 * The suspicion arrived sideways: industrial in California returns 9 comparables
 * and the entire Pacific division also 9. Oregon, Washington, Alaska and Hawaii
 * contribute none in eighteen months. Seattle and Portland are real industrial
 * markets, so either it is genuine, or the state is written differently in some
 * documents and those loans do not enter any query.
 *
 * An invalid state is not like a coverage figure that falls: it is a defect
 * whether or not the previous run had it, so it is reported ALWAYS and not only
 * when it changes.
 *
 * THE CRITERION IS /COMPS'S, NOT ITS OWN
 *
 * The first version asked `~ '^[A-Za-z]{2}$'`, which is MORE PERMISSIVE than the
 * product: `/comps` compares `btrim(state) = ANY($1)` against uppercase codes. A
 * lowercase "ny" passed the monitor and matched no query — exactly the defect
 * this check exists to find, invisible to the check itself.
 *
 * And any two letters is not enough either: "XX" is syntactically a code and is
 * no state at all. The list comes from `states.ts`, the same one the harvester
 * uses, so that there are not two definitions of "valid state".
 */
async function invalidStates() {
  const filter = `state IS NULL OR NOT (btrim(state) = ANY($1))`;

  /**
   * THE TOTAL IS COUNTED SEPARATELY, AND THIS LINE IS A CORRECTION.
   *
   * The previous version summed the twelve rows it prints, so it reported the
   * size of the problem from the slice it had decided to show. It said "1,585
   * loans" when there were 1,900: a 20% undercount, in the very number that
   * justifies fixing it.
   *
   * It is the same error as the tests that could not fail —measuring against
   * what you already chose to look at— and it surfaced here because the fix
   * recovered 1,107 where I had predicted 795.
   */
  const { rows: tot } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM corpus.loans WHERE ${filter}`,
    [[...STATE_CODES]],
  );
  const { rows } = await query<{ value: string; n: string }>(
    `SELECT coalesce(nullif(btrim(state), ''), '(empty)') AS value, count(*)::text AS n
       FROM corpus.loans
      WHERE ${filter}
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 12`,
    [[...STATE_CODES]],
  );
  return {
    total: Number(tot[0]!.n),
    distinct: rows.map((r) => ({ value: r.value, n: Number(r.n) })),
  };
}

async function takeSnapshot(): Promise<Snapshot> {
  const e = await corpusState();

  const { rows: cov } = await query<{ metric: string; n: string }>(
    `SELECT metric_key AS metric, count(DISTINCT loan_id)::text AS n
       FROM corpus.facts
      WHERE metric_key = ANY($1) AND value ~ '^[0-9.]+$'
      GROUP BY 1`,
    [KEY_METRICS],
  );
  const coverage: Record<string, number> = {};
  for (const r of cov) coverage[r.metric] = Number(r.n) / Math.max(1, e.loans);

  const { rows: st } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM corpus.loans WHERE property_type IS NULL`,
  );

  /**
   * Unmapped headers are the parser's work queue: if a new one appears, an
   * issuer changed format and we are losing a column.
   */
  const { rows: hs } = await query<{ header: string }>(
    `SELECT header FROM corpus.unmapped_headers ORDER BY filings DESC LIMIT 400`,
  );

  return {
    date: new Date().toISOString(),
    taxonomy: e.taxonomy,
    loans: e.loans,
    issuances: e.issuances,
    coverage,
    withoutType: Number(st[0]!.n),
    unmappedHeaders: hs.map((r) => r.header),
  };
}

const today = await takeSnapshot();
const invalid = await invalidStates();

/**
 * The states with fewer loans than their market would lead you to expect. It is
 * not an alert —it may be genuine— but it is the figure you need in order to
 * decide whether an empty region is the market or the parser.
 */
const { rows: byState } = await query<{ state: string; n: string }>(
  `SELECT btrim(state) AS state, count(*)::text AS n
     FROM corpus.loans
    WHERE btrim(state) = ANY($1)
    GROUP BY 1 ORDER BY count(*) DESC`,
  [[...STATE_CODES]],
);
const state = await corpusState();
await closePool();

let previous: Snapshot | null = null;
try {
  previous = JSON.parse(await readFile(FILE, "utf8")) as Snapshot;
} catch {
  previous = null;
}

const alerts: string[] = [];
const notes: string[] = [];

/**
 * This one needs no comparison: more than one taxonomy version coexisting means
 * part of the corpus was harvested with a different mapping, and any query
 * spanning both mixes two different criteria.
 */
if (state.versions > 1) {
  alerts.push(
    `${state.versions} taxonomy versions coexist in the corpus: part was never re-harvested`,
  );
}

if (!previous) {
  notes.push("First run: there is no previous snapshot to compare against.");
} else {
  if (today.taxonomy !== previous.taxonomy) {
    notes.push(
      `Taxonomy: ${previous.taxonomy} → ${today.taxonomy} (the numbers may move)`,
    );
  }

  const dLoans = today.loans - previous.loans;
  if (dLoans !== 0) {
    notes.push(
      `Loans: ${previous.loans.toLocaleString("en-US")} → ${today.loans.toLocaleString("en-US")}` +
        ` (${dLoans > 0 ? "+" : ""}${dLoans.toLocaleString("en-US")})`,
    );
  }

  for (const m of KEY_METRICS) {
    const before = previous.coverage[m] ?? 0;
    const now = today.coverage[m] ?? 0;
    if (before - now >= DROP_ALERT) {
      alerts.push(
        `Coverage of ${m} fell from ${pct(before)} to ${pct(now)} — /comps answers with less backing`,
      );
    }
  }

  /**
   * The type gap is measured as a share, not a count: if the corpus grows 20%
   * it is normal for the number of loans without a type to rise, and that is
   * not a regression.
   */
  const beforeShare = previous.withoutType / Math.max(1, previous.loans);
  const nowShare = today.withoutType / Math.max(1, today.loans);
  if (nowShare - beforeShare >= 0.005) {
    alerts.push(
      `Loans without a property type: ${pct(beforeShare, 2)} → ${pct(nowShare, 2)}` +
        ` (${previous.withoutType} → ${today.withoutType})`,
    );
  }

  const added = today.unmappedHeaders.filter((h) => !previous!.unmappedHeaders.includes(h));
  if (added.length > 0) {
    alerts.push(
      `${added.length} unmapped header(s) that were not there before — an issuer changed format:\n` +
        added.slice(0, 6).map((h) => `      · ${h.slice(0, 70)}`).join("\n"),
    );
  }
}

if (invalid.total > 0) {
  const shown = invalid.distinct.reduce((t, i) => t + i.n, 0);
  const rest = invalid.total - shown;
  alerts.push(
    `${invalid.total} loans with an invalid or empty state — they enter no /comps query:\n` +
      invalid.distinct.map((i) => `      "${i.value}" × ${i.n}`).join("\n") +
      (rest > 0 ? `\n      \x1b[90m… and ${rest} more across other values\x1b[0m` : ""),
  );
}

await mkdir(new URL("../out/", import.meta.url).pathname, { recursive: true });
await writeFile(FILE, JSON.stringify(today, null, 2), "utf8");

// ---------------------------------------------------------------------------

console.log(`\n  ${provenanceStamp(state)}`);
console.log(
  `  \x1b[90m${byState.length} states with a valid code · ` +
    `the five with the most loans: ${byState.slice(0, 5).map((e) => `${e.state} ${e.n}`).join(" · ")}\x1b[0m`,
);
/**
 * States with a real market and few loans are the clue to a harvesting gap.
 * They are listed without alarm: it could be the market and it could be the
 * parser.
 */
const BIG_STATES = ["CA", "TX", "NY", "FL", "IL", "PA", "OH", "GA", "NC", "MI", "NJ", "VA", "WA", "AZ", "MA"];
const howMany = (g: string) => Number(byState.find((e) => e.state === g)?.n ?? 0);
const thin = BIG_STATES.filter((g) => howMany(g) < 30);
if (thin.length > 0) {
  console.log(
    `  \x1b[90mbig states with fewer than 30 loans: ` +
      `${thin.map((f) => `${f} (${howMany(f)})`).join(" · ")}\x1b[0m`,
  );
}

if (alerts.length === 0 && notes.length === 0) {
  console.log(`\n  \x1b[32mNo changes.\x1b[0m\n`);
  process.exit(0);
}

for (const n of notes) console.log(`\n  \x1b[90m· ${n}\x1b[0m`);

if (alerts.length > 0) {
  console.log(`\n  \x1b[31m${alerts.length} thing(s) to look at:\x1b[0m\n`);
  for (const a of alerts) console.log(`  \x1b[33m→ ${a}\x1b[0m`);
  console.log(`\n  \x1b[90mDiagnosis of the type gap:  npm run db:type-gap\x1b[0m`);
  console.log(`  \x1b[90mCoverage by metric:         npm run db:coverage\x1b[0m\n`);
  process.exit(1);
}

console.log();
process.exit(0);

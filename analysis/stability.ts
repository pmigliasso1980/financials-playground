/**
 * Are the origination distributions comparable across vintages?
 *
 *   npm run db:stability
 *
 * WHY THIS QUESTION COMES FIRST
 *
 * The corpus hit its ceiling for outcome questions: transfer to special servicing
 * is a rare event (2.4%) over a bounded universe, and the 10-D history only buys
 * 1.33x. Four independent routes reached the same place.
 *
 * What there is plenty of is ORIGINATION data: 9,751 loans, 94 metrics, identities
 * closing at 90-98%. There the cells have thousands of observations rather than
 * dozens.
 *
 * But any question that pools vintages —a historical reference distribution, or a
 * cross-section over the whole corpus— assumes a 2021 loan and a 2024 loan are
 * comparable. Between those two dates the interest rate went from ~3.5% to ~7%, and
 * that drags DSCR and debt yield along by construction, not by anyone's decision.
 *
 * If the distributions are not stable, the reference measures the cycle and not the
 * issuance. That breaks the profile benchmark AND breaks the cross-sections. One
 * test decides both directions, which is why it comes before writing anything.
 *
 * HOW IT IS MEASURED
 *
 * For each metric, the median per vintage and the range between the highest and the
 * lowest, normalised by the global median. A 10% shift is noise; a 60% one means
 * the vintages are different populations.
 *
 * It is not a hypothesis test: with thousands of observations per cell any
 * difference comes out significant. What matters is the MAGNITUDE relative to the
 * use you want to put it to.
 *
 * WHAT THIS TEST CANNOT SAY
 *
 * That a metric is stable does not make it comparable if its meaning changed. LTV
 * is computed against an appraisal, and 2021 and 2024 appraisals do not measure the
 * same market even if the ratio comes out similar.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Fixed before looking at anything. */
const TOLERABLE_SHIFT = 0.2;
const MIN_PER_VINTAGE = 100;

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

/**
 * The metrics a profile benchmark would use, and their sanity ranges.
 *
 * The ranges discard the known rubbish —the DSCR of 91,617 we have been carrying
 * since `db:predictors`, the LTVs that arrive as a percentage without dividing—
 * without which the median holds up but the quartiles do not.
 */
const METRICS: Array<{ key: string; label: string; min: number; max: number; fmt: (v: number) => string }> = [
  { key: "interest_rate", label: "Interest rate", min: 0.001, max: 0.2, fmt: (v) => pct(v, 2) },
  { key: "dscr", label: "DSCR", min: 0.1, max: 20, fmt: (v) => v.toFixed(2) },
  { key: "ltv", label: "LTV", min: 0.01, max: 2, fmt: (v) => pct(v, 1) },
  { key: "debt_yield", label: "Debt yield", min: 0.01, max: 1, fmt: (v) => pct(v, 1) },
  { key: "loan_amount", label: "Balance", min: 1e5, max: 1e10, fmt: (v) => `${(v / 1e6).toFixed(1)}M` },
  { key: "occupancy", label: "Occupancy", min: 0.1, max: 1.01, fmt: (v) => pct(v, 1) },
  { key: "term_original", label: "Term (months)", min: 12, max: 480, fmt: (v) => v.toFixed(0) },
];

console.log(`\n${"═".repeat(78)}`);
console.log("Are the vintages comparable? — the test that decides whether there is a reference");
console.log(`${"═".repeat(78)}`);

const { rows: vintages } = await query<{ vintage: string; n: string }>(
  `SELECT extract(year FROM f.filed_at)::int::text AS vintage, count(l.id)::text AS n
     FROM corpus.filings f JOIN corpus.loans l ON l.accession = f.accession
    WHERE f.filed_at IS NOT NULL
    GROUP BY 1 HAVING count(l.id) >= ${MIN_PER_VINTAGE}
    ORDER BY 1`,
);

const cols = vintages.map((a) => a.vintage);
console.log(
  `\n\x1b[90m  ${cols.length} vintages with ≥ ${MIN_PER_VINTAGE} loans: ` +
    `${vintages.map((a) => `${a.vintage} (${a.n})`).join(" · ")}\x1b[0m\n`,
);

console.log(
  `  metric           ` + cols.map((c) => c.padStart(9)).join("") + `   shift      null  ×null`,
);
console.log(`  ${"─".repeat(20 + cols.length * 9 + 12)}`);

interface Resultado {
  label: string;
  shift: number;
  monotona: boolean;
  /** How much it would shift by pure sampling if the vintages were exchangeable. */
  nullMedian: number | null;
  pValor: number;
}

/** Fixed seed: a p-value that changes between runs cannot be quoted. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const results: Resultado[] = [];

for (const m of METRICS) {
  const { rows } = await query<{ vintage: string; median: string | null; n: string; values: number[] }>(
    `SELECT extract(year FROM f.filed_at)::int::text AS vintage,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY fa.value::numeric)::text AS median,
            count(*)::text AS n,
            array_agg(fa.value::numeric) AS values
       FROM corpus.facts fa
       JOIN corpus.loans l ON l.id = fa.loan_id
       JOIN corpus.filings f ON f.accession = l.accession
      WHERE fa.metric_key = $1
        AND fa.value ~ '^-?[0-9.]+$'
        AND fa.value::numeric BETWEEN ${m.min} AND ${m.max}
        AND f.filed_at IS NOT NULL
      GROUP BY 1 HAVING count(*) >= ${MIN_PER_VINTAGE}
      ORDER BY 1`,
    [m.key],
  );

  const byVintage = new Map(rows.map((r) => [r.vintage, Number(r.median)]));
  const values = cols.map((c) => byVintage.get(c) ?? null);
  const present = values.filter((v): v is number => v !== null);

  if (present.length < 3) {
    console.log(`  ${m.label.padEnd(17)}` + `\x1b[90m  no sufficient sample\x1b[0m`);
    continue;
  }

  const high = Math.max(...present);
  const low = Math.min(...present);
  const center = present.slice().sort((a, b) => a - b)[Math.floor(present.length / 2)]!;
  const shift = center !== 0 ? (high - low) / Math.abs(center) : 0;

  /**
   * Monotone or not: a large shift that zigzags is composition noise; one that
   * always goes the same way is a market trend, and that is the one that makes the
   * vintages non-exchangeable.
   */
  let subiendo = true;
  let bajando = true;
  for (let i = 1; i < present.length; i++) {
    if (present[i]! < present[i - 1]!) subiendo = false;
    if (present[i]! > present[i - 1]!) bajando = false;
  }
  const monotona = subiendo || bajando;

  /**
   * THE NULL FOR THE SHIFT, WHICH WAS MISSING.
   *
   * The 20% threshold was fixed a priori and with no reference. But the per-vintage
   * medians vary by sampling even if the vintages are identical, so
   * `(max − min) / median` has an expected value GREATER THAN ZERO that grows with
   * the number of vintages and falls with each cell's n. Comparing against 20%
   * without knowing what the null is worth is the class of error this session found
   * seven times.
   *
   * It simulates what the question asserts: if the vintages were exchangeable, you
   * draw from a common pool as many values as each one has and recompute the shift.
   * The observed value is compared against that distribution.
   *
   * A note on cost: this resamples thousands of values per metric, so it uses 600
   * replicates rather than 2,000. With an observed value usually ten times above the
   * null, the p-value's precision is not what decides.
   */
  const REPLICAS = 600;
  const pool = rows.flatMap((r) => (r.values ?? []).map(Number)).filter(Number.isFinite);
  const sizes = rows
    .filter((r) => byVintage.has(r.vintage))
    .map((r) => Number(r.n));

  let nullMedian: number | null = null;
  let pValor = 1;

  if (pool.length > 0 && sizes.length >= 3) {
    const rand = rng(0xC0FFEE);
    const simulated: number[] = [];
    for (let k = 0; k < REPLICAS; k++) {
      const medians: number[] = [];
      for (const n of sizes) {
        // Sampling with replacement from the common pool: the exchangeability hypothesis.
        const sample: number[] = [];
        for (let i = 0; i < n; i++) sample.push(pool[Math.floor(rand() * pool.length)]!);
        sample.sort((a, b) => a - b);
        const mid = sample.length >> 1;
        medians.push(
          sample.length % 2 ? sample[mid]! : (sample[mid - 1]! + sample[mid]!) / 2,
        );
      }
      const c = medians.slice().sort((a, b) => a - b)[Math.floor(medians.length / 2)]!;
      simulated.push(c !== 0 ? (Math.max(...medians) - Math.min(...medians)) / Math.abs(c) : 0);
    }
    simulated.sort((a, b) => a - b);
    nullMedian = simulated[Math.floor(simulated.length / 2)]!;
    pValor = simulated.filter((x) => x >= shift).length / simulated.length;
  }

  results.push({ label: m.label, shift, monotona, nullMedian, pValor });

  const color =
    shift > TOLERABLE_SHIFT ? "\x1b[31m" : "\x1b[32m";
  console.log(
    `  ${m.label.padEnd(17)}` +
      values.map((v) => (v === null ? "—" : m.fmt(v)).padStart(9)).join("") +
      `   ${color}${pct(shift).padStart(7)}\x1b[0m` +
      `  \x1b[90m${nullMedian === null ? "  —" : pct(nullMedian).padStart(6)}\x1b[0m` +
      /**
       * The ratio against the null, which is what the p-value does not say.
       *
       * With thousands of loans per cell EVERYTHING comes out significant — the
       * docstring itself anticipated that — so the p decides nothing. What matters
       * is how many times the observed shift exceeds the noise: below 2x, the 20%
       * threshold is doing sampling's work and not the market's.
       *
       * Balance is the case: a null of 16% because its median has fat tails. With
       * an observed 106% there is plenty of room, but had it been 25% the a priori
       * criterion would have said "unstable" with 1.5x of margin over the noise.
       */
      `  ${
        nullMedian === null || nullMedian === 0
          ? "\x1b[90m    —\x1b[0m"
          : (() => {
              const veces = shift / nullMedian;
              return `${veces < 2 ? "\x1b[33m" : "\x1b[90m"}${veces.toFixed(1)}x\x1b[0m`;
            })()
      }` +
      `${monotona ? " \x1b[33m↗\x1b[0m" : ""}`,
  );
}

console.log(
  `\n  \x1b[90mShift = (max − min) / central median. The "null" column is how much it\x1b[0m`,
);
console.log(
  `  \x1b[90mwould shift by pure sampling if the vintages were exchangeable:\x1b[0m`,
);
console.log(
  `  \x1b[90myou draw from a common pool as many values as each vintage has and\x1b[0m`,
);
console.log(
  `  \x1b[90mrecompute. The threshold of ${pct(TOLERABLE_SHIFT)} was fixed a priori with no reference;\x1b[0m`,
);
console.log(
  `  \x1b[90mnow you can see whether it sits above or below the null. Threshold ${pct(TOLERABLE_SHIFT)},\x1b[0m`,
);
console.log(
  `  \x1b[90mfixed before looking. ↗ marks the ones that always move in the same\x1b[0m`,
);
console.log(`  \x1b[90mdirection: a market trend, not composition noise.\x1b[0m`);
/**
 * WHAT THE NULL REVEALED IN THIS CORPUS, AND IN WHICH DIRECTION
 *
 * The measured ratios: Rate 10.9x · DSCR 10.0x · LTV 11.5x · Debt yield 5.8x ·
 * Balance 6.8x · Occupancy 3.4x. None below 2x, so the 20% threshold has margin on
 * all seven.
 *
 * The worry this column was added for was Balance: its null is 16% —eight times
 * LTV's, because its median has fat tails— and with a fixed 20% threshold that
 * leaves little air. But the observed value is 106%, so the fear was a conditional
 * that did not materialise.
 *
 * What the table does show runs the other way. LTV and Debt yield are both at 21%,
 * barely above the threshold, and are 11.5x and 5.8x the noise. The 20% criterion
 * almost classified them as stable when they are overwhelmingly above sampling:
 * here the risk is the threshold being too STRICT.
 *
 * That does not change the verdict —the six unstable ones are unstable by both
 * yardsticks— but it does change which yardstick to look at if a metric drops to
 * 18% tomorrow.
 */

/**
 * THE TWO QUESTIONS ARE DIFFERENT AND WORTH NOT MIXING.
 *
 * The 20% threshold asks whether the shift is LARGE. The null asks whether it is
 * REAL. Occupancy shifts 3% against a null of 1%: real and negligible at once, and
 * both are true.
 *
 * What decides whether there is a pooled reference is the first —a 3% shift does
 * not ruin a reference— so the verdict still uses the threshold. The null enters as
 * a check that the threshold sits above the noise, and there the single case where
 * it does not with margin appears.
 */
const nearNoise = results.filter(
  (r) => r.nullMedian !== null && r.nullMedian > 0 && r.shift / r.nullMedian < 2,
);
if (nearNoise.length > 0) {
  console.log(
    `\n  \x1b[33mNote:\x1b[0m ${nearNoise.map((r) => r.label).join(", ")} ` +
      `ha(ve) a shift less than`,
  );
  console.log(
    `  \x1b[90m2x the sampling noise. There the ${pct(TOLERABLE_SHIFT)} threshold does not separate market\x1b[0m`,
  );
  console.log(`  \x1b[90mfrom chance, and the verdict on that metric cannot be quoted.\x1b[0m`);
}

const unstable = results.filter((r) => r.shift > TOLERABLE_SHIFT);
const trending = unstable.filter((r) => r.monotona);

console.log(`\n${"─".repeat(78)}\n`);
console.log(
  `  ${unstable.length} of ${results.length} metrics shift more than ` +
    `${pct(TOLERABLE_SHIFT)}` +
    (trending.length > 0 ? `, ${trending.length} with a monotone trend` : ""),
);

if (unstable.length === 0) {
  console.log(
    `\n  \x1b[32mThe vintages are comparable.\x1b[0m A pooled reference is defensible.\n`,
  );
} else {
  console.log(
    `\n  \x1b[31mNo son intercambiables:\x1b[0m ${unstable.map((r) => r.label).join(", ")}.`,
  );
  console.log(
    `\n  \x1b[90mA pooled historical reference over those metrics would measure the cycle\x1b[0m`,
  );
  console.log(
    `  \x1b[90mand not the issuance. The reference has to be PER VINTAGE or against trend.\x1b[0m`,
  );
  console.log(
    `\n  \x1b[90mAnd that has a cost worth stating now: per vintage, each cell's n is\x1b[0m`,
  );
  console.log(
    `  \x1b[90mdivided by five, which is the same constraint that already stopped us.\x1b[0m\n`,
  );
}

// ---------------------------------------------------------------------------
// Does the term explain the drift better than the vintage?
// ---------------------------------------------------------------------------

/**
 * The finding I did not see coming, and its consequence.
 *
 * The term went from 120 months to 60 between 2022 and 2024, monotonically, and it
 * is the only metric on the board that always moves the same way. The market shifted
 * from ten-year loans to five-year loans — which is why the BANK5, BBCMS 5C and BMO
 * 5C shelves exist, names we had been reading for two days without registering what
 * they meant.
 *
 * That is not a nuisance: it is a change of product. And if the product is what
 * changed, the correct comparison axis is not the vintage but the term.
 *
 * WHY IT MATTERS FOR THE ARITHMETIC
 *
 * By vintage the n divides by nine. By term it divides by two: ~5,000 ten-year
 * loans and ~4,700 five-year. That is the difference between having a reference and
 * not having one.
 *
 * HOW TO READ IT
 *
 * For each metric, the shift between vintages WITHIN each term bucket, against the
 * global shift from the previous table.
 *
 *   falls a lot  →  the drift was the product change: reference by term
 *   does not fall →  it is pure macro and there is no alternative to the vintage
 *
 * WHAT CANNOT HAPPEN AND HAS TO BE WATCHED
 *
 * The buckets are almost perfectly separated in time: 10 years is 2013-2022 and 5
 * years is 2023-2026. If few vintages remain inside a bucket, the shift falls for
 * lack of temporal range and not because the term explains anything. That is why
 * how many vintages each bucket has is printed BEFORE the
 * resultado.
 */
const BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "≤ 84 months", min: 12, max: 84 },
  { label: "> 84 months", min: 85, max: 480 },
];

console.log(`\n${"═".repeat(78)}`);
console.log("Does the term explain the drift better than the vintage?");
console.log(`${"═".repeat(78)}`);

for (const b of BUCKETS) {
  const { rows: coverage } = await query<{ vintages: string; n: string }>(
    `SELECT count(DISTINCT extract(year FROM f.filed_at))::text AS vintages,
            count(*)::text AS n
       FROM corpus.facts t
       JOIN corpus.loans l ON l.id = t.loan_id
       JOIN corpus.filings f ON f.accession = l.accession
      WHERE t.metric_key = 'term_original' AND t.value ~ '^[0-9.]+$'
        AND t.value::numeric BETWEEN ${b.min} AND ${b.max}`,
  );

  const nVintages = Number(coverage[0]?.vintages ?? 0);
  console.log(
    `\n  \x1b[1m${b.label}\x1b[0m  ${Number(coverage[0]?.n ?? 0).toLocaleString("en-US")} loans ` +
      `across ${nVintages} vintages` +
      (nVintages < 3
        ? `  \x1b[31m← no temporal range: any fall is an artefact\x1b[0m`
        : ""),
  );
  if (nVintages < 3) continue;

  console.log(`    metric             global   within the bucket`);
  console.log(`    ${"─".repeat(48)}`);

  for (const m of METRICS) {
    if (m.key === "term_original") continue;
    const prev = results.find((r) => r.label === m.label);
    if (!prev) continue;

    const { rows } = await query<{ median: string | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY fa.value::numeric)::text AS median
         FROM corpus.facts fa
         JOIN corpus.loans l ON l.id = fa.loan_id
         JOIN corpus.filings f ON f.accession = l.accession
         JOIN corpus.facts t ON t.loan_id = l.id AND t.metric_key = 'term_original'
                            AND t.value ~ '^[0-9.]+$'
                            AND t.value::numeric BETWEEN ${b.min} AND ${b.max}
        WHERE fa.metric_key = $1
          AND fa.value ~ '^-?[0-9.]+$'
          AND fa.value::numeric BETWEEN ${m.min} AND ${m.max}
          AND f.filed_at IS NOT NULL
        GROUP BY extract(year FROM f.filed_at)
       HAVING count(*) >= 50
        ORDER BY extract(year FROM f.filed_at)`,
      [m.key],
    );

    const vals = rows.map((r) => Number(r.median)).filter((v) => Number.isFinite(v));
    if (vals.length < 3) {
      console.log(`    ${m.label.padEnd(18)} ${pct(prev.shift).padStart(6)}   \x1b[90m—\x1b[0m`);
      continue;
    }

    const center = vals.slice().sort((a, b2) => a - b2)[Math.floor(vals.length / 2)]!;
    const within = center !== 0 ? (Math.max(...vals) - Math.min(...vals)) / Math.abs(center) : 0;
    const improvement = prev.shift > 0 ? 1 - within / prev.shift : 0;

    console.log(
      `    ${m.label.padEnd(18)} ${pct(prev.shift).padStart(6)}   ` +
        `${(within <= TOLERABLE_SHIFT ? "\x1b[32m" : "\x1b[31m")}${pct(within).padStart(6)}\x1b[0m` +
        `   \x1b[90m${improvement > 0 ? `−${pct(improvement)}` : "no improvement"}\x1b[0m`,
    );
  }
}

console.log(
  `\n  \x1b[90mIf the shift within the bucket falls below ${pct(TOLERABLE_SHIFT)},\x1b[0m`,
);
console.log(
  `  \x1b[90mthe drift was the product change and the reference is built by term,\x1b[0m`,
);
console.log(
  `  \x1b[90mwith thousands of loans per cell. If it does not fall, it is macro and we\x1b[0m`,
);
console.log(`  \x1b[90mhave to go by vintage — with the n divided by nine.\x1b[0m\n`);

await closePool();

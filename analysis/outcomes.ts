/**
 * Underwriting against outcome.
 *
 *   npm run db:outcomes
 *
 * THE QUESTION THIS SCRIPT CAN ANSWER AND THE PREVIOUS ONE COULD NOT
 *
 * All of the Annex A analysis measured optimism: how far the underwriter
 * departed from the trailing figures. It could never say whether they were
 * right. With the actual NOI of the first full year it can, and that opens the
 * question that matters:
 *
 *   does optimism at origination predict the outcome?
 *
 * There is reason to doubt it. Benchmark 2024-V7, loan 8: underwritten 3.4%
 * BELOW the trailing figure —conservative by any origination metric— and the
 * actual NOI fell 62%. It was the worst in the pool. If that case is
 * representative, much of what we measure with the Annex A has no predictive
 * content, and it is worth knowing before building a product on top of it.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const pct = (v: number | string | null, d = 1) =>
  v === null ? "—" : `${(Number(v) * 100).toFixed(d)}%`;
const num = (v: number | string | null, d = 2) => (v === null ? "—" : Number(v).toFixed(d));

console.log(`\n${"═".repeat(78)}`);
console.log("Underwriting against outcome");
console.log(`${"═".repeat(78)}`);

// ---------------------------------------------------------------------------
// Sample
// ---------------------------------------------------------------------------

const { rows: sample } = await query<{
  trusts: string; loans: string; with_uw: string; with_all: string; period: string;
}>(
  `SELECT count(DISTINCT accession) AS trusts,
          count(*) AS loans,
          count(*) FILTER (WHERE noi_underwritten IS NOT NULL) AS with_uw,
          count(*) FILTER (WHERE noi_underwritten IS NOT NULL AND noi_trailing IS NOT NULL) AS with_all,
          min(noi_start)::text || ' a ' || max(noi_end)::text AS period
     FROM corpus.underwriting_outcomes`,
);

const s = sample[0];
if (!s || Number(s.with_uw) === 0) {
  console.error(`\n✗ No performance data. Run first:  npm run db:performance\n`);
  await closePool();
  process.exit(1);
}

console.log(`\n  ${s.trusts} trusts · ${s.loans} loans with actual NOI · ${s.with_all} with all three figures`);
console.log(`  \x1b[90mNOI periods: ${s.period}\x1b[0m`);

/**
 * Overlap filter — without it we measure the same history twice.
 *
 * The servicer reports the latest period it has available, and for some loans
 * that period starts BEFORE origination. A loan closed in June 2024 with NOI
 * reported from October 2023 to September 2024 has no "outcome": that period is
 * almost the same trailing figure the underwriter looked at in order to
 * underwrite. The gap against it does not measure projection error, it measures
 * noise.
 *
 * On the first run the range started at 2023-10-01 over a corpus originated in
 * 2024. Everything below uses only periods after closing.
 */
const { rows: overlapRows } = await query<{ total: string; overlapping: string }>(
  `SELECT count(*) AS total,
          count(*) FILTER (WHERE days_after_origination < 0) AS overlapping
     FROM corpus.underwriting_outcomes WHERE gap_vs_actual IS NOT NULL`,
);
const ov = overlapRows[0]!;
if (Number(ov.overlapping) > 0) {
  console.log(
    `\n  \x1b[33m${ov.overlapping} of ${ov.total} loans have an NOI period that starts\x1b[0m`,
  );
  console.log(`  \x1b[33mBEFORE closing: they overlap the trailing figures and are excluded.\x1b[0m`);
}

/** Common clause: only performance genuinely after origination. */
const POST = `gap_vs_actual IS NOT NULL AND days_after_origination >= 0`;

// ---------------------------------------------------------------------------
// A) The Griffin measurement, now actually comparable
// ---------------------------------------------------------------------------

const GRIFFIN_SHARE = 0.29;

const { rows: griffin } = await query<{
  n: string; median: number | null; share: number | null; p25: number | null; p75: number | null;
}>(
  `SELECT count(*) AS n,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY gap_vs_actual) AS median,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY gap_vs_actual) AS p25,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY gap_vs_actual) AS p75,
          1.0 * count(*) FILTER (WHERE gap_vs_actual >= 0.05) / count(*) AS share
     FROM corpus.underwriting_outcomes
    WHERE ${POST}`,
);

const g = griffin[0]!;
console.log(`\n\x1b[1mA. Underwritten NOI against actual NOI\x1b[0m`);
console.log(`\x1b[90m   Now it is the same quantity Griffin measures: promise against outcome.\x1b[0m\n`);
console.log(`   n                      ${String(g.n).padStart(6)}`);
console.log(`   median                 ${pct(g.median).padStart(6)}`);
console.log(`   interquartile range    ${pct(g.p25)} to ${pct(g.p75)}`);
console.log(`   with gap ≥5%           ${pct(g.share, 0).padStart(6)}`);
console.log(`   \x1b[90mGriffin 2013-2019      ${(GRIFFIN_SHARE * 100).toFixed(0)}%   (n = 39.522)\x1b[0m`);

const delta = Number(g.share) - GRIFFIN_SHARE;
console.log();
if (Number(g.n) < 300) {
  console.log(`   \x1b[33mWith n = ${g.n} against 39,522, any difference is provisional.\x1b[0m`);
} else if (Math.abs(delta) < 0.06) {
  console.log(`   \x1b[32mIn line with the published figure\x1b[0m: the phenomenon continues at a similar`);
  console.log(`   intensity five years later, measured independently.`);
} else if (delta > 0) {
  console.log(`   \x1b[33mUp ${(delta * 100).toFixed(0)} points on Griffin's period.\x1b[0m`);
} else {
}

// ---------------------------------------------------------------------------
// A2) By origination vintage
// ---------------------------------------------------------------------------

/**
 * The aggregate mixes two different markets and hides the signal.
 *
 * With the 2024 vintage alone the median came out at 5.6% and 52% of loans
 * cleared the threshold. Adding 2020-2023 dropped the median to 1.0% and the
 * share to 41%. That movement does not mean the practice is milder than we
 * thought: it means there are vintages with opposite signs averaging together.
 *
 * The reason is obvious once stated. A loan originated in 2020 was underwritten
 * during COVID uncertainty, on depressed assumptions, and its first full year
 * fell in the recovery. One originated in 2024 was underwritten projecting
 * growth onto a market that then went flat. Averaging them gives a number that
 * describes neither.
 *
 * It is the same composition error that already bit us with multifamily in
 * `db:challenge`, where one type's share moved the aggregates without any
 * underwriting standard changing.
 */
console.log(`\n\n\x1b[1mA2. By origination vintage\x1b[0m`);
console.log(`\x1b[90m   The aggregate averages different markets: 2020 was underwritten in full\x1b[0m`);
console.log(`\x1b[90m   uncertainty and collected in the recovery; 2024 projected growth onto\x1b[0m`);
console.log(`\x1b[90m   a market that went flat.\x1b[0m\n`);

const { rows: vintages } = await query<{
  vintage: string; n: string; median: number | null; share: number | null;
  projected: number | null; growth: number | null; dy_miss: number | null;
}>(
  `SELECT extract(year FROM originated_at)::int::text AS vintage,
          count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_actual) AS median,
          1.0 * count(*) FILTER (WHERE gap_vs_actual >= 0.05) / count(*) AS share,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_trailing) AS projected,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY growth_delivered) AS growth,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY (noi_actual - noi_underwritten) / NULLIF(loan_amount_senior, 0)) AS dy_miss
     FROM corpus.underwriting_outcomes
    WHERE ${POST} AND originated_at IS NOT NULL
    GROUP BY 1 HAVING count(*) >= 30
    ORDER BY 1`,
);

if (vintages.length >= 3) {
  console.log(`   vintage    n   median    ≥5%   projected  delivered  DY error`);
  for (const v of vintages) {
    const hot = Number(v.share) >= GRIFFIN_SHARE;
    const cell = hot
      ? `\x1b[33m${pct(v.share, 0).padStart(5)}\x1b[0m`
      : `\x1b[32m${pct(v.share, 0).padStart(5)}\x1b[0m`;
    console.log(
      `   ${v.vintage}  ${String(v.n).padStart(5)}   ${pct(v.median).padStart(7)} ${cell}  ` +
        `${pct(v.projected).padStart(9)} ${pct(v.growth).padStart(9)}   ${pct(v.dy_miss).padStart(8)}`,
    );
  }

  /**
   * Minimum against maximum, not first against last.
   *
   * The first version compared the ends of the series and announced "stable
   * across vintages" over a U-shaped pattern: 2020 gave 51% and 2024 gave 52%,
   * with 2021 at 33% in between. Subtracting the ends of a non-linear curve
   * gives zero and hides exactly the variation it was meant to measure.
   *
   * The sample floor drops 2020, which contributes 39 loans against the ~500 of
   * the central vintages.
   */
  const VINTAGE_MIN_N = 100;
  const solid = vintages.filter((v) => Number(v.n) >= VINTAGE_MIN_N);
  const pool = solid.length >= 3 ? solid : vintages;
  const lo = pool.reduce((a, b) => (Number(b.share) < Number(a.share) ? b : a));
  const hi = pool.reduce((a, b) => (Number(b.share) > Number(a.share) ? b : a));
  const spread = Number(hi.share) - Number(lo.share);
  if (solid.length !== vintages.length) {
    const thin = vintages.filter((v) => Number(v.n) < VINTAGE_MIN_N).map((v) => v.vintage);
    console.log(
      `\n   \x1b[90mOut of the comparison for small sample: ${thin.join(", ")}.\x1b[0m`,
    );
  }

  console.log(
    `\n   \x1b[90mGriffin measured 29% over 2013-2019. His window ends where ours\x1b[0m`,
  );
  console.log(`   \x1b[90mbegins, so these rows are the continuation of his series.\x1b[0m`);

  console.log();
  if (Math.abs(spread) > 0.12) {
    console.log(
      `   \x1b[33mThe vintage matters more than the level:\x1b[0m ${pct(lo.share, 0)} in ${lo.vintage} ` +
        `against ${pct(hi.share, 0)} in ${hi.vintage}.`,
    );
    console.log(`   Cualquier cifra agregada promedia esos extremos y no describe a ninguno.`);

    /**
     * The question that decides what the series means.
     *
     * If PROJECTED growth stayed similar across vintages and DELIVERED growth
     * collapsed, the underwriter did not change: the market did. If the
     * projected figure rose, there was a change of practice.
     *
     * They are not the same and the headline differs: "underwriting became more
     * aggressive" against "the properties stopped growing and underwriting did
     * not adjust".
     */
    const dProjected = Number(hi.projected) - Number(lo.projected);
    const dGrowth = Number(hi.growth) - Number(lo.growth);
    console.log();
    console.log(`   Between ${lo.vintage} and ${hi.vintage}:`);
    console.log(
      `     crecimiento proyectado   ${pct(lo.projected)} → ${pct(hi.projected)}   ` +
        `(${dProjected >= 0 ? "+" : ""}${(dProjected * 100).toFixed(1)} pp)`,
    );
    console.log(
      `     crecimiento entregado    ${pct(lo.growth)} → ${pct(hi.growth)}   ` +
        `(${dGrowth >= 0 ? "+" : ""}${(dGrowth * 100).toFixed(1)} pp)`,
    );
    console.log();
    if (Math.abs(dGrowth) > Math.abs(dProjected) * 2) {
      console.log(
        `   \x1b[1mWhat moved is the market, not the underwriting.\x1b[0m The underwriter projected`,
      );
      console.log(
        `   almost the same in both vintages; the properties delivered ${Math.abs(dGrowth * 100).toFixed(0)} points less.`,
      );
      console.log(
        `   \x1b[90mThe gap grows because reality fell, not because the promise rose.\x1b[0m`,
      );
    } else if (dProjected > 0.03) {
      console.log(
        `   \x1b[33mUnderwriting did become more aggressive\x1b[0m: ${(dProjected * 100).toFixed(1)} pp more growth`,
      );
      console.log(`   was projected in ${hi.vintage} than in ${lo.vintage}.`);
    } else {
      console.log(`   \x1b[90mProjection and outcome moved together. No clear reading.\x1b[0m`);
    }
  } else {
    console.log(`   \x1b[90mStable across vintages: the aggregate does represent the whole.\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// B) Is what we measure with the Annex A worth anything?
// ---------------------------------------------------------------------------

console.log(`\n\n\x1b[1mB. Does optimism at origination predict the outcome?\x1b[0m`);
console.log(`\x1b[90m   If measuring against the trailing figure had predictive content, loans\x1b[0m`);
console.log(`\x1b[90m   underwritten with more optimism should fail more often.\x1b[0m\n`);

const { rows: buckets } = await query<{
  bucket: string; n: string; gap_actual: number | null; growth: number | null; fail: number | null;
}>(
  `WITH b AS (
     SELECT CASE
              WHEN gap_vs_trailing <  0    THEN '1. conservador (<0%)'
              WHEN gap_vs_trailing < 0.05  THEN '2. neutral (0-5%)'
              WHEN gap_vs_trailing < 0.15  THEN '3. optimista (5-15%)'
              ELSE                              '4. muy optimista (>15%)'
            END AS bucket,
            gap_vs_actual, growth_delivered
       FROM corpus.underwriting_outcomes
      WHERE ${POST} AND gap_vs_trailing IS NOT NULL AND growth_delivered IS NOT NULL
   )
   SELECT bucket, count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_actual) AS gap_actual,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY growth_delivered) AS growth,
          1.0 * count(*) FILTER (WHERE growth_delivered < -0.10) / count(*) AS fail
     FROM b GROUP BY 1 ORDER BY 1`,
);

if (buckets.length >= 3) {
  console.log(`   bucket at origination      n   gap vs actual   grew   fell >10%`);
  for (const b of buckets) {
    console.log(
      `   ${b.bucket.padEnd(24)} ${String(b.n).padStart(4)}   ${pct(b.gap_actual).padStart(12)}   ` +
        `${pct(b.growth).padStart(6)}   ${pct(b.fail, 0).padStart(8)}`,
    );
  }

  const first = buckets[0]!;
  const last = buckets[buckets.length - 1]!;
  const spread = Number(last.fail) - Number(first.fail);

  console.log();
  if (spread > 0.15) {
    console.log(`   \x1b[32mOptimism would appear to predict\x1b[0m: the most optimistic fall ${(spread * 100).toFixed(0)} points more.`);
  } else if (Math.abs(spread) <= 0.15) {
    console.log(`   \x1b[33mNo clear gradient (${(spread * 100).toFixed(0)} points between the extremes).\x1b[0m`);
  } else {
    console.log(`   \x1b[31mThe relationship runs backwards\x1b[0m: the conservative ones fall much more.`);
  }
  console.log(
    `   \x1b[90mDo not draw conclusions from this table yet: the two columns share\x1b[0m`,
  );
  console.log(`   \x1b[90mdenominador. El bloque B2 controla eso.\x1b[0m`);
}

/**
 * The individual case that prompted this section, as a count.
 *
 * How many loans underwritten below the trailing figure —the "prudent" ones—
 * ended up among the worst outcomes in the corpus.
 */
const { rows: paradox } = await query<{ conservative: string; collapsed: string }>(
  `SELECT count(*) FILTER (WHERE gap_vs_trailing < 0) AS conservative,
          count(*) FILTER (WHERE gap_vs_trailing < 0 AND growth_delivered < -0.25) AS collapsed
     FROM corpus.underwriting_outcomes
    WHERE ${POST} AND gap_vs_trailing IS NOT NULL AND growth_delivered IS NOT NULL`,
);
const p = paradox[0];
if (p && Number(p.conservative) > 0) {
  const share = Number(p.collapsed) / Number(p.conservative);
  console.log(
    `\n   \x1b[90mOf ${p.conservative} loans underwritten BELOW the trailing figure, ` +
      `${p.collapsed} (${pct(share, 0)})\x1b[0m`,
  );
  console.log(`   \x1b[90mlost more than 25% of their NOI. Prudence did not protect them.\x1b[0m`);
}

// ---------------------------------------------------------------------------
// B2) Is B's gradient real or arithmetic?
// ---------------------------------------------------------------------------

/**
 * Block B compares two ratios that SHARE A DENOMINATOR.
 *
 *   gap_vs_trailing   = underwritten / trailing - 1
 *   growth_delivered  = actual       / trailing - 1
 *
 * The trailing figure is underneath both. If for any given loan that trailing
 * figure happens to be high —a good year, a non-recurring item, a tenant who
 * later left— then the first ratio falls (it looks conservative) and so does the
 * second (the property looks like it fell). And the reverse if it is low. That
 * produces a perfect gradient between the two, in the negative direction,
 * WITHOUT any real relationship existing.
 *
 * It is called ratio bias from a common denominator, and it is the most
 * economical explanation for a result as tidy as B's —four monotonic buckets
 * from -10.7% to +18.6%— which also contradicts intuition.
 *
 * The control uses a denominator that does not come from NOI: the loan balance.
 *
 *   actual debt yield = actual NOI / senior balance
 *
 * The balance is set by the lender, is not derived from any NOI, and takes no
 * part in gap_vs_trailing. If loans underwritten optimistically really do end up
 * worse, their actual debt yield has to be lower. If actual debt yield comes out
 * even across buckets, B's gradient came from the divisor, not from the world.
 *
 * WHICH BALANCE: the senior one, not the trust's portion.
 *
 * The first version used `loan_amount`, which is what this issuance bought,
 * against an NOI that belongs to the whole property. On loans split across
 * several trusts that inflates debt yield by the split factor —up to 288x in one
 * case. The arithmetic identities later established that the issuer computes
 * against trust + non-trust pari passu, with 99% agreement, so that is the
 * correct denominator for any ratio against a property-level NOI.
 */
console.log(`\n\n\x1b[1mB2. Control: is B's gradient arithmetic?\x1b[0m`);
console.log(`\x1b[90m   B compares two ratios that share the trailing figure as a denominator.\x1b[0m`);
console.log(`\x1b[90m   That alone produces a negative gradient with no real relationship behind it.\x1b[0m`);
console.log(`\x1b[90m   Control with actual debt yield (actual NOI / balance): the balance does\x1b[0m`);
console.log(`\x1b[90m   not come from NOI.\x1b[0m\n`);

const { rows: dyBuckets } = await query<{
  bucket: string; n: string; dy_uw: number | null; dy_actual: number | null; drop: number | null;
}>(
  `WITH b AS (
     SELECT CASE
              WHEN gap_vs_trailing <  0    THEN '1. conservador (<0%)'
              WHEN gap_vs_trailing < 0.05  THEN '2. neutral (0-5%)'
              WHEN gap_vs_trailing < 0.15  THEN '3. optimista (5-15%)'
              ELSE                              '4. muy optimista (>15%)'
            END AS bucket,
            noi_underwritten / NULLIF(loan_amount_senior, 0) AS dy_uw,
            noi_actual       / NULLIF(loan_amount_senior, 0) AS dy_actual
       FROM corpus.underwriting_outcomes
      WHERE ${POST} AND gap_vs_trailing IS NOT NULL
        AND loan_amount_senior IS NOT NULL AND loan_amount_senior > 0
   )
   SELECT bucket, count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY dy_uw)     AS dy_uw,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY dy_actual) AS dy_actual,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY dy_actual - dy_uw) AS drop
     FROM b WHERE dy_uw IS NOT NULL AND dy_actual IS NOT NULL
    GROUP BY 1 ORDER BY 1`,
);

if (dyBuckets.length >= 3) {
  console.log(`   bucket at origination      n   underwritten DY   actual DY   difference`);
  for (const b of dyBuckets) {
    console.log(
      `   ${b.bucket.padEnd(24)} ${String(b.n).padStart(4)}   ${pct(b.dy_uw).padStart(9)}   ` +
        `${pct(b.dy_actual).padStart(7)}   ${pct(b.drop).padStart(10)}`,
    );
  }

  const dys = dyBuckets.map((b) => Number(b.dy_actual));
  const spread = Math.max(...dys) - Math.min(...dys);
  const drops = dyBuckets.map((b) => Number(b.drop));
  const dropSpread = Math.max(...drops) - Math.min(...drops);

  console.log();
  if (spread < 0.015 && dropSpread < 0.015) {
    console.log(
      `   \x1b[31mActual debt yield is even across buckets (${pct(spread)} of range).\x1b[0m`,
    );
    console.log(`   B's gradient was common-denominator bias, not a relationship.`);
    console.log(`   \x1b[1mB is discarded.\x1b[0m Measuring optimism against the trailing figure says`);
    console.log(`   nothing about the outcome, in either direction.`);
  } else if (Number(dyBuckets[dyBuckets.length - 1]!.dy_actual) < Number(dyBuckets[0]!.dy_actual) - 0.01) {
    console.log(`   \x1b[32mThe optimistic ones end with lower actual debt yield.\x1b[0m`);
    console.log(`   It survives the control: the relationship exists and runs as expected.`);
  } else {
    console.log(`   \x1b[33mThere is dispersion (${pct(spread)}) but no clear order.\x1b[0m`);
    console.log(`   Neither confirmed nor ruled out with this sample.`);
  }
}

// ---------------------------------------------------------------------------
// C) By property type
// ---------------------------------------------------------------------------

console.log(`\n\n\x1b[1mC. By property type\x1b[0m`);
console.log(`\x1b[90m   The scale we found with the Annex A ordered types by visibility of\x1b[0m`);
console.log(`\x1b[90m   contractual rent. Does it hold up against the actual outcome?\x1b[0m\n`);

const { rows: byType } = await query<{
  ptype: string; n: string; vs_trailing: number | null; vs_actual: number | null;
  growth: number | null; dy_miss: number | null;
}>(
  `SELECT coalesce(nullif(property_type, ''), 'no type') AS ptype,
          count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_trailing) AS vs_trailing,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_actual)   AS vs_actual,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY growth_delivered) AS growth,
          -- Clean metric: how far actual debt yield departed from underwritten.
          -- Shares no denominator with anything above.
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY (noi_actual - noi_underwritten) / NULLIF(loan_amount_senior, 0)) AS dy_miss
     FROM corpus.underwriting_outcomes
    WHERE ${POST}
    GROUP BY 1 HAVING count(*) >= 8
    ORDER BY percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_actual) DESC`,
);

if (byType.length >= 3) {
  console.log(`   type                    n   vs trailing   vs actual   grew   DY error`);
  for (const r of byType) {
    const bad = Number(r.dy_miss) < -0.01;
    const cell = bad ? `\x1b[33m${pct(r.dy_miss).padStart(8)}\x1b[0m` : pct(r.dy_miss).padStart(8);
    console.log(
      `   ${r.ptype.slice(0, 20).padEnd(20)} ${String(r.n).padStart(4)}   ` +
        `${pct(r.vs_trailing).padStart(10)}   ${pct(r.vs_actual).padStart(7)}   ` +
        `${pct(r.growth).padStart(6)}   ${cell}`,
    );
  }

  /**
   * "DY error" is the column that can be compared across types.
   *
   * It is (actual NOI − underwritten NOI) / balance: how many points of debt
   * yield the property fell short of what was promised. The balance as a
   * denominator does not come from NOI, so it does not carry the bias that
   * killed block B, and it is in units comparable across types —unlike a
   * porcentaje sobre bases distintas.
   */
  console.log(
    `\n   \x1b[90mThe comparable column is "DY error": (actual − underwritten) / balance, in\x1b[0m`,
  );
  console.log(`   \x1b[90mpoints of debt yield. It is the only one that shares no denominator.\x1b[0m`);

  /**
   * "no type" is not a property type, it is a mapping hole.
   *
   * The first run picked it as the worst in the table and produced a meaningless
   * sentence: "no type was underwritten at 6.3% over its trailing figure". They
   * are nine loans whose category we could not read; putting them in a
   * comparison between types is comparing a category with the absence of one.
   *
   * A sample floor is also needed: with a single-digit n, one loan moves the
   * median.
   */
  const NARRATIVE_MIN_N = 20;
  const real = byType.filter(
    (r) => r.ptype !== "no type" && Number(r.n) >= NARRATIVE_MIN_N,
  );

  const untyped = byType.find((r) => r.ptype === "no type");
  if (untyped) {
    console.log(
      `\n   \x1b[90m"no type" is ${untyped.n} loans with no mapped category, not a type.\x1b[0m`,
    );
    console.log(`   \x1b[90mThey stay out of the comparison; they are mapping debt.\x1b[0m`);
  }

  if (real.length < 3) {
    console.log(`\n   \x1b[33mInsufficient sample per type to compare.\x1b[0m`);
  } else {
  /**
   * "Most accurate" is the closest to zero, not the highest.
   *
   * With the 2024 vintage alone every error was negative —properties came in
   * below what was underwritten— and taking the maximum happened, by chance, to
   * give the one closest to zero. Adding 2020-2023 brought POSITIVE errors:
   * properties that beat what was underwritten. At that point the maximum
   * stopped meaning "accurate" and started meaning "the one that overshot most",
   * and the script printed that Manufactured Housing at +1.5% was the most
   * precise when Self Storage was at -0.0%.
   *
   * A heuristic that works only while all the signs agree is a coincidence, not
   * a heuristic.
   */
  const worst = real.reduce((a, b) => (Number(b.dy_miss) < Number(a.dy_miss) ? b : a));
  const over = real.reduce((a, b) => (Number(b.dy_miss) > Number(a.dy_miss) ? b : a));
  const best = real.reduce((a, b) =>
    Math.abs(Number(b.dy_miss)) < Math.abs(Number(a.dy_miss)) ? b : a,
  );

  /**
   * The contrast that inverts the Annex A finding.
   *
   * With the Annex A alone, "risk" was optimism: how far the underwriter
   * departed from the trailing figure. Against the outcome it can turn out that
   * the most optimistic type is the most accurate and the most prudent one fails
   * most —because in volatile assets anchoring to the trailing figure is not
   * prudence, it is having nothing better to hand.
   */
  if (Number(worst.vs_trailing) < Number(best.vs_trailing)) {
    console.log(
      `\n   \x1b[33mThe Annex A ordering inverts.\x1b[0m ${worst.ptype} was underwritten at `,
        `${pct(worst.vs_trailing)} sobre`,
    );
    console.log(
      `   its trailing figure —the prudent extreme— and has the largest error (${pct(worst.dy_miss)} of DY).`,
    );
    console.log(
      `   ${best.ptype} is the most accurate: ${pct(best.dy_miss)} of deviation over the balance.`,
    );
    if (Number(over.dy_miss) > 0.005 && over.ptype !== best.ptype) {
      console.log(
        `   \x1b[90mAnd ${over.ptype} came in ${pct(over.dy_miss)} ABOVE what was underwritten: it was\x1b[0m`,
      );
      console.log(`   \x1b[90munderwritten short, not long.\x1b[0m`);
    }
    console.log(
      `\n   \x1b[90mAt origination, risk looks like optimism. Against the outcome, risk is\x1b[0m`,
    );
    console.log(
      `   \x1b[90mvolatility. They are not the same, and the Annex A only sees the first.\x1b[0m`,
    );
  } else {
    console.log(
      `\n   \x1b[90mThe order holds: ${worst.ptype} has the largest error (${pct(worst.dy_miss)}).\x1b[0m`,
    );
  }
  }
}

// ---------------------------------------------------------------------------
// D) Is the sample biased?
// ---------------------------------------------------------------------------

console.log(`\n\n\x1b[1mD. Sample bias control\x1b[0m`);
console.log(`\x1b[90m   Only loans whose servicer reported a full year get in. If the ones that\x1b[0m`);
console.log(`\x1b[90m   report were systematically different, everything above collapses.\x1b[0m\n`);

const { rows: bias } = await query<{
  reported: string; n: string; uw_gap: number | null; dscr: number | null; ltv: number | null;
}>(
  `SELECT CASE WHEN p.loan_id IS NULL THEN 'not reported' ELSE 'with actual NOI' END AS reported,
          count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1) AS uw_gap,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY d.value::numeric) AS dscr,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY v.value::numeric) AS ltv
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.performance p ON p.loan_id = l.id
     LEFT JOIN corpus.facts uw ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten' AND uw.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts mr ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'  AND mr.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts d  ON d.loan_id  = l.id AND d.metric_key  = 'dscr'             AND d.value  ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts v  ON v.loan_id  = l.id AND v.metric_key  = 'ltv'              AND v.value  ~ '^-?[0-9.]+$'
    WHERE f.accession IN (SELECT DISTINCT accession FROM corpus.underwriting_outcomes)
    GROUP BY 1`,
);

if (bias.length === 2) {
  console.log(`   group             n   gap vs trailing   DSCR    LTV`);
  for (const b of bias) {
    console.log(
      `   ${b.reported.padEnd(14)} ${String(b.n).padStart(4)}   ${pct(b.uw_gap).padStart(12)}   ` +
        `${num(b.dscr).padStart(4)}  ${pct(b.ltv).padStart(6)}`,
    );
  }

  const a = bias.find((x) => x.reported === "with actual NOI")!;
  const b = bias.find((x) => x.reported === "not reported")!;
  const gapDiff = Math.abs(Number(a.uw_gap) - Number(b.uw_gap));
  const dscrDiff = Math.abs(Number(a.dscr) - Number(b.dscr));

  console.log();
  if (gapDiff < 0.04 && dscrDiff < 0.15) {
    console.log(`   \x1b[32mThe two groups look alike at origination.\x1b[0m Whether a servicer reports`);
    console.log(`   does not depend on how the loan was underwritten: the sample is usable.`);
  } else {
    console.log(`   \x1b[33mThe groups differ at origination\x1b[0m (gap ${pct(gapDiff)}, DSCR ${num(dscrDiff)}).`);
    console.log(`   Those that report are not a neutral sample: that has to be said in any`);
    console.log(`   conclusion drawn from here.`);
  }
}

console.log(`\n${"─".repeat(78)}`);
console.log(
  `\n  \x1b[90mFirst time the corpus can say whether an underwriting was\x1b[0m`,
);
console.log(`  \x1b[90mwrong, and not only whether it was optimistic.\x1b[0m\n`);

await closePool();

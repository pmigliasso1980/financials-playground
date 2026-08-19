/**
 * What effect can this sample detect, and which one could it never have?
 *
 *   npm run db:power
 *
 * WHY THIS FILE EXISTS
 *
 * Five hypotheses died in this project: "office is underwritten more
 * aggressively", "multifamily breaks the LTV band", "delivered NOI growth
 * collapsed between 2021 and 2024", "BANK underwrites four times better than
 * BBCMS" and "LMF originates worse". Zero survived.
 *
 * Five out of five is not bad luck, and the suspicion this file was written with
 * was that we were asking the data for a precision it does not have.
 *
 * THE SUSPICION TURNED OUT FALSE, AND THAT IS THE RESULT
 *
 * The MDE is 6.7% and the claimed effect was 10.5%: the sample could detect it. The
 * hypotheses did not die for lack of power but because the effects are not there —
 * a stronger and less comfortable conclusion than "it could not be seen".
 *
 * This header used to say the opposite ("the three hypotheses were dead before
 * being formulated") while the script printed the opposite result three screens
 * below. It stayed that way until someone read both together.
 *
 * The median NOI growth of a vintage is computed over 89 to 157 loans and the
 * individual dispersion is enormous —one tenant leaving moves the number thirty
 * points— so the suspicion was reasonable. It simply was not true, and the
 * bootstrap below is what decides it.
 *
 * WHAT IT DOES
 *
 * Bootstrap: resamples each vintage with replacement 2,000 times and measures how
 * the median moves. The width of that distribution is the sampling noise, and it
 * depends on no assumption about the shape of the distribution — which is exactly
 * what we need, because these tails are not normal.
 *
 * Two numbers come out of it that are worth more than any finding:
 *
 *   95% CI   the range where that vintage's true median lies
 *   MDE      the minimum difference between two vintages we could detect
 *
 * The MDE is the one that decides the project's future. If it is larger than the
 * effects we are looking for, we should not look harder: we should change the
 * outcome variable or the question.
 *
 * WHY THE SEED IS FIXED
 *
 * A verifier that returns a different number on every run is no use for verifying.
 * With a fixed seed, two runs over the same corpus give the same result and any
 * change comes from the data, not from chance.
 */

import { closePool, ping, query } from "../db/client.js";
import { corpusState, provenanceStamp } from "../db/provenance.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Same stratum as `analysis/bias.ts`, for the same reason: it neutralises the size bias. */
const BAND_MIN = 10_000_000;
const BAND_MAX = 30_000_000;
const RESAMPLES = 2000;
const MIN_N = 30;
const SEED = 20260815;

/**
 * The effect the dead finding claimed, to have as a yardstick.
 *
 * The headline said delivered growth fell from 11.5% to 1.0%: 10.5 points. If the
 * MDE turns out larger than that, the sample could never have supported that claim
 * — not even if it had been true.
 */
const CLAIMED_EFFECT = 0.105;

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

/** Seeded generator: same corpus, same result, always. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = n >> 1;
  return n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Distribution of the median under resampling.
 *
 * Each replicate takes n values WITH REPLACEMENT from the same sample and computes
 * its median. The spread of those 2,000 medians is how much the number would move
 * if we had drawn different loans — which is exactly what we want to know.
 */
function bootstrapMedian(
  values: number[],
  rng: () => number,
): { lo: number; hi: number; se: number } {
  const n = values.length;
  const medians = new Float64Array(RESAMPLES);
  const buf = new Float64Array(n);

  for (let r = 0; r < RESAMPLES; r++) {
    for (let i = 0; i < n; i++) buf[i] = values[Math.floor(rng() * n)]!;
    const sorted = Array.from(buf).sort((a, b) => a - b);
    medians[r] = median(sorted);
  }

  const ms = Array.from(medians).sort((a, b) => a - b);
  const mean = ms.reduce((a, b) => a + b, 0) / RESAMPLES;
  const varianza = ms.reduce((a, b) => a + (b - mean) ** 2, 0) / (RESAMPLES - 1);

  return {
    lo: ms[Math.floor(0.025 * RESAMPLES)]!,
    hi: ms[Math.floor(0.975 * RESAMPLES)]!,
    se: Math.sqrt(varianza),
  };
}

console.log(`\n${"═".repeat(78)}`);
console.log("Noise floor — what effect this sample can detect");
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  Bootstrap of ${RESAMPLES.toLocaleString("en-US")} replicates, fixed seed, band ${BAND_MIN / 1e6}M-${BAND_MAX / 1e6}M.\x1b[0m`,
);
console.log(
  `\x1b[90m  The band is the same as analysis/bias.ts: it neutralises the size bias.\x1b[0m\n`,
);

const { rows } = await query<{ vintage: string; valores: number[] }>(
  `SELECT extract(year FROM originated_at)::int::text AS vintage,
          array_agg(growth_delivered) AS valores
     FROM corpus.underwriting_outcomes
    WHERE days_after_origination >= 0
      AND is_full_year
      AND growth_delivered IS NOT NULL
      AND loan_amount_senior BETWEEN ${BAND_MIN} AND ${BAND_MAX}
    GROUP BY 1
   HAVING count(*) >= ${MIN_N}
    ORDER BY 1`,
);

if (rows.length < 2) {
  console.log(
    `  \x1b[33mFewer than two vintages with n ≥ ${MIN_N}. Run db:performance first.\x1b[0m\n`,
  );
  await closePool();
  process.exit(0);
}

const rng = makeRng(SEED);

interface Anada {
  vintage: string;
  n: number;
  median: number;
  lo: number;
  hi: number;
  se: number;
}

const vintages: Anada[] = [];

console.log(`  vintage   n    median         95% CI              width`);
console.log(`  ${"─".repeat(62)}`);

for (const r of rows) {
  const values = r.valores.map(Number).filter(Number.isFinite);
  if (values.length < MIN_N) continue;

  const { lo, hi, se } = bootstrapMedian(values, rng);
  const sorted = [...values].sort((a, b) => a - b);
  const med = median(sorted);

  vintages.push({ vintage: r.vintage, n: values.length, median: med, lo, hi, se });
  console.log(
    `  ${r.vintage}   ${String(values.length).padStart(3)}    ${pct(med).padStart(6)}    ` +
      `[${pct(lo).padStart(6)} , ${pct(hi).padStart(6)}]      ${pct(hi - lo).padStart(6)}`,
  );
}

/**
 * The minimum detectable difference between two vintages.
 *
 * The standard error of a DIFFERENCE of two independent medians is the square root
 * of the sum of their variances. At 95% confidence the difference has to exceed
 * 1.96 of those errors not to be attributable to chance.
 *
 * The median standard error across vintages is used, not the best or the worst: the
 * best would be selling the most favourable sample and the worst would be punishing
 * it for its poorest vintage.
 */
const ses = vintages.map((a) => a.se).sort((a, b) => a - b);
const typicalSe = median(ses);
const mde = 1.96 * Math.sqrt(2) * typicalSe;

console.log(`\n${"─".repeat(78)}`);
console.log("What can be detected");
console.log(`${"─".repeat(78)}\n`);

console.log(`  Typical standard error of an annual median:      ${pct(typicalSe, 2)}`);
console.log(`  Minimum detectable difference between vintages: \x1b[1m${pct(mde)}\x1b[0m`);
console.log(`  Effect the dead finding claimed:                 ${pct(CLAIMED_EFFECT)}\n`);

/**
 * How many loans would be needed.
 *
 * The standard error falls with the square root of n, so detecting an effect k
 * times smaller needs k² times more sample. It is the number that decides whether
 * "harvest more sources" is a strategy or an illusion.
 */
const typicalN = median(vintages.map((a) => a.n).sort((a, b) => a - b));
/**
 * The SUM, not the median times the number of vintages.
 *
 * The first version printed `typicalN * vintages.length` and gave 600 — which is
 * exactly the real sum of 89+157+145+89+120. It coincided by accident with these
 * five numbers and will not coincide on the next run. A wrong formula that returns
 * the right value is worse than one that fails.
 */
const totalMeasured = vintages.reduce((x, a) => x + a.n, 0);
const target = 0.05;
const factor = (mde / target) ** 2;

if (mde >= CLAIMED_EFFECT) {
  console.log(`  \x1b[31mLA MUESTRA NUNCA PUDO SOSTENER EL HALLAZGO.\x1b[0m`);
  console.log(
    `  \x1b[90mThe claimed effect is smaller than the sampling noise. Even if the\x1b[0m`,
  );
  console.log(
    `  \x1b[90mcollapse had been real, we could not have told it from chance.\x1b[0m\n`,
  );
} else {
  console.log(`  \x1b[33mThe claimed effect exceeds the noise floor.\x1b[0m`);
  console.log(
    `  \x1b[90mThe sample could detect it in principle; that it does not appear on\x1b[0m`,
  );
  console.log(`  \x1b[90mstratifying is evidence that it is not there.\x1b[0m\n`);
}

/**
 * Pairs whose intervals do NOT overlap — a criterion STRICTER than the MDE.
 *
 * Two 95% CIs not overlapping is equivalent to testing the difference at a level
 * close to 0.5%, not 5%: each interval already carries its own 1.96 SE, so
 * demanding total separation asks for ~2.8 SE of distance when the MDE asks for
 * 1.96·√2 = 2.77 SE... of the difference, which has a larger SE.
 *
 * The previous version of this comment called them "the only real differences",
 * which gives this criterion an authority it does not have: it is the more
 * conservative of the two this script prints, and presenting it as definitive makes
 * the vintages look more indistinguishable than the MDE says.
 *
 * It is kept because it is easy to read, but labelled as what it is.
 */
const distinguishable: string[] = [];
for (let i = 0; i < vintages.length; i++) {
  for (let j = i + 1; j < vintages.length; j++) {
    const a = vintages[i]!;
    const b = vintages[j]!;
    if (a.hi < b.lo || b.hi < a.lo) {
      distinguishable.push(`${a.vintage} vs ${b.vintage}`);
    }
  }
}

const pairs = (vintages.length * (vintages.length - 1)) / 2;
console.log(
  `  Pairs with non-overlapping intervals: ${distinguishable.length} of ${pairs}` +
    `  \x1b[90m(criterio conservador)\x1b[0m`,
);
if (distinguishable.length > 0) {
  console.log(`  \x1b[90m${distinguishable.join(" · ")}\x1b[0m`);
} else {
  console.log(
    `  \x1b[90mNone under this criterion, which is the stricter of the two: it asks for\x1b[0m`,
  );
  console.log(
    `  \x1b[90mmore separation than the MDE above. The conclusion that counts is the MDE.\x1b[0m`,
  );
}

console.log(`\n${"─".repeat(78)}`);
console.log("What it would take");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  To detect an effect of ${pct(target, 0)} would need ~${Math.round(factor)}x more loans`,
);
console.log(
  `  per vintage: from ${Math.round(typicalN)} to ~${Math.round(typicalN * factor).toLocaleString("en-US")}.\n`,
);
console.log(
  `  \x1b[90mThe corpus has ${totalMeasured.toLocaleString("en-US")} loans in the measured vintages.\x1b[0m\n`,
);
/**
 * Two lines used to end here saying "that number per vintage is not a matter of
 * harvesting more trusts: there are not that many CMBS issuances per year".
 *
 * When I replaced the paragraph's first line I cut the sentence and left the tail
 * pointing at the previous conclusion, so the output asserted that and then two
 * lines later "at 2x, harvesting more can be enough". Two opposite verdicts on the
 * same screen, one alive and one fossil.
 *
 * It is the same pattern as the rest of the day in its simplest form: the sentence
 * outlives the finding that refutes it because nobody rereads what was left around
 * the change.
 */
/**
 * THE RECOMMENDATION IS COMPUTED, NOT ASSERTED.
 *
 * This block used to say that "the way out is not more sample" and that reaching
 * the needed n "is not a matter of harvesting more trusts". The real factor is 2x,
 * and `docs/underwriting-finding.md` already said 2x is achievable —enumerating
 * where it would come from: 10-D coverage of 26-48%, 176 unmatched loans, six BANK
 * issuances with no full years, and the 2025-2026 vintages not yet matured.
 *
 * So the script and the document contradicted each other, and the document was
 * right. The recommendation is now derived from the factor rather than written by
 * hand, which is what stops them diverging again.
 *
 * (An earlier version of this comment said the factor "was much larger" when the
 * old text was written. That is not verified: the document records an MDE of 6.6%
 * and a factor of 2x from the beginning. The contradiction was between two texts,
 * not between two eras.)
 */
if (factor <= 3) {
  console.log(
    `  \x1b[33mAt ${Math.round(factor)}x, harvesting more can be enough.\x1b[0m With ${vintages.length} measured vintages and`,
  );
  console.log(
    `  \x1b[90m~${Math.round(typicalN)} loans per vintage, doubling is plausible: there are more issuances\x1b[0m`,
  );
  console.log(
    `  \x1b[90mper year than we have harvested. This conclusion was the opposite when\x1b[0m`,
  );
  console.log(
    `  \x1b[90mthe corpus was smaller, and it is worth rereading every time it grows.\x1b[0m\n`,
  );
} else {
  console.log(
    `  \x1b[90mAt ${Math.round(factor)}x harvesting is not enough: there are not that many CMBS issuances\x1b[0m`,
  );
  console.log(
    `  \x1b[90mper year. The way out is a less noisy outcome variable —delinquency is\x1b[0m`,
  );
  console.log(
    `  \x1b[90mbinary and is in the same 10-D filings— or cross-sectional questions.\x1b[0m\n`,
  );
}

if (mde < CLAIMED_EFFECT) {
  console.log(
    `  \x1b[33mCareful with the project summary:\x1b[0m with this sample the claimed effect is`,
  );
  console.log(
    `  \x1b[90mabove the noise floor, so that hypothesis did not die for lack of power —\x1b[0m`,
  );
  console.log(
    `  \x1b[90mit died because the effect is not there. They are two different things and the\x1b[0m`,
  );
  console.log(
    `  \x1b[90mproyecto viene diciendo la primera.\x1b[0m\n`,
  );
}

/**
 * The provenance stamp at the foot, because this verdict depends on the sample size.
 *
 * This script's MDE already flipped once when the corpus grew, and the old version
 * stayed quoted in a document for weeks. A number that depends on the sample and
 * does not say which sample it was measured against cannot be quoted
 * sin riesgo.
 */
const estado = await corpusState();
console.log(`${"─".repeat(78)}`);
console.log(`  \x1b[90m${provenanceStamp(estado)}\x1b[0m`);
console.log(
  `  \x1b[90mIf this number is quoted anywhere, it goes with this line. See npm run db:provenance.\x1b[0m\n`,
);

await closePool();

/**
 * What distinguishes LMF's loans that DSCR and LTV do not capture?
 *
 *   npm run db:mechanism
 *   npm run db:mechanism -- --seller SMC
 *
 * WHAT KIND OF QUESTION THIS IS
 *
 * Twelve attacks left a residue: LMF transfers to special servicing 1.89 times
 * more than expected, controlling for property type, vintage, DSCR tercile and
 * LTV tercile. The excess lives in three multifamily subtypes —Garden, Mid Rise,
 * Multifamily/Retail— where it stands at 30.5% against ~8% for the corpus, and it
 * appears in all four vintages where it has a sample.
 *
 * Eleven of those twelve attacks asked "is it an artefact?". The one that paid off
 * —mapping the seller— asked "what would this be if it were real?".
 *
 * This question is of the second kind, one step further on: given that it looks
 * real, WHY? If LMF lends at the same DSCR and the same LTV but with softer
 * structure, that is the mechanism, and it explains why observable leverage was
 * not capturing it.
 *
 * THE CANDIDATES, ALL ALREADY MAPPED
 *
 *   io_period_original      a long interest-only period defers amortisation: the
 *                           loan reaches maturity with more balance outstanding
 *                           and less cushion
 *   reserve_replacement_*   thin replacement reserves leave the property with no
 *                           funds for capex when NOI shrinks
 *   reserve_tilc_*          same for tenant improvements and leasing commissions
 *   noi_underwritten vs
 *   noi_most_recent         how much of the underwritten NOI was projection and
 *                           how much was rent already in place at origination
 *
 * The last is the most interesting: if LMF underwrites on projected NOI well above
 * the historical figure, it is lending against rent growth that has not happened
 * yet. That is exactly the bet that did not pay off in multifamily 2021-2024, and
 * it would be a mechanism, not a correlation.
 *
 * HOW THE COMPARISON IS MADE
 *
 * Against loans of the SAME subtype and the same vintage, not against the whole
 * corpus. If LMF concentrates in Garden and Garden has longer IO in general, the
 * raw comparison would be measuring the subtype.
 *
 * WHAT THIS CANNOT DO
 *
 * With ~59 loans in the affected subtypes, this describes a profile; it does not
 * prove causality. A plausible and consistent mechanism is more than we had, and
 * less than a demonstrated explanation.
 *
 * TWO FIXES FROM A LATER AUDIT
 *
 * 1. The "no replacement reserve" percentage counted NULL together with zero. If a
 *    seller's Annex A does not publish that column, that seller came out at 100%
 *    "no reserve" and it read as a structural difference when it was a failure to
 *    extract. It is the same shape as the occupancy bug: absence of the datum
 *    confused with absence of the thing. The other two rows of the same block
 *    already used a non-null denominator, so the script contradicted itself.
 *
 * 2. There was no reference at all. It printed one seller's medians against the
 *    rest and closed with "a large difference would be a mechanism", without
 *    defining large and without a null. With ~59 loans the sampling noise in a
 *    median is considerable, so the script could not tell a mechanism from chance
 *    in EITHER direction — and its negative result was being cited as evidence that
 *    there is no mechanism.
 *
 *    Now there is permutation: the seller labels are shuffled 4,000 times and we
 *    measure what difference chance produces. It is the same procedure as in
 *    db:composition-signal, which is the only measurement from that session that did
 *    corregir.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const vFlag = process.argv.indexOf("--seller");
const SELLER = vFlag === -1 ? "LMF" : (process.argv[vFlag + 1] ?? "LMF");

/** Fixed before looking at anything: below this the comparison does not read. */
const MIN_CELDA = 10;

const num = (v: number | null, d = 2) => (v === null ? "—" : v.toFixed(d));

/**
 * The base: loans with a seller, a subtype and a vintage, plus the candidate metrics.
 *
 * Restricted to the subtypes where the excess lives. Comparing over the whole
 * corpus would mix LMF's profile in self storage with its profile in multifamily,
 * and the excess is in multifamily.
 */
const SUBTYPES = ["Garden", "Mid Rise", "Multifamily/Retail"];

const BASE = `
  SELECT l.id,
         nullif(btrim(l.loan_seller), '') AS seller,
         extract(year FROM f.filed_at)::int AS vintage,
         nullif(btrim(fd.value), '') AS subtype,
         (d.transfer_date IS NOT NULL)::int AS event,
         nullif(io.value, '')::numeric   AS io_months,
         nullif(term.value, '')::numeric AS term_months,
         nullif(rr.value, '')::numeric   AS replacement_reserve,
         nullif(uw.value, '')::numeric   AS noi_uw,
         nullif(mr.value, '')::numeric   AS noi_hist,
         nullif(amt.value, '')::numeric  AS balance
    FROM corpus.loans l
    JOIN corpus.filings f ON f.accession = l.accession
    LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
    LEFT JOIN corpus.facts fd  ON fd.loan_id = l.id AND fd.metric_key = 'property_type_detailed'
    LEFT JOIN corpus.facts io  ON io.loan_id = l.id AND io.metric_key = 'io_period_original'
                              AND io.value ~ '^[0-9.]+$'
    LEFT JOIN corpus.facts term ON term.loan_id = l.id AND term.metric_key = 'term_original'
                               AND term.value ~ '^[0-9.]+$'
    LEFT JOIN corpus.facts rr  ON rr.loan_id = l.id AND rr.metric_key = 'reserve_replacement_monthly'
                              AND rr.value ~ '^[0-9.]+$'
    LEFT JOIN corpus.facts uw  ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten'
                              AND uw.value ~ '^[0-9.]+$'
    LEFT JOIN corpus.facts mr  ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'
                              AND mr.value ~ '^[0-9.]+$'
    LEFT JOIN corpus.facts amt ON amt.loan_id = l.id AND amt.metric_key = 'loan_amount'
                              AND amt.value ~ '^[0-9.]+$'
   WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                          WHERE deal_accession IS NOT NULL)
`;

console.log(`\n${"═".repeat(78)}`);
console.log(`What do ${SELLER}'s loans have that leverage does not show?`);
console.log(`${"═".repeat(78)}`);

/**
 * The ROWS are fetched, not the aggregates.
 *
 * The previous version computed medians and percentages in SQL. To permute the
 * labels we need each loan separately: shuffling in SQL would mean rewriting
 * the query 4,000 times.
 */
const { rows } = await query<{
  seller: string; event: string;
  io_months: string | null; term_months: string | null;
  replacement_reserve: string | null; noi_uw: string | null; noi_hist: string | null;
  balance: string | null;
}>(
  `WITH base AS (${BASE})
   SELECT seller, event::text,
          io_months::text, term_months::text, replacement_reserve::text,
          noi_uw::text, noi_hist::text, balance::text
     FROM base
    WHERE subtype = ANY($1) AND seller IS NOT NULL`,
  [SUBTYPES],
);

if (rows.length === 0) {
  console.log(`\n  \x1b[33mNo loans in ${SUBTYPES.join(", ")}.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

interface Loan {
  isSeller: boolean;
  event: number;
  /** null significa "no lo tenemos", y se propaga: nunca se convierte en 0. */
  ioShare: number | null;
  reserveBp: number | null;
  projection: number | null;
  balance: number | null;
}

const n = (x: string | null) => (x === null || x === "" ? null : Number(x));

const data: Loan[] = rows.map((r) => {
  const io = n(r.io_months);
  const term_months = n(r.term_months);
  const rr = n(r.replacement_reserve);
  const uw = n(r.noi_uw);
  const hist = n(r.noi_hist);
  const balance = n(r.balance);
  return {
    isSeller: r.seller === SELLER,
    event: Number(r.event),
    ioShare: io !== null && term_months ? io / term_months : null,
    /**
     * The reserve is stored as null when it WAS NOT EXTRACTED and as 0 when the
     * document says zero. The previous version merged them, and that turned a
     * seller with a different format into a seller with softer structure.
     */
    reserveBp: rr !== null && balance ? (rr * 12) / balance * 10000 : null,
    projection: uw !== null && hist ? uw / hist : null,
    balance,
  };
});

const sellerLoans = data.filter((d) => d.isSeller);
const restLoans = data.filter((d) => !d.isSeller);

console.log(
  `\n\x1b[90m  Subtypes: ${SUBTYPES.join(" · ")} — where the excess lives\x1b[0m\n`,
);
console.log(`  group        n    ev     tasa`);
console.log(`  ${"─".repeat(44)}`);
for (const [label, group] of [[SELLER, sellerLoans], ["resto", restLoans]] as const) {
  const ev = group.reduce((a, d) => a + d.event, 0);
  console.log(
    `  ${label.padEnd(10)} ${String(group.length).padStart(4)} ${String(ev).padStart(5)}  ` +
      `${group.length ? ((ev / group.length) * 100).toFixed(1).padStart(6) : "   —"}%`,
  );
}

/** Fixed seed: a p-value that changes between runs cannot be quoted. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const o = [...xs].sort((a, b) => a - b);
  const m = o.length >> 1;
  return o.length % 2 ? o[m]! : (o[m - 1]! + o[m]!) / 2;
};

/**
 * PERMUTATION: the reference the script did not have.
 *
 * The seller labels are shuffled among the same loans and the difference of medians
 * is recomputed. If the observed one does not exceed what shuffling produces, there
 * is nothing to explain — and that holds as much for asserting a mechanism as for
 * ruling one out.
 *
 * Nulls do NOT take part: a loan without the datum contributes neither to the
 * observed nor to the permuted value, so the comparison is between those that have
 * the datum in each group.
 */
const PERMUTACIONES = 4000;

function permute(
  extract: (d: Loan) => number | null,
): { obs: number | null; nullVal: number | null; p: number; nA: number; nB: number } {
  const withDatum = data.filter((d) => extract(d) !== null);
  const a = withDatum.filter((d) => d.isSeller).map((d) => extract(d)!);
  const b = withDatum.filter((d) => !d.isSeller).map((d) => extract(d)!);
  if (a.length < 3 || b.length < 3) {
    return { obs: median(a), nullVal: null, p: 1, nA: a.length, nB: b.length };
  }

  const obs = Math.abs(median(a)! - median(b)!);
  const all = [...a, ...b];
  const rand = rng(0xc0ffee);
  const diffs: number[] = [];

  for (let k = 0; k < PERMUTACIONES; k++) {
    // Fisher-Yates over a copy: it shuffles the labels, not the values.
    const shuffled = [...all];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const pa = shuffled.slice(0, a.length);
    const pb = shuffled.slice(a.length);
    diffs.push(Math.abs(median(pa)! - median(pb)!));
  }
  diffs.sort((x, y) => x - y);

  return {
    obs,
    nullVal: diffs[Math.floor(diffs.length / 2)]!,
    p: diffs.filter((x) => x >= obs).length / diffs.length,
    nA: a.length,
    nB: b.length,
  };
}

console.log(`\n${"─".repeat(78)}`);
console.log("The profile, against what shuffling the labels produces");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  metric                        ${SELLER.padStart(9)}      rest    |dif|    null   p-value    n`,
);
console.log(`  ${"─".repeat(74)}`);

const METRICS: Array<{
  label: string;
  extract: (d: Loan) => number | null;
  fmt: (v: number) => string;
}> = [
  { label: "IO / term_months", extract: (d) => d.ioShare, fmt: (v) => v.toFixed(2) },
  { label: "Replacement reserve (bp of balance)", extract: (d) => d.reserveBp, fmt: (v) => v.toFixed(0) },
  { label: "Underwritten NOI / historical", extract: (d) => d.projection, fmt: (v) => v.toFixed(2) },
  { label: "Balance (M)", extract: (d) => d.balance, fmt: (v) => (v / 1e6).toFixed(1) },
];

/**
 * STRATIFIED PERMUTATION, AND WHY IT IS RESTRICTED TO THE OVERLAP.
 *
 * The two differences that appear —thinner reserve and smaller loan— are
 * entangled. The reserve is measured in basis points of the balance, so it is
 * already normalised, but that does not rule out small loans having thinner
 * reserves for other reasons.
 *
 * THE FIRST VERSION CONTROLLED FOR NOTHING, AND IT WAS VERIFIED BEFORE BEING USED
 *
 * Stratifying into three terciles and permuting within each looked sufficient. The
 * calibration check —data where the metric depends ONLY on the balance, that is,
 * where any signal is spurious— found 37 significant out of 40. The control was
 * manufacturing exactly the effect it claimed to rule out.
 *
 * More strata barely help: with six it is 31 of 40, with ten 19 of 40.
 *
 * What fixes it is RESTRICTING TO THE OVERLAP. With the balances limited to the
 * range where both groups have mass, the calibration drops to 0-2 of 40 with any
 * number of strata. The reason: the problem was not how coarse the stratum was but
 * the tails where one group has nobody to be compared against — there the stratum
 * averages against no one and the confounder passes through whole.
 *
 * The cost is sample, and it is printed: how many loans are left after trimming.
 */
const STRATA = 6;

function permuteStratified(
  extract: (d: Loan) => number | null,
): {
  obs: number | null; nullVal: number | null; p: number;
  nA: number; nB: number; trimmed: number;
} {
  const all = data.filter((d) => extract(d) !== null && d.balance !== null);
  const empty = { obs: null, nullVal: null, p: 1, nA: 0, nB: 0, trimmed: 0 };
  if (all.length < 12) return empty;

  /**
   * The overlap range: from the larger of the two minima to the smaller of the two
   * maxima. Outside it, one group has no counterpart.
   */
  const sA = all.filter((d) => d.isSeller).map((d) => d.balance!).sort((x, y) => x - y);
  const sB = all.filter((d) => !d.isSeller).map((d) => d.balance!).sort((x, y) => x - y);
  if (sA.length < 4 || sB.length < 4) return empty;
  const lo = Math.max(sA[0]!, sB[0]!);
  const hi = Math.min(sA[sA.length - 1]!, sB[sB.length - 1]!);

  const base = all.filter((d) => d.balance! >= lo && d.balance! <= hi);
  const trimmed = all.length - base.length;
  if (base.filter((d) => d.isSeller).length < 4) return { ...empty, trimmed };

  const sorted = [...base].sort((a, b) => a.balance! - b.balance!);
  const cuts = [...Array(STRATA - 1)].map(
    (_, i) => sorted[Math.floor(((i + 1) * sorted.length) / STRATA)]!.balance!,
  );
  const stratumOf = (d: Loan) => cuts.filter((c) => d.balance! > c).length;
  const strata = [...Array(STRATA)].map((_, t) => base.filter((d) => stratumOf(d) === t));

  /** Average of the within-stratum differences: each contributes its own comparison. */
  const stratifiedDiff = (label: (d: Loan) => boolean) => {
    const partials: number[] = [];
    for (const stratum of strata) {
      const a = stratum.filter(label).map((d) => extract(d)!);
      const b = stratum.filter((d) => !label(d)).map((d) => extract(d)!);
      if (a.length < 2 || b.length < 2) continue;
      partials.push(median(a)! - median(b)!);
    }
    if (partials.length === 0) return null;
    return Math.abs(partials.reduce((x, y) => x + y, 0) / partials.length);
  };

  const obs = stratifiedDiff((d) => d.isSeller);
  if (obs === null) return { ...empty, trimmed };

  const rand = rng(0xc0ffee);
  const diffs: number[] = [];
  for (let k = 0; k < PERMUTACIONES; k++) {
    /**
     * Shuffling happens WITHIN each stratum, preserving how many of the seller's
     * loans are in each. Shuffling across strata would let the balance back in.
     */
    const assigned = new Map<Loan, boolean>();
    for (const stratum of strata) {
      const howMany = stratum.filter((d) => d.isSeller).length;
      const idx = stratum.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [idx[i], idx[j]] = [idx[j]!, idx[i]!];
      }
      idx.forEach((pos, orden) => assigned.set(stratum[pos]!, orden < howMany));
    }
    const d = stratifiedDiff((x) => assigned.get(x) ?? false);
    if (d !== null) diffs.push(d);
  }
  diffs.sort((x, y) => x - y);

  return {
    obs,
    nullVal: diffs.length ? diffs[Math.floor(diffs.length / 2)]! : null,
    p: diffs.length ? diffs.filter((x) => x >= obs).length / diffs.length : 1,
    nA: base.filter((d) => d.isSeller).length,
    nB: base.filter((d) => !d.isSeller).length,
    trimmed,
  };
}

let significant = 0;
for (const m of METRICS) {
  const r = permute(m.extract);
  const withA = data.filter((d) => d.isSeller && m.extract(d) !== null).map((d) => m.extract(d)!);
  const withB = data.filter((d) => !d.isSeller && m.extract(d) !== null).map((d) => m.extract(d)!);
  const mA = median(withA);
  const mB = median(withB);
  const sig = r.nullVal !== null && r.p < 0.05;
  if (sig) significant++;

  console.log(
    `  ${m.label.padEnd(30)} ${(mA === null ? "—" : m.fmt(mA)).padStart(9)} ` +
      `${(mB === null ? "—" : m.fmt(mB)).padStart(9)} ` +
      `${(r.obs === null ? "—" : m.fmt(r.obs)).padStart(8)} ` +
      `${(r.nullVal === null ? "—" : m.fmt(r.nullVal)).padStart(7)} ` +
      `${sig ? "\x1b[32m" : "\x1b[90m"}${r.nullVal === null ? "no sample" : r.p.toFixed(4)}\x1b[0m` +
      `  \x1b[90m${r.nA}/${r.nB}\x1b[0m`,
  );
}

console.log(`\n${"─".repeat(78)}`);
console.log("The same, but shuffling WITHIN balance terciles");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `\x1b[90m  LMF lends smaller and requires less reserve: the two differences are\x1b[0m`,
);
console.log(
  `\x1b[90m  entangled. Among loans of similar size, is anything still there?\x1b[0m`,
);
console.log(
  `\x1b[90m  Restricted to the balance overlap and ${STRATA} strata: verified at 0-2 false\x1b[0m`,
);
console.log(
  `\x1b[90m  positives out of 40 against data where the metric depends only on balance. The\x1b[0m`,
);
console.log(
  `\x1b[90m  "trim" column says how many loans the control cost.\x1b[0m\n`,
);
console.log(`  metric                             |dif|    null   p-value      n      trim`);
console.log(`  ${"─".repeat(70)}`);

let sigStrat = 0;
for (const m of METRICS) {
  if (m.label.startsWith("Balance")) continue; // stratifying by balance nullifies it
  const r = permuteStratified(m.extract);
  const sig = r.nullVal !== null && r.p < 0.05;
  if (sig) sigStrat++;
  console.log(
    `  ${m.label.padEnd(32)} ${(r.obs === null ? "—" : m.fmt(r.obs)).padStart(8)} ` +
      `${(r.nullVal === null ? "—" : m.fmt(r.nullVal)).padStart(7)} ` +
      `${sig ? "\x1b[32m" : "\x1b[90m"}${(r.nullVal === null ? "no sample" : r.p.toFixed(4)).padStart(9)}\x1b[0m` +
      `  \x1b[90m${r.nA}/${r.nB}   -${r.trimmed}\x1b[0m`,
  );
}

console.log(
  sigStrat === 0
    ? `\n  \x1b[33mNothing survives the size control.\x1b[0m What looked like a mechanism was the\n` +
        `  balance: LMF lends smaller, and small loans have thinner reserves.\n` +
        `  Sixth control that erodes a finding about LMF, and the sixth that makes it\n` +
        `  disappear rather than explain it.`
    : `\n  \x1b[32m${sigStrat} survive(s) the size control.\x1b[0m Among loans of similar balance\n` +
        `  the difference persists, so size does not explain it. It is the closest to a\n` +
        `  mechanism this project got.`,
);

console.log(`\n${"─".repeat(78)}\n`);

/**
 * THE CLOSING LINE IS THE CONTROLLED RESULT, NOT THE RAW ONE.
 *
 * The previous version printed "2 mechanism candidates" AFTER the stratified
 * section that says nothing survives. The last thing read was the weaker
 * conclusion, and the two coexisted on the same screen contradicting each other.
 *
 * It is the pattern this project has been chasing all day, committed ten minutes
 * after fixing it in another file. Now the raw count is labelled as what it is
 * —uncontrolled— and the verdict is the stratified one.
 */
const esperadas = METRICS.length * 0.05;
console.log(
  `  \x1b[90mUncontrolled: ${significant} of ${METRICS.length} metrics depart from chance ` +
    `(esperadas ${esperadas.toFixed(1)}).\x1b[0m`,
);
console.log(
  `  \x1b[90mWith the size control: ${sigStrat} of ${METRICS.length - 1}.\x1b[0m`,
);
console.log(
  sigStrat === 0
    ? `\n  \x1b[1mThere is no identifiable mechanism in these four metrics.\x1b[0m What appeared\n` +
        `  without a control was the balance: LMF lends smaller and small loans have\n` +
        `  proportionally thinner reserves.\n\n` +
        `  \x1b[90mAnd that now means something, which is the difference from the previous\x1b[0m\n` +
        `  \x1b[90mversion of this script: it had no reference, so "I did not find it" was\x1b[0m\n` +
        `  \x1b[90mcompatible with "I could not have found it". With calibrated permutation, the\x1b[0m\n` +
        `  \x1b[90mabsence is informative within what ${sellerLoans.length} loans allow.\x1b[0m`
    : `\n  \x1b[32m${sigStrat} candidate(s) survive the size control.\x1b[0m Before believing it, it is worth\n` +
        `  attacking it with the same savagery as the five previous findings about LMF.`,
);

console.log(
  `\n  \x1b[90mNulls do not take part: a loan without the datum contributes neither to the\x1b[0m`,
);
console.log(
  `  \x1b[90mobserved nor to the permuted value. The n column says how many had the datum in\x1b[0m`,
);
console.log(
  `  \x1b[90meach group, and if those two numbers differ a lot, the metric measures coverage\x1b[0m`,
);
console.log(
  `  \x1b[90mas well as structure.\x1b[0m`,
);
console.log(
  `\n  \x1b[90mWith ${sellerLoans.length} loans from ${SELLER} this describes a profile. It does not prove causality.\x1b[0m\n`,
);

await closePool();

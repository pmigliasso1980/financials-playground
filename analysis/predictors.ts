/**
 * What predicts transfer to special servicing?
 *
 *   npm run db:predictors
 *
 * WHY THIS QUESTION AND NOT THE VINTAGE ONE
 *
 * Asking "which vintage is worse?" splits the sample into cells of fifteen
 * cases. Yesterday that killed the NOI finding —no vintage was distinguishable
 * from another— and today it left the 2023 spike explanation resting on 17
 * events.
 *
 * Asking "which characteristics at origination predict the problem?" pools the
 * five vintages: 335 events against 8,935 loans. The time axis stops splitting
 * the sample and becomes just another variable.
 *
 * It is what the power analysis said yesterday: this corpus is good for
 * cross-sectional questions. The difference is that there is now an outcome
 * variable that is not noisy.
 *
 * THE HYPOTHESIS THAT COMES FROM TODAY
 *
 * The seven issuances concentrating the problematic 2023 multifamily all share
 * one profile: DSCR between 1.28 and 1.45 and rate between 6.7% and 7.4%. If
 * that predicts transfer in ALL vintages, the lead was real and stops depending
 * on a cell of 17 cases. If it only shows up in 2023, it was noise.
 *
 * WHAT IT DOES AND DOES NOT DO
 *
 * Transfer rates by decile of each variable, plus a DSCR × rate cross-tab. It is
 * not a model: they are tabulations. A model with 335 events and mutually
 * correlated covariates would give coefficients that cannot be interpreted, and
 * this project has had enough numbers that looked like they said something.
 *
 * THE BIAS THAT DOES NOT GO AWAY
 *
 * It is still stock: loans already resolved do not appear. That understates the
 * old vintages evenly within each decile, so it affects the levels but not the
 * ORDER between deciles, which is what gets read here.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

/** Wilson: with rates of 2-5% the normal approximation gives intervals that go negative. */
function wilson(k: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = k / total;
  const d = 1 + (z * z) / total;
  const c = p + (z * z) / (2 * total);
  const m = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

console.log(`\n${"═".repeat(78)}`);
console.log("What predicts transfer to special servicing");
console.log(`${"═".repeat(78)}`);

/**
 * The base: one loan per row, with its origination metrics and whether it transferred.
 *
 * Only issuances that have a servicer report: in the others the event is not
 * observable and counting them as "no transfer" would invent zeros.
 *
 * THE GATE CHANGED, AND WHY THAT MATTERS
 *
 * It used to say the same thing but asked `corpus.performance`, which is the
 * NOI table. That is, it used "we could parse the NOI" as a proxy for "there is
 * a report". The BANK shelf publishes its whole delinquency block and was still
 * left out, because its NOI comes with no usable period: some 800 loans excluded
 * from a question that never needed the NOI.
 *
 * It now asks `servicer_reports.deal_accession`, which is written as soon as the
 * report is parsed, whether or not it yielded NOI. It is the difference between
 * "there was no event" and "we did not observe it" — which, without a record,
 * are the same absent row.
 */
const BASE = `
  SELECT l.id,
         extract(year FROM f.filed_at)::int AS vintage,
         ltv.value::numeric   AS ltv,
         dscr.value::numeric  AS dscr,
         dy.value::numeric    AS dy,
         ir.value::numeric    AS rate,
         l.property_type,
         (d.transfer_date IS NOT NULL)::int AS event
    FROM corpus.loans l
    JOIN corpus.filings f ON f.accession = l.accession
    LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
    LEFT JOIN corpus.facts ltv  ON ltv.loan_id = l.id AND ltv.metric_key = 'ltv'
                               AND ltv.value ~ '^-?[0-9.]+$'
    LEFT JOIN corpus.facts dscr ON dscr.loan_id = l.id AND dscr.metric_key = 'dscr'
                               AND dscr.value ~ '^-?[0-9.]+$'
    LEFT JOIN corpus.facts dy   ON dy.loan_id = l.id AND dy.metric_key = 'debt_yield'
                               AND dy.value ~ '^-?[0-9.]+$'
    LEFT JOIN corpus.facts ir   ON ir.loan_id = l.id AND ir.metric_key = 'interest_rate'
                               AND ir.value ~ '^-?[0-9.]+$'
   WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
`;

const { rows: total } = await query<{ n: string; ev: string }>(
  `WITH base AS (${BASE}) SELECT count(*)::text AS n, sum(event)::text AS ev FROM base`,
);
console.log(
  `\n\x1b[90m  ${Number(total[0]!.n).toLocaleString("en-US")} loans · ` +
    `${total[0]!.ev} transfers · base rate ${pct(Number(total[0]!.ev) / Number(total[0]!.n))}\x1b[0m\n`,
);

/**
 * Rate by quintile of a variable.
 *
 * Quintiles and not deciles: with 335 events, ten cells leave ~33 each and the
 * intervals all overlap. Five cells give ~67, which is enough to see a
 * gradient.
 */
async function byQuintile(col: string, label: string, format: (v: number) => string) {
  const { rows } = await query<{
    q: string; n: string; ev: string; lo: string; hi: string;
  }>(
    `WITH base AS (${BASE}),
     conq AS (
       SELECT *, ntile(5) OVER (ORDER BY ${col}) AS q
         FROM base WHERE ${col} IS NOT NULL
     )
     SELECT q::text, count(*)::text AS n, sum(event)::text AS ev,
            min(${col})::text AS lo, max(${col})::text AS hi
       FROM conq GROUP BY q ORDER BY q`,
  );

  if (rows.length === 0) return;

  console.log(`${"─".repeat(78)}`);
  console.log(label);
  console.log(`${"─".repeat(78)}\n`);
  console.log(`  quintile       range           n      events    rate         95% CI`);
  console.log(`  ${"─".repeat(72)}`);

  const tasas: number[] = [];
  for (const r of rows) {
    const n = Number(r.n), ev = Number(r.ev);
    const [lo, hi] = wilson(ev, n);
    tasas.push(ev / n);
    console.log(
      `    ${r.q}      ${format(Number(r.lo))}–${format(Number(r.hi))}`.padEnd(32) +
        `${String(n).padStart(5)}   ${String(ev).padStart(5)}    ${pct(ev / n).padStart(6)}   ` +
        `[${pct(lo).padStart(5)} , ${pct(hi).padStart(5)}]`,
    );
  }

  /**
   * Do the extremes separate?
   *
   * Comparing Q1 against Q5 is the honest reading: if their intervals overlap,
   * the variable separates nothing even if the middle column draws a trend.
   */
  const p = rows[0]!, u = rows[rows.length - 1]!;
  const [lo1, hi1] = wilson(Number(p.ev), Number(p.n));
  const [lo5, hi5] = wilson(Number(u.ev), Number(u.n));
  const separan = hi1 < lo5 || hi5 < lo1;
  console.log(
    `\n  Q1 vs Q5: ${pct(tasas[0]!)} contra ${pct(tasas[tasas.length - 1]!)}  ` +
      (separan
        ? `\x1b[32m← the intervals do not overlap\x1b[0m`
        : `\x1b[90mlos intervalos se pisan: no separa\x1b[0m`),
  );
  console.log();
}

await byQuintile("dscr", "By DSCR at origination", (v) => v.toFixed(2));
await byQuintile("ltv", "By LTV at origination", (v) => pct(v, 0));
await byQuintile("rate", "By interest rate at origination", (v) => pct(v, 2));
await byQuintile("dy", "By debt yield at origination", (v) => pct(v, 0));

/**
 * The cross-tab that comes from today's lead: thin coverage AND high rate.
 *
 * The cutoffs come from the profile observed in the seven 2023 multifamily
 * issuances —DSCR below 1.50 and rate above 6.5%— and are applied to ALL
 * vintages. If the "thin and expensive" quadrant has a markedly higher rate than
 * the other three, today's lead describes a product and not a vintage.
 */
const DSCR_CUT = 1.5;
const RATE_CUT = 0.065;

const { rows: cruce } = await query<{
  coverage: string; cost: string; n: string; ev: string;
}>(
  `WITH base AS (${BASE})
   SELECT CASE WHEN dscr < ${DSCR_CUT} THEN 'thin' ELSE 'ample' END AS coverage,
          CASE WHEN rate > ${RATE_CUT} THEN 'expensive' ELSE 'cheap' END AS cost,
          count(*)::text AS n, sum(event)::text AS ev
     FROM base WHERE dscr IS NOT NULL AND rate IS NOT NULL
    GROUP BY 1, 2 ORDER BY 1, 2`,
);

console.log(`${"─".repeat(78)}`);
console.log(`Coverage × cost  (DSCR ${DSCR_CUT} · rate ${pct(RATE_CUT, 1)})`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  coverage    cost         n     events    rate           95% CI`);
console.log(`  ${"─".repeat(68)}`);

let worst = { k: "", rate: 0, n: 0 };
for (const c of cruce) {
  const n = Number(c.n), ev = Number(c.ev);
  const [lo, hi] = wilson(ev, n);
  const t = ev / n;
  if (t > worst.rate && n >= 100) worst = { k: `${c.coverage} and ${c.cost}`, rate: t, n };
  console.log(
    `  ${c.coverage.padEnd(11)} ${c.cost.padEnd(10)} ${String(n).padStart(5)}   ` +
      `${String(ev).padStart(5)}    ${pct(t).padStart(6)}    [${pct(lo).padStart(5)} , ${pct(hi).padStart(5)}]`,
  );
}
console.log(
  `\n  Worst quadrant with n ≥ 100: \x1b[1m${worst.k}\x1b[0m  ${pct(worst.rate)} over ${worst.n}\n`,
);

/**
 * Is the bad quadrant a 2023 phenomenon or one of every vintage?
 *
 * If the "thin and expensive" quadrant's rate is high only in 2023, the lead was
 * that vintage. If it is high in several, it is the product.
 */
const { rows: byVintage } = await query<{
  vintage: string; n: string; ev: string;
}>(
  `WITH base AS (${BASE})
   SELECT vintage::text, count(*)::text AS n, sum(event)::text AS ev
     FROM base
    WHERE dscr IS NOT NULL AND rate IS NOT NULL
      AND dscr < ${DSCR_CUT} AND rate > ${RATE_CUT}
    GROUP BY 1 ORDER BY 1`,
);

console.log(`${"─".repeat(78)}`);
console.log("The thin-and-expensive quadrant, vintage by vintage");
console.log(`${"─".repeat(78)}\n`);
console.log(`  vintage    n     events    rate`);
console.log(`  ${"─".repeat(44)}`);

let vintagesWithSample = 0;
let highVintages = 0;
for (const r of byVintage) {
  const n = Number(r.n), ev = Number(r.ev);
  if (n < 30) {
    console.log(`  ${r.vintage}   ${String(n).padStart(4)}    \x1b[90minsufficient n\x1b[0m`);
    continue;
  }
  vintagesWithSample++;
  if (ev / n > 0.04) highVintages++;
  console.log(
    `  ${r.vintage}   ${String(n).padStart(4)}    ${String(ev).padStart(5)}    ${pct(ev / n).padStart(6)}`,
  );
}

console.log();
if (vintagesWithSample >= 3 && highVintages >= 2) {
  console.log(
    `  \x1b[32mThe quadrant fails in ${highVintages} of ${vintagesWithSample} vintages with a sample.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mToday's lead describes a product, not the 2023 vintage.\x1b[0m\n`,
  );
} else if (vintagesWithSample >= 3) {
  console.log(`  \x1b[33mOnly one vintage shows a high rate.\x1b[0m`);
  console.log(
    `  \x1b[90mThe lead was 2023, not the product. It goes back to depending on few cases.\x1b[0m\n`,
  );
} else {
  console.log(
    `  \x1b[33mFewer than three vintages with n ≥ 30 in the quadrant: not enough to decide.\x1b[0m\n`,
  );
}

/**
 * Within a single vintage: does the variable still predict?
 *
 * THE CONFOUNDER THE PREVIOUS TABLE EXPOSED
 *
 * The rate quintiles are vintage quintiles in disguise: Q1 runs from 0% to 3.56%
 * —2020-2021 loans— and Q5 from 6.91% to 12% —2023-2024. The same happens partly
 * with DSCR, which falls from a median 2.25 in 2020-2021 to 1.62-1.72 in
 * 2023-2024.
 *
 * And the vintages are contaminated by stock bias: the 10-D lists what is in
 * special servicing TODAY, so the old ones lose whatever has been resolved. A
 * variable correlated with vintage inherits that bias whole.
 *
 * LTV is the exception: its medians run from 55% to 61% across the five
 * vintages, with no trend. That is why its gradient was the most credible in the
 * previous table.
 *
 * THIS IS THE TEST
 *
 * Split by vintage and look at the gradient inside. If within 2024 alone the low
 * DSCR quintile still fails more than the high one, the variable really does
 * predict. If it flattens, it was vintage.
 *
 * With ~1,300 loans and 25-47 events per vintage the cells get thin, so terciles
 * are used rather than quintiles, and the extreme ratio is read, not each
 * individual cell.
 */
console.log(`${"─".repeat(78)}`);
console.log("Within each vintage: does the gradient survive?");
console.log(`${"─".repeat(78)}\n`);

for (const [col, label] of [
  ["dscr", "DSCR"],
  ["ltv", "LTV"],
] as Array<[string, string]>) {
  const { rows } = await query<{
    vintage: string; t: string; n: string; ev: string;
  }>(
    `WITH base AS (${BASE}),
     cont AS (
       SELECT *, ntile(3) OVER (PARTITION BY vintage ORDER BY ${col}) AS t
         FROM base WHERE ${col} IS NOT NULL
     )
     SELECT vintage::text, t::text, count(*)::text AS n, sum(event)::text AS ev
       FROM cont GROUP BY vintage, t ORDER BY vintage, t`,
  );

  console.log(`  \x1b[1m${label}\x1b[0m   (T1 = riskiest per the previous table)`);
  console.log(`  vintage   T1            T2            T3         ratio T1/T3`);
  console.log(`  ${"─".repeat(64)}`);

  const vintages = [...new Set(rows.map((r) => r.vintage))].sort();
  let survive = 0;
  let evaluated = 0;

  for (const a of vintages) {
    const ts = rows.filter((r) => r.vintage === a);
    if (ts.length < 3) continue;

    /**
     * The "risky" tercile is the low one for DSCR and the high one for LTV: the
     * previous table showed loss rates fall with DSCR and rise with LTV.
     */
    const riesgoso = col === "dscr" ? ts[0]! : ts[2]!;
    const seguro = col === "dscr" ? ts[2]! : ts[0]!;

    const tr = Number(riesgoso.ev) / Number(riesgoso.n);
    const ts3 = Number(seguro.ev) / Number(seguro.n);
    const coc = ts3 > 0 ? tr / ts3 : NaN;

    evaluated++;
    if (!Number.isNaN(coc) && coc >= 1.5) survive++;

    const celdas = ts
      .map((x) => `${pct(Number(x.ev) / Number(x.n)).padStart(5)} (${String(x.ev).padStart(2)})`)
      .join("  ");

    console.log(
      `  ${a}   ${celdas}     ` +
        (Number.isNaN(coc)
          ? "\x1b[90m  —  \x1b[0m"
          : coc >= 1.5
            ? `\x1b[32m${coc.toFixed(1)}x\x1b[0m`
            : `\x1b[90m${coc.toFixed(1)}x\x1b[0m`),
    );
  }

  console.log(
    `\n  Gradient ≥1.5x in ${survive} of ${evaluated} vintages` +
      (survive >= evaluated - 1
        ? `  \x1b[32m← survives within vintage\x1b[0m`
        : survive >= 3
          ? `  \x1b[33m← survives in most\x1b[0m`
          : `  \x1b[31m← it was vintage in disguise\x1b[0m`),
  );
  console.log();
}

console.log(
  `  \x1b[90mA gradient that survives within each vintage cannot be the stock bias:\x1b[0m`,
);
console.log(
  `  \x1b[90minside one vintage every loan has the same age and the same exposure to\x1b[0m`,
);
console.log(`  \x1b[90mits case having already been resolved.\x1b[0m\n`);

/**
 * DSCR against LTV: which one rules when the other is controlled for?
 *
 * WHY IT MATTERS
 *
 * Both show gradients of 6-8x and both survive within vintage. But they are
 * correlated —a highly leveraged loan tends to have tight coverage— so it may be
 * that one is what matters and the other is its reflection.
 *
 * The cross-tab separates them. If, holding the DSCR tercile fixed, the loss
 * rate still rises with LTV, both contribute. If it flattens, LTV was the
 * reflection. And vice versa.
 *
 * DELIBERATELY NOT A REGRESSION
 *
 * With 147 events in nine cells that leaves ~16 per cell. A regression would
 * spit out two coefficients with enormous intervals and the illusion of having
 * controlled. The table shows the cells and their n, which is what allows
 * judging whether the pattern holds or is three cases.
 *
 * MECANISMO ESPERADO
 *
 * DSCR measures flow —can it pay the instalment?— and transfer to special
 * servicing is a payment event. LTV measures stock and bites at maturity. Since
 * almost none of these loans has matured yet, DSCR should dominate.
 */
console.log(`${"─".repeat(78)}`);
console.log("DSCR × LTV: which one rules?");
console.log(`${"─".repeat(78)}\n`);

const { rows: cruz } = await query<{
  td: string; tl: string; n: string; ev: string;
}>(
  `WITH base AS (${BASE}),
   conts AS (
     SELECT *,
            ntile(3) OVER (ORDER BY dscr) AS td,
            ntile(3) OVER (ORDER BY ltv)  AS tl
       FROM base WHERE dscr IS NOT NULL AND ltv IS NOT NULL
   )
   SELECT td::text, tl::text, count(*)::text AS n, sum(event)::text AS ev
     FROM conts GROUP BY td, tl ORDER BY td, tl`,
);

const celda = (td: number, tl: number) => {
  const r = cruz.find((x) => Number(x.td) === td && Number(x.tl) === tl);
  if (!r) return { n: 0, ev: 0, t: 0 };
  const n = Number(r.n), ev = Number(r.ev);
  return { n, ev, t: n > 0 ? ev / n : 0 };
};

const LBL_D = ["DSCR low  ", "DSCR mid  ", "DSCR high "];
const LBL_L = ["LTV low", "LTV mid", "LTV high"];

console.log(`                 ${LBL_L.map((e) => e.padEnd(16)).join("")}`);
console.log(`  ${"─".repeat(64)}`);
for (let d = 1; d <= 3; d++) {
  const row = [1, 2, 3]
    .map((l) => {
      const c = celda(d, l);
      return `${pct(c.t).padStart(5)} (${String(c.ev).padStart(2)}/${String(c.n).padStart(3)})`.padEnd(16);
    })
    .join("");
  console.log(`  ${LBL_D[d - 1]}    ${row}`);
}

/**
 * The two marginal effects, each measured where the other is held fixed.
 *
 * The LTV effect is measured within the riskiest DSCR tercile —where there are
 * enough events to see it— and the DSCR effect within the riskiest LTV tercile,
 * for the same reason.
 */
const ltvWithinDscrLow = celda(1, 3).t / (celda(1, 1).t || Infinity);
const dscrWithinLtvHigh = celda(1, 3).t / (celda(3, 3).t || Infinity);

console.log(`\n  With DSCR low fixed, going from LTV low to high multiplies by ` +
  `\x1b[1m${Number.isFinite(ltvWithinDscrLow) ? ltvWithinDscrLow.toFixed(1) : "∞"}x\x1b[0m`);
console.log(`  With LTV high fixed, going from DSCR high to low multiplies by ` +
  `\x1b[1m${Number.isFinite(dscrWithinLtvHigh) ? dscrWithinLtvHigh.toFixed(1) : "∞"}x\x1b[0m`);

const ganaDscr = dscrWithinLtvHigh > ltvWithinDscrLow * 1.5;
const ganaLtv = ltvWithinDscrLow > dscrWithinLtvHigh * 1.5;

console.log();
if (ganaDscr) {
  console.log(`  \x1b[32mDSCR domina.\x1b[0m`);
  console.log(
    `  \x1b[90mControlling for leverage, coverage still separates; the other way round\x1b[0m`,
  );
  console.log(`  \x1b[90mnot so much. LTV was largely its reflection.\x1b[0m\n`);
} else if (ganaLtv) {
  console.log(`  \x1b[32mLTV domina.\x1b[0m`);
  console.log(
    `  \x1b[90mContrary to the expected mechanism: if the event is about payment,\x1b[0m`,
  );
  console.log(`  \x1b[90mcoverage should rule. That it does not is the interesting part.\x1b[0m\n`);
} else {
  console.log(`  \x1b[33mBoth contribute, at similar magnitudes.\x1b[0m`);
  console.log(
    `  \x1b[90mNeither is the other's reflection: they measure different risks and add up.\x1b[0m\n`,
  );
}

console.log(
  `  \x1b[90mWith ~16 events per cell this is a reading of shape, not a measurement.\x1b[0m`,
);
console.log(
  `  \x1b[90mThe worst and best corners are credible; the middle ones, less so.\x1b[0m\n`,
);

/**
 * Are there issuers that underwrite better?
 *
 * LA PREGUNTA
 *
 * CMBS issuances come out under "shelves" —BBCMS, Benchmark, BANK, BMO— that
 * correspond to different banks. If one shelf has fewer transfers than another
 * with loans of the same profile, that says something about who underwrites
 * better.
 *
 * If instead they all look alike once the profile is adjusted for, it says
 * something equally interesting: that the shelf is a distribution label and not
 * an underwriting standard. Conduit loans are originated by the same few banks
 * and sold into whichever issuance comes up.
 *
 * HOW COMPOSITION IS CONTROLLED
 *
 * Indirect standardisation. For each shelf we compute how many transfers it
 * WOULD EXPECT if its loans failed at the global rate of their DSCR × LTV cell.
 * The observed/expected ratio (SIR) is 1.0 if the shelf behaves like the average
 * given what it lent.
 *
 * It is the same instrument as the standardisation by asset type in
 * `db:delinquency`, but here the adjustment is by the two variables that today
 * proved to predict.
 *
 * WHAT THIS TEST CANNOT DO
 *
 * The shelf is not the originator. A BBCMS deal can have loans originated by
 * four different banks, and the Annex A publishes the seller per loan in a
 * column we have not yet mapped. This measures the issuance, which is a coarse
 * approximation.
 */
console.log(`${"─".repeat(78)}`);
console.log("Are there issuers that underwrite better?");
console.log(`${"─".repeat(78)}\n`);

const { rows: shelves } = await query<{
  shelf: string; n: string; ev: string; expected: string;
}>(
  `WITH base AS (${BASE}),
   withcells AS (
     SELECT *,
            ntile(3) OVER (ORDER BY dscr) AS td,
            ntile(3) OVER (ORDER BY ltv)  AS tl
       FROM base WHERE dscr IS NOT NULL AND ltv IS NOT NULL
   ),
   /**
    * The cell includes the VINTAGE, not just the profile.
    *
    * Without it the SIR measures age, not quality, and by two opposite routes: a
    * young shelf has not had time for its loans to enter special servicing, and
    * an old one has already seen its own resolved —the 10-D lists stock, not
    * cumulative. BANK5 (100% 2023-2024) gave 0.16 and BANK (87% 2020-2022) gave
    * 0.34; both ends were the same artefact.
    *
    * LTV drops out of the adjustment so as not to run out of sample: 5 vintages
    * × 3 DSCR terciles is 15 cells with ~10 events. With LTV it would be 45
    * cells with 3 events, and the "adjustment" would be noise.
    */
   cell_rate AS (
     SELECT vintage, td, avg(event::numeric) AS rate FROM withcells GROUP BY vintage, td
   ),
   withshelf AS (
     SELECT c.*,
            upper(split_part(
              (SELECT f2.company_name FROM corpus.loans l2
                 JOIN corpus.filings f2 ON f2.accession = l2.accession
                WHERE l2.id = c.id), ' ', 1)) AS shelf
       FROM withcells c
   )
   SELECT s.shelf,
          count(*)::text AS n,
          sum(s.event)::text AS ev,
          round(sum(t.rate), 2)::text AS expected
     FROM withshelf s
     JOIN cell_rate t ON t.vintage = s.vintage AND t.td = s.td
    GROUP BY s.shelf
   HAVING count(*) >= 200
    ORDER BY count(*) DESC`,
);

console.log(`  issuer         n     obs   expected    SIR        95% CI of the SIR`);
console.log(`  ${"─".repeat(68)}`);

/**
 * SIR interval by Byar's method, which behaves well with few events.
 * If the interval contains 1.0 the shelf is not distinguishable from the average.
 */
function byar(obs: number, esp: number): [number, number] {
  if (esp <= 0) return [0, 0];
  const lo = obs === 0 ? 0 : (obs * (1 - 1 / (9 * obs) - 1.96 / (3 * Math.sqrt(obs))) ** 3) / esp;
  const hi = ((obs + 1) * (1 - 1 / (9 * (obs + 1)) + 1.96 / (3 * Math.sqrt(obs + 1))) ** 3) / esp;
  return [Math.max(0, lo), hi];
}

let distinct = 0;
for (const r of shelves) {
  const obs = Number(r.ev), esp = Number(r.expected);
  const sir = esp > 0 ? obs / esp : 0;
  const [lo, hi] = byar(obs, esp);
  const distinta = lo > 1 || hi < 1;
  if (distinta) distinct++;
  console.log(
    `  ${r.shelf.padEnd(12)} ${String(r.n).padStart(5)}   ${String(obs).padStart(3)}    ` +
      `${esp.toFixed(1).padStart(6)}   ${sir.toFixed(2).padStart(5)}   ` +
      `[${lo.toFixed(2)} , ${hi.toFixed(2)}]` +
      (distinta ? `  \x1b[33m← se aparta\x1b[0m` : ""),
  );
}

console.log(
  `\n  ${distinct} of ${shelves.length} issuers depart from the average adjusted for profile and vintage.`,
);

/**
 * Each shelf's vintage mix: the raw datum that gives the confounder away.
 *
 * A SIR does not distinguish "underwrites better" from "is newer". The vintage
 * weights do. BANK5 has issued on a 5-year run since 2023; if its column is all
 * to the right, its low SIR was age and not quality.
 */
const { rows: mix } = await query<{ shelf: string; vintage: string; n: string }>(
  `WITH base AS (${BASE})
   SELECT upper(split_part(f.company_name, ' ', 1)) AS shelf,
          extract(year FROM f.filed_at)::int::text AS vintage,
          count(*)::text AS n
     FROM base b
     JOIN corpus.loans l ON l.id = b.id
     JOIN corpus.filings f ON f.accession = l.accession
    GROUP BY 1, 2 ORDER BY 1, 2`,
);

const byShelf = new Map<string, Map<string, number>>();
for (const m of mix) {
  const inner = byShelf.get(m.shelf) ?? new Map<string, number>();
  inner.set(m.vintage, Number(m.n));
  byShelf.set(m.shelf, inner);
}

/**
 * Join coverage by issuer: the hypothesis the SIR cannot distinguish.
 *
 * The numerator counts only loans that matched their servicer report. The
 * denominator is the whole pool. If one shelf matches at 20% and another at 80%,
 * the first will show fewer events even with the same problems.
 *
 * We already knew the join is uneven —Benchmark 2020-B16 matched 3 of 33— but we
 * never looked at it by issuer. If BANK and BANK5 match badly and BBCMS matches
 * well, the three SIRs that "depart" are coverage and not underwriting.
 *
 * It is the same error as always in a new form: a ratio whose numerator and
 * denominator come from sources with different coverage.
 */
const { rows: coverage } = await query<{ shelf: string; pool: string; matched: string }>(
  `SELECT upper(split_part(f.company_name, ' ', 1)) AS shelf,
          count(*)::text AS pool,
          count(*) FILTER (
            WHERE EXISTS (SELECT 1 FROM corpus.performance p WHERE p.loan_id = l.id)
               OR EXISTS (SELECT 1 FROM corpus.delinquency d WHERE d.loan_id = l.id)
          )::text AS matched
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
    WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
    GROUP BY 1`,
);

const cob = new Map(
  coverage.map((c) => [c.shelf, Number(c.matched) / Math.max(1, Number(c.pool))]),
);

console.log(`\n  Join coverage — does the SIR measure underwriting or how many match?\n`);
console.log(`  issuer         SIR    % of loans matching against the 10-D`);
console.log(`  ${"─".repeat(60)}`);
for (const r of shelves) {
  const sir = Number(r.expected) > 0 ? Number(r.ev) / Number(r.expected) : 0;
  const c = cob.get(r.shelf) ?? 0;
  const barra = "█".repeat(Math.round(c * 20));
  console.log(
    `  ${r.shelf.padEnd(12)} ${sir.toFixed(2).padStart(5)}    ${pct(c, 0).padStart(4)}  ${barra}`,
  );
}

const conSir = shelves.map((r) => ({
  sir: Number(r.expected) > 0 ? Number(r.ev) / Number(r.expected) : 0,
  cob: cob.get(r.shelf) ?? 0,
}));
const n2 = conSir.length;
const mx = conSir.reduce((a, b) => a + b.sir, 0) / n2;
const my = conSir.reduce((a, b) => a + b.cob, 0) / n2;
const cov = conSir.reduce((a, b) => a + (b.sir - mx) * (b.cob - my), 0);
const sx = Math.sqrt(conSir.reduce((a, b) => a + (b.sir - mx) ** 2, 0));
const sy = Math.sqrt(conSir.reduce((a, b) => a + (b.cob - my) ** 2, 0));
const corr = sx > 0 && sy > 0 ? cov / (sx * sy) : 0;

console.log(`\n  Correlation between SIR and join coverage: \x1b[1m${corr.toFixed(2)}\x1b[0m`);
if (Math.abs(corr) > 0.6) {
  console.log(
    `  \x1b[31mThe SIR follows coverage. It does not measure underwriting: it measures matching.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mFixing the join for the issuers with low coverage is a precondition\x1b[0m`,
  );
  console.log(`  \x1b[90mfor being able to ask who underwrites better.\x1b[0m\n`);
} else {
  console.log(
    `  \x1b[32mNo strong relationship: coverage does not explain the differences.\x1b[0m\n`,
  );
}

const cols = ["2020", "2021", "2022", "2023", "2024", "2025", "2026"];
console.log(`\n  Vintage mix — does the SIR measure quality or age?\n`);
console.log(`  emisora      ${cols.map((a) => a.slice(2).padStart(5)).join("")}`);
console.log(`  ${"─".repeat(52)}`);
for (const r of shelves) {
  const inner = byShelf.get(r.shelf) ?? new Map<string, number>();
  const tot = [...inner.values()].reduce((a, b) => a + b, 0) || 1;
  console.log(
    `  ${r.shelf.padEnd(12)} ` +
      cols.map((a) => `${Math.round(((inner.get(a) ?? 0) / tot) * 100)}%`.padStart(5)).join(""),
  );
}
console.log();
if (distinct === 0) {
  console.log(
    `\n  \x1b[32mNone is distinguishable once adjusted for DSCR and LTV.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mThe issuance is not an underwriting standard: it is a distribution\x1b[0m`,
  );
  console.log(
    `  \x1b[90mlabel. What separates good loans from bad ones are the loan's own\x1b[0m`,
  );
  console.log(`  \x1b[90mnumbers, not whose name is on it.\x1b[0m\n`);
} else {
  console.log(
    `\n  \x1b[33mSome issuers do depart.\x1b[0m Before reading that as underwriting`,
  );
  console.log(
    `  \x1b[90mquality, rule out that it is vintage concentration: a shelf with more\x1b[0m`,
  );
  console.log(`  \x1b[90m2023 deals inherits its exposure.\x1b[0m\n`);
}

await closePool();

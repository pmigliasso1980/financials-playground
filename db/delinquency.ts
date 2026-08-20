/**
 * Delinquency and special servicing by vintage.
 *
 *   npm run db:delinquency
 *
 * THE ORDER MATTERS AND IS ENFORCED BY THE CODE
 *
 * The identity first, the rates after. If the identity does not close, the script
 * does NOT report rates: it prints the deviations and stops.
 *
 * That is not tidiness. With the NOI we built the analysis first and the
 * verification months later, and the result lived a year without anyone being able
 * to break it. Here the verification comes first by construction, not by
 * discipline.
 *
 * LA IDENTIDAD
 *
 * `months_delinquent` and `paid_through` are the same fact by two routes: the
 * months should be ≈ (end of period − paid through) / 30.44. That two
 * independently mapped columns agree over hundreds of rows is the same class of
 * evidence as the Annex A identities.
 *
 * TWO DIFFERENT EVENTS
 *
 * Benchmark 2020-B16 has a loan transferred to special servicing that is paying
 * on time. The transfer is the early signal; delinquency, the late symptom.
 * They are reported separately because they measure different things.
 *
 * THE DENOMINATOR IS A BOUND
 *
 * The numerator only counts loans that joined against the servicer report. The
 * denominator is the full pool of those issuances, including the ones that did not
 * join. Where the join is partial —Benchmark 2020-B16 joins 3 of 33— the rate is
 * understated. That is why it is also reported restricted to issuances whose join
 * majority join: if both versions say the same thing, the bias does not drive it.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Thresholds fixed before looking at the numbers. */
const MIN_IDENTITY = 0.9;
const TOLERANCE_MONTHS = 1;
const JOIN_MAYORITARIO = 0.5;

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

console.log(`\n${"═".repeat(78)}`);
console.log("Delinquency and special servicing");
console.log(`${"═".repeat(78)}`);

// ---------------------------------------------------------------------------
// 1. The identity, before anything else
// ---------------------------------------------------------------------------

const { rows: ident } = await query<{
  n: string; closes: string;
}>(
  `SELECT count(*)::text AS n,
          count(*) FILTER (
            WHERE abs(
              greatest(0, floor((period - paid_through) / 30.44))
              - months_delinquent
            ) <= ${TOLERANCE_MONTHS}
          )::text AS closes
     FROM corpus.delinquency
    WHERE period IS NOT NULL AND paid_through IS NOT NULL
      AND months_delinquent IS NOT NULL`,
);

const n = Number(ident[0]?.n ?? 0);
const closes = Number(ident[0]?.closes ?? 0);

console.log(`\n${"─".repeat(78)}`);
console.log("Identity: months delinquent ≈ (period − paid through) / 30.44");
console.log(`${"─".repeat(78)}\n`);

if (n === 0) {
  console.log(
    `  \x1b[33mNo rows have both columns. Run db:performance.\x1b[0m\n`,
  );
  await closePool();
  process.exit(0);
}

const share = closes / n;
console.log(
  `  ${closes} of ${n} close within ±${TOLERANCE_MONTHS} month  →  ` +
    `${share >= MIN_IDENTITY ? "\x1b[32m" : "\x1b[31m"}${pct(share, 0)}\x1b[0m` +
    `   (threshold ${pct(MIN_IDENTITY, 0)})`,
);

const { rows: desvios } = await query<{
  published: string; paid: string; period: string; expected: string;
}>(
  `SELECT months_delinquent::text AS published,
          paid_through::text AS paid,
          period::text AS period,
          greatest(0, floor((period - paid_through) / 30.44))::text AS expected
     FROM corpus.delinquency
    WHERE period IS NOT NULL AND paid_through IS NOT NULL
      AND months_delinquent IS NOT NULL
      AND abs(greatest(0, floor((period - paid_through) / 30.44)) - months_delinquent)
          > ${TOLERANCE_MONTHS}
    ORDER BY abs(greatest(0, floor((period - paid_through) / 30.44)) - months_delinquent) DESC
    LIMIT 5`,
);

for (const d of desvios) {
  console.log(
    `    \x1b[90mpublica ${d.published.padStart(3)} months · paid through ${d.paid} · ` +
      `period ${d.period} → ${d.expected}\x1b[0m`,
  );
}

if (share < MIN_IDENTITY) {
  console.log(
    `\n  \x1b[31mTHE IDENTITY DOES NOT CLOSE. No rates are reported.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mOne of the two columns does not mean what we think. Computing rates\x1b[0m`,
  );
  console.log(
    `  \x1b[90mon top of it would be building on a datum we do not understand — which\x1b[0m`,
  );
  console.log(`  \x1b[90mis exactly what happened with the NOI.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Rates by vintage, with an interval
// ---------------------------------------------------------------------------

/**
 * Wilson interval, not the normal approximation.
 *
 * With low rates and moderate n, the normal gives intervals that run negative and
 * understate the uncertainty. Wilson behaves well at the extremes, which is
 * exactly where the young vintages are going to fall.
 */
function wilson(k: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = k / total;
  const d = 1 + (z * z) / total;
  const centro = p + (z * z) / (2 * total);
  const margen = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (centro - margen) / d), Math.min(1, (centro + margen) / d)];
}

interface Vintage {
  vintage: string; pool: string; delinquent: string; special: string; foreclosure: string;
}

async function rates(majorityJoinOnly: boolean): Promise<Vintage[]> {
  const filter = majorityJoinOnly
    ? `AND f.accession IN (
         SELECT l2.accession FROM corpus.loans l2
          GROUP BY l2.accession
         HAVING count(*) FILTER (
                  WHERE EXISTS (SELECT 1 FROM corpus.performance p2 WHERE p2.loan_id = l2.id)
                     OR EXISTS (SELECT 1 FROM corpus.delinquency d2 WHERE d2.loan_id = l2.id)
                )::numeric / count(*) >= ${JOIN_MAYORITARIO}
       )`
    : "";

  const { rows } = await query<Vintage>(
    `SELECT extract(year FROM f.filed_at)::int::text AS vintage,
            count(*)::text AS pool,
            count(*) FILTER (WHERE d.months_delinquent > 0)::text AS delinquent,
            count(*) FILTER (WHERE d.transfer_date IS NOT NULL)::text AS special,
            count(*) FILTER (WHERE d.foreclosure_date IS NOT NULL
                                OR d.reo_date IS NOT NULL)::text AS foreclosure
       FROM corpus.loans l
       JOIN corpus.filings f ON f.accession = l.accession
       LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
      WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
        ${filter}
      GROUP BY 1 ORDER BY 1`,
  );
  return rows;
}

for (const [titulo, solo] of [
  ["All issuances with a servicer report", false],
  [`Only issuances with a join ≥ ${pct(JOIN_MAYORITARIO, 0)}`, true],
] as Array<[string, boolean]>) {
  const rows = await rates(solo);
  console.log(`\n${"─".repeat(78)}`);
  console.log(titulo);
  console.log(`${"─".repeat(78)}\n`);
  console.log(`  vintage  pool   special servicing        95% CI        delinq.  forecl.`);
  console.log(`  ${"─".repeat(70)}`);

  for (const r of rows) {
    const pool = Number(r.pool);
    const sp = Number(r.special);
    const [lo, hi] = wilson(sp, pool);
    console.log(
      `  ${r.vintage}  ${String(pool).padStart(5)}   ${pct(sp / pool).padStart(6)} (${String(sp).padStart(3)})   ` +
        `[${pct(lo).padStart(5)} , ${pct(hi).padStart(5)}]    ` +
        `${pct(Number(r.delinquent) / pool).padStart(6)}  ${pct(Number(r.foreclosure) / pool).padStart(5)}`,
    );
  }
}

/**
 * Is any vintage distinguishable from another?
 *
 * It is the question that killed the NOI finding, asked before asserting anything.
 */
const rows = await rates(false);
const conIC = rows.map((r) => {
  const pool = Number(r.pool);
  const [lo, hi] = wilson(Number(r.special), pool);
  return { vintage: r.vintage, lo, hi, pool };
});

const distinguishable: string[] = [];
for (let i = 0; i < conIC.length; i++) {
  for (let j = i + 1; j < conIC.length; j++) {
    const a = conIC[i]!;
    const b = conIC[j]!;
    if (a.hi < b.lo || b.hi < a.lo) distinguishable.push(`${a.vintage} vs ${b.vintage}`);
  }
}

const pairs = (conIC.length * (conIC.length - 1)) / 2;
console.log(`\n${"─".repeat(78)}`);
console.log("Verdict");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  Vintage pairs whose intervals do NOT overlap: ${distinguishable.length} of ${pairs}`,
);
if (distinguishable.length > 0) {
  console.log(`  \x1b[32m${distinguishable.join(" · ")}\x1b[0m\n`);
  console.log(
    `  \x1b[90mThis variable does distinguish vintages, unlike NOI growth\x1b[0m`,
  );
  console.log(`  \x1b[90m—where 0 of 10 pairs were distinguishable.\x1b[0m\n`);
} else {
  console.log(`  \x1b[33mNone.\x1b[0m\n`);
  console.log(
    `  \x1b[90mDelinquency does not separate vintages with this sample either. The problem\x1b[0m`,
  );
  console.log(`  \x1b[90mera la variable elegida.\x1b[0m\n`);
}

/**
 * The vintage, or two issuances?
 *
 * A rate per vintage averages issuances, and the corpus has few per year. If a
 * vintage's excess lives in one or two of them, it is not a market phenomenon but
 * a property of those deals —different originator, different concentration,
 * different asset.
 *
 * The criterion is fixed before looking: if the worst-affected issuance
 * contributes more than half of its vintage's events, the annual rate does not
 * describe the vintage.
 */
const CONCENTRACION_MAX = 0.5;

const { rows: byIssuance } = await query<{
  vintage: string; company: string; pool: string; events: string;
}>(
  `SELECT extract(year FROM f.filed_at)::int::text AS vintage,
          f.company_name AS company,
          count(*)::text AS pool,
          count(*) FILTER (WHERE d.transfer_date IS NOT NULL)::text AS events
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
    WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
    GROUP BY 1, 2, f.accession
   HAVING count(*) FILTER (WHERE d.transfer_date IS NOT NULL) > 0
    ORDER BY 1, count(*) FILTER (WHERE d.transfer_date IS NOT NULL) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("The vintage, or a few issuances?");
console.log(`${"─".repeat(78)}\n`);

const byVintage = new Map<string, typeof byIssuance>();
for (const r of byIssuance) {
  const list = byVintage.get(r.vintage) ?? [];
  list.push(r);
  byVintage.set(r.vintage, list);
}

for (const [vintage, list] of [...byVintage].sort()) {
  const total = list.reduce((a, r) => a + Number(r.events), 0);
  const top = list[0]!;
  const shareTop = Number(top.events) / total;
  const alerta = shareTop > CONCENTRACION_MAX;

  console.log(
    `  \x1b[1m${vintage}\x1b[0m  ${total} events in ${list.length} issuances` +
      (alerta ? `  \x1b[31m← concentrado\x1b[0m` : ""),
  );
  for (const r of list.slice(0, 3)) {
    const p = Number(r.events) / total;
    console.log(
      `      ${String(r.events).padStart(3)} of ${String(r.pool).padStart(3)} ` +
        `(${pct(Number(r.events) / Number(r.pool)).padStart(5)} of the deal · ` +
        `${pct(p, 0).padStart(4)} of the vintage)  \x1b[90m${r.company.slice(0, 38)}\x1b[0m`,
    );
  }
  if (list.length > 3) console.log(`      \x1b[90m… and ${list.length - 3} more issuances\x1b[0m`);
  console.log();
}

/**
 * WHEN they fail, not how many fail.
 *
 * THE CONFOUNDER THAT REMAINS
 *
 * The 10-D lists the loans in special servicing TODAY, not those that were at some
 * point. A 2020 loan that entered in 2021 and was resolved does not appear; a 2024
 * one has not had time to enter. That produces a peak in the middle-aged vintages
 * without anything being wrong with them, and it is the most economical
 * explanation for 2023's 6.1%.
 *
 * `transfer_date` lets us tell them apart without downloading historical reports:
 * for each event we know how many months passed between the issuance closing and
 * the transfer.
 *
 *   If 2023 fails at the SAME age as the others → it is stock, not quality.
 *     Every vintage transfers at ~30 months; 2023 is in that window now and the
 *     others have already passed through it.
 *
 *   If 2023 fails EARLIER —at 18 months where others take 40— stock does not
 *     explain that. A loan that breaks in a year and a half was underwritten badly.
 *
 * The second column is the rate per year of exposure, which partially normalises
 * for age: events divided by years since closing. It is crude —it assumes constant
 * risk over time, which is false— but it moves the number in the right direction
 * and shows whether the peak survives the adjustment.
 */
const { rows: timing } = await query<{
  vintage: string; n: string; p25: number | null; median: number | null;
  p75: number | null; age: number | null; pool: string;
}>(
  `WITH ev AS (
     SELECT extract(year FROM f.filed_at)::int AS vintage,
            (d.transfer_date - f.filed_at) / 30.44 AS months_to_event,
            (CURRENT_DATE - f.filed_at) / 365.25 AS edad_anos
       FROM corpus.delinquency d
       JOIN corpus.loans l ON l.id = d.loan_id
       JOIN corpus.filings f ON f.accession = l.accession
      WHERE d.transfer_date IS NOT NULL
        AND d.transfer_date >= f.filed_at
   ),
   po AS (
     SELECT extract(year FROM f.filed_at)::int AS vintage, count(*) AS pool
       FROM corpus.loans l JOIN corpus.filings f ON f.accession = l.accession
      WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
      GROUP BY 1
   )
   SELECT ev.vintage::text AS vintage,
          count(*)::text AS n,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY months_to_event) AS p25,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY months_to_event) AS median,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY months_to_event) AS p75,
          max(ev.edad_anos) AS age,
          max(po.pool)::text AS pool
     FROM ev JOIN po ON po.vintage = ev.vintage
    GROUP BY ev.vintage ORDER BY ev.vintage`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("When do they fail? Months between closing and transfer");
console.log(`${"─".repeat(78)}\n`);
console.log(`  vintage   n    p25   median   p75    age    events per 1,000 loan-years`);
console.log(`  ${"─".repeat(74)}`);

for (const t of timing) {
  const pool = Number(t.pool);
  const age = Number(t.age);
  const tasa = pool > 0 && age > 0 ? (Number(t.n) / (pool * age)) * 1000 : 0;
  console.log(
    `  ${t.vintage}  ${String(t.n).padStart(3)}   ` +
      `${(t.p25 ?? 0).toFixed(0).padStart(3)}    ${(t.median ?? 0).toFixed(0).padStart(3)}    ` +
      `${(t.p75 ?? 0).toFixed(0).padStart(3)}   ${age.toFixed(1)}a          ${tasa.toFixed(1).padStart(5)}`,
  );
}

const medians = timing
  .filter((t) => t.median !== null)
  .map((t) => ({ vintage: t.vintage, m: Number(t.median) }));
if (medians.length >= 2) {
  const slowest = medians.reduce((a, b) => (a.m > b.m ? a : b));
  const fastest = medians.reduce((a, b) => (a.m < b.m ? a : b));
  console.log(
    `\n  Fastest to fail: \x1b[1m${fastest.vintage}\x1b[0m at ${fastest.m.toFixed(0)} months · ` +
      `slowest: ${slowest.vintage} at ${slowest.m.toFixed(0)}`,
  );
  console.log(
    `\n  \x1b[90mIf the vintage with the most events is also the fastest to produce them,\x1b[0m`,
  );
  console.log(
    `  \x1b[90mstock does not explain it. If it fails at the same age as the rest, it does.\x1b[0m\n`,
  );
}

/**
 * Incidence at fixed age: events within the first 24 months.
 *
 * WHY THE PREVIOUS TEST IS NO USE
 *
 * The median months to transfer falls monotonically with the vintage —50, 43, 31,
 * 19, 14— and that says nothing about the vintages: it says that a 2024 issuance
 * has only been watched for 31 months, so its median cannot exceed 31. That is
 * right-censoring, and the test's failure mode is indistinguishable from the
 * hypothesis it was meant to rule out.
 *
 * WHAT THIS VERSION FIXES
 *
 * Fixing the window. Counting only events occurring within the first 24 months
 * from closing puts every vintage on the same scale: 24 months are fully observed
 * for any issuance older than two years.
 *
 * WHAT IT DOES NOT FIX
 *
 * The 10-D lists what is in special servicing TODAY. A 2020 loan that transferred
 * in month 18 and was resolved in 2023 does not appear, so its 24-month window is
 * emptied by resolution. **The incidence of older vintages is understated and the
 * bias grows with age.**
 *
 * That is why the honest comparison is 2023 against 2024: both young, both with 24
 * months observed, both with little time for anything to have been resolved. The
 * rest are shown for reference with the warning attached.
 */
const WINDOW_MONTHS = 24;

const { rows: fija } = await query<{
  vintage: string; pool: string; events: string; age: number;
}>(
  `SELECT extract(year FROM f.filed_at)::int::text AS vintage,
          count(*)::text AS pool,
          count(*) FILTER (
            WHERE d.transfer_date IS NOT NULL
              AND d.transfer_date >= f.filed_at
              AND (d.transfer_date - f.filed_at) <= ${WINDOW_MONTHS} * 30.44
          )::text AS events,
          max((CURRENT_DATE - f.filed_at) / 365.25) AS age
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
    WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
    GROUP BY 1 ORDER BY 1`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`Incidence at fixed age: transfers in the first ${WINDOW_MONTHS} months`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  vintage  pool   events   incidence          95% CI        age`);
console.log(`  ${"─".repeat(66)}`);

const fixed = fija
  .filter((r) => Number(r.age) * 12 >= WINDOW_MONTHS)
  .map((r) => {
    const pool = Number(r.pool);
    const k = Number(r.events);
    const [lo, hi] = wilson(k, pool);
    return { vintage: r.vintage, pool, k, lo, hi, age: Number(r.age) };
  });

for (const r of fixed) {
  const viejo = r.age > 4;
  console.log(
    `  ${r.vintage}  ${String(r.pool).padStart(5)}   ${String(r.k).padStart(5)}     ` +
      `${pct(r.k / r.pool).padStart(6)}    [${pct(r.lo).padStart(5)} , ${pct(r.hi).padStart(5)}]   ` +
      `${r.age.toFixed(1)}a` +
      (viejo ? `  \x1b[90m← emptied by resolution\x1b[0m` : ""),
  );
}

const a23 = fixed.find((r) => r.vintage === "2023");
const a24 = fixed.find((r) => r.vintage === "2024");

console.log(`\n  \x1b[1mThe clean comparison: 2023 against 2024\x1b[0m`);
if (a23 && a24) {
  const solapan = !(a23.lo > a24.hi || a24.lo > a23.hi);
  console.log(
    `    2023  ${pct(a23.k / a23.pool)} [${pct(a23.lo)} , ${pct(a23.hi)}]` +
      `    2024  ${pct(a24.k / a24.pool)} [${pct(a24.lo)} , ${pct(a24.hi)}]`,
  );
  if (solapan) {
    console.log(`\n    \x1b[33mLos intervalos se pisan.\x1b[0m`);
    console.log(
      `    \x1b[90mAt the same age, 2023 and 2024 are not distinguishable. 2023's 6.1%\x1b[0m`,
    );
    console.log(
      `    \x1b[90mwas the observation window, not the vintage. The peak is explained by\x1b[0m`,
    );
    console.log(`    \x1b[90mstock y censura.\x1b[0m\n`);
  } else {
    console.log(`\n    \x1b[32mThe intervals do NOT overlap.\x1b[0m`);
    console.log(
      `    \x1b[90mAt the same age and with the same resolution bias, one vintage has\x1b[0m`,
    );
    console.log(
      `    \x1b[90mmore early transfers than the other. Stock does not explain that.\x1b[0m\n`,
    );
  }
} else {
  console.log(`    \x1b[33mData is missing for one of the two vintages.\x1b[0m\n`);
}

/**
 * Were they already different at origination?
 *
 * THE LAST CHEAP ALTERNATIVE
 *
 * 2023 transfers to special servicing 2.4 times more often than 2024 at the same
 * age. That survived the identity, the join bias, the concentration by issuance
 * and the age confounder. One explanation remains that is not about underwriting
 * but about composition: that the 2023 loans were already worse on paper.
 *
 * 2023 was the lowest CMBS issuance year of the decade and the worst moment for
 * offices. If those deals carry more office, more leverage or less coverage at
 * origination, the market already knew and there is no news.
 *
 * The comparison is made on the Annex A side, which is the corpus's strongest
 * data —identities at 97%— and which is independent of the servicer report.
 *
 * HOW TO READ IT
 *
 *   similar profile + different outcome  → it is about underwriting
 *   worse profile in 2023                → it is composition, there is no news
 */
const { rows: profile } = await query<{
  vintage: string; n: string; ltv: number | null; dscr: number | null;
  dy: number | null; office: number | null; retail: number | null;
  hotel: number | null; multi: number | null;
}>(
  `SELECT extract(year FROM f.filed_at)::int::text AS vintage,
          count(*)::text AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ltv.value::numeric)  AS ltv,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY dscr.value::numeric) AS dscr,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY dy.value::numeric)   AS dy,
          avg((l.property_type ILIKE '%office%')::int)      AS office,
          avg((l.property_type ILIKE '%retail%')::int)      AS retail,
          avg((l.property_type ILIKE '%hospitality%'
               OR l.property_type ILIKE '%hotel%')::int)    AS hotel,
          avg((l.property_type ILIKE '%multifamily%')::int) AS multi
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.facts ltv  ON ltv.loan_id = l.id AND ltv.metric_key = 'ltv'
                                AND ltv.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts dscr ON dscr.loan_id = l.id AND dscr.metric_key = 'dscr'
                                AND dscr.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts dy   ON dy.loan_id = l.id AND dy.metric_key = 'debt_yield'
                                AND dy.value ~ '^-?[0-9.]+$'
    WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
    GROUP BY 1 ORDER BY 1`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("Were they already different at origination? Annex A profile");
console.log(`${"─".repeat(78)}\n`);
console.log(`  vintage   n     LTV    DSCR   debt yield    office  retail  hotel  multi`);
console.log(`  ${"─".repeat(74)}`);

for (const r of profile) {
  console.log(
    `  ${r.vintage}  ${String(r.n).padStart(5)}   ${pct(Number(r.ltv ?? 0), 0).padStart(4)}   ` +
      `${(Number(r.dscr ?? 0)).toFixed(2).padStart(5)}   ${pct(Number(r.dy ?? 0)).padStart(6)}      ` +
      `${pct(Number(r.office ?? 0), 0).padStart(5)}   ${pct(Number(r.retail ?? 0), 0).padStart(5)}  ` +
      `${pct(Number(r.hotel ?? 0), 0).padStart(5)}  ${pct(Number(r.multi ?? 0), 0).padStart(5)}`,
  );
}

const p23 = profile.find((r) => r.vintage === "2023");
const p24 = profile.find((r) => r.vintage === "2024");

if (p23 && p24) {
  /**
   * The criterion is fixed beforehand: 2023 "comes in worse" if its median LTV exceeds
   * 2024 by more than 3 points, its DSCR is lower by more than 0.15, or its office
   * exposure is higher by more than 8 points. Those are the three levers an
   * underwriter would look at first.
   */
  const peorLtv = Number(p23.ltv ?? 0) - Number(p24.ltv ?? 0) > 0.03;
  const peorDscr = Number(p24.dscr ?? 0) - Number(p23.dscr ?? 0) > 0.15;
  const masOffice = Number(p23.office ?? 0) - Number(p24.office ?? 0) > 0.08;

  console.log(`\n  \x1b[1m2023 contra 2024 al originar\x1b[0m`);
  console.log(
    `    LTV      ${pct(Number(p23.ltv ?? 0), 1)} vs ${pct(Number(p24.ltv ?? 0), 1)}` +
      `   ${peorLtv ? "\x1b[33m← 2023 more leveraged\x1b[0m" : "\x1b[90mno relevant difference\x1b[0m"}`,
  );
  console.log(
    `    DSCR     ${Number(p23.dscr ?? 0).toFixed(2)} vs ${Number(p24.dscr ?? 0).toFixed(2)}` +
      `     ${peorDscr ? "\x1b[33m← 2023 with less coverage\x1b[0m" : "\x1b[90mno relevant difference\x1b[0m"}`,
  );
  console.log(
    `    office   ${pct(Number(p23.office ?? 0), 1)} vs ${pct(Number(p24.office ?? 0), 1)}` +
      `   ${masOffice ? "\x1b[33m← 2023 more exposed\x1b[0m" : "\x1b[90mno relevant difference\x1b[0m"}`,
  );

  if (!peorLtv && !peorDscr && !masOffice) {
    console.log(`\n    \x1b[32mNot explained by composition.\x1b[0m`);
    console.log(
      `    \x1b[90mThe 2023 and 2024 loans look identical on paper and break\x1b[0m`,
    );
    console.log(
      `    \x1b[90mdifferently. That is about underwriting, or about something the Annex A\x1b[0m`,
    );
    console.log(`    \x1b[90mdoes not publish.\x1b[0m\n`);
  } else {
    console.log(`\n    \x1b[33m2023 already came in worse on paper.\x1b[0m`);
    console.log(
      `    \x1b[90mThe performance difference may be pool composition and not\x1b[0m`,
    );
    console.log(`    \x1b[90munderwriting quality.\x1b[0m\n`);
  }
}

/**
 * The same comparison, within each asset type.
 *
 * WHY THE PREVIOUS BLOCK WAS NOT ENOUGH
 *
 * The three thresholds I set —LTV, DSCR, office— each passed separately and the
 * script concluded "not explained by composition". Looking at the table shows
 * something else: 2023 has 17.5% office and 15% hotel against 11.2% and 10% for
 * 2024, and half the multifamily. No individual difference reached the cut, but
 * together they describe a riskier pool on the asset side.
 *
 * **A univariate threshold lets through a difference spread across several
 * variables.** The raw values showed it; the automatic verdict
 * no.
 *
 * THIS IS THE DIRECT TEST
 *
 * Comparing 2023 against 2024 WITHIN each type. If 2023's office fails as much
 * as 2024's and the aggregate gap comes from 2023 having more office, it is
 * composition. If 2023's office fails more than 2024's, it is not.
 *
 * It is the same logic as the size band that killed the NOI finding.
 *
 * The last row standardises: the rate 2023 would have with 2024's asset mix. If
 * reweighting dissolves the gap, it was composition.
 */
const TYPES: Array<[string, string]> = [
  ["oficina", "%office%"],
  ["retail", "%retail%"],
  ["hotel", "%hospitality%"],
  ["multifamily", "%multifamily%"],
  ["industrial", "%industrial%"],
];

console.log(`\n${"─".repeat(78)}`);
console.log(`Within each asset type: 2023 against 2024 at ${WINDOW_MONTHS} months`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  type            2023: n    tasa        2024: n    tasa      cociente`);
console.log(`  ${"─".repeat(72)}`);

const byType: Array<{ type: string; n23: number; k23: number; n24: number; k24: number }> = [];

for (const [name, pattern] of TYPES) {
  const { rows } = await query<{ vintage: string; pool: string; ev: string }>(
    `SELECT extract(year FROM f.filed_at)::int::text AS vintage,
            count(*)::text AS pool,
            count(*) FILTER (
              WHERE d.transfer_date IS NOT NULL
                AND d.transfer_date >= f.filed_at
                AND (d.transfer_date - f.filed_at) <= ${WINDOW_MONTHS} * 30.44
            )::text AS ev
       FROM corpus.loans l
       JOIN corpus.filings f ON f.accession = l.accession
       LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
      WHERE l.property_type ILIKE $1
        AND extract(year FROM f.filed_at) IN (2023, 2024)
        AND f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
      GROUP BY 1 ORDER BY 1`,
    [pattern],
  );

  const r23 = rows.find((r) => r.vintage === "2023");
  const r24 = rows.find((r) => r.vintage === "2024");
  const n23 = Number(r23?.pool ?? 0), k23 = Number(r23?.ev ?? 0);
  const n24 = Number(r24?.pool ?? 0), k24 = Number(r24?.ev ?? 0);
  if (n23 < 20 || n24 < 20) {
    console.log(`  ${name.padEnd(14)} \x1b[90mn insuficiente (${n23} / ${n24})\x1b[0m`);
    continue;
  }
  byType.push({ type: name, n23, k23, n24, k24 });

  const t23 = k23 / n23, t24 = k24 / n24;
  const coc = t24 > 0 ? t23 / t24 : NaN;
  console.log(
    `  ${name.padEnd(14)} ${String(n23).padStart(4)}  ${pct(t23).padStart(6)}` +
      `      ${String(n24).padStart(4)}  ${pct(t24).padStart(6)}` +
      `     ${Number.isNaN(coc) ? "  —  " : `${coc.toFixed(1)}x`}`,
  );
}

/**
 * Direct standardisation: 2023's rate with 2024's mix.
 *
 * 2023's per-type rates are applied to 2024's weights. If the result comes close
 * to 2024's crude rate, the gap was composition.
 */
if (byType.length >= 3) {
  const pool24 = byType.reduce((a, t) => a + t.n24, 0);
  const estandarizada = byType.reduce(
    (a, t) => a + (t.k23 / t.n23) * (t.n24 / pool24),
    0,
  );
  const cruda24 = byType.reduce((a, t) => a + t.k24, 0) / pool24;
  const cruda23 =
    byType.reduce((a, t) => a + t.k23, 0) / byType.reduce((a, t) => a + t.n23, 0);

  console.log(`\n  \x1b[1mStandardising 2023 to 2024's asset mix\x1b[0m`);
  console.log(`    2023 cruda          ${pct(cruda23)}`);
  console.log(`    2023 estandarizada  ${pct(estandarizada)}`);
  console.log(`    2024 cruda          ${pct(cruda24)}`);

  const brechaCruda = cruda23 - cruda24;
  const brechaEstand = estandarizada - cruda24;
  const explicado = brechaCruda !== 0 ? 1 - brechaEstand / brechaCruda : 0;

  console.log(
    `\n    Composition explains ${pct(Math.max(0, Math.min(1, explicado)), 0)} of the gap.`,
  );
  if (brechaEstand > 0.01) {
    console.log(
      `    \x1b[32mA gap of ${pct(brechaEstand)} remains after equalising the mix.\x1b[0m\n`,
    );
  } else {
    console.log(
      `    \x1b[33mEqualising the mix, the gap disappears: it was composition.\x1b[0m\n`,
    );
  }
}

/**
 * The cell holding everything up: multifamily 2023.
 *
 * WHY LOOK HERE
 *
 * The standardisation concluded that composition explains 0% of the gap. That
 * verdict depends almost entirely on one cell: multifamily 2023, with 17 events
 * over 95 loans —17.9%. Since multifamily weighs 30% in 2024's mix, that rate
 * propagates through the whole standardisation.
 *
 * And 17.9% special servicing in multifamily at 24 months is not a market rate:
 * multifamily is the most resilient class in CMBS. A number like that describes a
 * specific product —floating-rate bridge loans, leveraged sponsors— or an error,
 * but not "2023 multifamily".
 *
 * If the 17 sit in one or two issuances, the result is not about the vintage nor
 * about the asset type, and the whole chain of conclusions falls apart.
 */
const { rows: mf } = await query<{
  company: string; pool: string; events: string; ltv: number | null;
  dscr: number | null; tasa: number | null;
}>(
  `SELECT f.company_name AS company,
          count(*)::text AS pool,
          count(*) FILTER (
            WHERE d.transfer_date IS NOT NULL
              AND d.transfer_date >= f.filed_at
              AND (d.transfer_date - f.filed_at) <= ${WINDOW_MONTHS} * 30.44
          )::text AS events,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ltv.value::numeric)  AS ltv,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY dscr.value::numeric) AS dscr,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ir.value::numeric)   AS tasa
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
     LEFT JOIN corpus.facts ltv  ON ltv.loan_id = l.id AND ltv.metric_key = 'ltv'
                                AND ltv.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts dscr ON dscr.loan_id = l.id AND dscr.metric_key = 'dscr'
                                AND dscr.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts ir   ON ir.loan_id = l.id AND ir.metric_key = 'interest_rate'
                                AND ir.value ~ '^-?[0-9.]+$'
    WHERE l.property_type ILIKE '%multifamily%'
      AND extract(year FROM f.filed_at) = 2023
      AND f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
    GROUP BY f.company_name, f.accession
    ORDER BY count(*) FILTER (
      WHERE d.transfer_date IS NOT NULL
        AND d.transfer_date >= f.filed_at
        AND (d.transfer_date - f.filed_at) <= ${WINDOW_MONTHS} * 30.44
    ) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("The cell holding up the result: multifamily 2023");
console.log(`${"─".repeat(78)}\n`);
console.log(`  events / pool     LTV    DSCR   rate     issuance`);
console.log(`  ${"─".repeat(72)}`);

const totalEvents = mf.reduce((a, r) => a + Number(r.events), 0);
let cumulative = 0;

for (const r of mf.filter((x) => Number(x.events) > 0)) {
  cumulative += Number(r.events);
  console.log(
    `  ${String(r.events).padStart(3)} / ${String(r.pool).padEnd(4)}      ` +
      `${pct(Number(r.ltv ?? 0), 0).padStart(4)}   ${Number(r.dscr ?? 0).toFixed(2)}   ` +
      `${pct(Number(r.tasa ?? 0), 2).padStart(6)}   \x1b[90m${r.company.slice(0, 34)}\x1b[0m`,
  );
}

const withEvents = mf.filter((x) => Number(x.events) > 0).length;
const top2 = mf.slice(0, 2).reduce((a, r) => a + Number(r.events), 0);
const shareTop2 = totalEvents > 0 ? top2 / totalEvents : 0;

console.log(
  `\n  ${totalEvents} events across ${withEvents} issuances · the worst two contribute ${pct(shareTop2, 0)}`,
);

if (shareTop2 > 0.5) {
  console.log(`\n  \x1b[31mTHE CELL IS DOMINATED BY TWO ISSUANCES.\x1b[0m`);
  console.log(
    `  \x1b[90m"2023 multifamily" does not exist as a phenomenon: it is those deals. And\x1b[0m`,
  );
  console.log(
    `  \x1b[90msince this cell drives the standardisation, the "0% explained by composition"\x1b[0m`,
  );
  console.log(`  \x1b[90mtampoco se sostiene.\x1b[0m\n`);
} else {
  console.log(`\n  \x1b[32mSpread across ${withEvents} issuances.\x1b[0m`);
  console.log(
    `  \x1b[90mNot a one-off deal. Look at LTV, DSCR and rate: if those issuances carry\x1b[0m`,
  );
  console.log(
    `  \x1b[90mnotably higher rates, the product is different even though the asset type\x1b[0m`,
  );
  console.log(`  \x1b[90mactivo se llame igual.\x1b[0m\n`);
}

console.log(
  `  \x1b[90mCAUTION: risk exposure grows with age. A 2020 vintage had six years to\x1b[0m`,
);
console.log(
  `  \x1b[90maccumulate events and a 2024 one had two. A difference between vintages\x1b[0m`,
);
console.log(
  `  \x1b[90mmay be underwriting quality or simply time, and these\x1b[0m`,
);
console.log(`  \x1b[90mrates do not separate them.\x1b[0m\n`);

await closePool();

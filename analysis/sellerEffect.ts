/**
 * Is the gap the issuer's, or that of whoever originated the loan?
 *
 *   npm run db:seller
 *
 * THE QUESTION, AND WHY IT DIFFERS FROM THE PREVIOUS NINE
 *
 * BANK transfers to special servicing 4 times less than BBCMS, standardised by
 * vintage, property type and leverage. That survived nine attempts to kill it:
 * join coverage, listed population, block format, parser filters, raw value in
 * twenty issuances, master servicer, special servicer, portfolio composition,
 * and the specially-serviced block the parser was not reading.
 *
 * All nine were defensive: each asked "is this an artefact?" and the answer was
 * "no". Nine "no"s do not make a "yes".
 *
 * This is the first that can CONFIRM the effect, because it proposes what it
 * would be if real. BANK is not an originator: it is a vehicle that packages
 * loans originated by Bank of America, Morgan Stanley and Wells Fargo. Saying
 * "BANK underwrites better" is congratulating the box for what the factory did.
 *
 * WHY IT IS IDENTIFIABLE
 *
 * The same seller places into several issuances, so the design ends up crossed
 * without anyone designing it. Wells Fargo sells into BANK (SIR 0.42) and into
 * its own shelf (1.20). If the seller is what matters, holding it fixed flattens
 * that difference.
 *
 * THE ORDER IS FORCED
 *
 * Coverage → raw values → identifiability → effect. Each step can stop the
 * script. In particular the raw values come before grouping anything: the Annex
 * A publishes abbreviations —JPMCB, CREFI, GACC, MSMCH— and if two filings write
 * the same seller differently, grouping without looking fragments the design the
 * same way Midland got fragmented into five strings.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Fixed before looking at anything. */
const MIN_COVERAGE = 0.5;
const MIN_POOL = 150;

/**
 * `--with-leverage`: adds the DSCR tercile to the stratum.
 *
 * THE DISTINCTION THAT DECIDES WHAT THE RESULT MEANS
 *
 * Adjusted for type and vintage, LMF comes out at 3.61 and GSMC at 0.14: 26
 * times. But that is compatible with two very different stories.
 *
 *   LMF lends more leveraged on purpose, and charges for that risk. Then the
 *   3.61 measures its strategy, is to be expected, and says nothing about its
 *   quality.
 *
 *   LMF lends at the same leverage as everyone else and still does worse. Then
 *   it is underwriting: it picks worse borrowers or projects rents that do not
 *   materialise.
 *
 * Only the second is interesting, and they are only distinguishable by
 * controlling for leverage. `db:predictors` already showed that DSCR at
 * origination separates strongly —6.0% against 0.8% between extreme quintiles—
 * so it is the control most likely to move these numbers.
 *
 * TERCILES Y NO QUINTILES
 *
 * The stratum becomes type × vintage × tercile: 9 × 5 × 3 is 135 cells for 168
 * events. With quintiles it would be 225 and half would be empty. We have
 * already seen what happens when you over-stratify: the expected values collapse
 * towards the observed and the test eats itself without saying so.
 *
 * WHAT TO WATCH TO KNOW IF THAT HAPPENED
 *
 * If EVERY seller's expected value approaches its observed and the SIRs converge
 * to 1 as a block, the stratum is too fine. If some rise and others fall, the
 * control is doing its job.
 */
const WITH_LEVERAGE = process.argv.includes("--with-leverage");

/**
 * `--with-ltv`: also adds the LTV tercile.
 *
 * DSCR and LTV measure different risks and add up: `db:predictors` showed that
 * with DSCR low fixed, going from LTV low to high multiplies by 3.7x, and the
 * other way round by 3.1x. Controlling only one leaves half the leverage out.
 *
 * EL COSTO
 *
 * The stratum becomes type × vintage × 3 × 3: up to 405 cells for 168 events.
 * That is almost certainly too many, and the signature of it —the SIRs
 * converging to 1 as a block while the expected values stick to the observed—
 * has to be looked at BEFORE the result. That is why the script prints the mean
 * expected/observed ratio when this flag is on.
 *
 * If it collapses, the way out is not to lower the threshold until it works: it
 * is to accept that the corpus cannot bear this control, and say so.
 */
const WITH_LTV = process.argv.includes("--with-ltv");

/**
 * `--with-size`: adds the loan balance tercile.
 *
 * WHY IT ONLY APPEARS NOW
 *
 * `db:mechanism` went looking for the mechanism behind LMF's residual
 * —interest-only, reserves, NOI projection— and found none: every candidate came
 * out flat or against. The only thing that moved was the balance: a median of
 * 5.9M against 11.3M for the rest in the same subtypes.
 *
 * Size was not controlled in any of the twelve previous attacks.
 *
 * CONFOUNDER OR MEDIATOR: THE DISTINCTION MATTERS
 *
 * If small loans default more for reasons unrelated to the lender —less
 * institutional sponsors, secondary markets, less scrutiny— then size is a
 * confounder and has to be controlled.
 *
 * If LMF CHOOSES to lend small, size is on the causal path of its strategy, and
 * controlling for it is over-controlling: it takes credit away for a decision
 * that is theirs.
 *
 * Both readings are defensible and the data does not separate them. What the
 * control does do is change the question, and it is worth saying which one is
 * left:
 *
 *   uncontrolled  →  "does LMF's book perform worse?"        (we know it does)
 *   controlled    →  "does LMF perform worse than other
 *                     lenders making loans of the same size?" (a benchmark's)
 */
const WITH_SIZE = process.argv.includes("--with-size");

/**
 * `--with-subtype`: the stratum uses property_type_detailed instead of the coarse type.
 *
 * WHY, AND WHERE IT CAME FROM
 *
 * Adding the multiple-comparisons correction to this script changed which
 * finding is citable. With DSCR + LTV + balance, LMF falls to z = 2.28 and does
 * NOT pass Bonferroni; UBS AG sits at z = 2.97 against a threshold of 2.91 and
 * does pass. The project spent thirteen attacks on LMF and none on UBS.
 *
 * And the subtype table says where UBS's excess lives: 6 of its 13 events are in
 * 11 Limited Service loans, at 54.5% against 9.2% for the corpus.
 *
 * Limited service and full service hotels both live inside "Hospitality". They
 * are different products, so standardising by the coarse type does not control
 * for that. It is the same product-within-type mechanism that already killed the
 * issuer effect: the cooperatives inside multifamily.
 *
 * THE COST, WHICH IS DOUBLE
 *
 * property_type_detailed coverage is 75% (71.6% in LMF), so a quarter of the
 * sample is lost. And there are more than twenty subtypes: with vintage that is
 * ~100 cells for 168 events, so over-stratification is likely. The signature
 * —expected values sticking to observed— is already printed and has to be looked
 * at BEFORE the result.
 *
 * If it collapses, the right answer is that the corpus cannot bear this control,
 * not to lower the threshold until it works.
 */
const WITH_SUBTYPE = process.argv.includes("--with-subtype");

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

function wilson(k: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = k / total;
  const d = 1 + (z * z) / total;
  const c = p + (z * z) / (2 * total);
  const m = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

const SHELF = `
  CASE
    WHEN f.company_name ILIKE 'BANK5%'     THEN 'BANK5'
    WHEN f.company_name ILIKE 'BANK %'     THEN 'BANK'
    WHEN f.company_name ILIKE 'BENCHMARK%' THEN 'Benchmark'
    WHEN f.company_name ILIKE 'BBCMS%'     THEN 'BBCMS'
    WHEN f.company_name ILIKE 'BMO%'       THEN 'BMO'
    WHEN f.company_name ILIKE 'WELLS%'     THEN 'Wells'
    WHEN f.company_name ILIKE 'MORGAN%' OR f.company_name ILIKE 'MSWF%' THEN 'MS'
    WHEN f.company_name ILIKE 'GS %'       THEN 'GS'
    ELSE 'otros'
  END`;

const BASE = `
  SELECT l.id,
         ${SHELF} AS shelf,
         nullif(btrim(l.loan_seller), '') AS seller,
         extract(year FROM f.filed_at)::int AS vintage,
         (d.transfer_date IS NOT NULL)::int AS event
    FROM corpus.loans l
    JOIN corpus.filings f ON f.accession = l.accession
    LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
   WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                          WHERE deal_accession IS NOT NULL)
`;

console.log(`\n${"═".repeat(78)}`);
console.log("Issuer, or the loan's seller?");
console.log(`${"═".repeat(78)}`);

// ---------------------------------------------------------------------------
// 1. Coverage
// ---------------------------------------------------------------------------

const { rows: cov } = await query<{ n: string; with_seller: string; issuances: string; with_col: string }>(
  `WITH base AS (${BASE})
   SELECT count(*)::text AS n,
          count(*) FILTER (WHERE seller IS NOT NULL)::text AS with_seller,
          (SELECT count(DISTINCT f.accession)::text FROM corpus.filings f) AS issuances,
          (SELECT count(DISTINCT l.accession)::text FROM corpus.loans l
            WHERE nullif(btrim(l.loan_seller), '') IS NOT NULL) AS with_col
     FROM base`,
);

const n = Number(cov[0]!.n);
const withSeller = Number(cov[0]!.with_seller);
const coverage = n > 0 ? withSeller / n : 0;

console.log(`\n${"─".repeat(78)}`);
console.log("Seller coverage");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  ${withSeller.toLocaleString("en-US")} of ${n.toLocaleString("en-US")} loans  →  ` +
    `${coverage >= MIN_COVERAGE ? "\x1b[32m" : "\x1b[31m"}${pct(coverage)}\x1b[0m` +
    `   \x1b[90m(threshold ${pct(MIN_COVERAGE, 0)})\x1b[0m`,
);
console.log(
  `  \x1b[90m${cov[0]!.with_col} of ${cov[0]!.issuances} issuances in the corpus have the column\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 2. Raw values, before grouping
// ---------------------------------------------------------------------------

const { rows: raw } = await query<{ v: string; n: string; ev: string; shelves: string }>(
  `WITH base AS (${BASE})
   SELECT seller AS v, count(*)::text AS n, sum(event)::text AS ev,
          count(DISTINCT shelf)::text AS shelves
     FROM base WHERE seller IS NOT NULL
    GROUP BY seller ORDER BY count(*) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`Valores raw (${raw.length} distintos)`);
console.log(`${"─".repeat(78)}\n`);

if (raw.length === 0) {
  console.log(`  \x1b[33mNone. Re-harvest with: npm run harvest:batch -- --refresh-stale\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

for (const r of raw.slice(0, 25)) {
  const nn = Number(r.n), ev = Number(r.ev);
  console.log(
    `  ${r.v.slice(0, 30).padEnd(32)} ${String(nn).padStart(5)}  ${String(ev).padStart(3)} ev  ` +
      `${nn >= 50 ? pct(ev / nn).padStart(6) : "     —"}   \x1b[90men ${r.shelves} emisora(s)\x1b[0m`,
  );
}
if (raw.length > 25) console.log(`  \x1b[90m... and ${raw.length - 25} more\x1b[0m`);

/**
 * Joint sales —"JPMCB/CREFI"— are a composite seller, not a new one. They are
 * counted separately so we can decide what to do with them, rather than having
 * them enter as their own category without anyone noticing.
 */
const joint = raw.filter((r) => /[\/&+]|\band\b/i.test(r.v));
if (joint.length > 0) {
  const total = joint.reduce((a, r) => a + Number(r.n), 0);
  console.log(
    `\n  \x1b[90m${joint.length} values are joint sales (${total} loans): ` +
      `${joint.slice(0, 4).map((r) => r.v).join(", ")}\x1b[0m`,
  );
}

if (coverage < MIN_COVERAGE) {
  console.log(`\n  \x1b[31mINSUFFICIENT COVERAGE. The effect is not reported.\x1b[0m`);
  console.log(
    `  \x1b[90mWith fewer than half the loans, the issuer × seller cross compares\x1b[0m`,
  );
  console.log(
    `  \x1b[90mdifferent subsets of each issuer, which is the very bias this\x1b[0m`,
  );
  console.log(`  \x1b[90meste script viene a descartar.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. Is it identifiable?
// ---------------------------------------------------------------------------

const { rows: celdas } = await query<{
  shelf: string; v: string; n: string; ev: string;
}>(
  `WITH base AS (${BASE})
   SELECT shelf, seller AS v, count(*)::text AS n, sum(event)::text AS ev
     FROM base WHERE seller IS NOT NULL
    GROUP BY shelf, seller
   HAVING count(*) >= ${MIN_POOL}
    ORDER BY seller, shelf`,
);

const bySeller = new Map<string, Array<{ k: string; rate: number; n: number }>>();
const porShelf = new Map<string, Array<{ k: string; rate: number; n: number }>>();
for (const c of celdas) {
  const nn = Number(c.n), ev = Number(c.ev);
  const rate = ev / nn;
  (bySeller.get(c.v) ?? bySeller.set(c.v, []).get(c.v)!).push({ k: c.shelf, rate, n: nn });
  (porShelf.get(c.shelf) ?? porShelf.set(c.shelf, []).get(c.shelf)!).push({ k: c.v, rate, n: nn });
}

const crossedSellers = [...bySeller].filter(([, xs]) => xs.length > 1);
const crossedShelves = [...porShelf].filter(([, xs]) => xs.length > 1);

console.log(`\n${"─".repeat(78)}`);
console.log(`Issuer × seller cells (pool ≥ ${MIN_POOL})`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  seller              issuer         n   ev     rate         95% CI`);
console.log(`  ${"─".repeat(68)}`);

let prev = "";
for (const c of celdas) {
  const nn = Number(c.n), ev = Number(c.ev);
  const [lo, hi] = wilson(ev, nn);
  const label = c.v === prev ? "" : c.v.slice(0, 18);
  prev = c.v;
  console.log(
    `  ${label.padEnd(19)} ${c.shelf.padEnd(10)} ${String(nn).padStart(5)} ${String(ev).padStart(4)}  ` +
      `${pct(ev / nn).padStart(6)}  [${pct(lo).padStart(5)} , ${pct(hi).padStart(5)}]`,
  );
}

console.log(
  `\n  Sellers in more than one issuer: \x1b[1m${crossedSellers.length}\x1b[0m` +
    `   ·   Issuers with more than one seller: \x1b[1m${crossedShelves.length}\x1b[0m`,
);

if (crossedSellers.length === 0 || crossedShelves.length === 0) {
  console.log(
    `\n  \x1b[31mNOT IDENTIFIABLE with cells of pool ≥ ${MIN_POOL}.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mWithout off-diagonal cells, issuer and seller are the same column\x1b[0m`,
  );
  console.log(`  \x1b[90mwith two names.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 4. Which one disperses more?
// ---------------------------------------------------------------------------

/**
 * In percentage points, not as a ratio: a cell with zero events makes the ratio
 * undefined, and the previous version of this test papered over that with a
 * `max(1e-9, min)` that returned 29,333,333x.
 */
const spread = (xs: number[]) => (xs.length < 2 ? null : Math.max(...xs) - Math.min(...xs));
const median = (xs: number[]) =>
  xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

console.log(`\n${"─".repeat(78)}`);
console.log("Holding one variable fixed, how much does the other disperse?");
console.log(`${"─".repeat(78)}\n`);

const spV: number[] = [];
console.log(`  With the SELLER fixed, dispersion across issuers:\n`);
for (const [v, xs] of crossedSellers) {
  const sp = spread(xs.map((x) => x.rate))!;
  spV.push(sp);
  const detail = [...xs].sort((a, b) => a.rate - b.rate)
    .map((x) => `${x.k} ${pct(x.rate)}`).join("  ·  ");
  console.log(`    ${v.slice(0, 18).padEnd(19)} ${(sp * 100).toFixed(1).padStart(5)} pp   \x1b[90m${detail}\x1b[0m`);
}

const spS: number[] = [];
console.log(`\n  With the ISSUER fixed, dispersion across sellers:\n`);
for (const [s, xs] of crossedShelves) {
  const sp = spread(xs.map((x) => x.rate))!;
  spS.push(sp);
  const detail = [...xs].sort((a, b) => a.rate - b.rate)
    .map((x) => `${x.k.slice(0, 12)} ${pct(x.rate)}`).join("  ·  ");
  console.log(`    ${s.padEnd(19)} ${(sp * 100).toFixed(1).padStart(5)} pp   \x1b[90m${detail}\x1b[0m`);
}

const medV = median(spV);
const medS = median(spS);

console.log(`\n${"─".repeat(78)}\n`);
if (medV === null || medS === null) {
  console.log(`  \x1b[33mNot enough cells in both directions.\x1b[0m\n`);
} else {
  console.log(`  Median with seller fixed: \x1b[1m${(medV * 100).toFixed(1)} pp\x1b[0m across issuers`);
  console.log(`  Median with issuer fixed: \x1b[1m${(medS * 100).toFixed(1)} pp\x1b[0m across sellers`);

  /**
   * THE 1.5 FACTOR HAS NO NULL, AND THAT SHOULD BE KNOWN.
   *
   * The two medians are computed over different numbers of cells, and a
   * dispersion has a POSITIVE expected value even with no effect: with cells of
   * ~200 loans and rates of 5%, the range between two cells moves several points
   * from sampling alone.
   *
   * Comparing the two medians against a fixed factor is the same error as the
   * top-2 threshold in db:cohort. What is missing is a simulation: permute the
   * seller label within each issuer and see how much it disperses by chance.
   *
   * The verdict stays because the conclusion it produced —the seller rules, not
   * the issuer— was later confirmed by the independent route of the SIR by
   * originator, which does have a reference. But the factor itself is arbitrary.
   */
  if (medS > medV * 1.5) {
    console.log(
      `\n  \x1b[32mTHE SELLER RULES.\x1b[0m Fixing the issuer leaves large differences between`,
    );
    console.log(
      `  \x1b[90msellers, and fixing the seller flattens the issuers. What we had been\x1b[0m`,
    );
    console.log(
      `  \x1b[90mcalling an "issuer effect" was each shelf's mix of originators.\x1b[0m`,
    );
  } else if (medV > medS * 1.5) {
    console.log(
      `\n  \x1b[33mTHE ISSUER RULES.\x1b[0m The same seller performs differently depending on which`,
    );
    console.log(
      `  \x1b[90missuance it places into. That is not "who underwrites better": it is that\x1b[0m`,
    );
    console.log(
      `  \x1b[90mthe shelf chooses which loans it accepts from each seller, or pools them\x1b[0m`,
    );
  } else {
    console.log(`\n  \x1b[33mBoth disperse similarly.\x1b[0m They do not separate with these cells.`);
  }
  console.log(
    `\n  \x1b[90mNot standardised by vintage or type: cells of ~200 loans cannot bear\x1b[0m`,
  );
  console.log(`  \x1b[90mstratifying. It is a declared limitation.\x1b[0m`);
  console.log(
    `  \x1b[33mAnd the 1.5 factor in this verdict has no null:\x1b[0m \x1b[90ma dispersion has a\x1b[0m`,
  );
  console.log(
    `  \x1b[90mpositive expected value even with no effect. The conclusion holds because of\x1b[0m`,
  );
  console.log(
    `  \x1b[90mthe SIR by originator, which does have a reference — not because of this ratio.\x1b[0m\n`,
  );
}

// ---------------------------------------------------------------------------
// 5. The inverted SIR: which originators depart, adjusted?
// ---------------------------------------------------------------------------

/**
 * The question that remains after killing the issuer effect.
 *
 * Standardising by seller showed that no issuer departs: BANK 1.01 · BBCMS 1.10
 * · BMO 1.03. The variation was one level down, among originators — from 0%
 * (NCB) to 11.2% (LMF).
 *
 * But those are RAW rates. LMF may be concentrated in 2021-2022, or in
 * hospitality, in which case its 11.2% would be measuring the vintage or the
 * asset. This is the same SIR as `db:composition` with the roles swapped: the
 * seller is the unit and the stratum is property type × vintage.
 *
 * UNLIKE THE ISSUER, HERE THE QUESTION MAKES SENSE
 *
 * The originator does decide who it lends to, at what leverage and against what
 * rent projection. It is the level where underwriting happens. The issuer only
 * chooses who to buy from.
 *
 * WHAT IS STILL NOT CONTROLLED
 *
 * Leverage. An originator with a high SIR may be lending more expensively and
 * more leveraged on purpose, and charging for that risk. "Departs" here means
 * "more transfers than expected given its mix of assets and vintages", not
 * "worse business".
 */
const { rows: sirAll } = await query<{
  v: string; n: string; obs: string; expected: string; shelves: string; self: string;
}>(
  `WITH base AS (
     SELECT b.*,
            CASE
              -- With --with-subtype the stratum is the PRODUCT, not the coarse
              -- category. property_type_detailed is taken raw: grouping it would
              -- reintroduce the very decision this control exists to avoid.
              WHEN ${WITH_SUBTYPE ? "TRUE" : "FALSE"} THEN nullif(btrim(sub.value), '')
              WHEN t.property_type IS NULL THEN NULL
              WHEN t.property_type ~* 'multifamily|cooperative|garden|low rise|mid rise|high rise|student' THEN 'Multifamily'
              WHEN t.property_type ~* 'manufactured' THEN 'Manufactured'
              WHEN t.property_type ~* 'retail|anchored|single tenant|shadow' THEN 'Retail'
              WHEN t.property_type ~* 'office|cbd|suburban|medical' THEN 'Office'
              WHEN t.property_type ~* 'industrial|warehouse|flex|distribution' THEN 'Industrial'
              WHEN t.property_type ~* 'self storage|storage' THEN 'Self Storage'
              WHEN t.property_type ~* 'hospitality|hotel|full service|limited service|extended stay' THEN 'Hospitality'
              WHEN t.property_type ~* 'mixed' THEN 'Mixed Use'
              ELSE 'Otro'
            END AS type
       FROM (${BASE}) b
       JOIN corpus.loans t ON t.id = b.id
       LEFT JOIN corpus.facts sub ON sub.loan_id = b.id
                                 AND sub.metric_key = 'property_type_detailed'
   ),
   with_dscr AS (
     SELECT b.*, ds.value::numeric AS dscr, lt.value::numeric AS ltv,
            am.value::numeric AS balance
       FROM base b
       LEFT JOIN corpus.facts am ON am.loan_id = b.id AND am.metric_key = 'loan_amount'
                                AND am.value ~ '^[0-9.]+$'
       LEFT JOIN corpus.facts ds ON ds.loan_id = b.id AND ds.metric_key = 'dscr'
                                AND ds.value ~ '^[0-9.]+$' AND ds.value::numeric < 20
       LEFT JOIN corpus.facts lt ON lt.loan_id = b.id AND lt.metric_key = 'ltv'
                                AND lt.value ~ '^[0-9.]+$' AND lt.value::numeric <= 2
   ),
   with_type AS (
     SELECT c.*,
            ${WITH_LEVERAGE || WITH_LTV ? "ntile(3) OVER (ORDER BY dscr NULLS LAST)" : "0"}::int AS tercile,
            ${WITH_LTV ? "ntile(3) OVER (ORDER BY ltv NULLS LAST)" : "0"}::int AS ltv_tercile,
            ${WITH_SIZE ? "ntile(3) OVER (ORDER BY balance NULLS LAST)" : "0"}::int AS balance_tercile
       FROM with_dscr c
      WHERE seller IS NOT NULL AND type IS NOT NULL
        ${WITH_LEVERAGE || WITH_LTV ? "AND dscr IS NOT NULL" : ""}
        ${WITH_LTV ? "AND ltv IS NOT NULL" : ""}
        ${WITH_SIZE ? "AND balance IS NOT NULL" : ""}
   ),
   -- The per-stratum rates include the very seller that is then evaluated.
   -- It is standard indirect standardisation, but it has a consequence: for a
   -- seller that dominates a stratum, the expected approaches the observed and
   -- the SIR moves towards 1. It biases against finding an effect, not for it,
   -- so a high SIR survives despite this and not thanks to it.
   rates AS (
     SELECT type, vintage, tercile, ltv_tercile, balance_tercile,
            sum(event)::numeric / count(*) AS rate
       FROM with_type GROUP BY type, vintage, tercile, ltv_tercile, balance_tercile
   ),
   -- HOW MUCH OF A SELLER'S EXPECTED RATE IS ITS OWN RATE.
   --
   -- The comment above says self-reference biases towards 1 and is therefore
   -- conservative. That holds when the seller is a large part of the stratum.
   -- When it IS the whole stratum, standardisation stops being conservative and
   -- becomes empty: the expected is the observed by construction.
   --
   -- With subtype that stops being hypothetical. NCB has 355 loans and every
   -- Cooperative in the corpus is theirs, so its expected comes out at exactly
   -- 0.0 and its SIR is 0/0. Byar's interval returns [0,0], which excludes 1,
   -- and the script counted it as "departs". It is a test that cannot fail.
   dominance AS (
     SELECT seller, type, vintage, tercile, ltv_tercile, balance_tercile,
            count(*)::numeric AS nc,
            count(*)::numeric / sum(count(*)) OVER (
              PARTITION BY type, vintage, tercile, ltv_tercile, balance_tercile
            ) AS share
       FROM with_type
      GROUP BY seller, type, vintage, tercile, ltv_tercile, balance_tercile
   ),
   self_v AS (
     SELECT seller,
            coalesce(sum(nc) FILTER (WHERE share >= 0.8), 0) / nullif(sum(nc), 0) AS self
       FROM dominance GROUP BY seller
   )
   SELECT c.seller AS v, count(*)::text AS n,
          sum(c.event)::text AS obs,
          round(sum(t.rate), 2)::text AS expected,
          count(DISTINCT c.shelf)::text AS shelves,
          round(coalesce(max(a.self), 0) * 100)::text AS self
     FROM with_type c JOIN rates t
       ON t.type = c.type AND t.vintage = c.vintage AND t.tercile = c.tercile
      AND t.ltv_tercile = c.ltv_tercile AND t.balance_tercile = c.balance_tercile
     LEFT JOIN self_v a ON a.seller = c.seller
    GROUP BY c.seller
    ORDER BY sum(c.event)::numeric / nullif(sum(t.rate), 0)`,
);

/**
 * WHO FELL OUT OF THE TABLE, WHICH IS THE FIRST THING TO LOOK AT.
 *
 * The `pool >= MIN_POOL` filter was applied inside the SQL, so a seller that
 * came up short simply did not appear. With the controls on, that stops being
 * innocent: each control discards the loans missing that datum, and a seller
 * with worse-than-average coverage drops out of the table without a trace.
 *
 * That is exactly what happened, and with the seller that motivated the control.
 * UBS AG has 177 loans and subtype coverage is 75%, so stratifying by subtype
 * put it below 150 and it disappeared. The run did not say "UBS does not
 * survive": it said nothing about UBS, and without this list the two read the
 * same.
 *
 * A control that removes from the sample precisely the case it came to examine
 * does not answer the question. It may still be the correct control — but then
 * the conclusion is "the corpus is not enough", not "it does not depart".
 */
const sirV = sirAll.filter((r) => Number(r.n) >= MIN_POOL);
const enTabla = new Set(sirV.map((r) => r.v));
const dropped = raw
  .filter((r) => Number(r.n) >= MIN_POOL && !enTabla.has(r.v))
  .map((r) => {
    const inside = sirAll.find((x) => x.v === r.v);
    return { v: r.v, raw: Number(r.n), withStratum: Number(inside?.n ?? 0) };
  });

/** Byar: with 0 observed events the normal interval does not exist. */
function byar(obs: number, expected: number): [number, number] {
  if (expected <= 0) return [0, 0];
  const lo =
    obs === 0 ? 0 : (obs * Math.pow(1 - 1 / (9 * obs) - 1.96 / (3 * Math.sqrt(obs)), 3)) / expected;
  const o1 = obs + 1;
  const hi = (o1 * Math.pow(1 - 1 / (9 * o1) + 1.96 / (3 * Math.sqrt(o1)), 3)) / expected;
  return [Math.max(0, lo), hi];
}

console.log(`\n${"═".repeat(78)}`);
console.log(
  `Originators: SIR by ${WITH_SUBTYPE ? "SUBTYPE" : "TYPE"} × VINTAGE${WITH_LEVERAGE || WITH_LTV ? " × DSCR" : ""}` +
    `${WITH_LTV ? " × LTV" : ""}${WITH_SIZE ? " × BALANCE" : ""} (pool ≥ ${MIN_POOL})`,
);
console.log(`${"═".repeat(78)}\n`);
console.log(`  seller            iss.        n   obs   expected    SIR         95% CI      self`);
console.log(`  ${"─".repeat(72)}`);

let departing = 0;
let sumObs = 0;
let sumEsp = 0;
let stuck = 0;
for (const r of sirV) {
  sumObs += Number(r.obs);
  sumEsp += Number(r.expected);
  // "Stuck" = the expected came within 15% of the observed: the stratum no
  // longer adds contrast because the loan is compared almost against itself.
  if (Number(r.expected) > 0 && Math.abs(Number(r.obs) - Number(r.expected)) / Number(r.expected) < 0.15) {
    stuck++;
  }
}
let tautological = 0;
for (const r of sirV) {
  const obs = Number(r.obs), expected = Number(r.expected), nn = Number(r.n);
  const self = Number(r.self);
  const s = expected > 0 ? obs / expected : 0;
  const [lo, hi] = byar(obs, expected);
  /**
   * With expected 0, Byar's interval is [0,0], which always excludes 1. That is
   * not a finding: it is dividing by zero under another name.
   */
  const evaluable = expected > 0;
  if (!evaluable) tautological++;
  const aparta = evaluable && (lo > 1 || hi < 1);
  if (aparta) departing++;
  console.log(
    `  ${r.v.slice(0, 16).padEnd(17)} ${String(r.shelves).padStart(4)} ${String(nn).padStart(7)} ` +
      `${String(obs).padStart(5)} ${expected.toFixed(1).padStart(9)}  ${(evaluable ? s.toFixed(2) : "—").padStart(6)}   ` +
      `${evaluable ? `[${lo.toFixed(2)} , ${hi.toFixed(2)}]` : "         —      "}  ` +
      `${self >= 50 ? "\x1b[33m" : "\x1b[90m"}${String(self).padStart(3)}%\x1b[0m` +
      (aparta ? `  \x1b[1m← se aparta\x1b[0m` : "") +
      (!evaluable ? `  \x1b[31m← esperado 0: no evaluable\x1b[0m` : ""),
  );
}

if (dropped.length > 0) {
  console.log(
    `\n  \x1b[33mThe control dropped ${dropped.length} seller(s) from the table that do reach the pool without it:\x1b[0m`,
  );
  for (const c of dropped) {
    console.log(
      `  \x1b[90m  ${c.v.slice(0, 20).padEnd(21)} ${c.raw} loans → ${c.withStratum} with the full stratum\x1b[0m`,
    );
  }
  console.log(
    `  \x1b[90mAbout them this run does not say they do not depart: it says nothing.\x1b[0m`,
  );
}

/**
 * HOW MANY WOULD DEPART BY CHANCE, WHICH WAS MISSING.
 *
 * This count used individual 95% intervals and printed with no reference. With M
 * originators tested, the expectation under the null is M × 0.05: with twelve
 * originators, 0.6. So ONE "departs" is what chance produces, and two barely
 * exceed it.
 *
 * The finding document did apply Bonferroni —LMF passed with z = 3.49— but the
 * script did not, so its count and the document's were not comparable.
 *
 * Bonferroni on the SIR is done on the log scale: the standard error of log(SIR)
 * is approximately 1/√obs, and the threshold goes from 1.96 to z(0.05/M).
 */
const expectedByChance = sirV.length * 0.05;

/** Two-sided z for alpha/M, by search: the exact inverse is not needed. */
function zBonferroni(m: number): number {
  const alpha = 0.05 / Math.max(1, m);
  // Φ(z) = 1 - alpha/2  →  binary search over the cumulative normal.
  const Phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
  let lo = 1, hi = 6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (Phi(mid) < 1 - alpha / 2) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Abramowitz-Stegun approximation, error < 1.5e-7. */
function erf(x: number): number {
  const signo = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return signo * y;
}

const zThreshold = zBonferroni(sirV.length);
let departingBonf = 0;
for (const r of sirV) {
  const obs = Number(r.obs), expected = Number(r.expected);
  if (obs < 1 || expected <= 0) continue;
  const z = Math.abs(Math.log(obs / expected)) * Math.sqrt(obs);
  if (z > zThreshold) departingBonf++;
}

console.log(
  `\n  ${departing} of ${sirV.length} originators depart from the average adjusted for ` +
    `${WITH_SUBTYPE ? "subtype" : "type"} and vintage${WITH_LEVERAGE || WITH_LTV || WITH_SIZE ? ", DSCR" : ""}` +
    `${WITH_LTV ? ", LTV" : ""}${WITH_SIZE ? " and balance" : ""}.`,
);
if (tautological > 0) {
  console.log(
    `  \x1b[90m${tautological} of those ${sirV.length} are not evaluable: their expected is 0 because they\x1b[0m`,
  );
  console.log(
    `  \x1b[90mown their stratum, and there standardisation compares the loan with itself.\x1b[0m`,
  );
}
console.log(
  `  \x1b[90mBy chance you would expect ${expectedByChance.toFixed(1)} with ${sirV.length} tests at 5%.\x1b[0m` +
    (departing <= Math.ceil(expectedByChance)
      ? `  \x1b[33m← within what is expected\x1b[0m`
      : ""),
);
console.log(
  `  \x1b[90mWith Bonferroni (z > ${zThreshold.toFixed(2)} on the log scale): \x1b[0m` +
    `${departingBonf === 0 ? "\x1b[33mnone\x1b[0m" : `\x1b[32m${departingBonf}\x1b[0m`}` +
    `\x1b[90m. That is the citable count with ${sirV.length} comparisons.\x1b[0m`,
);

/**
 * The signature of over-stratification, printed BEFORE anyone believes the
 * result: if almost every expected ends up stuck to its observed, the stratum
 * has become so fine that each loan is compared against itself and all the SIRs
 * tend to 1 without that meaning anything.
 */
console.log(
  `\n  \x1b[90mOver-stratification control: ${stuck} of ${sirV.length} originators have\x1b[0m`,
);
console.log(
  `  \x1b[90mthe expected within 15% of the observed.\x1b[0m` +
    (stuck > sirV.length * 0.6
      ? `  \x1b[31m← the stratum is too fine\x1b[0m`
      : `  \x1b[32m← the stratum still adds contrast\x1b[0m`),
);
console.log(
  `\n  \x1b[90m"self" is what share of a seller's loans falls in strata where it is itself\x1b[0m`,
);
console.log(
  `  \x1b[90m80% or more. There its expected rate is largely its own rate, and the SIR\x1b[0m`,
);
console.log(
  `  \x1b[90mmeasures less than it appears. Above 50% it is worth distrusting.\x1b[0m`,
);
console.log(
  `\n  \x1b[90m"iss." is how many issuers each one places into. One that appears in a\x1b[0m`,
);
console.log(
  `  \x1b[90msingle issuer is indistinguishable from that issuance: there seller and\x1b[0m` +
    `  \x1b[90mshelf are the same thing.\x1b[0m`,
);
if (WITH_LEVERAGE || WITH_LTV) {
  console.log(
    `\n  \x1b[90mDSCR${WITH_LTV ? " and LTV are" : " is"} controlled${WITH_LTV ? "" : " by tercile, not LTV"}. And property type does not capture\x1b[0m`,
  );
  console.log(
    `  \x1b[90mPRODUCT: the cooperatives live inside multifamily, and that same\x1b[0m`,
  );
  console.log(
    `  \x1b[90mmechanism already killed the issuer effect once. It may be operating here.\x1b[0m\n`,
  );
} else {
  console.log(
    `\n  \x1b[90mLeverage is not controlled. A high SIR may be the strategy of lending\x1b[0m`,
  );
  console.log(
    `  \x1b[90mmore expensively and more leveraged, charging for that risk.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mTo tell them apart:  npm run db:seller -- --with-leverage\x1b[0m\n`,
  );
}

// ---------------------------------------------------------------------------
// 6. Is the excess concentrated in one vintage?
// ---------------------------------------------------------------------------

/**
 * The question that can CONFIRM rather than only shrink.
 *
 * LMF's residual shrank with every control: 3.61 with type × vintage, 2.26
 * adding DSCR, 1.90 adding LTV. That monotone pattern is ambiguous — it may
 * converge above 1 or keep falling with the controls still missing.
 *
 * A control that REDUCES the effect is weakly informative. One that does NOT
 * reduce it would be strong. This test is of the second kind.
 *
 * WHAT IT DISTINGUISHES
 *
 * If an originator's events are concentrated in 2021-2022, it made a cycle bet:
 * it lent heavily at the peak of valuations. That is not underwriting, and
 * standardising by vintage does NOT correct it — it adjusts each year's level,
 * but does not capture an originator having lent differently WITHIN the year.
 *
 * If they are spread between 2020 and 2024, it is a persistent style, and there
 * the residual starts to mean something about how it underwrites.
 *
 * HOW TO READ IT
 *
 * The "concentration" column is the share of events falling in the vintage where
 * the originator has its largest excess, compared against the share of its pool
 * in that same vintage. If event and pool coincide, the excess is spread.
 */
const { rows: byVintage } = await query<{
  v: string; vintage: string; n: string; ev: string;
}>(
  `WITH base AS (${BASE})
   SELECT seller AS v, vintage::text, count(*)::text AS n, sum(event)::text AS ev
     FROM base
    WHERE seller IS NOT NULL
      AND seller IN (
        SELECT seller FROM base WHERE seller IS NOT NULL
         GROUP BY seller HAVING count(*) >= ${MIN_POOL} AND sum(event) >= 10
      )
    GROUP BY seller, vintage
    ORDER BY seller, vintage`,
);

const byV = new Map<string, Array<{ vintage: string; n: number; ev: number }>>();
for (const r of byVintage) {
  const xs = byV.get(r.v) ?? [];
  xs.push({ vintage: r.vintage, n: Number(r.n), ev: Number(r.ev) });
  byV.set(r.v, xs);
}

console.log(`\n${"═".repeat(78)}`);
console.log("Is the excess concentrated in one vintage, or spread?");
console.log(`${"═".repeat(78)}\n`);
console.log(`  seller        events   vintages with event  worst vintage   % ev / % pool`);
console.log(`  ${"─".repeat(72)}`);

for (const [v, xs] of [...byV].sort((a, b) => {
  const s = (z: typeof a) => z[1].reduce((t, x) => t + x.ev, 0);
  return s(b) - s(a);
})) {
  const totEv = xs.reduce((t, x) => t + x.ev, 0);
  const totN = xs.reduce((t, x) => t + x.n, 0);
  if (totEv === 0) continue;

  const withEvent = xs.filter((x) => x.ev > 0).length;
  const worst = xs.reduce((a, b) => (b.ev / Math.max(1, b.n) > a.ev / Math.max(1, a.n) ? b : a));
  const shareEv = worst.ev / totEv;
  const sharePool = worst.n / totN;

  /**
   * If the worst vintage's share of events comfortably exceeds its share of the
   * pool, the excess lives in that year. Spread means the two shares are
   * similar.
   */
  const concentrado = shareEv > sharePool * 2 && shareEv > 0.5;
  console.log(
    `  ${v.slice(0, 12).padEnd(13)} ${String(totEv).padStart(7)}   ${String(withEvent).padStart(10)} of ${xs.length}` +
      `      ${worst.vintage}  ${pct(shareEv, 0).padStart(7)} / ${pct(sharePool, 0).padStart(5)}` +
      (concentrado ? `  \x1b[33m← concentrado\x1b[0m` : `  \x1b[90mrepartido\x1b[0m`),
  );
}

console.log(
  `\n  \x1b[90mConcentrated = the excess lives in one year: it is a cycle bet, and\x1b[0m`,
);
console.log(
  `  \x1b[90mstandardising by vintage does NOT correct it —it adjusts the year's level,\x1b[0m`,
);
console.log(
  `  \x1b[90mnot how each one lent within it. Spread = a persistent style.\x1b[0m\n`,
);

// ---------------------------------------------------------------------------
// 7. Product within type: the attack with the best prior of landing
// ---------------------------------------------------------------------------

/**
 * The mechanism that already killed this project once.
 *
 * BANK appeared to underwrite 4 times better. The explanation was NCB: housing
 * cooperatives, a product that almost never defaults, living INSIDE the
 * multifamily category —the corpus's riskiest. `property_type` does not
 * distinguish product, so standardisation assigned those loans a high expected
 * rate and handed BANK a low SIR.
 *
 * If LMF specialises in something analogous —limited service hospitality inside
 * hospitality, a multifamily subtype, unanchored retail— its 1.89 is the same
 * artefact under another name.
 *
 * THE COLUMN WE NEVER USED
 *
 * `property_type_detailed` has been in the taxonomy from the start and has never
 * entered an analysis. It lives in `corpus.facts`, not `corpus.loans`, because
 * it is a metric and not a row label.
 *
 * THE ORDER, AGAIN
 *
 * Coverage first. If the column appears in few filings, the test cannot be done
 * over LMF's 270 loans and the correct answer is "unknown" — worse than killing
 * it or confirming it, but it is the one available.
 */
const { rows: covDet } = await query<{
  n: string; with_detail: string; lmf_n: string; lmf_with: string;
}>(
  `WITH base AS (${BASE}),
   det AS (
     SELECT b.*, nullif(btrim(fd.value), '') AS detail
       FROM base b
       LEFT JOIN corpus.facts fd ON fd.loan_id = b.id
                                AND fd.metric_key = 'property_type_detailed'
   )
   SELECT count(*)::text AS n,
          count(*) FILTER (WHERE detail IS NOT NULL)::text AS with_detail,
          count(*) FILTER (WHERE seller = 'LMF')::text AS lmf_n,
          count(*) FILTER (WHERE seller = 'LMF' AND detail IS NOT NULL)::text AS lmf_with
     FROM det`,
);

const detN = Number(covDet[0]!.n);
const detWith = Number(covDet[0]!.with_detail);
const lmfN = Number(covDet[0]!.lmf_n);
const lmfWith = Number(covDet[0]!.lmf_with);

console.log(`\n${"═".repeat(78)}`);
console.log("Product within type: does the subtype explain the residual?");
console.log(`${"═".repeat(78)}\n`);
console.log(
  `  property_type_detailed: ${detWith.toLocaleString("en-US")} of ${detN.toLocaleString("en-US")} ` +
    `loans  →  ${detN > 0 && detWith / detN >= 0.5 ? "\x1b[32m" : "\x1b[31m"}` +
    `${pct(detN > 0 ? detWith / detN : 0)}\x1b[0m`,
);
console.log(
  `  \x1b[90min LMF: ${lmfWith} of ${lmfN}` +
    `${lmfN > 0 ? ` (${pct(lmfWith / lmfN)})` : ""}\x1b[0m`,
);

if (detWith === 0) {
  console.log(
    `\n  \x1b[33mThe metric is not populated. The mapping may capture it and the corpus\x1b[0m`,
  );
  console.log(`  \x1b[90mmay not have stored it as a fact. It cannot be tested.\x1b[0m\n`);
} else {
  /**
   * The subtype mix of those that depart, against the corpus's.
   *
   * If an originator concentrates in a subtype the corpus has little of, that
   * subtype is a candidate to explain its excess — just as the cooperatives
   * explained BANK.
   */
  const { rows: mix } = await query<{
    v: string; detail: string; n: string; ev: string; corpus_rate: string;
  }>(
    `WITH base AS (${BASE}),
     det AS (
       SELECT b.*, nullif(btrim(fd.value), '') AS detail
         FROM base b
         LEFT JOIN corpus.facts fd ON fd.loan_id = b.id
                                  AND fd.metric_key = 'property_type_detailed'
     ),
     corpus_rate AS (
       SELECT detail, sum(event)::numeric / count(*) AS rate
         FROM det WHERE detail IS NOT NULL GROUP BY detail
     )
     SELECT d.seller AS v, d.detail, count(*)::text AS n,
            sum(d.event)::text AS ev,
            round(tc.rate * 100, 1)::text AS corpus_rate
       FROM det d JOIN corpus_rate tc ON tc.detail = d.detail
      WHERE d.seller IN ('LMF', 'UBS AG', 'NCB') AND d.detail IS NOT NULL
      GROUP BY d.seller, d.detail, tc.rate
     HAVING count(*) >= 10
      ORDER BY d.seller, count(*) DESC`,
  );

  if (mix.length === 0) {
    console.log(
      `\n  \x1b[33mNo subtype reaches 10 loans among the originators that depart.\x1b[0m\n`,
    );
  } else {
    console.log(`\n  seller      subtype                     n   ev    rate   corpus rate`);
    console.log(`  ${"─".repeat(70)}`);
    let prev = "";
    for (const r of mix) {
      const nn = Number(r.n), ev = Number(r.ev);
      const et = r.v === prev ? "" : r.v;
      prev = r.v;
      console.log(
        `  ${et.padEnd(11)} ${r.detail.slice(0, 24).padEnd(26)} ${String(nn).padStart(4)} ` +
          `${String(ev).padStart(4)}  ${pct(ev / nn).padStart(6)}   ${r.corpus_rate.padStart(5)}%`,
      );
    }
    console.log(
      `\n  \x1b[90mIf an originator's rate in a subtype resembles the corpus's rate IN THAT\x1b[0m`,
    );
    console.log(
      `  \x1b[90msame subtype, its excess is composition: it picks worse subtypes. If it is\x1b[0m`,
    );
    console.log(
      `  \x1b[90mhigher within the same subtype, it underwrites worse inside it.\x1b[0m\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// 8. The last cut, with the cells at the limit
// ---------------------------------------------------------------------------

/**
 * LMF's excess in multifamily, vintage by vintage.
 *
 * The subtype test showed LMF does not pick worse subtypes: it is higher WITHIN
 * Garden, Mid Rise and Multifamily/Retail —59 loans, 18 events, 30.5% against
 * ~8% for the corpus in those same subtypes.
 *
 * One question remains and there is no room for more: does that excess live in
 * 2021-2022, when the whole market underwrote multifamily on rent growth that
 * did not materialise, or is it in every vintage?
 *
 * WHY IT IS PRINTED EVEN THOUGH IT IS NOT ENOUGH
 *
 * The cells will end up at five or six loans. That does NOT support a
 * conclusion, and the script says so rather than letting the percentages look
 * like an answer. It is printed anyway because the shape —all in one year versus
 * spread— can be looked at even if no individual cell means anything, and
 * because the alternative is not looking and assuming.
 *
 * It is the same criterion as with the specially-serviced block: see the raw
 * datum even when the count cannot bear a formal test.
 */
const MF_SUBTYPES = ["Garden", "Mid Rise", "Multifamily/Retail"];

const { rows: mfVintage } = await query<{
  vintage: string; n: string; ev: string; corpus_n: string; corpus_ev: string;
}>(
  `WITH base AS (${BASE}),
   det AS (
     SELECT b.*, nullif(btrim(fd.value), '') AS detail
       FROM base b
       LEFT JOIN corpus.facts fd ON fd.loan_id = b.id
                                AND fd.metric_key = 'property_type_detailed'
   ),
   mf AS (SELECT * FROM det WHERE detail = ANY($1))
   SELECT vintage::text,
          count(*) FILTER (WHERE seller = 'LMF')::text AS n,
          sum(event) FILTER (WHERE seller = 'LMF')::text AS ev,
          count(*) FILTER (WHERE seller IS DISTINCT FROM 'LMF')::text AS corpus_n,
          sum(event) FILTER (WHERE seller IS DISTINCT FROM 'LMF')::text AS corpus_ev
     FROM mf GROUP BY vintage ORDER BY vintage`,
  [MF_SUBTYPES],
);

console.log(`\n${"═".repeat(78)}`);
console.log("LMF in multifamily, vintage by vintage  —  cells at the limit");
console.log(`${"═".repeat(78)}\n`);
console.log(`  vintage   LMF n   ev     rate      rest n   ev     rate`);
console.log(`  ${"─".repeat(62)}`);

let mfN = 0;
let mfEv = 0;
let vintagesWithEvent = 0;
for (const r of mfVintage) {
  const nn = Number(r.n ?? 0);
  const ev = Number(r.ev ?? 0);
  const cn = Number(r.corpus_n ?? 0);
  const cev = Number(r.corpus_ev ?? 0);
  mfN += nn;
  mfEv += ev;
  if (ev > 0) vintagesWithEvent++;
  console.log(
    `  ${r.vintage}   ${String(nn).padStart(7)} ${String(ev).padStart(4)}  ` +
      `${(nn > 0 ? pct(ev / nn) : "—").padStart(7)}   ${String(cn).padStart(7)} ${String(cev).padStart(4)}  ` +
      `${(cn > 0 ? pct(cev / cn) : "—").padStart(7)}`,
  );
}

console.log(
  `\n  \x1b[1mLMF total: ${mfEv} events over ${mfN} loans` +
    `${mfN > 0 ? ` (${pct(mfEv / mfN)})` : ""}, across ${vintagesWithEvent} vintages\x1b[0m`,
);

/**
 * The size verdict comes BEFORE the reading, not after.
 */
const medianCell = mfVintage.length > 0 ? mfN / mfVintage.length : 0;
console.log(
  `\n  \x1b[90mLMF's average cell: ${medianCell.toFixed(0)} loans.\x1b[0m` +
    (medianCell < 15
      ? `  \x1b[31m← not enough to conclude by vintage\x1b[0m`
      : `  \x1b[32m← enough to read\x1b[0m`),
);
console.log(
  `\n  \x1b[90mWith cells like these, the only legible thing is the SHAPE: if the events\x1b[0m`,
);
console.log(
  `  \x1b[90mappear in a single vintage it is the 2021-22 bet the whole market made.\x1b[0m`,
);
console.log(
  `  \x1b[90mIf they appear across several, it is a style. No individual cell proves anything.\x1b[0m\n`,
);

await closePool();

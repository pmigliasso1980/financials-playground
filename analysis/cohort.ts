/**
 * Is the cohort big enough to serve as a reference?
 *
 *   npm run db:cohort
 *   npm run db:cohort -- --vintage 2025
 *
 * LA PREGUNTA
 *
 * `db:stability` closed off the pooled reference: 6 of 7 metrics shift more than
 * 20% between vintages and conditioning on term does not fix it. The reference has
 * to be against the COHORT — the issuances of the same year.
 *
 * That is also what a user wants: nobody asks whether their 2026 deal departs from
 * 2013, they ask whether it departs from what is being originated now.
 *
 * But a cohort only serves as a reference if it has enough PEER issuances.
 * Comparing an issuance against its cohort means comparing it against the OTHERS,
 * and if there are eight, "departs from the market" is a claim about eight
 * documents.
 *
 * WHAT IS MEASURED, AND WHY IN THIS ORDER
 *
 *   1. how many issuances the cohort has     → how many peers there are
 *   2. how many loans each contributes       → whether one dominates the aggregate
 *   3. concentration                          → one issuance of 90 loans out of 900
 *                                               moves the median
 *   4. coverage against the market            → how much of the universe we have
 *
 * Step 3 is the most often forgotten: if two large issuances are 40% of the
 * cohort, the "market reference" is largely those two, and an issuance resembling
 * them will look normal by construction.
 *
 * IT IS NOT A MARKET ANALYSIS
 *
 * It is the prior measurement that decides whether the benchmark can be built at
 * all. Same as the noise floor before the effect, and the history pilot before
 * bajar 1.500 documentos.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const vintageFlag = process.argv.indexOf("--vintage");
const ANADA = vintageFlag === -1 ? null : Number(process.argv[vintageFlag + 1]);

/**
 * Fixed before looking at anything.
 *
 * MIN_PAIRS comes from a simple count: to say an issuance is in the top decile of
 * something you need at least ten peers, and for that decile not to depend on a
 * single document, rather more. Fifteen is the floor where the claim "it is among
 * the most aggressive in its cohort" starts to mean
 * algo.
 */
const MIN_PAIRS = 15;
/**
 * How much the top-2 may weigh above its floor before calling it concentrated.
 *
 * It is not a percentage of the total: it is a multiple of 2/N, which is what the
 * two largest would weigh if every pool were the same size. 1.6x means the two
 * largest take 60% more than their share.
 */
const MAX_EXCESS = 1.6;

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

console.log(`\n${"═".repeat(78)}`);
console.log("Is the cohort big enough to be a reference?");
console.log(`${"═".repeat(78)}`);

const { rows: cohortes } = await query<{
  vintage: string; issuances: string; loans: string;
  mediana_pool: string; top2: string;
}>(
  `WITH por_emision AS (
     SELECT extract(year FROM f.filed_at)::int AS vintage,
            f.accession, count(l.id) AS pool
       FROM corpus.filings f
       JOIN corpus.loans l ON l.accession = f.accession
      WHERE f.filed_at IS NOT NULL
      GROUP BY 1, 2
   ),
   rankeado AS (
     SELECT *, row_number() OVER (PARTITION BY vintage ORDER BY pool DESC) AS rn,
            sum(pool) OVER (PARTITION BY vintage) AS total
       FROM por_emision
   )
   SELECT vintage::text,
          count(*)::text AS issuances,
          sum(pool)::text AS loans,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY pool)::text AS mediana_pool,
          (sum(pool) FILTER (WHERE rn <= 2)::numeric / nullif(max(total), 0))::text AS top2
     FROM rankeado
    GROUP BY vintage
    ORDER BY vintage DESC`,
);

console.log(`\n  vintage  issuances   loans   median pool   top-2 of total`);
console.log(`  ${"─".repeat(64)}`);

for (const c of cohortes) {
  const em = Number(c.issuances);
  const top2 = Number(c.top2);
  const suficiente = em - 1 >= MIN_PAIRS;

  /**
   * THE TOP-2 IS COMPARED AGAINST ITS FLOOR, NOT AGAINST A FIXED NUMBER.
   *
   * The previous version flagged `top2 > 0.3` without looking at how many
   * issuances the vintage has. But the top-2 of N issuances has a floor of 2/N
   * even with perfectly equal pools: with 6 issuances the floor is 33%, with 3 it
   * is 67%. So for any vintage of 6 or fewer the flag fired always, whether or not
   * there was real concentration. A test that cannot fail to fire informs nothing.
   *
   * It is the same class of error as the "50% outside the interquartile range" in
   * `db:page --all`: the observed value and the reference coincided by
   * construction and I read it as a finding.
   *
   * The ratio against the floor IS comparable across vintages: 1.0 means pools of
   * the same size and 2.0 that the two largest weigh double their share. The
   * threshold is applied there.
   */
  /**
   * The floor is capped at 1: with one or two issuances the top-2 IS the total.
   *
   * The first version computed 2/N with no cap and printed "floor 200%" for the
   * single-issuance vintages, with an excess of 0.50x. A floor above 100% does not
   * exist, and the ratio against it inverts the meaning: the most concentrated
   * vintage possible appeared as the least.
   *
   * Fixing a class B error I introduced a class A one on the same line.
   */
  const piso = Math.min(1, 2 / Math.max(1, em));
  const exceso = top2 / piso;
  /** With 2 or fewer issuances the ratio is always 1.0: there is nothing to measure. */
  const medible = em > 2;
  const concentrada = medible && exceso > MAX_EXCESS;

  console.log(
    `  ${c.vintage}   ${String(em).padStart(9)}   ${String(c.loans).padStart(9)}   ` +
      `${Number(c.mediana_pool).toFixed(0).padStart(12)}   ` +
      `${(concentrada ? "\x1b[31m" : "\x1b[90m")}${pct(top2).padStart(7)}\x1b[0m` +
      ` \x1b[90m(piso ${pct(piso)}${medible ? `, ${exceso.toFixed(2)}x` : ", sin medir"})\x1b[0m` +
      (suficiente ? "  \x1b[32m✓\x1b[0m" : `  \x1b[31m← ${em - 1} pares\x1b[0m`),
  );
}

console.log(
  `\n  \x1b[90mAn issuance is compared against the OTHERS of its vintage: with ${MIN_PAIRS}\x1b[0m`,
);
console.log(
  `  \x1b[90mminimum peers, "it is among the most aggressive in its cohort" means something.\x1b[0m`,
);
console.log(
  `  \x1b[90mThe top-2 is compared against its 2/N floor, not against a fixed percentage:\x1b[0m`,
);
console.log(
  `  \x1b[90mwith 6 issuances the floor is already 33% even with equal pools. It is flagged\x1b[0m`,
);
console.log(
  `  \x1b[90mabove ${MAX_EXCESS}x the floor, which does mean the reference is those two.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// La cohorte viva, en detalle
// ---------------------------------------------------------------------------

const objetivo = ANADA ?? Number(cohortes[0]?.vintage ?? new Date().getFullYear());

const { rows: issuances } = await query<{
  nombre: string; pool: string; con_dscr: string; con_ltv: string; mes: string;
}>(
  `SELECT left(f.company_name, 34) AS nombre,
          count(l.id)::text AS pool,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM corpus.facts x WHERE x.loan_id = l.id AND x.metric_key = 'dscr'
          ))::text AS con_dscr,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM corpus.facts x WHERE x.loan_id = l.id AND x.metric_key = 'ltv'
          ))::text AS con_ltv,
          to_char(f.filed_at, 'MM') AS mes
     FROM corpus.filings f
     JOIN corpus.loans l ON l.accession = f.accession
    WHERE extract(year FROM f.filed_at) = $1
    GROUP BY f.company_name, f.accession, f.filed_at
    ORDER BY f.filed_at`,
  [objetivo],
);

console.log(`\n${"─".repeat(78)}`);
console.log(`La cohorte ${objetivo} en detalle`);
console.log(`${"─".repeat(78)}\n`);

if (issuances.length === 0) {
  console.log(`  \x1b[33mSin issuances en ${objetivo}.\x1b[0m\n`);
} else {
  console.log(`  month  issuance                             pool   DSCR    LTV`);
  console.log(`  ${"─".repeat(66)}`);
  for (const e of issuances) {
    const pool = Number(e.pool);
    console.log(
      `  ${e.mes}    ${e.nombre.padEnd(36)} ${String(pool).padStart(5)}  ` +
        `${pct(Number(e.con_dscr) / pool).padStart(5)}  ${pct(Number(e.con_ltv) / pool).padStart(5)}`,
    );
  }

  /**
   * Monthly coverage matters for a live benchmark.
   *
   * If the cohort has twelve issuances but all from January to March, an August
   * issuance is compared against a market from six months earlier — which in this
   * period, with rates moving, is not the same market.
   */
  const meses = new Set(issuances.map((e) => e.mes));
  console.log(
    `\n  \x1b[90m${issuances.length} issuances en ${meses.size} meses distintos.\x1b[0m` +
      (meses.size < 4
        ? `  \x1b[33m← concentradas en el tiempo\x1b[0m`
        : ""),
  );
}

console.log(
  `\n  \x1b[90mThe denominator this corpus does not have is missing: how many issuances\x1b[0m`,
);
console.log(
  `  \x1b[90mthere actually were in the year. Without that, "we have N" does not say\x1b[0m`,
);
console.log(
  `  \x1b[90mwhether it is a lot or a little, and it is the first thing to resolve before\x1b[0m`,
);
console.log(
  `  \x1b[90mpromising anyone coverage.\x1b[0m\n`,
);

await closePool();

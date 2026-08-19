/**
 * Does property composition distinguish issuances, or is it small-pool noise?
 *
 *   npm run db:composition-signal
 *   npm run db:composition-signal -- --vintage 2025
 *
 * WHY THIS QUESTION, AND WHY NOW
 *
 * `db:page --all` showed that the metrics table distinguishes nothing: 84 of 168
 * measurements outside the interquartile range, exactly the 50% chance predicts,
 * z = 0.00. None of the six metrics departs.
 *
 * The tempting conclusion is "then what informs is the composition". But that was
 * not measured, and turning the page by leaning on the unverified half of a
 * disjunction is the shortcut this session has already charged for several times.
 *
 * THE NULL HAS TO DISCOUNT POOL SIZE
 *
 * A pool of 15 loans departs from the average mix by pure sampling far more than
 * one of 70. Comparing raw distance between issuances would reward the small ones
 * for being small.
 *
 * So the null is explicit: if this issuance's loans had been drawn at random from
 * the cohort's universe, what distance would we expect? It is simulated with a
 * multinomial of n draws over the cohort's proportions, and the observed distance
 * is compared against that distribution.
 *
 * The distance is total variation —half the sum of the absolute differences—
 * which reads directly: 0.20 means you have to move 20% of the pool to reach the
 * cohort's mix.
 *
 * WHAT IT ANSWERS AND WHAT IT DOES NOT
 *
 * It answers whether the mix is more different than chance produces. It does not
 * answer whether that distinction matters to anyone: an issuance can differ in a way
 * medible e irrelevante.
 */

import { closePool, ping, query } from "../db/client.js";
import { pct } from "../db/cohortBenchmark.js";
import { apart, SIMULATIONS, totalVariation } from "../db/compositionDistance.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const args = process.argv.slice(2);
const iA = args.indexOf("--vintage");
const VINTAGE = iA === -1 ? String(new Date().getFullYear()) : args[iA + 1]!;

/** Fixed before looking. The simulations and the seed live in the module. */
const ALPHA = 0.05;


/** The coarse categories, the same ones the benchmark uses. */
const CANON = `CASE
    WHEN l.property_type ~* 'multifamily|cooperative|garden|low rise|mid rise|student' THEN 'Multifamily'
    WHEN l.property_type ~* 'retail|anchored|single tenant' THEN 'Retail'
    WHEN l.property_type ~* 'office|cbd|suburban|medical' THEN 'Office'
    WHEN l.property_type ~* 'industrial|warehouse|flex' THEN 'Industrial'
    WHEN l.property_type ~* 'storage' THEN 'Self Storage'
    WHEN l.property_type ~* 'hospitality|hotel|service|extended stay' THEN 'Hospitality'
    WHEN l.property_type ~* 'mixed' THEN 'Mixed Use'
    WHEN l.property_type ~* 'manufactured' THEN 'Manufactured'
    ELSE 'Sin clasificar'
  END`;

const { rows } = await query<{ accession: string; nombre: string; tipo: string; n: string }>(
  `SELECT l.accession, f.company_name AS nombre, ${CANON} AS tipo, count(*)::text AS n
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
    WHERE l.property_type IS NOT NULL
      AND extract(year FROM f.filed_at) = $1
    GROUP BY l.accession, f.company_name, ${CANON}`,
  [Number(VINTAGE)],
);
await closePool();

if (rows.length === 0) {
  console.log(`\n  No issuances in ${VINTAGE}.\n`);
  process.exit(0);
}

const tipos = [...new Set(rows.map((r) => r.tipo))].sort();
const porEmision = new Map<string, { nombre: string; conteo: Map<string, number>; total: number }>();
for (const r of rows) {
  const e = porEmision.get(r.accession) ?? { nombre: r.nombre, conteo: new Map(), total: 0 };
  e.conteo.set(r.tipo, Number(r.n));
  e.total += Number(r.n);
  porEmision.set(r.accession, e);
}

console.log(`\n${"═".repeat(78)}`);
console.log(`Does composition distinguish? — ${VINTAGE} cohort`);
console.log(`${"═".repeat(78)}\n`);
console.log(
  `\x1b[90m  Null: the issuance's loans drawn at random from the rest of the cohort.\x1b[0m`,
);
console.log(
  `\x1b[90m  Distance = total variation. 0.20 = you have to move 20% of the pool.\x1b[0m\n`,
);
console.log(`  issuance                           pool   distance   null p50   p-value`);
console.log(`  ${"─".repeat(74)}`);

let significant = 0;
const detalle: Array<{ nombre: string; d: number; p: number; pool: number }> = [];
/**
 * THE WEIGHTING OF THE REFERENCE, WHICH I CHOSE WITHOUT THINKING.
 *
 * The cohort's mix is computed by pooling ALL the peers' loans: it is weighted by
 * loan. With 2026 at double its concentration floor, BANK 2026-BNK52 (70) and
 * Benchmark 2026-B42 (62) contribute 14% of those loans between them, so the
 * "market mix" is largely the mix of those two issuances.
 *
 * The alternative is weighting by issuance: averaging each peer's composition
 * vector, with every issuance weighing the same. Neither is obviously correct —it
 * depends on whether "the market" is a set of loans or of deals— but the product's
 * conclusion should not depend on which one I picked without thinking.
 *
 * Both are computed and the sets of significant issuances compared.
 */
const perIssuanceSig = new Set<string>();
const perLoanSig = new Set<string>();

for (const [accession, e] of porEmision) {
  /**
   * The reference excludes the issuance itself.
   *
   * Including it shrinks the distance precisely for the large issuances, which are
   * the ones weighing most in the average: the bias would run against finding
   * signal where there is the most data.
   */
  const resto = new Map<string, number>();
  let totalResto = 0;
  for (const [acc, o] of porEmision) {
    if (acc === accession) continue;
    for (const [t, n] of o.conteo) resto.set(t, (resto.get(t) ?? 0) + n);
    totalResto += o.total;
  }

  const q = tipos.map((t) => (resto.get(t) ?? 0) / Math.max(1, totalResto));
  const p = tipos.map((t) => (e.conteo.get(t) ?? 0) / Math.max(1, e.total));
  const dObs = totalVariation(p, q);

  /** The same reference, with each issuance weighing equally rather than by loan. */
  const otras = [...porEmision].filter(([acc]) => acc !== accession);
  const qEmision = tipos.map((t) => {
    const suma = otras.reduce(
      (x, [, o]) => x + (o.conteo.get(t) ?? 0) / Math.max(1, o.total),
      0,
    );
    return suma / Math.max(1, otras.length);
  });
  const dEmision = totalVariation(p, qEmision);

  const porPrestamo = apart(p, q, e.total);
  const nuloP50 = porPrestamo.nullMedian;
  const pVal = porPrestamo.p;
  if (pVal < ALPHA) {
    significant++;
    perLoanSig.add(e.nombre);
  }

  /**
   * The null is re-simulated inside `apart`: changing the reference also changes
   * which distances chance produces.
   */
  if (apart(p, qEmision, e.total).p < ALPHA) perIssuanceSig.add(e.nombre);
  detalle.push({ nombre: e.nombre, d: dObs, p: pVal, pool: e.total });

  const marca = pVal < ALPHA ? "\x1b[32m" : "\x1b[90m";
  console.log(
    `  ${e.nombre.slice(0, 32).padEnd(34)} ${String(e.total).padStart(4)}   ` +
      `${dObs.toFixed(3).padStart(9)}   ${nuloP50.toFixed(3).padStart(8)}   ` +
      `${marca}${pVal < 1 / SIMULATIONS ? `<${(1 / SIMULATIONS).toFixed(4)}` : pVal.toFixed(4)}\x1b[0m`,
  );
}

console.log(`\n${"─".repeat(78)}\n`);

const n = porEmision.size;
const expected = n * ALPHA;
console.log(
  `  \x1b[1m${significant} of ${n} issuances with a mix more different than chance (p < ${ALPHA})\x1b[0m`,
);
console.log(
  `  \x1b[90mBy chance you would expect ${expected.toFixed(1)} with ${n} tests at ${pct(ALPHA)}.\x1b[0m`,
);

/**
 * The contrast that decides, and it is not "there are significant ones".
 *
 * With 28 tests at 5% you expect 1.4 false positives. Finding 2 says nothing;
 * finding 20 does. The comparison is against that expectation, not against zero —
 * the same error I made reading the metrics table's 50% as signal.
 */
console.log(
  significant > expected * 3
    ? `\n  \x1b[32mComposition distinguishes.\x1b[0m ${significant} against ${expected.toFixed(1)} expected by chance is\n` +
        `  a difference sampling does not explain: the property mix is information\n` +
        `  about the issuance and deserves the main place on the page.`
    : `\n  \x1b[31mComposition does not distinguish either.\x1b[0m ${significant} against ${expected.toFixed(1)} expected is\n` +
        `  within what ${n} tests at ${pct(ALPHA)} produce. If neither the metrics nor the mix\n` +
        `  separate an issuance from its cohort, comparing against the cohort is not a\n` +
        `  product, and the question to ask this data is a different one.`,
);

/**
 * Does the conclusion depend on the weighting I chose without thinking?
 *
 * If the two sets coincide, the decision did not matter and is ruled out. If they
 * differ, the finding holding up the page depends on an arbitrary choice and it has
 * to be justified or both reported.
 */
const onlyPerLoan = [...perLoanSig].filter((x) => !perIssuanceSig.has(x));
const onlyPerIssuance = [...perIssuanceSig].filter((x) => !perLoanSig.has(x));

console.log(`\n${"─".repeat(78)}\n`);
console.log(`  \x1b[1mWeighting of the reference: by loan against by issuance\x1b[0m\n`);
console.log(
  `    by loan (what the page uses)         ${perLoanSig.size} significant`,
);
console.log(`    by issuance (each deal equal)        ${perIssuanceSig.size} significant`);
console.log(
  `    \x1b[90mcoinciden en ${[...perLoanSig].filter((x) => perIssuanceSig.has(x)).length}\x1b[0m`,
);
if (onlyPerLoan.length === 0 && onlyPerIssuance.length === 0) {
  console.log(
    `\n    \x1b[32mSame set.\x1b[0m The weighting does not change the conclusion and the decision\n` +
      `    is ruled out as a source of doubt.`,
  );
} else {
  console.log(
    `\n    \x1b[33mThey differ.\x1b[0m The finding depends on a choice I made without thinking.`,
  );
  for (const x of onlyPerLoan) console.log(`      \x1b[90mby loan only:     ${x}\x1b[0m`);
  for (const x of onlyPerIssuance) console.log(`      \x1b[90mby issuance only: ${x}\x1b[0m`);
}

const top = [...detalle].sort((a, b) => a.p - b.p || b.d - a.d).slice(0, 5);
console.log(`\n  The five most different:\n`);
for (const t of top) {
  console.log(
    `    ${t.nombre.slice(0, 36).padEnd(38)} d = ${t.d.toFixed(3)}  p = ${t.p.toFixed(4)}  ` +
      `\x1b[90m${t.pool} loans\x1b[0m`,
  );
}
console.log();

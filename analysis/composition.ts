/**
 * Is the gap between issuers portfolio composition?
 *
 *   npm run db:composition
 *
 * THE LAST ATTACK REMAINING
 *
 * BANK transfers to special servicing 4 times less often than BBCMS. That survived
 * seven attempts to kill it: join coverage (97.7%), the population each shelf
 * lists, the block format, the parser's filters, the raw value verified across
 * twenty issuances, the master servicer and the special servicer.
 *
 * What is missing is the one that killed everything else in this project:
 * composition. The SIR in `db:predictors` standardises by vintage and by DSCR
 * tercile. Never by property type. If BANK is heavy in multifamily and BBCMS in
 * office, the gap is explained entirely without anyone underwriting better.
 *
 * That is exactly what already happened to us: the 2023 peak survived five attacks
 * and died when the composition showed 17.5% office and 15% hotel against 11.2%
 * and 10%.
 *
 * THE ORDER IS ENFORCED BY THE CODE
 *
 * Coverage first, then the raw values, and only then the SIR. If coverage does not
 * reach the threshold, the script does NOT report a SIR.
 *
 * And the raw values come before any aggregation because `property_type` is stored
 * as text exactly as it comes from the Annex A, with no canonicalisation.
 * "Office", "office", "Various" and "Mixed Use" in the same column produce strata
 * that look like types and are spelling variants. Grouping without looking would
 * be manufacturing empty cells and then standardising against them.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Fixed before looking at anything. */
const COBERTURA_MINIMA = 0.9;
const MIN_POOL_SHELF = 150;

/**
 * `--without-seller NCB`: remove an originator from the numerator AND the
 * denominator.
 *
 * WHY IT IS NEEDED
 *
 * `db:seller` showed that NCB —National Cooperative Bank— contributes 396 loans to
 * the corpus with ZERO transfers, and 363 of those are in BANK: 27% of its pool.
 * NCB lends to housing co-operatives, a product with extremely low leverage that
 * structurally does not default.
 *
 * The problem is that `property_type` does not distinguish that. Only 17 rows in
 * the corpus say "Cooperative"; the rest of the co-operative loans come labelled as
 * multifamily, which is the HIGHEST risk category (5.4%). So the standardisation
 * assigns a high expected rate to loans that never fail, and inflates the expected
 * count of whoever holds them.
 *
 * Rough arithmetic: 363 × 5% is ~18 impossible expected events. BANK's expected is
 * 30.9 with 13 observed. Without those, it would be 13 over ~13.
 *
 * WHY IT IS EXCLUDED BY NAME AND NOT BY OUTCOME
 *
 * Excluding "sellers with zero events" would be selecting on the dependent
 * variable and would guarantee the result. NCB is excluded because it is a lender
 * of a different product, which is known without looking at its events. The
 * criterion is debatable; that is why it is an explicit flag and not a default.
 */
/**
 * `--stratum seller`: standardise by originator instead of by type.
 *
 * Excluding NCB by hand moved BANK's SIR from 0.42 to 0.57 — a single seller
 * explained a third of the gap. This is the systematic version of that
 * intervention: instead of removing a hand-picked originator, it asks how many
 * events each issuer would expect if its loans failed at the general rate OF ITS
 * OWN SELLER AND VINTAGE.
 *
 * WHAT EACH RESULT MEANS
 *
 * If the per-seller SIR flattens near 1 for every issuer, then the "issuer effect"
 * was the mix of originators: the shelf does not underwrite, it chooses who to buy
 * from.
 *
 * If it holds, the same seller performs differently depending on which issuance it
 * places into, and that is no longer composition: it is selection within the
 * seller —which loans each shelf accepts— or something we have not seen yet.
 *
 * WHY IT IS NOT CIRCULAR
 *
 * Standardising by the variable you suspect causes the effect is not cheating: it
 * is the definition of decomposing. It would be circular if the seller were a
 * function of the issuer, and it is not — the same seller places into several.
 *
 * THE 136 SELLERS COLLAPSE TO THE 15 LARGEST
 *
 * 136 × 5 vintages is 680 strata for 168 events. The tail of sellers with two or
 * three loans would produce strata where expected = observed by construction, which
 * dilute without contributing contrast.
 */
const estratoFlag = process.argv.indexOf("--stratum");
const ESTRATO = estratoFlag === -1 ? "tipo" : (process.argv[estratoFlag + 1] ?? "tipo");
const POR_VENDEDOR = ESTRATO === "seller";
const TOP_SELLERS = 15;

const sinFlag = process.argv.indexOf("--without-seller");
const WITHOUT_SELLER = sinFlag === -1 ? null : (process.argv[sinFlag + 1] ?? null);
const FILTRO_VENDEDOR = WITHOUT_SELLER
  ? `AND coalesce(btrim(l.loan_seller), '') <> '${WITHOUT_SELLER.replace(/'/g, "''")}'`
  : "";

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

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

/**
 * Los 41 valores crudos colapsados a nueve tipos.
 *
 * WHY IT IS NEEDED
 *
 * `property_type` carries everything: real types (Multifamily, Office), subtypes
 * that some filings publish in the same column (Suburban, CBD, Garden, Anchored,
 * Low Rise, Full Service) and things that are not properties at all (Mezzanine,
 * "Equityholder Debt or Debt-Like Pre").
 *
 * With 41 types × 5 vintages that is up to 205 strata for 147 events. In a stratum
 * of one loan the "general" rate is determined by that same loan, so expected =
 * observed and the stratum contributes no contrast: it only dilutes. Worse, with
 * cells of two or three the standardisation starts producing extreme SIRs from
 * noise. Over-stratifying is a known way of manufacturing a finding.
 *
 * WHY THE CANONICALISATION LIVES HERE AND NOT IN THE HARVESTER
 *
 * Unlike the servicer's name —where the variant was an artefact of our extraction—
 * here the raw value IS what the document says. A filing publishing "Suburban" is
 * saying that. Grouping is an analytical decision, not a correction, and that is
 * why it is taken in the analysis, printed, and can be argued with without
 * re-harvesting.
 */
const TIPO = `
  CASE
    WHEN l.property_type IS NULL THEN NULL
    WHEN l.property_type ~* 'multifamily|cooperative|garden|low rise|mid rise|high rise|student|military' THEN 'Multifamily'
    WHEN l.property_type ~* 'manufactured' THEN 'Manufactured Housing'
    WHEN l.property_type ~* 'retail|anchored|single tenant|shadow' THEN 'Retail'
    WHEN l.property_type ~* 'office|cbd|suburban|medical' THEN 'Office'
    WHEN l.property_type ~* 'industrial|warehouse|flex|distribution' THEN 'Industrial'
    WHEN l.property_type ~* 'self storage|storage' THEN 'Self Storage'
    WHEN l.property_type ~* 'hospitality|hotel|full service|limited service|extended stay' THEN 'Hospitality'
    WHEN l.property_type ~* 'mixed' THEN 'Mixed Use'
    ELSE 'Otro'
  END`;

const BASE = `
  SELECT l.id,
         ${SHELF} AS shelf,
         ${TIPO} AS tipo_crudo,
         nullif(btrim(l.loan_seller), '') AS seller,
         l.property_type AS tipo_original,
         extract(year FROM f.filed_at)::int AS vintage,
         (d.transfer_date IS NOT NULL)::int AS evento
    FROM corpus.loans l
    JOIN corpus.filings f ON f.accession = l.accession
    LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
   WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                          WHERE deal_accession IS NOT NULL)
     ${FILTRO_VENDEDOR}
`;

console.log(`\n${"═".repeat(78)}`);
console.log("Portfolio composition?");
console.log(`${"═".repeat(78)}`);
if (WITHOUT_SELLER) {
  console.log(
    `\n\x1b[33m  Excluding the seller "${WITHOUT_SELLER}" from the numerator and the denominator.\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 1. Coverage, before anything else
// ---------------------------------------------------------------------------

const { rows: cob } = await query<{
  n: string; con_tipo: string; weak_shelves: string;
}>(
  `WITH base AS (${BASE})
   SELECT count(*)::text AS n,
          count(*) FILTER (WHERE tipo_crudo IS NOT NULL)::text AS con_tipo,
          (SELECT count(*)::text FROM (
             SELECT shelf FROM base GROUP BY shelf
              HAVING count(*) FILTER (WHERE tipo_crudo IS NOT NULL)::numeric
                     / count(*) < ${COBERTURA_MINIMA}
           ) x) AS weak_shelves
     FROM base`,
);

const n = Number(cob[0]!.n);
const withType = Number(cob[0]!.con_tipo);
const cobertura = withType / n;

console.log(`\n${"─".repeat(78)}`);
console.log("Cobertura de property_type");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  ${withType.toLocaleString("en-US")} of ${n.toLocaleString("en-US")} loans  →  ` +
    `${cobertura >= COBERTURA_MINIMA ? "\x1b[32m" : "\x1b[31m"}${pct(cobertura)}\x1b[0m` +
    `   \x1b[90m(umbral ${pct(COBERTURA_MINIMA, 0)})\x1b[0m`,
);

/**
 * Global coverage can be fine and broken within one shelf.
 *
 * If BANK is missing the type on half its loans and BBCMS on none, standardising
 * compares one's known composition against the other's — which is the bias this
 * script exists to rule out, coming in through the side
 * lado.
 */
const { rows: porShelfCob } = await query<{
  shelf: string; n: string; con_tipo: string;
}>(
  `WITH base AS (${BASE})
   SELECT shelf, count(*)::text AS n,
          count(*) FILTER (WHERE tipo_crudo IS NOT NULL)::text AS con_tipo
     FROM base GROUP BY shelf ORDER BY count(*) DESC`,
);

console.log(`\n  por issuer:`);
/**
 * This filter was CALCULATED and unused: the query returned `weak_shelves` and the
 * script never looked at it. Benchmark entered the SIR with 88.3% coverage,
 * `other` with 87.5% and GS with 76.5%, all below the threshold the script itself
 * declares.
 *
 * Writing the check and not wiring it up is worse than not writing it: it leaves
 * the appearance that the control exists.
 */
const excluidos: string[] = [];
for (const r of porShelfCob) {
  const c = Number(r.con_tipo) / Number(r.n);
  const pasa = c >= COBERTURA_MINIMA;
  if (!pasa) excluidos.push(r.shelf);
  console.log(
    `    ${r.shelf.padEnd(12)} ${String(r.n).padStart(5)}  ` +
      `${pasa ? "\x1b[90m" : "\x1b[31m"}${pct(c).padStart(6)}\x1b[0m` +
      `${pasa ? "" : "  \x1b[31m← excluida del SIR\x1b[0m"}`,
  );
}
const FILTRO_SHELF = excluidos.length
  ? `AND ${SHELF} NOT IN (${excluidos.map((s) => `'${s}'`).join(", ")})`
  : "";

// ---------------------------------------------------------------------------
// 2. The raw values, before grouping
// ---------------------------------------------------------------------------

const { rows: crudos } = await query<{
  tipo: string; n: string; ev: string; originales: string; variantes: string;
}>(
  `WITH base AS (${BASE})
   SELECT tipo_crudo AS tipo, count(*)::text AS n, sum(evento)::text AS ev,
          count(DISTINCT tipo_original)::text AS variantes,
          string_agg(DISTINCT tipo_original, ', ' ORDER BY tipo_original) AS originales
     FROM base WHERE tipo_crudo IS NOT NULL
    GROUP BY tipo_crudo ORDER BY count(*) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`Canonical types and which raw values each absorbed`);
console.log(`${"─".repeat(78)}\n`);

for (const r of crudos) {
  const nn = Number(r.n), ev = Number(r.ev);
  console.log(
    `  ${r.tipo.padEnd(22)} ${String(nn).padStart(5)}  ${String(ev).padStart(3)} ev  ` +
      `${nn >= 30 ? pct(ev / nn).padStart(6) : "     —"}   \x1b[90m${r.variantes} variantes\x1b[0m`,
  );
  console.log(`      \x1b[90m${(r.originales ?? "").slice(0, 110)}\x1b[0m`);
}

/**
 * If there are many spelling variants, any later standardisation is noise in the
 * shape of a stratum. It is flagged here and not afterwards.
 */
const suspects = crudos.filter((r) => {
  const t = (r.tipo || "").toLowerCase().trim();
  return crudos.some(
    (o) => o !== r && (o.tipo || "").toLowerCase().trim() === t,
  );
});
if (suspects.length > 0) {
  console.log(
    `\n  \x1b[31m${suspects.length} values differ only in case or spacing.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mThey are the same type split across different strata: canonicalise first.\x1b[0m`,
  );
}

if (cobertura < COBERTURA_MINIMA) {
  console.log(
    `\n  \x1b[31mINSUFFICIENT COVERAGE. No SIR is reported.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mStandardising with a third of the loans lacking a type compares one\x1b[0m`,
  );
  console.log(
    `  \x1b[90missuer's known composition against another's, which is\x1b[0m`,
  );
  console.log(`  \x1b[90mexactly the bias this script exists to rule out.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. Mezcla por issuer
// ---------------------------------------------------------------------------

const { rows: mezcla } = await query<{
  shelf: string; tipo: string; n: string; total: string;
}>(
  `WITH base AS (${BASE} AND l.property_type IS NOT NULL),
   tot AS (SELECT shelf, count(*) AS total FROM base GROUP BY shelf)
   SELECT b.shelf, b.tipo_crudo AS tipo, count(*)::text AS n, t.total::text
     FROM base b JOIN tot t ON t.shelf = b.shelf
    WHERE t.total >= ${MIN_POOL_SHELF}
    GROUP BY b.shelf, b.tipo_crudo, t.total
    ORDER BY b.shelf, count(*) DESC`,
);

const tiposTop = crudos.slice(0, 6).map((r) => r.tipo);
const mezclaMap = new Map<string, Map<string, number>>();
const totales = new Map<string, number>();
for (const r of mezcla) {
  const m = mezclaMap.get(r.shelf) ?? new Map<string, number>();
  m.set(r.tipo, Number(r.n));
  mezclaMap.set(r.shelf, m);
  totales.set(r.shelf, Number(r.total));
}

console.log(`\n${"─".repeat(78)}`);
console.log("Type mix by issuer (% of the pool with a known type)");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  issuer     ` + tiposTop.map((t) => (t || "?").slice(0, 9).padStart(10)).join(""),
);
console.log(`  ${"─".repeat(72)}`);
for (const [shelf, m] of [...mezclaMap].sort()) {
  const total = totales.get(shelf)!;
  console.log(
    `  ${shelf.padEnd(12)}` +
      tiposTop.map((t) => pct((m.get(t) ?? 0) / total, 0).padStart(10)).join(""),
  );
}

// ---------------------------------------------------------------------------
// 4. SIR standardised by type × vintage
// ---------------------------------------------------------------------------

/**
 * Indirect standardisation: how many events each issuer would expect if its loans
 * failed at the general rate of their own type and vintage.
 *
 * The stratum is type × vintage and not type alone, because both confound at once:
 * BANK is older than BBCMS (64% in 2020-21 against 37%) and that pushes in the
 * opposite direction to composition.
 */
const { rows: sir } = await query<{
  shelf: string; n: string; obs: string; esp: string;
}>(
  POR_VENDEDOR
    ? `WITH base0 AS (${BASE} AND l.loan_seller IS NOT NULL ${FILTRO_SHELF}),
       top AS (
         SELECT seller FROM base0 GROUP BY seller
          ORDER BY count(*) DESC LIMIT ${TOP_SELLERS}
       ),
       base AS (
         SELECT b.*, CASE WHEN b.seller IN (SELECT seller FROM top)
                          THEN b.seller ELSE 'otros' END AS v
           FROM base0 b
       ),
       tasas AS (
         SELECT v, vintage, sum(evento)::numeric / count(*) AS tasa
           FROM base GROUP BY v, vintage
       )
       SELECT b.shelf, count(*)::text AS n,
              sum(b.evento)::text AS obs,
              round(sum(t.tasa), 2)::text AS esp
         FROM base b JOIN tasas t ON t.v = b.v AND t.vintage = b.vintage
        GROUP BY b.shelf
       HAVING count(*) >= ${MIN_POOL_SHELF}
        ORDER BY sum(b.evento)::numeric / nullif(sum(t.tasa), 0)`
    : `WITH base AS (${BASE} AND l.property_type IS NOT NULL ${FILTRO_SHELF}),
   tasas AS (
     SELECT tipo_crudo, vintage,
            sum(evento)::numeric / count(*) AS tasa
       FROM base GROUP BY tipo_crudo, vintage
   )
   SELECT b.shelf, count(*)::text AS n,
          sum(b.evento)::text AS obs,
          round(sum(t.tasa), 2)::text AS esp
     FROM base b JOIN tasas t
       ON t.tipo_crudo = b.tipo_crudo AND t.vintage = b.vintage
    GROUP BY b.shelf
   HAVING count(*) >= ${MIN_POOL_SHELF}
    ORDER BY sum(b.evento)::numeric / nullif(sum(t.tasa), 0)`,
);

/** Byar: with 0 observed events the normal interval does not exist. */
function byar(obs: number, esp: number): [number, number] {
  if (esp <= 0) return [0, 0];
  const lo =
    obs === 0
      ? 0
      : (obs * Math.pow(1 - 1 / (9 * obs) - 1.96 / (3 * Math.sqrt(obs)), 3)) / esp;
  const o1 = obs + 1;
  const hi = (o1 * Math.pow(1 - 1 / (9 * o1) + 1.96 / (3 * Math.sqrt(o1)), 3)) / esp;
  return [Math.max(0, lo), hi];
}

console.log(`\n${"─".repeat(78)}`);
console.log(
  POR_VENDEDOR
    ? `SIR standardised by SELLER (top ${TOP_SELLERS}) × VINTAGE`
    : "SIR standardised by PROPERTY TYPE × VINTAGE",
);
console.log(`${"─".repeat(78)}\n`);
if (excluidos.length > 0) {
  console.log(
    `  \x1b[90mExcluidas por cobertura < ${pct(COBERTURA_MINIMA, 0)}: ${excluidos.join(", ")}\x1b[0m\n`,
  );
}
console.log(`  issuer        n    obs   esperado    SIR        IC 95%`);
console.log(`  ${"─".repeat(66)}`);

for (const r of sir) {
  const obs = Number(r.obs), esp = Number(r.esp);
  const s = esp > 0 ? obs / esp : 0;
  const [lo, hi] = byar(obs, esp);
  const aparta = lo > 1 || hi < 1;
  console.log(
    `  ${r.shelf.padEnd(12)} ${String(r.n).padStart(5)} ${String(obs).padStart(5)} ` +
      `${esp.toFixed(1).padStart(9)}  ${s.toFixed(2).padStart(6)}   ` +
      `[${lo.toFixed(2)} , ${hi.toFixed(2)}]` +
      (aparta ? `  \x1b[1m← se aparta\x1b[0m` : ""),
  );
}

console.log(
  `\n  \x1b[90mCompare against the SIR in db:predictors, which standardises by vintage and\x1b[0m`,
);
console.log(
  `  \x1b[90mDSCR tercile but NOT by type: BANK 0.39 · Benchmark 1.02 · BBCMS 1.60.\x1b[0m`,
);
console.log(
  `\n  \x1b[90mIf BANK rises towards 1 here, the gap was composition. If it stays low,\x1b[0m`,
);
console.log(
  `  \x1b[90mthe eighth attack fails too and there are no easy explanations left.\x1b[0m\n`,
);

await closePool();

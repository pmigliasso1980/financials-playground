/**
 * ¿La brecha entre emisoras es composición de cartera?
 *
 *   npm run db:composition
 *
 * EL ÚLTIMO ATAQUE QUE QUEDA
 *
 * BANK transfiere a special servicing 4 veces menos que BBCMS. Eso sobrevivió
 * siete intentos de matarlo: la cobertura del join (97,7%), la población que
 * cada shelf lista, el formato del bloque, los filtros del parser, el valor
 * crudo verificado en veinte emisiones, el administrador maestro y el especial.
 *
 * Falta el que mató todo lo demás en este proyecto: la composición. El SIR de
 * `db:predictors` estandariza por añada y por tercil de DSCR. Nunca por tipo de
 * propiedad. Si BANK es pesado en multifamily y BBCMS en oficinas, la brecha se
 * explica entera sin que nadie suscriba mejor.
 *
 * Ya nos pasó exactamente eso: el pico de 2023 sobrevivió cinco ataques y murió
 * cuando la composición mostró 17,5% oficinas y 15% hotel contra 11,2% y 10%.
 *
 * EL ORDEN ESTÁ FORZADO POR EL CÓDIGO
 *
 * Primero la cobertura, después los valores crudos, y solo entonces el SIR. Si
 * la cobertura no llega al umbral, el script NO reporta SIR.
 *
 * Y los valores crudos van antes que cualquier agregación porque `property_type`
 * se guarda como texto tal cual viene del Annex A, sin canónico. "Office",
 * "office", "Various" y "Mixed Use" en la misma columna producen estratos que
 * parecen tipos y son variantes de escritura. Agrupar sin mirar sería fabricar
 * celdas vacías y después estandarizar contra ellas.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Fijados antes de ver nada. */
const COBERTURA_MINIMA = 0.9;
const MIN_POOL_SHELF = 150;

/**
 * `--sin-vendedor NCB`: sacar un originador del numerador Y del denominador.
 *
 * POR QUÉ HACE FALTA
 *
 * `db:seller` mostró que NCB —National Cooperative Bank— aporta 396 préstamos
 * al corpus con CERO transferencias, y 363 de esos están en BANK: el 27% de su
 * pool. NCB presta a cooperativas de vivienda, un producto con apalancamiento
 * bajísimo que estructuralmente no incumple.
 *
 * El problema es que `property_type` no distingue eso. Solo 17 filas del corpus
 * dicen "Cooperative"; el resto de los préstamos de cooperativa vienen
 * etiquetados como multifamily, que es la categoría de MAYOR riesgo (5,4%). O
 * sea que la estandarización les asigna una tasa esperada alta a préstamos que
 * nunca fallan, e infla el esperado de quien los tenga.
 *
 * Cuenta gruesa: 363 × 5% son ~18 eventos esperados imposibles. El esperado de
 * BANK es 30,9 con 13 observados. Sin esos, sería 13 sobre ~13.
 *
 * POR QUÉ SE EXCLUYE POR NOMBRE Y NO POR RESULTADO
 *
 * Excluir "vendedores con cero eventos" sería seleccionar por la variable
 * dependiente y garantizaría el resultado. NCB se excluye porque es un
 * prestamista de un producto distinto, lo cual se sabe sin mirar sus eventos.
 * El criterio es discutible; por eso es un flag explícito y no un default.
 */
/**
 * `--estrato vendedor`: estandarizar por originador en vez de por tipo.
 *
 * Excluir a NCB a mano movió el SIR de BANK de 0,42 a 0,57 — un solo vendedor
 * explicaba un tercio de la brecha. Esta es la versión sistemática de esa
 * intervención: en vez de sacar un originador elegido a dedo, se pregunta
 * cuántos eventos esperaría cada emisora si sus préstamos fallaran a la tasa
 * general DE SU MISMO VENDEDOR Y AÑADA.
 *
 * QUÉ SIGNIFICA CADA RESULTADO
 *
 * Si el SIR por vendedor se aplana cerca de 1 para todas las emisoras, entonces
 * "efecto emisora" era el mix de originadores: el shelf no suscribe, elige a
 * quién comprarle.
 *
 * Si se mantiene, el mismo vendedor rinde distinto según a qué emisión coloca,
 * y eso ya no es composición: es selección dentro del vendedor —qué préstamos
 * acepta cada shelf— o algo que todavía no vimos.
 *
 * POR QUÉ NO ES CIRCULAR
 *
 * Estandarizar por la variable que uno sospecha causa el efecto no es hacer
 * trampa: es la definición de descomponer. Sería circular si el vendedor fuera
 * una función de la emisora, y no lo es —el mismo vendedor coloca en varias—.
 *
 * LOS 136 VENDEDORES SE COLAPSAN A LOS 15 MÁS GRANDES
 *
 * 136 × 5 añadas son 680 estratos para 168 eventos. La cola de vendedores con
 * dos o tres préstamos produciría estratos donde esperado = observado por
 * construcción, que diluyen sin aportar contraste.
 */
const estratoFlag = process.argv.indexOf("--estrato");
const ESTRATO = estratoFlag === -1 ? "tipo" : (process.argv[estratoFlag + 1] ?? "tipo");
const POR_VENDEDOR = ESTRATO === "vendedor";
const TOP_VENDEDORES = 15;

const sinFlag = process.argv.indexOf("--sin-vendedor");
const SIN_VENDEDOR = sinFlag === -1 ? null : (process.argv[sinFlag + 1] ?? null);
const FILTRO_VENDEDOR = SIN_VENDEDOR
  ? `AND coalesce(btrim(l.loan_seller), '') <> '${SIN_VENDEDOR.replace(/'/g, "''")}'`
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
 * POR QUÉ HACE FALTA
 *
 * `property_type` trae de todo: tipos reales (Multifamily, Office), subtipos
 * que algunos filings publican en la misma columna (Suburban, CBD, Garden,
 * Anchored, Low Rise, Full Service) y cosas que no son propiedades en absoluto
 * (Mezzanine, "Equityholder Debt or Debt-Like Pre").
 *
 * Con 41 tipos × 5 añadas son hasta 205 estratos para 147 eventos. En un
 * estrato de un préstamo la tasa "general" la determina ese mismo préstamo, así
 * que esperado = observado y el estrato no aporta contraste: solo diluye. Peor,
 * con celdas de dos o tres la estandarización empieza a producir SIR extremos
 * por ruido. Sobre-estratificar es una forma conocida de fabricar un hallazgo.
 *
 * POR QUÉ EL CANÓNICO VIVE ACÁ Y NO EN EL COSECHADOR
 *
 * A diferencia del nombre del administrador —donde la variante era un artefacto
 * de nuestra extracción— acá el valor crudo ES lo que dice el documento. Un
 * filing que publica "Suburban" está diciendo eso. Agrupar es una decisión
 * analítica, no una corrección, y por eso se toma en el análisis, se imprime, y
 * se puede discutir sin recosechar.
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
         nullif(btrim(l.loan_seller), '') AS vendedor,
         l.property_type AS tipo_original,
         extract(year FROM f.filed_at)::int AS anada,
         (d.transfer_date IS NOT NULL)::int AS evento
    FROM corpus.loans l
    JOIN corpus.filings f ON f.accession = l.accession
    LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
   WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                          WHERE deal_accession IS NOT NULL)
     ${FILTRO_VENDEDOR}
`;

console.log(`\n${"═".repeat(78)}`);
console.log("¿Composición de cartera?");
console.log(`${"═".repeat(78)}`);
if (SIN_VENDEDOR) {
  console.log(
    `\n\x1b[33m  Excluyendo al vendedor "${SIN_VENDEDOR}" del numerador y del denominador.\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 1. Cobertura, antes que nada
// ---------------------------------------------------------------------------

const { rows: cob } = await query<{
  n: string; con_tipo: string; shelves_flojos: string;
}>(
  `WITH base AS (${BASE})
   SELECT count(*)::text AS n,
          count(*) FILTER (WHERE tipo_crudo IS NOT NULL)::text AS con_tipo,
          (SELECT count(*)::text FROM (
             SELECT shelf FROM base GROUP BY shelf
              HAVING count(*) FILTER (WHERE tipo_crudo IS NOT NULL)::numeric
                     / count(*) < ${COBERTURA_MINIMA}
           ) x) AS shelves_flojos
     FROM base`,
);

const n = Number(cob[0]!.n);
const conTipo = Number(cob[0]!.con_tipo);
const cobertura = conTipo / n;

console.log(`\n${"─".repeat(78)}`);
console.log("Cobertura de property_type");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  ${conTipo.toLocaleString("en-US")} de ${n.toLocaleString("en-US")} préstamos  →  ` +
    `${cobertura >= COBERTURA_MINIMA ? "\x1b[32m" : "\x1b[31m"}${pct(cobertura)}\x1b[0m` +
    `   \x1b[90m(umbral ${pct(COBERTURA_MINIMA, 0)})\x1b[0m`,
);

/**
 * La cobertura global puede estar bien y estar rota en un shelf.
 *
 * Si a BANK le falta el tipo en la mitad de sus préstamos y a BBCMS en ninguno,
 * estandarizar compara la composición conocida de uno contra la de otro — que
 * es el sesgo que este script viene a descartar, entrando por la puerta de al
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

console.log(`\n  por emisora:`);
/**
 * Este filtro estaba CALCULADO y sin usar: la consulta traía `shelves_flojos`
 * y el script nunca lo miraba. Benchmark entró al SIR con 88,3% de cobertura,
 * `otros` con 87,5% y GS con 76,5%, todos debajo del umbral que el propio
 * script declara.
 *
 * Escribir la verificación y no conectarla es peor que no escribirla: deja la
 * apariencia de que el control existe.
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
// 2. Los valores crudos, antes de agrupar
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
console.log(`Tipos canónicos y qué valores crudos absorbió cada uno`);
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
 * Si hay muchas variantes de escritura, cualquier estandarización posterior es
 * ruido con forma de estrato. Se avisa acá y no después.
 */
const sospechosos = crudos.filter((r) => {
  const t = (r.tipo || "").toLowerCase().trim();
  return crudos.some(
    (o) => o !== r && (o.tipo || "").toLowerCase().trim() === t,
  );
});
if (sospechosos.length > 0) {
  console.log(
    `\n  \x1b[31m${sospechosos.length} valores difieren solo en mayúsculas o espacios.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mSon el mismo tipo partido en estratos distintos: hay que canonizar antes.\x1b[0m`,
  );
}

if (cobertura < COBERTURA_MINIMA) {
  console.log(
    `\n  \x1b[31mCOBERTURA INSUFICIENTE. No se reporta SIR.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mEstandarizar con un tercio de los préstamos sin tipo compara la\x1b[0m`,
  );
  console.log(
    `  \x1b[90mcomposición conocida de una emisora contra la de otra, que es\x1b[0m`,
  );
  console.log(`  \x1b[90mexactamente el sesgo que este script viene a descartar.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. Mezcla por emisora
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
console.log("Mezcla de tipos por emisora (% del pool con tipo conocido)");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  emisora     ` + tiposTop.map((t) => (t || "?").slice(0, 9).padStart(10)).join(""),
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
// 4. SIR estandarizado por tipo × añada
// ---------------------------------------------------------------------------

/**
 * Estandarización indirecta: cuántos eventos esperaría cada emisora si sus
 * préstamos fallaran a la tasa general de su mismo tipo y añada.
 *
 * El estrato es tipo × añada y no solo tipo, porque las dos cosas confunden a la
 * vez: BANK es más viejo que BBCMS (64% en 2020-21 contra 37%) y eso empuja en
 * dirección contraria a la composición.
 */
const { rows: sir } = await query<{
  shelf: string; n: string; obs: string; esp: string;
}>(
  POR_VENDEDOR
    ? `WITH base0 AS (${BASE} AND l.loan_seller IS NOT NULL ${FILTRO_SHELF}),
       top AS (
         SELECT vendedor FROM base0 GROUP BY vendedor
          ORDER BY count(*) DESC LIMIT ${TOP_VENDEDORES}
       ),
       base AS (
         SELECT b.*, CASE WHEN b.vendedor IN (SELECT vendedor FROM top)
                          THEN b.vendedor ELSE 'otros' END AS v
           FROM base0 b
       ),
       tasas AS (
         SELECT v, anada, sum(evento)::numeric / count(*) AS tasa
           FROM base GROUP BY v, anada
       )
       SELECT b.shelf, count(*)::text AS n,
              sum(b.evento)::text AS obs,
              round(sum(t.tasa), 2)::text AS esp
         FROM base b JOIN tasas t ON t.v = b.v AND t.anada = b.anada
        GROUP BY b.shelf
       HAVING count(*) >= ${MIN_POOL_SHELF}
        ORDER BY sum(b.evento)::numeric / nullif(sum(t.tasa), 0)`
    : `WITH base AS (${BASE} AND l.property_type IS NOT NULL ${FILTRO_SHELF}),
   tasas AS (
     SELECT tipo_crudo, anada,
            sum(evento)::numeric / count(*) AS tasa
       FROM base GROUP BY tipo_crudo, anada
   )
   SELECT b.shelf, count(*)::text AS n,
          sum(b.evento)::text AS obs,
          round(sum(t.tasa), 2)::text AS esp
     FROM base b JOIN tasas t
       ON t.tipo_crudo = b.tipo_crudo AND t.anada = b.anada
    GROUP BY b.shelf
   HAVING count(*) >= ${MIN_POOL_SHELF}
    ORDER BY sum(b.evento)::numeric / nullif(sum(t.tasa), 0)`,
);

/** Byar: con 0 eventos observados el intervalo normal no existe. */
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
    ? `SIR estandarizado por VENDEDOR (top ${TOP_VENDEDORES}) × AÑADA`
    : "SIR estandarizado por TIPO DE PROPIEDAD × AÑADA",
);
console.log(`${"─".repeat(78)}\n`);
if (excluidos.length > 0) {
  console.log(
    `  \x1b[90mExcluidas por cobertura < ${pct(COBERTURA_MINIMA, 0)}: ${excluidos.join(", ")}\x1b[0m\n`,
  );
}
console.log(`  emisora        n    obs   esperado    SIR        IC 95%`);
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
  `\n  \x1b[90mComparar contra el SIR de db:predictors, que estandariza por añada y\x1b[0m`,
);
console.log(
  `  \x1b[90mtercil de DSCR pero NO por tipo: BANK 0,39 · Benchmark 1,02 · BBCMS 1,60.\x1b[0m`,
);
console.log(
  `\n  \x1b[90mSi acá BANK sube hacia 1, la brecha era composición. Si se queda abajo,\x1b[0m`,
);
console.log(
  `  \x1b[90mel octavo ataque también falla y no quedan explicaciones fáciles.\x1b[0m\n`,
);

await closePool();

/**
 * ¿La brecha es de la emisora o de quién originó el préstamo?
 *
 *   npm run db:seller
 *
 * LA PREGUNTA, Y POR QUÉ ES DISTINTA DE LAS NUEVE ANTERIORES
 *
 * BANK transfiere a special servicing 4 veces menos que BBCMS, estandarizado por
 * añada, tipo de propiedad y apalancamiento. Eso sobrevivió nueve intentos de
 * matarlo: cobertura del join, población listada, formato del bloque, filtros
 * del parser, valor crudo en veinte emisiones, administrador maestro,
 * administrador especial, composición de cartera, y el bloque de especialmente
 * administrados que el parser no leía.
 *
 * Los nueve eran defensivos: cada uno preguntaba "¿esto es un artefacto?" y la
 * respuesta fue "no". Nueve "no" no hacen un "sí".
 *
 * Este es el primero que puede CONFIRMAR el efecto, porque propone qué sería si
 * es real. BANK no es un originador: es un vehículo que empaqueta préstamos
 * originados por Bank of America, Morgan Stanley y Wells Fargo. Decir "BANK
 * suscribe mejor" es felicitar a la caja por lo que hizo la fábrica.
 *
 * POR QUÉ ES IDENTIFICABLE
 *
 * El mismo vendedor coloca en varias emisiones, así que el diseño queda cruzado
 * sin que nadie lo diseñe. Wells Fargo vende hacia BANK (SIR 0,42) y hacia su
 * propio shelf (1,20). Si el vendedor manda, fijarlo aplana esa diferencia.
 *
 * EL ORDEN ESTÁ FORZADO
 *
 * Cobertura → valores crudos → identificabilidad → efecto. Cada paso puede
 * cortar el script. En particular los valores crudos van antes de agrupar nada:
 * el Annex A publica abreviaturas —JPMCB, CREFI, GACC, MSMCH— y si dos filings
 * escriben el mismo vendedor distinto, agrupar sin mirar fragmenta el diseño
 * igual que se fragmentó Midland en cinco cadenas.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Fijados antes de ver nada. */
const COBERTURA_MINIMA = 0.5;
const MIN_POOL = 150;

/**
 * `--con-apalancamiento`: agrega el tercil de DSCR al estrato.
 *
 * LA DISTINCIÓN QUE DECIDE QUÉ SIGNIFICA EL RESULTADO
 *
 * Ajustado por tipo y añada, LMF sale 3,61 y GSMC 0,14: 26 veces. Pero eso es
 * compatible con dos historias muy distintas.
 *
 *   LMF presta más apalancado a propósito, y cobra por ese riesgo. Entonces el
 *   3,61 mide su estrategia, es esperable, y no dice nada sobre su calidad.
 *
 *   LMF presta al mismo apalancamiento que los demás y le va peor igual.
 *   Entonces sí es suscripción: elige peores prestatarios o proyecta rentas que
 *   no se cumplen.
 *
 * Solo la segunda es interesante, y solo se distinguen controlando por
 * apalancamiento. `db:predictors` ya mostró que el DSCR al originar separa
 * fuerte —6,0% contra 0,8% entre quintiles extremos— así que es el control que
 * más puede mover estos números.
 *
 * TERCILES Y NO QUINTILES
 *
 * El estrato pasa a ser tipo × añada × tercil: 9 × 5 × 3 son 135 celdas para
 * 168 eventos. Con quintiles serían 225 y la mitad quedaría vacía. Ya vimos qué
 * pasa cuando se sobre-estratifica: los esperados colapsan hacia los observados
 * y el test se come a sí mismo sin avisar.
 *
 * QUÉ MIRAR PARA SABER SI PASÓ ESO
 *
 * Si los esperados de TODOS los vendedores se acercan a sus observados y los
 * SIR convergen a 1 en bloque, el estrato es demasiado fino. Si unos suben y
 * otros bajan, el control está haciendo su trabajo.
 */
const CON_APALANCAMIENTO = process.argv.includes("--con-apalancamiento");

/**
 * `--con-ltv`: agrega también el tercil de LTV.
 *
 * El DSCR y el LTV miden riesgos distintos y se suman: `db:predictors` mostró
 * que con DSCR bajo fijo, pasar de LTV bajo a alto multiplica por 3,7x, y al
 * revés por 3,1x. Controlar uno solo deja la mitad del apalancamiento afuera.
 *
 * EL COSTO
 *
 * El estrato pasa a tipo × añada × 3 × 3: hasta 405 celdas para 168 eventos. Es
 * casi seguro demasiado, y la firma de eso —los SIR convergiendo a 1 en bloque
 * mientras los esperados se pegan a los observados— hay que mirarla ANTES que
 * el resultado. Por eso el script imprime el cociente esperado/observado
 * promedio cuando este flag está activo.
 *
 * Si colapsa, el camino no es bajar el umbral hasta que dé: es aceptar que el
 * corpus no aguanta este control y decirlo.
 */
const CON_LTV = process.argv.includes("--con-ltv");

/**
 * `--con-tamano`: agrega el tercil de saldo del préstamo.
 *
 * POR QUÉ APARECE RECIÉN AHORA
 *
 * `db:mechanism` fue a buscar el mecanismo del residuo de LMF —solo-interés,
 * reservas, proyección de NOI— y no encontró ninguno: todos los candidatos
 * salieron planos o en contra. Lo único que se movió fue el saldo: mediana de
 * 5,9M contra 11,3M del resto en los mismos subtipos.
 *
 * El tamaño no estaba controlado en ninguno de los doce ataques anteriores.
 *
 * CONFUNDIDO O MEDIADOR: LA DISTINCIÓN IMPORTA
 *
 * Si los préstamos chicos incumplen más por razones ajenas al prestamista
 * —sponsors menos institucionales, mercados secundarios, menos escrutinio— el
 * tamaño es un confundido y hay que controlarlo.
 *
 * Si LMF ELIGE prestar chico, el tamaño está en el camino causal de su
 * estrategia, y controlarlo es sobre-controlar: le saca crédito por una decisión
 * que es suya.
 *
 * Las dos lecturas son defendibles y el dato no las separa. Lo que sí hace el
 * control es cambiar la pregunta, y conviene decir cuál queda:
 *
 *   sin control  →  "¿el libro de LMF rinde peor?"           (ya sabemos que sí)
 *   con control  →  "¿LMF rinde peor que otros prestamistas
 *                    haciendo préstamos del mismo tamaño?"   (la de un benchmark)
 */
const CON_TAMANO = process.argv.includes("--con-tamano");

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
         nullif(btrim(l.loan_seller), '') AS vendedor,
         extract(year FROM f.filed_at)::int AS anada,
         (d.transfer_date IS NOT NULL)::int AS evento
    FROM corpus.loans l
    JOIN corpus.filings f ON f.accession = l.accession
    LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
   WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                          WHERE deal_accession IS NOT NULL)
`;

console.log(`\n${"═".repeat(78)}`);
console.log("¿Emisora o vendedor del préstamo?");
console.log(`${"═".repeat(78)}`);

// ---------------------------------------------------------------------------
// 1. Cobertura
// ---------------------------------------------------------------------------

const { rows: cob } = await query<{ n: string; con: string; emisiones: string; con_em: string }>(
  `WITH base AS (${BASE})
   SELECT count(*)::text AS n,
          count(*) FILTER (WHERE vendedor IS NOT NULL)::text AS con,
          (SELECT count(DISTINCT f.accession)::text FROM corpus.filings f) AS emisiones,
          (SELECT count(DISTINCT l.accession)::text FROM corpus.loans l
            WHERE nullif(btrim(l.loan_seller), '') IS NOT NULL) AS con_em
     FROM base`,
);

const n = Number(cob[0]!.n);
const con = Number(cob[0]!.con);
const cobertura = n > 0 ? con / n : 0;

console.log(`\n${"─".repeat(78)}`);
console.log("Cobertura del vendedor");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  ${con.toLocaleString("en-US")} de ${n.toLocaleString("en-US")} préstamos  →  ` +
    `${cobertura >= COBERTURA_MINIMA ? "\x1b[32m" : "\x1b[31m"}${pct(cobertura)}\x1b[0m` +
    `   \x1b[90m(umbral ${pct(COBERTURA_MINIMA, 0)})\x1b[0m`,
);
console.log(
  `  \x1b[90m${cob[0]!.con_em} de ${cob[0]!.emisiones} emisiones del corpus tienen la columna\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 2. Valores crudos, antes de agrupar
// ---------------------------------------------------------------------------

const { rows: crudos } = await query<{ v: string; n: string; ev: string; shelves: string }>(
  `WITH base AS (${BASE})
   SELECT vendedor AS v, count(*)::text AS n, sum(evento)::text AS ev,
          count(DISTINCT shelf)::text AS shelves
     FROM base WHERE vendedor IS NOT NULL
    GROUP BY vendedor ORDER BY count(*) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`Valores crudos (${crudos.length} distintos)`);
console.log(`${"─".repeat(78)}\n`);

if (crudos.length === 0) {
  console.log(`  \x1b[33mNinguno. Recosechá con: npm run harvest:batch -- --refresh-stale\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

for (const r of crudos.slice(0, 25)) {
  const nn = Number(r.n), ev = Number(r.ev);
  console.log(
    `  ${r.v.slice(0, 30).padEnd(32)} ${String(nn).padStart(5)}  ${String(ev).padStart(3)} ev  ` +
      `${nn >= 50 ? pct(ev / nn).padStart(6) : "     —"}   \x1b[90men ${r.shelves} emisora(s)\x1b[0m`,
  );
}
if (crudos.length > 25) console.log(`  \x1b[90m... y ${crudos.length - 25} más\x1b[0m`);

/**
 * Las ventas conjuntas —"JPMCB/CREFI"— son un vendedor compuesto, no un
 * vendedor nuevo. Se cuentan aparte para decidir qué hacer con ellas en vez de
 * que entren como categoría propia sin que nadie lo note.
 */
const conjuntas = crudos.filter((r) => /[\/&+]|\band\b/i.test(r.v));
if (conjuntas.length > 0) {
  const total = conjuntas.reduce((a, r) => a + Number(r.n), 0);
  console.log(
    `\n  \x1b[90m${conjuntas.length} valores son ventas conjuntas (${total} préstamos): ` +
      `${conjuntas.slice(0, 4).map((r) => r.v).join(", ")}\x1b[0m`,
  );
}

if (cobertura < COBERTURA_MINIMA) {
  console.log(`\n  \x1b[31mCOBERTURA INSUFICIENTE. No se reporta el efecto.\x1b[0m`);
  console.log(
    `  \x1b[90mCon menos de la mitad de los préstamos, el cruce emisora × vendedor\x1b[0m`,
  );
  console.log(
    `  \x1b[90mcompara subconjuntos distintos de cada emisora, que es el sesgo que\x1b[0m`,
  );
  console.log(`  \x1b[90meste script viene a descartar.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. ¿Es identificable?
// ---------------------------------------------------------------------------

const { rows: celdas } = await query<{
  shelf: string; v: string; n: string; ev: string;
}>(
  `WITH base AS (${BASE})
   SELECT shelf, vendedor AS v, count(*)::text AS n, sum(evento)::text AS ev
     FROM base WHERE vendedor IS NOT NULL
    GROUP BY shelf, vendedor
   HAVING count(*) >= ${MIN_POOL}
    ORDER BY vendedor, shelf`,
);

const porVendedor = new Map<string, Array<{ k: string; tasa: number; n: number }>>();
const porShelf = new Map<string, Array<{ k: string; tasa: number; n: number }>>();
for (const c of celdas) {
  const nn = Number(c.n), ev = Number(c.ev);
  const tasa = ev / nn;
  (porVendedor.get(c.v) ?? porVendedor.set(c.v, []).get(c.v)!).push({ k: c.shelf, tasa, n: nn });
  (porShelf.get(c.shelf) ?? porShelf.set(c.shelf, []).get(c.shelf)!).push({ k: c.v, tasa, n: nn });
}

const vendedoresCruzados = [...porVendedor].filter(([, xs]) => xs.length > 1);
const shelvesCruzados = [...porShelf].filter(([, xs]) => xs.length > 1);

console.log(`\n${"─".repeat(78)}`);
console.log(`Celdas emisora × vendedor (pool ≥ ${MIN_POOL})`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  vendedor            emisora        n   ev     tasa         IC 95%`);
console.log(`  ${"─".repeat(68)}`);

let prev = "";
for (const c of celdas) {
  const nn = Number(c.n), ev = Number(c.ev);
  const [lo, hi] = wilson(ev, nn);
  const etiqueta = c.v === prev ? "" : c.v.slice(0, 18);
  prev = c.v;
  console.log(
    `  ${etiqueta.padEnd(19)} ${c.shelf.padEnd(10)} ${String(nn).padStart(5)} ${String(ev).padStart(4)}  ` +
      `${pct(ev / nn).padStart(6)}  [${pct(lo).padStart(5)} , ${pct(hi).padStart(5)}]`,
  );
}

console.log(
  `\n  Vendedores en más de una emisora: \x1b[1m${vendedoresCruzados.length}\x1b[0m` +
    `   ·   Emisoras con más de un vendedor: \x1b[1m${shelvesCruzados.length}\x1b[0m`,
);

if (vendedoresCruzados.length === 0 || shelvesCruzados.length === 0) {
  console.log(
    `\n  \x1b[31mNO IDENTIFICABLE con celdas de pool ≥ ${MIN_POOL}.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mSin celdas fuera de la diagonal, emisora y vendedor son la misma\x1b[0m`,
  );
  console.log(`  \x1b[90mcolumna con dos nombres.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 4. ¿Qué dispersa más?
// ---------------------------------------------------------------------------

/**
 * En puntos porcentuales, no como cociente: una celda con cero eventos hace que
 * el cociente no exista, y la versión anterior de este test lo tapó con un
 * `max(1e-9, min)` que devolvía 29.333.333x.
 */
const spread = (xs: number[]) => (xs.length < 2 ? null : Math.max(...xs) - Math.min(...xs));
const mediana = (xs: number[]) =>
  xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

console.log(`\n${"─".repeat(78)}`);
console.log("Fijando una variable, ¿cuánto dispersa la otra?");
console.log(`${"─".repeat(78)}\n`);

const spV: number[] = [];
console.log(`  Con el VENDEDOR fijo, dispersión entre emisoras:\n`);
for (const [v, xs] of vendedoresCruzados) {
  const sp = spread(xs.map((x) => x.tasa))!;
  spV.push(sp);
  const detalle = [...xs].sort((a, b) => a.tasa - b.tasa)
    .map((x) => `${x.k} ${pct(x.tasa)}`).join("  ·  ");
  console.log(`    ${v.slice(0, 18).padEnd(19)} ${(sp * 100).toFixed(1).padStart(5)} pp   \x1b[90m${detalle}\x1b[0m`);
}

const spS: number[] = [];
console.log(`\n  Con la EMISORA fija, dispersión entre vendedores:\n`);
for (const [s, xs] of shelvesCruzados) {
  const sp = spread(xs.map((x) => x.tasa))!;
  spS.push(sp);
  const detalle = [...xs].sort((a, b) => a.tasa - b.tasa)
    .map((x) => `${x.k.slice(0, 12)} ${pct(x.tasa)}`).join("  ·  ");
  console.log(`    ${s.padEnd(19)} ${(sp * 100).toFixed(1).padStart(5)} pp   \x1b[90m${detalle}\x1b[0m`);
}

const medV = mediana(spV);
const medS = mediana(spS);

console.log(`\n${"─".repeat(78)}\n`);
if (medV === null || medS === null) {
  console.log(`  \x1b[33mNo hay celdas suficientes en las dos direcciones.\x1b[0m\n`);
} else {
  console.log(`  Mediana con vendedor fijo: \x1b[1m${(medV * 100).toFixed(1)} pp\x1b[0m entre emisoras`);
  console.log(`  Mediana con emisora fija:  \x1b[1m${(medS * 100).toFixed(1)} pp\x1b[0m entre vendedores`);

  if (medS > medV * 1.5) {
    console.log(
      `\n  \x1b[32mEL VENDEDOR MANDA.\x1b[0m Fijar la emisora deja diferencias grandes entre`,
    );
    console.log(
      `  \x1b[90mvendedores, y fijar el vendedor aplana las emisoras. Lo que veníamos\x1b[0m`,
    );
    console.log(
      `  \x1b[90mllamando "efecto emisora" era el mix de originadores de cada shelf.\x1b[0m`,
    );
  } else if (medV > medS * 1.5) {
    console.log(
      `\n  \x1b[33mLA EMISORA MANDA.\x1b[0m El mismo vendedor rinde distinto según a qué`,
    );
    console.log(
      `  \x1b[90memisión coloque. Eso no es "quién suscribe mejor": es que el shelf\x1b[0m`,
    );
    console.log(
      `  \x1b[90melige qué préstamos acepta de cada vendedor, o los agrupa distinto.\x1b[0m`,
    );
  } else {
    console.log(`\n  \x1b[33mLas dos dispersan parecido.\x1b[0m No se separan con estas celdas.`);
  }
  console.log(
    `\n  \x1b[90mSin estandarizar por añada ni por tipo: las celdas de ~200 préstamos no\x1b[0m`,
  );
  console.log(`  \x1b[90maguantan estratificarse. Es una limitación declarada.\x1b[0m\n`);
}

// ---------------------------------------------------------------------------
// 5. El SIR invertido: ¿qué originadores se apartan, ajustados?
// ---------------------------------------------------------------------------

/**
 * La pregunta que queda después de matar el efecto emisora.
 *
 * Estandarizar por vendedor mostró que ninguna emisora se aparta: BANK 1,01 ·
 * BBCMS 1,10 · BMO 1,03. La variación estaba un nivel más abajo, entre
 * originadores — de 0% (NCB) a 11,2% (LMF).
 *
 * Pero esas son tasas CRUDAS. LMF puede estar concentrado en 2021-2022, o en
 * hotelería, y entonces su 11,2% mediría la añada o el activo. Este es el mismo
 * SIR de `db:composition` con los roles cambiados: el vendedor es la unidad y el
 * estrato es tipo de propiedad × añada.
 *
 * A DIFERENCIA DE LA EMISORA, ACÁ LA PREGUNTA TIENE SENTIDO
 *
 * El originador sí decide a quién le presta, con qué apalancamiento y contra qué
 * proyección de renta. Es el nivel donde la suscripción ocurre. La emisora solo
 * elige a quién comprarle.
 *
 * LO QUE SIGUE SIN CONTROLARSE
 *
 * El apalancamiento. Un originador con SIR alto puede estar prestando más caro y
 * más apalancado a propósito, y cobrando por ese riesgo. "Se aparta" acá
 * significa "más transferencias que lo esperable por su mezcla de activos y
 * añadas", no "peor negocio".
 */
const { rows: sirV } = await query<{
  v: string; n: string; obs: string; esp: string; shelves: string;
}>(
  `WITH base AS (
     SELECT b.*,
            CASE
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
            END AS tipo
       FROM (${BASE}) b
       JOIN corpus.loans t ON t.id = b.id
   ),
   con_dscr AS (
     SELECT b.*, ds.value::numeric AS dscr, lt.value::numeric AS ltv,
            am.value::numeric AS saldo
       FROM base b
       LEFT JOIN corpus.facts am ON am.loan_id = b.id AND am.metric_key = 'loan_amount'
                                AND am.value ~ '^[0-9.]+$'
       LEFT JOIN corpus.facts ds ON ds.loan_id = b.id AND ds.metric_key = 'dscr'
                                AND ds.value ~ '^[0-9.]+$' AND ds.value::numeric < 20
       LEFT JOIN corpus.facts lt ON lt.loan_id = b.id AND lt.metric_key = 'ltv'
                                AND lt.value ~ '^[0-9.]+$' AND lt.value::numeric <= 2
   ),
   con_tipo AS (
     SELECT c.*,
            ${CON_APALANCAMIENTO || CON_LTV ? "ntile(3) OVER (ORDER BY dscr NULLS LAST)" : "0"}::int AS tercil,
            ${CON_LTV ? "ntile(3) OVER (ORDER BY ltv NULLS LAST)" : "0"}::int AS tercil_ltv,
            ${CON_TAMANO ? "ntile(3) OVER (ORDER BY saldo NULLS LAST)" : "0"}::int AS tercil_saldo
       FROM con_dscr c
      WHERE vendedor IS NOT NULL AND tipo IS NOT NULL
        ${CON_APALANCAMIENTO || CON_LTV ? "AND dscr IS NOT NULL" : ""}
        ${CON_LTV ? "AND ltv IS NOT NULL" : ""}
        ${CON_TAMANO ? "AND saldo IS NOT NULL" : ""}
   ),
   tasas AS (
     SELECT tipo, anada, tercil, tercil_ltv, tercil_saldo,
            sum(evento)::numeric / count(*) AS tasa
       FROM con_tipo GROUP BY tipo, anada, tercil, tercil_ltv, tercil_saldo
   )
   SELECT c.vendedor AS v, count(*)::text AS n,
          sum(c.evento)::text AS obs,
          round(sum(t.tasa), 2)::text AS esp,
          count(DISTINCT c.shelf)::text AS shelves
     FROM con_tipo c JOIN tasas t
       ON t.tipo = c.tipo AND t.anada = c.anada AND t.tercil = c.tercil
      AND t.tercil_ltv = c.tercil_ltv AND t.tercil_saldo = c.tercil_saldo
    GROUP BY c.vendedor
   HAVING count(*) >= ${MIN_POOL}
    ORDER BY sum(c.evento)::numeric / nullif(sum(t.tasa), 0)`,
);

/** Byar: con 0 eventos observados el intervalo normal no existe. */
function byar(obs: number, esp: number): [number, number] {
  if (esp <= 0) return [0, 0];
  const lo =
    obs === 0 ? 0 : (obs * Math.pow(1 - 1 / (9 * obs) - 1.96 / (3 * Math.sqrt(obs)), 3)) / esp;
  const o1 = obs + 1;
  const hi = (o1 * Math.pow(1 - 1 / (9 * o1) + 1.96 / (3 * Math.sqrt(o1)), 3)) / esp;
  return [Math.max(0, lo), hi];
}

console.log(`\n${"═".repeat(78)}`);
console.log(
  `Originadores: SIR por TIPO × AÑADA${CON_APALANCAMIENTO || CON_LTV ? " × DSCR" : ""}` +
    `${CON_LTV ? " × LTV" : ""}${CON_TAMANO ? " × SALDO" : ""} (pool ≥ ${MIN_POOL})`,
);
console.log(`${"═".repeat(78)}\n`);
console.log(`  vendedor          emis.       n   obs   esperado    SIR         IC 95%`);
console.log(`  ${"─".repeat(72)}`);

let apartados = 0;
let sumObs = 0;
let sumEsp = 0;
let pegados = 0;
for (const r of sirV) {
  sumObs += Number(r.obs);
  sumEsp += Number(r.esp);
  // "Pegado" = el esperado quedó a menos de 15% del observado: el estrato ya no
  // aporta contraste porque el préstamo se compara casi contra sí mismo.
  if (Number(r.esp) > 0 && Math.abs(Number(r.obs) - Number(r.esp)) / Number(r.esp) < 0.15) {
    pegados++;
  }
}
for (const r of sirV) {
  const obs = Number(r.obs), esp = Number(r.esp), nn = Number(r.n);
  const s = esp > 0 ? obs / esp : 0;
  const [lo, hi] = byar(obs, esp);
  const aparta = lo > 1 || hi < 1;
  if (aparta) apartados++;
  console.log(
    `  ${r.v.slice(0, 16).padEnd(17)} ${String(r.shelves).padStart(4)} ${String(nn).padStart(7)} ` +
      `${String(obs).padStart(5)} ${esp.toFixed(1).padStart(9)}  ${s.toFixed(2).padStart(6)}   ` +
      `[${lo.toFixed(2)} , ${hi.toFixed(2)}]` +
      (aparta ? `  \x1b[1m← se aparta\x1b[0m` : ""),
  );
}

console.log(
  `\n  ${apartados} de ${sirV.length} originadores se apartan del promedio ajustado por ` +
    `tipo y añada${CON_APALANCAMIENTO || CON_LTV || CON_TAMANO ? ", DSCR" : ""}` +
    `${CON_LTV ? ", LTV" : ""}${CON_TAMANO ? " y saldo" : ""}.`,
);

/**
 * La firma de la sobre-estratificación, impresa ANTES de que uno se crea el
 * resultado: si casi todos los esperados quedan pegados a sus observados, el
 * estrato se volvió tan fino que cada préstamo se compara contra sí mismo y
 * todos los SIR tienden a 1 sin que eso signifique nada.
 */
console.log(
  `\n  \x1b[90mControl de sobre-estratificación: ${pegados} de ${sirV.length} originadores tienen\x1b[0m`,
);
console.log(
  `  \x1b[90mel esperado a menos de 15% del observado.\x1b[0m` +
    (pegados > sirV.length * 0.6
      ? `  \x1b[31m← el estrato es demasiado fino\x1b[0m`
      : `  \x1b[32m← el estrato sigue aportando contraste\x1b[0m`),
);
console.log(
  `\n  \x1b[90m"emis." es en cuántas emisoras coloca cada uno. Uno que aparece en una\x1b[0m`,
);
console.log(
  `  \x1b[90msola no se distingue de esa emisión: ahí vendedor y shelf son lo mismo.\x1b[0m`,
);
if (CON_APALANCAMIENTO || CON_LTV) {
  console.log(
    `\n  \x1b[90mSe controla DSCR${CON_LTV ? " y LTV" : " por tercil, no LTV"}. Y el tipo de propiedad no captura\x1b[0m`,
  );
  console.log(
    `  \x1b[90mPRODUCTO: las cooperativas viven dentro de multifamily, y ese mismo\x1b[0m`,
  );
  console.log(
    `  \x1b[90mmecanismo ya mató una vez el efecto emisora. Puede estar operando acá.\x1b[0m\n`,
  );
} else {
  console.log(
    `\n  \x1b[90mNo se controla apalancamiento. Un SIR alto puede ser la estrategia de\x1b[0m`,
  );
  console.log(
    `  \x1b[90mprestar más caro y más apalancado, cobrando por ese riesgo.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mPara distinguirlo:  npm run db:seller -- --con-apalancamiento\x1b[0m\n`,
  );
}

// ---------------------------------------------------------------------------
// 6. ¿El exceso está concentrado en una añada?
// ---------------------------------------------------------------------------

/**
 * La pregunta que puede CONFIRMAR en vez de solo achicar.
 *
 * El residuo de LMF se encogió con cada control: 3,61 con tipo × añada, 2,26
 * agregando DSCR, 1,90 agregando LTV. Ese patrón monótono es ambiguo — puede
 * converger arriba de 1 o seguir bajando con los controles que faltan.
 *
 * Un control que REDUCE el efecto es débilmente informativo. Uno que NO lo
 * reduce sería fuerte. Este test es de la segunda clase.
 *
 * QUÉ DISTINGUE
 *
 * Si los eventos de un originador están concentrados en 2021-2022, hizo una
 * apuesta de ciclo: prestó fuerte en el pico de valuaciones. Eso no es
 * suscripción, y estandarizar por añada NO lo corrige — ajusta el nivel de cada
 * año, pero no captura que un originador haya prestado distinto DENTRO del año.
 *
 * Si están repartidos entre 2020 y 2024, es un estilo persistente, y ahí el
 * residuo empieza a significar algo sobre cómo suscribe.
 *
 * CÓMO SE LEE
 *
 * La columna "concentración" es la porción de eventos que cae en la añada donde
 * el originador tiene su mayor exceso, comparada contra la porción de su pool
 * en esa misma añada. Si evento y pool coinciden, el exceso está repartido.
 */
const { rows: porAnada } = await query<{
  v: string; anada: string; n: string; ev: string;
}>(
  `WITH base AS (${BASE})
   SELECT vendedor AS v, anada::text, count(*)::text AS n, sum(evento)::text AS ev
     FROM base
    WHERE vendedor IS NOT NULL
      AND vendedor IN (
        SELECT vendedor FROM base WHERE vendedor IS NOT NULL
         GROUP BY vendedor HAVING count(*) >= ${MIN_POOL} AND sum(evento) >= 10
      )
    GROUP BY vendedor, anada
    ORDER BY vendedor, anada`,
);

const porV = new Map<string, Array<{ anada: string; n: number; ev: number }>>();
for (const r of porAnada) {
  const xs = porV.get(r.v) ?? [];
  xs.push({ anada: r.anada, n: Number(r.n), ev: Number(r.ev) });
  porV.set(r.v, xs);
}

console.log(`\n${"═".repeat(78)}`);
console.log("¿El exceso está concentrado en una añada, o repartido?");
console.log(`${"═".repeat(78)}\n`);
console.log(`  vendedor      eventos   añadas con evento   peor añada      % ev / % pool`);
console.log(`  ${"─".repeat(72)}`);

for (const [v, xs] of [...porV].sort((a, b) => {
  const s = (z: typeof a) => z[1].reduce((t, x) => t + x.ev, 0);
  return s(b) - s(a);
})) {
  const totEv = xs.reduce((t, x) => t + x.ev, 0);
  const totN = xs.reduce((t, x) => t + x.n, 0);
  if (totEv === 0) continue;

  const conEvento = xs.filter((x) => x.ev > 0).length;
  const peor = xs.reduce((a, b) => (b.ev / Math.max(1, b.n) > a.ev / Math.max(1, a.n) ? b : a));
  const shareEv = peor.ev / totEv;
  const sharePool = peor.n / totN;

  /**
   * Si la porción de eventos de la peor añada supera con holgura a su porción
   * del pool, el exceso vive en ese año. Repartido significa que las dos
   * porciones se parecen.
   */
  const concentrado = shareEv > sharePool * 2 && shareEv > 0.5;
  console.log(
    `  ${v.slice(0, 12).padEnd(13)} ${String(totEv).padStart(7)}   ${String(conEvento).padStart(10)} de ${xs.length}` +
      `      ${peor.anada}  ${pct(shareEv, 0).padStart(7)} / ${pct(sharePool, 0).padStart(5)}` +
      (concentrado ? `  \x1b[33m← concentrado\x1b[0m` : `  \x1b[90mrepartido\x1b[0m`),
  );
}

console.log(
  `\n  \x1b[90mConcentrado = el exceso vive en un año: es una apuesta de ciclo, y\x1b[0m`,
);
console.log(
  `  \x1b[90mestandarizar por añada NO lo corrige —ajusta el nivel del año, no cómo\x1b[0m`,
);
console.log(
  `  \x1b[90mprestó cada uno dentro de él—. Repartido = estilo persistente.\x1b[0m\n`,
);

// ---------------------------------------------------------------------------
// 7. Producto dentro de tipo: el ataque con más prior de acertar
// ---------------------------------------------------------------------------

/**
 * El mecanismo que ya mató una vez a este proyecto.
 *
 * BANK parecía suscribir 4 veces mejor. La explicación era NCB: cooperativas de
 * vivienda, un producto que casi no incumple, viviendo DENTRO de la categoría
 * multifamily —la de mayor riesgo del corpus—. `property_type` no distingue
 * producto, así que la estandarización le asignaba a esos préstamos una tasa
 * esperada alta y le regalaba a BANK un SIR bajo.
 *
 * Si LMF se especializa en algo análogo —hotelería de servicio limitado dentro
 * de hospitality, un subtipo de multifamily, retail sin ancla— su 1,89 es el
 * mismo artefacto con otro nombre.
 *
 * LA COLUMNA QUE NUNCA USAMOS
 *
 * `property_type_detailed` está en la taxonomía desde el principio y jamás entró
 * a un análisis. Vive en `corpus.facts`, no en `corpus.loans`, porque es una
 * métrica y no una etiqueta de fila.
 *
 * EL ORDEN, OTRA VEZ
 *
 * Cobertura primero. Si la columna aparece en pocos filings, el test no se puede
 * hacer sobre los 270 préstamos de LMF y la respuesta correcta es "no se sabe" —
 * peor que matarlo o confirmarlo, pero es la que hay.
 */
const { rows: covDet } = await query<{
  n: string; con: string; lmf_n: string; lmf_con: string;
}>(
  `WITH base AS (${BASE}),
   det AS (
     SELECT b.*, nullif(btrim(fd.value), '') AS detalle
       FROM base b
       LEFT JOIN corpus.facts fd ON fd.loan_id = b.id
                                AND fd.metric_key = 'property_type_detailed'
   )
   SELECT count(*)::text AS n,
          count(*) FILTER (WHERE detalle IS NOT NULL)::text AS con,
          count(*) FILTER (WHERE vendedor = 'LMF')::text AS lmf_n,
          count(*) FILTER (WHERE vendedor = 'LMF' AND detalle IS NOT NULL)::text AS lmf_con
     FROM det`,
);

const detN = Number(covDet[0]!.n);
const detCon = Number(covDet[0]!.con);
const lmfN = Number(covDet[0]!.lmf_n);
const lmfCon = Number(covDet[0]!.lmf_con);

console.log(`\n${"═".repeat(78)}`);
console.log("Producto dentro de tipo: ¿el subtipo explica el residuo?");
console.log(`${"═".repeat(78)}\n`);
console.log(
  `  property_type_detailed: ${detCon.toLocaleString("en-US")} de ${detN.toLocaleString("en-US")} ` +
    `préstamos  →  ${detN > 0 && detCon / detN >= 0.5 ? "\x1b[32m" : "\x1b[31m"}` +
    `${pct(detN > 0 ? detCon / detN : 0)}\x1b[0m`,
);
console.log(
  `  \x1b[90men LMF: ${lmfCon} de ${lmfN}` +
    `${lmfN > 0 ? ` (${pct(lmfCon / lmfN)})` : ""}\x1b[0m`,
);

if (detCon === 0) {
  console.log(
    `\n  \x1b[33mLa métrica no está poblada. Puede que el mapeo la capture y el corpus\x1b[0m`,
  );
  console.log(`  \x1b[90mno la haya guardado como fact. No se puede testear.\x1b[0m\n`);
} else {
  /**
   * La mezcla de subtipos de los que se apartan, contra la del corpus.
   *
   * Si un originador concentra en un subtipo que el corpus tiene poco, ese
   * subtipo es candidato a explicar su exceso — igual que las cooperativas
   * explicaron a BANK.
   */
  const { rows: mezcla } = await query<{
    v: string; detalle: string; n: string; ev: string; corpus_tasa: string;
  }>(
    `WITH base AS (${BASE}),
     det AS (
       SELECT b.*, nullif(btrim(fd.value), '') AS detalle
         FROM base b
         LEFT JOIN corpus.facts fd ON fd.loan_id = b.id
                                  AND fd.metric_key = 'property_type_detailed'
     ),
     tasa_corpus AS (
       SELECT detalle, sum(evento)::numeric / count(*) AS tasa
         FROM det WHERE detalle IS NOT NULL GROUP BY detalle
     )
     SELECT d.vendedor AS v, d.detalle, count(*)::text AS n,
            sum(d.evento)::text AS ev,
            round(tc.tasa * 100, 1)::text AS corpus_tasa
       FROM det d JOIN tasa_corpus tc ON tc.detalle = d.detalle
      WHERE d.vendedor IN ('LMF', 'UBS AG', 'NCB') AND d.detalle IS NOT NULL
      GROUP BY d.vendedor, d.detalle, tc.tasa
     HAVING count(*) >= 10
      ORDER BY d.vendedor, count(*) DESC`,
  );

  if (mezcla.length === 0) {
    console.log(
      `\n  \x1b[33mNingún subtipo llega a 10 préstamos en los originadores que se apartan.\x1b[0m\n`,
    );
  } else {
    console.log(`\n  vendedor    subtipo                     n   ev    tasa   tasa corpus`);
    console.log(`  ${"─".repeat(70)}`);
    let prev = "";
    for (const r of mezcla) {
      const nn = Number(r.n), ev = Number(r.ev);
      const et = r.v === prev ? "" : r.v;
      prev = r.v;
      console.log(
        `  ${et.padEnd(11)} ${r.detalle.slice(0, 24).padEnd(26)} ${String(nn).padStart(4)} ` +
          `${String(ev).padStart(4)}  ${pct(ev / nn).padStart(6)}   ${r.corpus_tasa.padStart(5)}%`,
      );
    }
    console.log(
      `\n  \x1b[90mSi la tasa del originador en un subtipo se parece a la del corpus EN ESE\x1b[0m`,
    );
    console.log(
      `  \x1b[90mmismo subtipo, su exceso es composición: elige subtipos peores. Si es\x1b[0m`,
    );
    console.log(
      `  \x1b[90mmás alta dentro del mismo subtipo, suscribe peor adentro de él.\x1b[0m\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// 8. El último corte, con las celdas al límite
// ---------------------------------------------------------------------------

/**
 * El exceso de LMF en multifamily, añada por añada.
 *
 * El test de subtipo mostró que LMF no elige subtipos peores: está más alto
 * DENTRO de Garden, Mid Rise y Multifamily/Retail —59 préstamos, 18 eventos,
 * 30,5% contra ~8% del corpus en esos mismos subtipos—.
 *
 * Queda una pregunta y no da para más: ¿ese exceso vive en 2021-2022, cuando
 * todo el mercado suscribió multifamily sobre crecimiento de renta que no se
 * cumplió, o está en todas las añadas?
 *
 * POR QUÉ SE IMPRIME AUNQUE NO ALCANCE
 *
 * Las celdas van a quedar de cinco o seis préstamos. Eso NO permite concluir, y
 * el script lo dice en vez de dejar que los porcentajes parezcan una respuesta.
 * Se imprime igual porque la forma —todo en un año contra repartido— se puede
 * mirar aunque cada celda individual no signifique nada, y porque la alternativa
 * es no mirarlo y suponer.
 *
 * Es el mismo criterio que con el bloque de especialmente administrados: ver el
 * dato crudo aunque el conteo no aguante una prueba formal.
 */
const SUBTIPOS_MF = ["Garden", "Mid Rise", "Multifamily/Retail"];

const { rows: mfAnada } = await query<{
  anada: string; n: string; ev: string; corpus_n: string; corpus_ev: string;
}>(
  `WITH base AS (${BASE}),
   det AS (
     SELECT b.*, nullif(btrim(fd.value), '') AS detalle
       FROM base b
       LEFT JOIN corpus.facts fd ON fd.loan_id = b.id
                                AND fd.metric_key = 'property_type_detailed'
   ),
   mf AS (SELECT * FROM det WHERE detalle = ANY($1))
   SELECT anada::text,
          count(*) FILTER (WHERE vendedor = 'LMF')::text AS n,
          sum(evento) FILTER (WHERE vendedor = 'LMF')::text AS ev,
          count(*) FILTER (WHERE vendedor IS DISTINCT FROM 'LMF')::text AS corpus_n,
          sum(evento) FILTER (WHERE vendedor IS DISTINCT FROM 'LMF')::text AS corpus_ev
     FROM mf GROUP BY anada ORDER BY anada`,
  [SUBTIPOS_MF],
);

console.log(`\n${"═".repeat(78)}`);
console.log("LMF en multifamily, añada por añada  —  celdas al límite");
console.log(`${"═".repeat(78)}\n`);
console.log(`  añada     LMF n   ev     tasa      resto n   ev     tasa`);
console.log(`  ${"─".repeat(62)}`);

let mfN = 0;
let mfEv = 0;
let anadasConEvento = 0;
for (const r of mfAnada) {
  const nn = Number(r.n ?? 0);
  const ev = Number(r.ev ?? 0);
  const cn = Number(r.corpus_n ?? 0);
  const cev = Number(r.corpus_ev ?? 0);
  mfN += nn;
  mfEv += ev;
  if (ev > 0) anadasConEvento++;
  console.log(
    `  ${r.anada}   ${String(nn).padStart(7)} ${String(ev).padStart(4)}  ` +
      `${(nn > 0 ? pct(ev / nn) : "—").padStart(7)}   ${String(cn).padStart(7)} ${String(cev).padStart(4)}  ` +
      `${(cn > 0 ? pct(cev / cn) : "—").padStart(7)}`,
  );
}

console.log(
  `\n  \x1b[1mLMF total: ${mfEv} eventos sobre ${mfN} préstamos` +
    `${mfN > 0 ? ` (${pct(mfEv / mfN)})` : ""}, en ${anadasConEvento} añadas\x1b[0m`,
);

/**
 * El veredicto de tamaño va ANTES que la lectura, no después.
 */
const celdaMediana = mfAnada.length > 0 ? mfN / mfAnada.length : 0;
console.log(
  `\n  \x1b[90mCelda promedio de LMF: ${celdaMediana.toFixed(0)} préstamos.\x1b[0m` +
    (celdaMediana < 15
      ? `  \x1b[31m← no alcanza para concluir por añada\x1b[0m`
      : `  \x1b[32m← suficiente para leer\x1b[0m`),
);
console.log(
  `\n  \x1b[90mCon celdas así, lo único legible es la FORMA: si los eventos aparecen\x1b[0m`,
);
console.log(
  `  \x1b[90men una sola añada es la apuesta de 2021-22 que hizo todo el mercado.\x1b[0m`,
);
console.log(
  `  \x1b[90mSi aparecen en varias, es un estilo. Ninguna celda individual prueba nada.\x1b[0m\n`,
);

await closePool();

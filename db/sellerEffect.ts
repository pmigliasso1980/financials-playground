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

await closePool();

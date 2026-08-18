/**
 * ¿La brecha entre emisoras es de la emisora o del administrador maestro?
 *
 *   npm run db:servicer-effect
 *
 * LA PREGUNTA
 *
 * Ajustado por añada y tercil de DSCR, BANK transfiere a special servicing 4
 * veces menos que BBCMS (SIR 0,39 contra 1,60, intervalos que no se pisan).
 * Sobrevivió cinco intentos de matarlo: el join —que pega al 97,7%—, la
 * población listada, el formato del bloque, los filtros, y el valor crudo
 * verificado en veinte emisiones.
 *
 * Queda una explicación alternativa. El administrador maestro arma la tabla de
 * morosidad, y decide cuándo un préstamo se transfiere al administrador
 * especial. Si un administrador transfiere con criterio más laxo, sus
 * emisiones marcan más eventos sin que el crédito sea peor.
 *
 * POR QUÉ SE PUEDE PREGUNTAR
 *
 * Porque el diseño está cruzado, y eso se verificó ANTES de mirar ningún
 * resultado (`db:coverage`, última sección): Trimont aparece en las ocho
 * emisoras, Midland en seis, KeyBank en cuatro. Si cada emisora usara un
 * administrador propio, las dos variables serían la misma columna con dos
 * nombres y no habría análisis posible.
 *
 * EL CONTRASTE QUE DECIDE
 *
 * BANK y Wells son ambas casi enteramente Trimont —16 de 24 y 10 de 11— y hoy
 * marcan 1,3% contra 4,4%. Si el administrador explicara la brecha, esas dos
 * deberían parecerse. Que no se parezcan es evidencia contra la hipótesis antes
 * de calcular nada, y este script lo mide en vez de razonarlo.
 *
 * CÓMO SE LEE
 *
 * La dispersión ENTRE emisoras dentro de un mismo administrador contra la
 * dispersión ENTRE administradores dentro de una misma emisora. La que sea
 * mayor es la variable que manda. Es una comparación de rangos, no un modelo:
 * con 151 eventos repartidos en celdas, un modelo daría coeficientes que no se
 * pueden interpretar.
 *
 * LO QUE ESTE SCRIPT NO CONTROLA
 *
 * La añada. Cada celda reporta su mezcla para que se pueda ver si un contraste
 * está montado sobre añadas distintas. No se estandariza porque estratificar
 * celdas de 300 préstamos por añada las deja en 60, y ahí no queda nada que
 * leer. Es una limitación declarada, no resuelta.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Fijado antes de ver los números: debajo de esto la celda no se lee. */
const MIN_POOL = 150;

/**
 * `--special` corre el mismo test contra el administrador ESPECIAL.
 *
 * El maestro decide cuándo transferir; el especial es quien recibe el préstamo
 * y lo designa el comprador del B-piece, que tiene apetito propio. Son dos
 * actores distintos y no hay razón para que el resultado sea el mismo.
 *
 * Es la misma pregunta con otra columna, así que comparte todo el código: si
 * el test fuera distinto para cada uno, la comparación entre ambos no diría
 * nada.
 */
const ESPECIAL = process.argv.includes("--special");
const COLUMNA = ESPECIAL ? "special_servicer" : "master_servicer";
const ROL = ESPECIAL ? "administrador especial" : "administrador maestro";

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

/**
 * Un préstamo por fila, con su emisora, su administrador y si transfirió.
 *
 * Solo emisiones con informe del servicer registrado: en las demás el evento no
 * es observable. El gate es `servicer_reports`, no `performance` — eso se
 * corrigió porque usar la tabla de NOI como proxy de "hay informe" dejaba
 * afuera ocho emisiones cuyo informe se parseó bien pero no dio NOI.
 */
const BASE = `
  SELECT l.id,
         ${SHELF} AS shelf,
         sr.${COLUMNA} AS master,
         extract(year FROM f.filed_at)::int AS anada,
         (d.transfer_date IS NOT NULL)::int AS evento
    FROM corpus.loans l
    JOIN corpus.filings f ON f.accession = l.accession
    JOIN corpus.servicer_reports sr ON sr.deal_accession = f.accession
    LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
   WHERE sr.${COLUMNA} IS NOT NULL
`;

console.log(`\n${"═".repeat(78)}`);
console.log(`¿Emisora o ${ROL}?`);
console.log(`${"═".repeat(78)}`);

const { rows: tot } = await query<{ n: string; ev: string }>(
  `WITH base AS (${BASE}) SELECT count(*)::text AS n, sum(evento)::text AS ev FROM base`,
);
const nTot = Number(tot[0]!.n);
const evTot = Number(tot[0]!.ev);
console.log(
  `\n\x1b[90m  ${nTot.toLocaleString("en-US")} préstamos con administrador identificado · ` +
    `${evTot} transferencias · tasa base ${pct(evTot / nTot)}\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 1. Marginal por administrador
// ---------------------------------------------------------------------------

const { rows: porMaster } = await query<{
  master: string; emisoras: string; n: string; ev: string;
}>(
  `WITH base AS (${BASE})
   SELECT master, count(DISTINCT shelf)::text AS emisoras,
          count(*)::text AS n, sum(evento)::text AS ev
     FROM base GROUP BY master ORDER BY count(*) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`Por ${ROL} (marginal)`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  administrador             emis.       n   eventos     tasa        IC 95%`);
console.log(`  ${"─".repeat(72)}`);
for (const r of porMaster) {
  const n = Number(r.n), ev = Number(r.ev);
  const [lo, hi] = wilson(ev, n);
  console.log(
    `  ${r.master.slice(0, 24).padEnd(25)} ${String(r.emisoras).padStart(4)} ` +
      `${String(n).padStart(7)} ${String(ev).padStart(8)}   ${pct(ev / n).padStart(6)}  ` +
      `[${pct(lo).padStart(5)} , ${pct(hi).padStart(5)}]`,
  );
}

// ---------------------------------------------------------------------------
// 2. Las celdas: emisora × administrador
// ---------------------------------------------------------------------------

const { rows: celdas } = await query<{
  shelf: string; master: string; n: string; ev: string; anadas: string;
}>(
  `WITH base AS (${BASE})
   SELECT shelf, master, count(*)::text AS n, sum(evento)::text AS ev,
          string_agg(DISTINCT anada::text, ',' ORDER BY anada::text) AS anadas
     FROM base GROUP BY shelf, master
    HAVING count(*) >= ${MIN_POOL}
    ORDER BY master, shelf`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`Celdas emisora × ${ROL} (pool ≥ ${MIN_POOL})`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  administrador          emisora        n   ev     tasa         IC 95%     añadas`);
console.log(`  ${"─".repeat(76)}`);

const porMasterCeldas = new Map<string, Array<{ shelf: string; tasa: number; n: number }>>();
const porShelfCeldas = new Map<string, Array<{ master: string; tasa: number; n: number }>>();

let masterPrev = "";
for (const c of celdas) {
  const n = Number(c.n), ev = Number(c.ev);
  const tasa = ev / n;
  const [lo, hi] = wilson(ev, n);

  (porMasterCeldas.get(c.master) ?? porMasterCeldas.set(c.master, []).get(c.master)!).push({
    shelf: c.shelf, tasa, n,
  });
  (porShelfCeldas.get(c.shelf) ?? porShelfCeldas.set(c.shelf, []).get(c.shelf)!).push({
    master: c.master, tasa, n,
  });

  const etiqueta = c.master === masterPrev ? "" : c.master.slice(0, 21);
  masterPrev = c.master;
  console.log(
    `  ${etiqueta.padEnd(22)} ${c.shelf.padEnd(10)} ${String(n).padStart(5)} ${String(ev).padStart(4)}  ` +
      `${pct(tasa).padStart(6)}  [${pct(lo).padStart(5)} , ${pct(hi).padStart(5)}]  ` +
      `\x1b[90m${c.anadas}\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 3. El test: ¿qué dispersa más?
// ---------------------------------------------------------------------------

/**
 * Fijando el administrador, ¿cuánto varían las emisoras? Y al revés.
 *
 * Si la brecha fuera del administrador, fijarlo debería aplanar las emisoras.
 * Si es de la emisora, fijar el administrador no cambia nada y lo que se aplana
 * es la otra dirección.
 */
/**
 * La dispersión se mide en PUNTOS PORCENTUALES, no como cociente.
 *
 * La primera versión hacía `max / max(1e-9, min)` y BANK con LNR —0 eventos
 * sobre 261 préstamos— salió como 29.333.333x. Un cociente de tasas no está
 * definido cuando el denominador es cero, y esa guarda convirtió un "no se
 * puede calcular" en un número enorme que además arrastraba la mediana.
 *
 * Los puntos porcentuales están siempre definidos, se comparan entre celdas sin
 * ambigüedad, y para tasas base de 1-7% son lo que uno quiere leer igual: la
 * diferencia entre 0,6% y 6,3% es de 5,7 puntos, y eso es interpretable
 * mientras que "diez veces" no dice cuánto.
 *
 * El cociente se sigue mostrando cuando existe, porque es la forma en que
 * veníamos hablando de esto, pero ya no decide nada.
 */
const spread = (xs: number[]) => (xs.length < 2 ? null : Math.max(...xs) - Math.min(...xs));
const cociente = (xs: number[]) => {
  if (xs.length < 2) return null;
  const min = Math.min(...xs);
  return min > 0 ? Math.max(...xs) / min : null;
};

console.log(`\n${"─".repeat(78)}`);
console.log("Fijando una variable, ¿cuánto dispersa la otra?");
console.log(`${"─".repeat(78)}\n`);

console.log(`  Con el ADMINISTRADOR (${ESPECIAL ? "especial" : "maestro"}) fijo, dispersión entre emisoras:\n`);
const spreadsMaster: number[] = [];
for (const [master, xs] of porMasterCeldas) {
  const tasas = xs.map((x) => x.tasa);
  const sp = spread(tasas);
  if (sp === null) continue;
  spreadsMaster.push(sp);
  const c = cociente(tasas);
  const detalle = xs
    .sort((a, b) => a.tasa - b.tasa)
    .map((x) => `${x.shelf} ${pct(x.tasa)}`)
    .join("  ·  ");
  console.log(
    `    ${master.slice(0, 22).padEnd(23)} ${(sp * 100).toFixed(1).padStart(4)} pp` +
      `${(c === null ? "   (—)" : ` (${c.toFixed(1)}x)`).padEnd(9)}  \x1b[90m${detalle}\x1b[0m`,
  );
}

console.log(`\n  Con la EMISORA fija, dispersión entre administradores:\n`);
const spreadsShelf: number[] = [];
for (const [shelf, xs] of porShelfCeldas) {
  const tasas = xs.map((x) => x.tasa);
  const sp = spread(tasas);
  if (sp === null) continue;
  spreadsShelf.push(sp);
  const c = cociente(tasas);
  const detalle = xs
    .sort((a, b) => a.tasa - b.tasa)
    .map((x) => `${x.master.slice(0, 14)} ${pct(x.tasa)}`)
    .join("  ·  ");
  console.log(
    `    ${shelf.padEnd(23)} ${(sp * 100).toFixed(1).padStart(4)} pp` +
      `${(c === null ? "   (—)" : ` (${c.toFixed(1)}x)`).padEnd(9)}  \x1b[90m${detalle}\x1b[0m`,
  );
}

const mediana = (xs: number[]) =>
  xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const medMaster = mediana(spreadsMaster);
const medShelf = mediana(spreadsShelf);

console.log(`\n${"─".repeat(78)}\n`);
if (medMaster === null || medShelf === null) {
  console.log(
    `  \x1b[33mNo hay suficientes celdas con pool ≥ ${MIN_POOL} en las dos direcciones.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mBajar el umbral haría aparecer contrastes montados sobre veinte préstamos.\x1b[0m\n`,
  );
} else {
  console.log(
    `  Mediana con administrador fijo: \x1b[1m${(medMaster * 100).toFixed(1)} pp\x1b[0m entre emisoras`,
  );
  console.log(
    `  Mediana con emisora fija:       \x1b[1m${(medShelf * 100).toFixed(1)} pp\x1b[0m entre administradores`,
  );

  if (medMaster > medShelf * 1.5) {
    console.log(
      `\n  \x1b[32mLa emisora dispersa más.\x1b[0m Fijar el administrador NO aplana las`,
    );
    console.log(
      `  \x1b[90memisoras: la brecha no se explica por quién administra.\x1b[0m`,
    );
  } else if (medShelf > medMaster * 1.5) {
    console.log(
      `\n  \x1b[31mEl administrador dispersa más.\x1b[0m La brecha entre emisoras es en`,
    );
    console.log(
      `  \x1b[90mbuena medida un efecto de quién arma el informe, no de quién suscribe.\x1b[0m`,
    );
  } else {
    console.log(
      `\n  \x1b[33mLas dos dispersan parecido.\x1b[0m No se pueden separar con estas celdas:`,
    );
    console.log(
      `  \x1b[90mel dato es compatible con las dos historias y con una mezcla de ambas.\x1b[0m`,
    );
  }
  console.log(
    `\n  \x1b[90mLas añadas de cada celda están en la tabla de arriba. Un contraste entre\x1b[0m`,
  );
  console.log(
    `  \x1b[90mceldas de añadas distintas hereda el censurado, y eso no está corregido.\x1b[0m\n`,
  );
}

await closePool();

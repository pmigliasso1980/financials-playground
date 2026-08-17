/**
 * ¿Qué métricas se deciden por el orden de las columnas?
 *
 *   npm run harvest:ties
 *   npm run harvest:ties -- --emisiones 10
 *
 * QUÉ BUSCA
 *
 * `scoreHeader` puntúa por posición del patrón que matchea, y `mapColumns`
 * resuelve empates por orden de columna. Cuando dos encabezados distintos
 * empatan en el puntaje máximo de una métrica, el ganador lo decide el orden en
 * que quedaron los bloques después de `joinAnnexTables` — que varía por
 * emisión.
 *
 * Así se mezclaron dos cantidades bajo `occupancy` durante tres semanas:
 * `Leased Occupancy (%)` y `Most Recent Hotel Occupancy (%)` empataban en 0,76,
 * y en 7 emisiones de 2026 ganó la de hotel. La cobertura se veía en 76% y
 * adentro había dos métricas distintas.
 *
 * El Annex A conduit tiene series históricas en varias métricas —NOI, ingresos,
 * gastos, ocupación—, así que no hay razón para pensar que la ocupación fuera
 * el único caso.
 *
 * ES UN TEST, NO UN INFORME
 *
 * Sale con código 1 si encuentra empates. Un empate en el puntaje ganador no es
 * un dato del documento: es un agujero en la taxonomía, y la taxonomía es
 * nuestra.
 *
 * QUÉ NO DETECTA
 *
 * Que la columna ganadora sea la correcta. Si una métrica tiene un único
 * candidato y es el equivocado, esto pasa en verde. Detecta ambigüedad, no
 * error.
 */

import { fetchBuffer, preflight } from "./edgar/client.js";
import { findAnnexFilings } from "./edgar/discover.js";
import { extractTables } from "./parse/tables.js";
import { findHeaderRow, METRIC_SPECS, scoreHeader } from "./normalize/columnMap.js";
import { attachContinuationTables, joinAnnexTables } from "./normalize/annexStructure.js";
import { closePool, ping, query } from "../db/client.js";

const args = process.argv.slice(2);
const i = args.indexOf("--emisiones");
const N = i === -1 ? 6 : Number(args[i + 1] ?? 6);

const health = await preflight();
if (!health.ok) {
  console.error(`\n✗ ${health.message}\n`);
  process.exit(1);
}
const db = await ping();
if (!db.ok) {
  console.error(`\n✗ ${db.message.split("\n").join("\n  ")}\n`);
  process.exit(1);
}

/**
 * Una emisión por añada, la de mayor pool.
 *
 * Criterio fijado antes de mirar: más préstamos es más probable que el Annex
 * traiga todos los bloques, y el muestreo por añada cubre cambios de plantilla
 * a lo largo del tiempo. No depende de ningún resultado.
 */
const { rows: emisiones } = await query<{ cik: string; nombre: string; anada: string }>(
  `WITH r AS (
     SELECT f.cik, f.company_name AS nombre,
            extract(year FROM f.filed_at)::int::text AS anada,
            row_number() OVER (
              PARTITION BY extract(year FROM f.filed_at)
              ORDER BY count(l.id) DESC, f.accession
            ) AS rn
       FROM corpus.filings f
       JOIN corpus.loans l ON l.accession = f.accession
      WHERE f.filed_at IS NOT NULL
      GROUP BY f.cik, f.company_name, f.accession, f.filed_at
   )
   SELECT cik, nombre, anada FROM r WHERE rn = 1 ORDER BY anada DESC`,
);
await closePool();

console.log(`\n${"═".repeat(78)}`);
console.log("¿Qué métricas se deciden por el orden de las columnas?");
console.log(`${"═".repeat(78)}\n`);

interface Empate {
  metrica: string;
  score: number;
  headers: string[];
  emision: string;
}
const empates: Empate[] = [];
let revisadas = 0;

for (const e of emisiones.slice(0, N)) {
  try {
    const picks = await findAnnexFilings(e.cik, { max: 1 });
    if (picks.length === 0) {
      console.log(`  ${e.nombre.slice(0, 40).padEnd(42)} \x1b[33msin Annex A\x1b[0m`);
      continue;
    }
    const { filing } = picks[0]!;
    const buffer = await fetchBuffer(filing.documentUrl, { timeoutMs: 180_000 });
    const tables = extractTables(buffer, filing.documentName);
    const { tables: annexTables } = attachContinuationTables(tables, (rows) =>
      findHeaderRow(rows),
    );
    const joined = joinAnnexTables(annexTables);
    if (!joined) {
      console.log(`  ${e.nombre.slice(0, 40).padEnd(42)} \x1b[33msin join\x1b[0m`);
      continue;
    }

    /**
     * Los encabezados UNIDOS, que es donde las columnas compiten de verdad.
     *
     * Mirar tabla por tabla no sirve: el empate aparece justamente porque el
     * join junta bloques que por separado tenían una sola candidata cada uno.
     */
    const headers = (joined.rows[joined.headerRowIndex] ?? []).map((c) =>
      c === null || c === undefined ? "" : String(c).replace(/\s+/g, " ").trim(),
    );

    revisadas++;
    const propios: Empate[] = [];

    for (const spec of METRIC_SPECS) {
      const puntuadas = headers
        .map((h) => ({ h, s: scoreHeader(h, spec) }))
        .filter((x) => x.s > 0);
      if (puntuadas.length < 2) continue;

      const max = Math.max(...puntuadas.map((x) => x.s));
      /**
       * Encabezados repetidos no son ambigüedad: son la misma columna en dos
       * bloques. La comparación ignora espacios y mayúsculas porque el Annex A
       * trae "# of Properties" en un bloque y "#of Properties" en otro — un
       * espacio de diferencia que la sonda reportaba como métrica ambigua.
       *
       * Es un falso positivo mío, no un defecto de la taxonomía: las dos
       * columnas contienen lo mismo y da igual cuál gane.
       */
      const clave = (h: string) => h.replace(/\s+/g, "").toLowerCase();
      const porClave = new Map<string, string>();
      for (const x of puntuadas.filter((x) => x.s === max)) {
        if (!porClave.has(clave(x.h))) porClave.set(clave(x.h), x.h);
      }
      const ganadoras = [...porClave.values()];
      if (ganadoras.length < 2) continue;

      propios.push({ metrica: spec.key, score: max, headers: ganadoras, emision: e.nombre });
    }

    empates.push(...propios);
    console.log(
      `  ${e.nombre.slice(0, 40).padEnd(42)} ${String(headers.length).padStart(3)} cols · ` +
        (propios.length === 0
          ? `\x1b[32msin empates\x1b[0m`
          : `\x1b[31m${propios.length} métrica(s) ambigua(s)\x1b[0m`),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${e.nombre.slice(0, 40).padEnd(42)} \x1b[31m${msg.slice(0, 30)}\x1b[0m`);
  }
}

console.log(`\n${"─".repeat(78)}\n`);

if (revisadas === 0) {
  console.log(`  \x1b[33mNinguna emisión se pudo revisar. Sin conclusión.\x1b[0m\n`);
  process.exit(1);
}

if (empates.length === 0) {
  console.log(
    `  \x1b[32mNinguna métrica ambigua en ${revisadas} emisiones.\x1b[0m Cada una tiene una\n` +
      `  sola columna en su puntaje máximo.\n`,
  );
  process.exit(0);
}

/** Se agrupa por métrica: la misma ambigüedad aparece en muchas emisiones. */
const porMetrica = new Map<string, Empate[]>();
for (const x of empates) {
  const l = porMetrica.get(x.metrica) ?? [];
  l.push(x);
  porMetrica.set(x.metrica, l);
}

console.log(
  `  \x1b[31m${porMetrica.size} métrica(s) con empate en el puntaje ganador\x1b[0m` +
    ` \x1b[90m(${revisadas} emisiones revisadas)\x1b[0m\n`,
);

for (const [metrica, casos] of [...porMetrica].sort((a, b) => b[1].length - a[1].length)) {
  console.log(
    `  \x1b[1m${metrica}\x1b[0m \x1b[90m· empata en ${casos.length} de ${revisadas} emisiones · puntaje ${casos[0]!.score.toFixed(2)}\x1b[0m`,
  );
  for (const h of casos[0]!.headers) console.log(`      \x1b[36m"${h.slice(0, 60)}"\x1b[0m`);

  /**
   * Si las columnas empatadas cambian entre emisiones, el conjunto de
   * candidatas depende del documento y no solo de la taxonomía.
   */
  const firmas = new Set(casos.map((c) => [...c.headers].sort().join("|")));
  if (firmas.size > 1) {
    console.log(`      \x1b[90m(${firmas.size} combinaciones distintas entre emisiones)\x1b[0m`);
  }
  console.log();
}

console.log(
  `  \x1b[90mEl arreglo es el mismo que se usó en occupancy: un patrón más específico\x1b[0m`,
);
console.log(
  `  \x1b[90mprimero para la columna que se quiere, o un exclude para las que no.\x1b[0m`,
);
console.log(
  `  \x1b[90mDejarlo así hace que el valor guardado dependa del orden de los bloques.\x1b[0m\n`,
);

process.exit(1);

/**
 * Estado del corpus acumulado.
 *
 *   npm run db:stats
 *
 * Las dos secciones que más importan:
 *
 *   COBERTURA POR MÉTRICA — cuántos préstamos tienen cada métrica. Si un cambio
 *   en el mapeo mejoró o empeoró las cosas, se ve acá antes que en ningún lado.
 *
 *   ENCABEZADOS SIN MAPEAR — la cola de trabajo. Los de arriba son los que más
 *   filings desaprovechan, así que son los que más rinde atacar.
 */

import { closePool, ping, query } from "./client.js";
import { corpusStats } from "./corpus.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}
if (!health.schemaReady) {
  console.error(`\n✗ El schema corpus no existe.\n\n    npm run db:migrate\n`);
  await closePool();
  process.exit(1);
}

const stats = await corpusStats();

console.log(`\n${"═".repeat(70)}`);
console.log("Corpus");
console.log(`${"═".repeat(70)}\n`);

console.log(
  `  ${stats.filings} filings · ${stats.loans} préstamos · ` +
    `${stats.observations} observations · ${stats.facts} facts\n`,
);

if (stats.filings === 0) {
  console.log("  Vacío. Cosechá con:\n");
  console.log("    npm run harvest -- fetch 2053102 --persist\n");
  await closePool();
  process.exit(0);
}

console.log("Cobertura por métrica");
console.log(`  ${"métrica".padEnd(26)} ${"préstamos".padStart(9)} ${"headers".padStart(8)}`);
console.log(`  ${"─".repeat(46)}`);

/**
 * Padding que ignora los códigos de color.
 *
 * `String.padStart` cuenta los escapes ANSI como caracteres visibles, así que
 * colorear un valor le come el ancho a la columna y desalinea la tabla.
 */
function pad(text: string, width: number, color?: string): string {
  const padding = " ".repeat(Math.max(0, width - text.length));
  return color ? `${padding}${color}${text}\x1b[0m` : `${padding}${text}`;
}

/**
 * Cobertura por debajo de la cual conviene sospechar del mapeo.
 *
 * Algunas métricas son legítimamente parciales —un multifamily no reporta
 * superficie, un portfolio trae "Various" como año— pero otras deberían estar
 * en casi todos los préstamos de un pool de CMBS: LTV, DSCR, balance.
 */
const EXPECTED_UNIVERSAL = new Set([
  "loan_amount", "ltv", "dscr", "noi_underwritten", "property_name", "interest_rate",
]);

const suspicious: string[] = [];

for (const m of stats.byMetric) {
  const pct = stats.loans > 0 ? Math.round((m.loans / stats.loans) * 100) : 0;
  const bar = "█".repeat(Math.round(pct / 10)).padEnd(10, "·");

  // distinct_headers > 1 significa que varios emisores nombran distinto la
  // misma métrica: buena señal de que los patrones están haciendo su trabajo.
  const headersCell = pad(
    String(m.distinct_headers),
    8,
    m.distinct_headers > 1 ? "\x1b[36m" : undefined,
  );

  const low = EXPECTED_UNIVERSAL.has(m.metric_key) && pct < 90;
  if (low) suspicious.push(`${m.metric_key} (${pct}%)`);

  const nameCell = low
    ? `\x1b[33m${m.metric_key.padEnd(26)}\x1b[0m`
    : m.metric_key.padEnd(26);

  console.log(
    `  ${nameCell} ${pad(String(m.loans), 9)} ${headersCell}  \x1b[90m${bar} ${pct}%\x1b[0m`,
  );
}

if (suspicious.length > 0) {
  console.log(
    `\n  \x1b[33m⚠ Cobertura baja en métricas que un pool de CMBS suele traer completas:\x1b[0m`,
  );
  console.log(`    ${suspicious.join(", ")}`);
  console.log(
    `    \x1b[90mProbablemente falte un patrón, o la columna esté en un bloque que no se unió.\x1b[0m`,
  );
  console.log(`    \x1b[90mInspeccioná con: npm run harvest:inspect\x1b[0m`);
}

/**
 * Integridad del corpus.
 *
 * Un Annex A numera sus préstamos de forma correlativa, así que la cantidad de
 * préstamos, la de IDs distintos y el ID máximo deberían coincidir. Cuando no
 * coinciden, hay filas de un bloque pegadas debajo del encabezado de otro y los
 * datos de ese filing están corridos.
 *
 * Este chequeo existe porque ese bug produjo tasas de interés de 480% —que en
 * realidad eran plazos de amortización en meses— y un pool con 165 préstamos
 * donde había 82. Los valores individuales parecían válidos; lo que no cerraba
 * era la aritmética de los identificadores.
 */
const { rows: integrity } = await query<{
  company_name: string; accession: string; loans: string;
  distinct_ids: string; max_id: string | null;
}>(
  `SELECT fi.company_name, fi.accession,
          count(*) AS loans,
          count(DISTINCT l.loan_ref) AS distinct_ids,
          max(l.loan_ref::numeric)::text AS max_id
     FROM corpus.loans l
     JOIN corpus.filings fi ON fi.accession = l.accession
    WHERE l.loan_ref ~ '^[0-9.]+$'
    GROUP BY 1, 2`,
);

const suspect = integrity.filter((r) => {
  const loans = Number(r.loans);
  const ids = Number(r.distinct_ids);
  const max = Number(r.max_id);
  if (!Number.isFinite(max) || loans < 5) return false;
  // IDs repetidos, o muchos más préstamos que el ID más alto.
  return ids < loans || loans > max * 1.3;
});

if (suspect.length > 0) {
  console.log(`\n\x1b[31mIntegridad: ${suspect.length} filing(s) con identificadores inconsistentes\x1b[0m`);
  console.log(`  ${"filing".padEnd(40)} ${"préstamos".padStart(9)} ${"ids".padStart(6)} ${"máx id".padStart(7)}`);
  for (const r of suspect.slice(0, 12)) {
    console.log(
      `  ${r.company_name.slice(0, 40).padEnd(40)} ${String(r.loans).padStart(9)} ` +
        `${String(r.distinct_ids).padStart(6)} ${String(r.max_id ?? "—").padStart(7)}`,
    );
  }
  console.log(
    `\n  \x1b[90mMás préstamos que IDs distintos significa filas duplicadas de otro bloque.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mLos datos de esos filings están corridos: no usarlos hasta corregir.\x1b[0m`,
  );
} else if (integrity.length > 0) {
  console.log(
    `\n\x1b[32mIntegridad: los ${integrity.length} filings tienen identificadores correlativos.\x1b[0m`,
  );
}

if (stats.topUnmapped.length > 0) {
  console.log(`\nEncabezados sin mapear \x1b[90m(cola de trabajo)\x1b[0m`);
  console.log(`  ${"filings".padStart(7)}  encabezado`);
  console.log(`  ${"─".repeat(60)}`);
  for (const u of stats.topUnmapped) {
    console.log(`  ${String(u.filings).padStart(7)}  ${u.header}`);
  }
  console.log(
    `\n  \x1b[90mPara capturar alguno: agregá su patrón a METRIC_SPECS en\x1b[0m`,
  );
  console.log(`  \x1b[90mharvest/normalize/columnMap.ts y recosechá con --persist.\x1b[0m`);
}

console.log();
await closePool();

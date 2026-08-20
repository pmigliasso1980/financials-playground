/**
 * Test de escala del harvester.
 *
 * Genera un Annex A sintético con la forma y el volumen de uno real —500
 * propiedades, encabezados agrupados por colspan, columnas parcialmente
 * pobladas— y verifica cobertura, sanidad y tiempos.
 *
 * POR QUÉ EXISTE
 *
 * Los tests de unidad usan tablas de 2-3 filas, y con eso no aparecen los
 * problemas de mapeo que sí surgen a escala. Dos bugs reales los encontró este
 * test, no los otros:
 *
 *   1. El encabezado de grupo "Physical & Occupancy" se pegaba por colspan a la
 *      columna "Net Rentable Area (SF)". El texto resultante matcheaba
 *      *occupancy* con más puntaje que *square feet*, así que se robaba la
 *      columna: 500 valores de superficie guardados como ocupancia, y la
 *      ocupancia real sin mapear.
 *
 *   2. La exclusión `/rent/i` de square_feet mataba "Net **Rent**able Area",
 *      el nombre más común de esa columna.
 *
 * Ninguno de los dos tira error. El primero lo cazó `checkSanity()`; el segundo
 * apareció al revisar la cobertura por métrica.
 *
 *   npm run harvest:scale
 */

import { extractFromHtml } from "./parse/tables.js";
import { findHeaderRow } from "./normalize/columnMap.js";
import { checkSanity, rowsToObservations, type SourceRef } from "./normalize/toObservations.js";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------

const HEADERS = [
  "Loan No.", "Property Name", "Street Address", "City", "State", "Zip",
  "Property Type", "Year Built", "Units/Rooms/Pads", "Net Rentable Area (SF)",
  "Occupancy", "Underwritten Net Operating Income", "Most Recent NOI",
  "Original Principal Balance", "Appraised Value", "Cut-off Date LTV",
  "Underwritten DSCR", "Debt Yield", "Mortgage Rate",
];

const TYPES = ["Multifamily", "Office", "Industrial", "Retail", "Hotel", "Self-Storage"];
const STATES = ["TX", "CA", "NY", "FL", "IL", "GA", "NC", "AZ", "WA", "CO"];
const N = 500;

function buildAnnexHtml(): string {
  let rows = "";
  for (let i = 1; i <= N; i++) {
    const noi = 800_000 + (i * 9973) % 6_000_000;
    const loan = Math.round(noi / 0.09);
    const value = Math.round(loan / 0.68);
    // Multifamily y hoteles reportan unidades; el resto, superficie.
    const units = i % 3 === 0 ? String(100 + (i % 400)) : "";
    const sf = i % 3 === 0 ? "" : String(50_000 + (i * 137) % 400_000);

    rows +=
      `<tr><td>${i}</td><td>Property ${i}</td><td>${100 + i} Main St</td>` +
      `<td>City${i % 50}</td><td>${STATES[i % 10]}</td><td>${10_000 + i}</td>` +
      `<td>${TYPES[i % 6]}</td><td>${1970 + (i % 50)}</td><td>${units}</td><td>${sf}</td>` +
      `<td>${(85 + (i % 15)).toFixed(1)}%</td>` +
      `<td>$${noi.toLocaleString("en-US")}</td>` +
      `<td>$${Math.round(noi * 0.95).toLocaleString("en-US")}</td>` +
      `<td>$${loan.toLocaleString("en-US")}</td>` +
      `<td>$${value.toLocaleString("en-US")}</td>` +
      `<td>${(68 + (i % 8)).toFixed(1)}%</td>` +
      `<td>${(1.2 + (i % 40) / 100).toFixed(2)}x</td>` +
      `<td>${(8 + (i % 20) / 10).toFixed(1)}%</td>` +
      `<td>${(4.5 + (i % 25) / 20).toFixed(2)}%</td></tr>`;
  }

  // Encabezados de grupo con colspan: la fuente de los bugs de mapeo.
  return (
    `<html><body><p>ANNEX A-1</p><table>` +
    `<tr><td colspan="7">Property Information</td>` +
    `<td colspan="4">Physical &amp; Occupancy</td>` +
    `<td colspan="8">Financial</td></tr>` +
    `<tr>${HEADERS.map((h) => `<th>${h}</th>`).join("")}</tr>${rows}</table></body></html>`
  );
}

const SOURCE: SourceRef = {
  cik: "1", accession: "scale-test", companyName: "Scale Test Trust",
  formType: "FWP", filedAt: "2026-08-01",
  fileName: "annexa1.htm", fileUrl: "https://www.sec.gov/scale-test",
};

console.log(`\nEscala — Annex A sintético de ${N} propiedades\n`);

const html = buildAnnexHtml();
console.log(`  documento: ${(Buffer.byteLength(html) / 1e6).toFixed(2)} MB`);

const t0 = Date.now();
const tables = extractFromHtml(html);
const parseMs = Date.now() - t0;

const header = findHeaderRow(tables[0]!.rows);
assert(header, "no se detectaron encabezados");

const t1 = Date.now();
const result = rowsToObservations(tables[0]!.rows, header.rowIndex, SOURCE);
const normalizeMs = Date.now() - t1;

console.log(`  parseo: ${parseMs} ms · normalización: ${normalizeMs} ms · heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB\n`);

// ---------------------------------------------------------------------------

check("parsea todas las filas sin perder ninguna", () => {
  assert(tables.length === 1, `esperaba 1 tabla, hay ${tables.length}`);
  assert(result.stats.propertiesKept === N, `${result.stats.propertiesKept} de ${N} propiedades`);
});

check("mapea todas las columnas del Annex A", () => {
  // 19 columnas menos "Loan No.", que no es una métrica nuestra.
  assert(
    result.columnsMapped.length >= 18,
    `solo ${result.columnsMapped.length} columnas mapeadas: ${result.columnsMapped.map((c) => c.metric).join(", ")}`,
  );
});

check("el encabezado de grupo no se roba la columna de superficie", () => {
  // El bug original: "Physical & Occupancy" + "Net Rentable Area (SF)" hacía
  // que occupancy ganara la columna de superficie.
  const occ = result.columnsMapped.find((c) => c.metric === "occupancy");
  assert(occ, "occupancy no se mapeó");
  assert(
    /^occupancy$/i.test(occ!.header.trim()),
    `occupancy tomó la columna "${occ!.header}" en vez de "Occupancy"`,
  );
});

check("square feet se mapea pese a llamarse 'Net Rentable Area'", () => {
  const sf = result.columnsMapped.find((c) => c.metric === "square_feet");
  assert(sf, "square_feet no se mapeó — ¿alguna exclusión demasiado amplia?");
  assert(/rentable/i.test(sf!.header), `mapeó a "${sf!.header}"`);
});

check("UW NOI y Most Recent NOI van a columnas distintas", () => {
  const uw = result.columnsMapped.find((c) => c.metric === "noi_underwritten");
  const recent = result.columnsMapped.find((c) => c.metric === "noi_most_recent");
  assert(uw && recent, "faltó alguno de los dos NOI");
  assert(uw!.header !== recent!.header, "los dos apuntan al mismo encabezado");
});

check("las columnas parcialmente pobladas tienen cobertura parcial", () => {
  // units y square_feet son mutuamente excluyentes en el fixture.
  const units = result.stats.coverageByMetric.units ?? 0;
  const sf = result.stats.coverageByMetric.square_feet ?? 0;
  assert(units > 0 && units < N, `units=${units}, esperaba entre 0 y ${N}`);
  assert(sf > 0 && sf < N, `square_feet=${sf}, esperaba entre 0 y ${N}`);
  assert(units + sf === N, `units+sf=${units + sf}, esperaba ${N}`);
});

check("las métricas centrales cubren todas las filas", () => {
  for (const key of ["noi_underwritten", "occupancy", "loan_amount", "ltv", "dscr"]) {
    const count = result.stats.coverageByMetric[key] ?? 0;
    assert(count === N, `${key}: ${count} de ${N}`);
  }
});

check("los chequeos de sanidad no encuentran nada", () => {
  const issues = checkSanity(result);
  assert(
    issues.length === 0,
    issues.map((i) => `[${i.metric}] ${i.message}`).join("; "),
  );
});

check("los valores quedan en el rango correcto para su unidad", () => {
  const sample = result.properties.slice(0, 50);
  for (const prop of sample) {
    for (const obs of prop.observations) {
      if (obs.unit !== "percent") continue;
      const v = Number(obs.value);
      assert(v >= 0 && v <= 1, `${obs.metric_key}=${v} fuera de 0-1`);
    }
  }
});

check("los ids de observation son únicos a escala", () => {
  const ids = result.properties.flatMap((p) => p.observations.map((o) => o.id));
  assert(new Set(ids).size === ids.length, `${ids.length - new Set(ids).size} ids duplicados`);
});

check("el rendimiento se mantiene razonable", () => {
  // Umbrales holgados: buscamos detectar una regresión de orden de magnitud,
  // no medir performance con precisión.
  assert(parseMs < 5000, `el parseo tardó ${parseMs} ms`);
  assert(normalizeMs < 5000, `la normalización tardó ${normalizeMs} ms`);
});

// ---------------------------------------------------------------------------

console.log(
  `\n  cobertura: ${Object.entries(result.stats.coverageByMetric)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}`,
);

console.log(
  `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} ok · ${failed} failed\x1b[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);

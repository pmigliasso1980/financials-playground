/**
 * Test offline del harvester.
 *
 * Prueba todo lo que NO depende de la red: detección de la fila de headers,
 * mapeo de columnas, parseo de valores, normalización a observations y los
 * chequeos de sanidad.
 *
 * Los fixtures imitan las variantes de headers que usan distintos emisores de
 * CMBS. Si algún día conseguís un Annex A real y el mapeo falla, agregá esa
 * variante acá antes de tocar los patrones — así el fix queda cubierto.
 *
 *   npm run harvest:test
 */

import * as XLSX from "xlsx";
import { findHeaderRow, mapColumns, parseValue } from "./normalize/columnMap.js";
import { checkSanity, rowsToObservations, type SourceRef } from "./normalize/toObservations.js";
import { scoreAnnexFiling, scoreProspectusFallback } from "./edgar/discover.js";
import { extractFromHtml, extractTables } from "./parse/tables.js";

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

function eq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) throw new Error(`${label}: esperaba ${String(expected)}, recibí ${String(actual)}`);
}

// ---------------------------------------------------------------------------
// Fixtures: variantes reales de headers entre emisores
// ---------------------------------------------------------------------------

/** Estilo "clásico": nombres largos y explícitos. */
const HEADERS_VERBOSE = [
  "Loan No.", "Property Name", "Street Address", "City", "State", "Zip Code",
  "Property Type", "Year Built", "Year Renovated", "Units/Rooms/Pads",
  "Net Rentable Area (SF)", "Occupancy", "Occupancy Date",
  "Underwritten Net Operating Income", "Most Recent NOI",
  "Original Principal Balance", "Appraised Value", "Cut-off Date LTV",
  "Underwritten DSCR", "Mortgage Rate",
];

/** Estilo abreviado. */
const HEADERS_TERSE = [
  "ID", "Property", "Address", "City", "ST", "Zip", "Type",
  "Built", "Units", "SF", "% Occupied", "UW NOI", "T-12 NOI",
  "Cut-off Balance", "Value", "LTV", "DSCR", "Debt Yield", "Coupon",
];

/** Estilo con símbolos y unidades entre paréntesis. */
const HEADERS_SYMBOLS = [
  "#", "Property Name", "Address", "City", "State", "Zip",
  "Property Type", "YOC", "# of Units", "NRA (SF)", "Occupancy Rate (%)",
  "U/W NOI ($)", "Original Balance ($)", "Appraised Value ($)",
  "LTV (%)", "DSCR (x)", "Interest Rate (%)",
];

function buildRows(headers: string[], dataRows: unknown[][], preamble = 3): unknown[][] {
  // Los Annex A reales arrancan con títulos y notas antes de la tabla.
  const junk: unknown[][] = [
    ["ANNEX A-1"],
    ["Certain Characteristics of the Mortgage Loans and Mortgaged Properties"],
    [],
  ].slice(0, preamble);
  return [...junk, headers, ...dataRows];
}

const SOURCE: SourceRef = {
  cik: "1735646",
  accession: "0001539497-18-000733",
  companyName: "JPMDB Commercial Mortgage Securities Trust 2018-C8",
  formType: "FWP",
  filedAt: "2018-06-01",
  fileName: "annexa-1.xlsx",
  fileUrl: "https://www.sec.gov/Archives/edgar/data/1735646/000153949718000733/annexa-1.xlsx",
};

// ---------------------------------------------------------------------------

console.log("\nHarvester — tests offline\n");

console.log("Parseo de valores");

check("moneda con $ y comas", () => {
  eq(parseValue("$1,234,567", "currency"), "1234567", "moneda");
});

check("negativo contable entre paréntesis", () => {
  eq(parseValue("(45,000)", "currency"), "-45000", "negativo");
});

check("porcentaje con signo → fracción", () => {
  eq(parseValue("94.5%", "percent"), "0.945", "pct con signo");
});

check("porcentaje sin signo pero > 1.5 → fracción", () => {
  eq(parseValue("94.5", "percent"), "0.945", "pct sin signo");
});

check("fracción ya normalizada se respeta", () => {
  eq(parseValue("0.945", "percent"), "0.945", "fracción");
});

check("ratio con sufijo x", () => {
  eq(parseValue("1.25x", "ratio"), "1.25", "ratio");
});

check("N/A y variantes → null", () => {
  for (const v of ["N/A", "n/a", "NA", "-", "—", "", "   ", "None"]) {
    assert(parseValue(v, "currency") === null, `"${v}" debería ser null`);
  }
});

check("año fuera de rango → null", () => {
  eq(parseValue("1985", "years"), "1985", "año válido");
  assert(parseValue("0", "years") === null, "año 0 debería ser null");
  assert(parseValue("99999", "years") === null, "año absurdo debería ser null");
});

check("cero es un valor, no ausencia", () => {
  eq(parseValue("0", "currency"), "0", "cero");
  eq(parseValue("$0", "currency"), "0", "cero con símbolo");
});

// ---------------------------------------------------------------------------

console.log("\nMapeo de columnas");

check("headers verbosos: mapea las métricas centrales", () => {
  const { matches } = mapColumns(HEADERS_VERBOSE);
  const keys = new Set(matches.map((m) => m.metric.key));
  for (const expected of ["noi_underwritten", "noi_most_recent", "occupancy", "units", "loan_amount", "ltv", "dscr"]) {
    assert(keys.has(expected as never), `falta ${expected}`);
  }
});

check("headers abreviados: mapea igual", () => {
  const { matches } = mapColumns(HEADERS_TERSE);
  const keys = new Set(matches.map((m) => m.metric.key));
  for (const expected of ["noi_underwritten", "noi_most_recent", "occupancy", "units", "ltv", "dscr"]) {
    assert(keys.has(expected as never), `falta ${expected}`);
  }
});

check("headers con símbolos: mapea igual", () => {
  const { matches } = mapColumns(HEADERS_SYMBOLS);
  const keys = new Set(matches.map((m) => m.metric.key));
  for (const expected of ["noi_underwritten", "occupancy", "units", "ltv", "dscr", "interest_rate"]) {
    assert(keys.has(expected as never), `falta ${expected}`);
  }
});

check("UW NOI y Most Recent NOI no se confunden", () => {
  const { matches } = mapColumns(HEADERS_VERBOSE);
  const uw = matches.find((m) => m.metric.key === "noi_underwritten");
  const recent = matches.find((m) => m.metric.key === "noi_most_recent");
  assert(uw && recent, "deberían mapearse las dos");
  assert(uw!.columnIndex !== recent!.columnIndex, "cayeron en la misma columna");
  assert(/underwritten/i.test(uw!.header), `UW mapeó a "${uw!.header}"`);
  assert(/most recent/i.test(recent!.header), `Most Recent mapeó a "${recent!.header}"`);
});

check("'Occupancy Date' no se toma por ocupancia", () => {
  const { matches } = mapColumns(["Occupancy", "Occupancy Date"]);
  const occ = matches.find((m) => m.metric.key === "occupancy");
  assert(occ, "debería mapear Occupancy");
  eq(occ!.header, "Occupancy", "eligió la columna equivocada");
});

check("'per unit' y '/SF' no se toman por units ni square feet", () => {
  const { matches } = mapColumns(["Price per Unit", "Rent / SF", "Units", "NRA (SF)"]);
  const units = matches.find((m) => m.metric.key === "units");
  const sf = matches.find((m) => m.metric.key === "square_feet");
  eq(units?.header, "Units", "units mapeó mal");
  eq(sf?.header, "NRA (SF)", "square feet mapeó mal");
});

check("una columna no se asigna a dos métricas", () => {
  const { matches } = mapColumns(HEADERS_VERBOSE);
  const cols = matches.map((m) => m.columnIndex);
  eq(new Set(cols).size, cols.length, "hay columnas duplicadas");
});

check("una métrica no toma dos columnas", () => {
  const { matches } = mapColumns(HEADERS_VERBOSE);
  const keys = matches.map((m) => m.metric.key);
  eq(new Set(keys).size, keys.length, "hay métricas duplicadas");
});

// ---------------------------------------------------------------------------

console.log("\nDetección de la fila de headers");

check("saltea el preámbulo de títulos", () => {
  const rows = buildRows(HEADERS_VERBOSE, [[1, "Test", "1 Main St"]]);
  const found = findHeaderRow(rows);
  assert(found, "no encontró headers");
  eq(found!.rowIndex, 3, "índice de fila");
});

check("elige la fila con más métricas si hay varias candidatas", () => {
  const rows: unknown[][] = [
    ["Loan No.", "City", "State", "Zip", "Notes"],   // pocas métricas
    HEADERS_VERBOSE,                                  // muchas
    [1, "Test"],
  ];
  const found = findHeaderRow(rows);
  eq(found?.rowIndex, 1, "eligió la fila equivocada");
});

check("sin tabla reconocible devuelve null", () => {
  const rows: unknown[][] = [["Título"], ["Nota al pie"], []];
  assert(findHeaderRow(rows) === null, "debería ser null");
});

// ---------------------------------------------------------------------------

console.log("\nNormalización a observations");

const DATA_VERBOSE: unknown[][] = [
  [1, "Harbor Point Plaza", "925 Harbor Point Dr", "Charleston", "SC", "29403",
   "Multifamily", 2016, null, 248, null, "94.5%", "2018-03-31",
   "$2,970,696", "$2,850,000", "$31,700,000", "$48,000,000", "66.0%", "1.42x", "4.85%"],
  [2, "Mesa Crossing", "4400 E Mesa Blvd", "Phoenix", "AZ", "85018",
   "Retail", 1998, 2015, null, 84000, "91.2%", "2018-03-31",
   "$1,140,000", "$1,085,000", "$12,400,000", "$19,000,000", "65.3%", "1.35x", "5.10%"],
  // Fila basura: subtotal, casi sin datos.
  [null, "TOTAL", null, null, null, null, null, null, null, null, null, null, null,
   "$4,110,696", null, "$44,100,000", null, null, null, null],
];

const rowsVerbose = buildRows(HEADERS_VERBOSE, DATA_VERBOSE);
const headerVerbose = findHeaderRow(rowsVerbose)!;
const harvest = rowsToObservations(rowsVerbose, headerVerbose.rowIndex, SOURCE);

check("descarta las filas de subtotal", () => {
  eq(harvest.stats.propertiesKept, 2, "propiedades");
  eq(harvest.stats.rowsSkipped, 1, "filas descartadas");
});

check("cada observation lleva su provenance", () => {
  const obs = harvest.properties[0]!.observations[0]!;
  assert(obs.source.accession === SOURCE.accession, "falta el accession");
  assert(obs.source.fileUrl.startsWith("https://www.sec.gov/"), "falta la URL del archivo");
  assert(obs.source_header.length > 0, "falta el header original");
  assert(typeof obs.source_column_index === "number", "falta el índice de columna");
});

check("conserva el valor crudo junto al parseado", () => {
  const noi = harvest.properties[0]!.observations.find((o) => o.metric_key === "noi_underwritten")!;
  eq(noi.value, "2970696", "valor parseado");
  eq(noi.raw_value, "$2,970,696", "valor crudo");
});

check("la ocupancia queda en fracción", () => {
  const occ = harvest.properties[0]!.observations.find((o) => o.metric_key === "occupancy")!;
  eq(occ.value, "0.945", "ocupancia");
});

check("las etiquetas de texto quedan accesibles", () => {
  eq(harvest.properties[0]!.label.property_name, "Harbor Point Plaza", "nombre");
  eq(harvest.properties[0]!.label.state, "SC", "estado");
  eq(harvest.properties[1]!.label.property_type, "Retail", "tipo");
});

check("las celdas vacías no generan observations", () => {
  const p0 = harvest.properties[0]!;
  assert(!p0.observations.some((o) => o.metric_key === "square_feet"), "multifamily no tenía SF");
  assert(!p0.observations.some((o) => o.metric_key === "year_renovated"), "no tenía renovación");
});

check("los ids de observation son estables y únicos", () => {
  const ids = harvest.properties.flatMap((p) => p.observations.map((o) => o.id));
  eq(new Set(ids).size, ids.length, "hay ids duplicados");
  const again = rowsToObservations(rowsVerbose, headerVerbose.rowIndex, SOURCE);
  eq(again.properties[0]!.observations[0]!.id, harvest.properties[0]!.observations[0]!.id, "no es estable");
});

// ---------------------------------------------------------------------------

console.log("\nChequeos de sanidad");

check("un harvest correcto no dispara errores", () => {
  const issues = checkSanity(harvest);
  const errors = issues.filter((i) => i.severity === "error");
  assert(errors.length === 0, `errores inesperados: ${errors.map((e) => e.message).join("; ")}`);
});

check("detecta NOI y loan amount cruzados", () => {
  const swapped = buildRows(HEADERS_VERBOSE, [
    [1, "Test", "1 Main", "X", "SC", "1", "Multifamily", 2000, null, 100, null, "90%", null,
     "$31,700,000", null, "$2,970,696", "$48,000,000", "66%", "1.4x", "5%"],
  ]);
  const h = findHeaderRow(swapped)!;
  const bad = rowsToObservations(swapped, h.rowIndex, SOURCE);
  const issues = checkSanity(bad);
  assert(
    issues.some((i) => i.severity === "error" && i.metric === "noi_underwritten"),
    "no detectó el cruce NOI/loan",
  );
});

check("detecta ocupancia fuera de rango", () => {
  // Forzamos el bug: valores ya en fracción pero > 1 tras el parseo.
  const rows = buildRows(["Property Name", "Occupancy", "UW NOI", "Original Balance", "Units"], [
    ["A", 9450, "$1,000,000", "$10,000,000", 100],
  ]);
  const h = findHeaderRow(rows, { minMatches: 3 });
  assert(h, "debería encontrar headers");
  const bad = rowsToObservations(rows, h!.rowIndex, SOURCE, { minObservationsPerRow: 2 });
  const issues = checkSanity(bad);
  assert(issues.some((i) => i.metric === "occupancy"), "no detectó la ocupancia rota");
});

check("avisa cuando falta un concepto central", () => {
  // El aviso es por CONCEPTO, no por métrica: un Annex A puede traer solo
  // ocupancia económica o solo NOI underwritten y eso no es un problema.
  const rows = buildRows(["Property Name", "City", "State", "Units", "Year Built"], [
    ["A", "X", "SC", 100, 2000],
    ["B", "Y", "AZ", 200, 2010],
  ]);
  const h = findHeaderRow(rows, { minMatches: 3 })!;
  const thin = rowsToObservations(rows, h.rowIndex, SOURCE, { minObservationsPerRow: 2 });
  const issues = checkSanity(thin);
  assert(issues.some((i) => i.metric === "NOI"), `avisos: ${issues.map((i) => i.metric).join(", ")}`);
});

check("no avisa si el concepto está cubierto por una variante", () => {
  // Solo ocupancia económica: no debería quejarse por la física.
  const rows = buildRows(
    ["Property Name", "Underwritten Economic Occupancy (%)", "UW NOI", "Original Balance"],
    [["A", "94.0%", "$1,000,000", "$11,000,000"], ["B", "91.0%", "$2,000,000", "$22,000,000"]],
  );
  const h = findHeaderRow(rows, { minMatches: 3 })!;
  const result = rowsToObservations(rows, h.rowIndex, SOURCE, { minObservationsPerRow: 3 });
  const issues = checkSanity(result);
  assert(
    !issues.some((i) => i.metric === "occupancy"),
    `avisó igual: ${issues.map((i) => i.message).join("; ")}`,
  );
});

// ---------------------------------------------------------------------------

console.log("\nSelección del filing con el Annex A");

/**
 * Filings reales observados en EDGAR (agosto 2026), de tres familias de
 * emisores distintas. Cada una nombra y describe su Annex A a su manera.
 *
 * Si aparece un emisor que rompe el mapeo, agregá su caso ACÁ antes de tocar
 * los pesos de scoreAnnexFiling.
 */
const REAL_FILINGS: Array<{
  issuer: string; form: string; documentName: string;
  documentDescription: string; sizeBytes: number; isAnnex: boolean;
}> = [
  // Wells Fargo Commercial Mortgage Trust 2025-C64 (CIK 2053102)
  { issuer: "WFCM", form: "FWP", documentName: "n4801_x5-annexa1.htm", documentDescription: "ANNEX A-1", sizeBytes: 4_088_848, isAnnex: true },
  { issuer: "WFCM", form: "FWP", documentName: "n4801_x3-annexa1.htm", documentDescription: "FWP", sizeBytes: 4_428_170, isAnnex: true },
  { issuer: "WFCM", form: "FWP", documentName: "n4801_x6-ts.htm", documentDescription: "PRELIMINARY TERM SHEET", sizeBytes: 7_982_193, isAnnex: false },
  { issuer: "WFCM", form: "FWP", documentName: "n4801_x10-ipt.htm", documentDescription: "FWP", sizeBytes: 18_056, isAnnex: false },
  { issuer: "WFCM", form: "FWP", documentName: "n4801_x19-xalaunch.htm", documentDescription: "FWP", sizeBytes: 25_911, isAnnex: false },
  { issuer: "WFCM", form: "10-D", documentName: "wcm25c64_10d-202606.htm", documentDescription: "", sizeBytes: 1_690_088, isAnnex: false },

  // Benchmark 2026-B42 Mortgage Trust (CIK 2110410)
  // Descripción genérica "FWP", y el term sheet pesa casi lo mismo.
  { issuer: "Benchmark", form: "FWP", documentName: "n5676_x3-annexa.htm", documentDescription: "FWP", sizeBytes: 8_910_695, isAnnex: true },
  { issuer: "Benchmark", form: "FWP", documentName: "n5676_x4-ts.htm", documentDescription: "FWP", sizeBytes: 6_899_495, isAnnex: false },
  { issuer: "Benchmark", form: "FWP", documentName: "n5676_x12-xafinpricdetails.htm", documentDescription: "FWP", sizeBytes: 16_009, isAnnex: false },
  { issuer: "Benchmark", form: "424H", documentName: "n5676_x5-424h.htm", documentDescription: "424H", sizeBytes: 21_777_523, isAnnex: false },

  // BANK5 2026-5YR20 (CIK 2104049)
  // Descripción "FREE WRITING PROSPECTUS" — otra grafía más.
  { issuer: "BANK5", form: "FWP", documentName: "n5543_x4-annexa1.htm", documentDescription: "FREE WRITING PROSPECTUS", sizeBytes: 15_798_735, isAnnex: true },
  { issuer: "BANK5", form: "FWP", documentName: "n5543_x5-ts.htm", documentDescription: "FWP", sizeBytes: 8_465_975, isAnnex: false },
  { issuer: "BANK5", form: "FWP", documentName: "n5543_x9-xapricingdetails.htm", documentDescription: "FWP", sizeBytes: 15_796, isAnnex: false },

  // BANK 2026-BNK52 (CIK 2138709)
  // Abrevia el anexo a "a1" sin escribir "annex". En una corrida de 100 trusts
  // este formato fue parte de los 29 que se perdieron por no reconocerlo.
  { issuer: "BNK52", form: "FWP", documentName: "n5947_x2-a1.htm", documentDescription: "FWP", sizeBytes: 3_774_325, isAnnex: true },
  { issuer: "BNK52", form: "FWP", documentName: "n5947_x3-ts.htm", documentDescription: "FWP", sizeBytes: 8_028_283, isAnnex: false },
  { issuer: "BNK52", form: "FWP", documentName: "n5947_x15-xapricing.htm", documentDescription: "FWP", sizeBytes: 16_003, isAnnex: false },
  { issuer: "BNK52", form: "424H", documentName: "n5947_x5-424h.htm", documentDescription: "424H", sizeBytes: 18_131_627, isAnnex: false },

  // Familia "anx": "annex" abreviado. Salió de diagnosticar 36 trusts fallidos.
  // Ojo con los term sheets de la misma familia: pesan MÁS que el anexo, así
  // que un umbral por tamaño los dejaría pasar y al anexo afuera.
  { issuer: "anx-a", form: "FWP", documentName: "n4501-x4_anxa.htm", documentDescription: "FREE WRITING PROSPECTUS", sizeBytes: 3_300_000, isAnnex: true },
  { issuer: "anx-a", form: "FWP", documentName: "n4501_x8-premktts.htm", documentDescription: "", sizeBytes: 5_700_000, isAnnex: false },
  { issuer: "anx-b", form: "FWP", documentName: "n4385-x4anxa1.htm", documentDescription: "FREE WRITING PROSPECTUS", sizeBytes: 2_600_000, isAnnex: true },
  { issuer: "anx-b", form: "FWP", documentName: "n4385-x5ts.htm", documentDescription: "FREE WRITING PROSPECTUS", sizeBytes: 7_400_000, isAnnex: false },
  { issuer: "anx-c", form: "FWP", documentName: "n4706-x6_anx1.htm", documentDescription: "ANNEX A-1", sizeBytes: 2_800_000, isAnnex: true },
  { issuer: "anx-c", form: "FWP", documentName: "n4706-x7_ts.htm", documentDescription: "PRELIMINARY TERM SHEET", sizeBytes: 7_900_000, isAnnex: false },
];

check("reconoce el Annex A de las tres familias de emisores", () => {
  for (const f of REAL_FILINGS.filter((x) => x.isAnnex)) {
    const score = scoreAnnexFiling(f);
    assert(score >= 0.5, `${f.issuer} "${f.documentName}" tuvo ${score.toFixed(2)}, esperaba ≥ 0.5`);
  }
});

check("ningún documento que no sea Annex A supera el umbral", () => {
  for (const f of REAL_FILINGS.filter((x) => !x.isAnnex)) {
    const score = scoreAnnexFiling(f);
    assert(score < 0.5, `${f.issuer} "${f.documentName}" tuvo ${score.toFixed(2)}, debería quedar afuera`);
  }
});

check("dentro de cada emisor, el Annex A gana", () => {
  for (const issuer of new Set(REAL_FILINGS.map((f) => f.issuer))) {
    const scored = REAL_FILINGS.filter((f) => f.issuer === issuer)
      .map((f) => ({ ...f, score: scoreAnnexFiling(f) }))
      .sort((a, b) => b.score - a.score);
    assert(scored[0]!.isAnnex, `en ${issuer} ganó "${scored[0]!.documentName}" (${scored[0]!.score.toFixed(2)})`);
  }
});

check("el term sheet no se cuela pese a pesar 6-8 MB", () => {
  // Este es el caso que rompía la heurística basada en tamaño.
  for (const f of REAL_FILINGS.filter((x) => /-ts\.htm$/.test(x.documentName))) {
    const score = scoreAnnexFiling(f);
    assert(score < 0.5, `"${f.documentName}" (${(f.sizeBytes / 1e6).toFixed(1)} MB) tuvo ${score.toFixed(2)}`);
  }
});

check("la descripción varía entre emisores y no se depende de ella", () => {
  const descriptions = new Set(REAL_FILINGS.filter((f) => f.isAnnex).map((f) => f.documentDescription));
  assert(descriptions.size >= 3, `esperaba variedad, hay: ${[...descriptions].join(" | ")}`);
  // Aun con la descripción vacía, el nombre debería alcanzar.
  const score = scoreAnnexFiling({
    form: "FWP", documentName: "n5676_x3-annexa.htm", documentDescription: "", sizeBytes: 8_910_695,
  });
  assert(score >= 0.5, `sin descripción quedó en ${score.toFixed(2)}`);
});

check("descarta formas que nunca traen Annex A", () => {
  for (const form of ["10-D", "10-K", "ABS-EE", "8-K", "ABS-15G"]) {
    eq(scoreAnnexFiling({ form, documentName: "annexa1.htm", documentDescription: "ANNEX A-1", sizeBytes: 4_000_000 }), 0, form);
  }
});

check("el prospecto sirve de respaldo cuando no hay Annex dedicado", () => {
  // 11 de 36 trusts fallidos publican el anexo dentro del prospecto en vez de
  // como filing propio. El parser es agnóstico al formato, así que vale
  // intentarlo —pero solo como respaldo: son documentos de 15-22 MB.
  assert(
    scoreProspectusFallback({ form: "424B2", documentName: "n4362_x19-424b2.htm", sizeBytes: 17_400_000 }) > 0,
    "un 424B2 grande debería servir de respaldo",
  );
  assert(
    scoreProspectusFallback({ form: "424H", documentName: "n4501_x5-424h.htm", sizeBytes: 15_700_000 }) > 0,
    "un 424H grande también",
  );
  eq(
    scoreProspectusFallback({ form: "424B2", documentName: "chico.htm", sizeBytes: 1_000_000 }),
    0,
    "un prospecto chico no trae el pool completo",
  );
  eq(
    scoreProspectusFallback({ form: "FWP", documentName: "n4385-x5ts.htm", sizeBytes: 7_400_000 }),
    0,
    "un FWP no es prospecto",
  );
});

check("el prospecto final se prefiere al preliminar", () => {
  const final = scoreProspectusFallback({ form: "424B2", documentName: "a.htm", sizeBytes: 17_000_000 });
  const preliminary = scoreProspectusFallback({ form: "424H", documentName: "b.htm", sizeBytes: 17_000_000 });
  assert(final > preliminary, `424B2 ${final} debería superar a 424H ${preliminary}`);
});

check("un nombre irreconocible NO alcanza el umbral por tamaño solo", () => {
  // Es el modo de falla conocido: si un emisor no pone "annex" en el nombre,
  // el harvester no lo encuentra y hay que inspeccionar con `filings <cik>`.
  const score = scoreAnnexFiling({
    form: "FWP", documentName: "d123456dfwp.htm", documentDescription: "", sizeBytes: 3_500_000,
  });
  assert(score < 0.5, `quedó en ${score.toFixed(2)} — el tamaño solo no debería alcanzar`);
});

// ---------------------------------------------------------------------------

console.log("\nParseo de tablas HTML");

/** HTML con la forma de un Annex A: encabezados en dos filas y colspan. */
const ANNEX_HTML = `
<html><body>
  <p>ANNEX A-1</p>
  <table>
    <tr><td colspan="3">Property Information</td><td colspan="2">Underwritten</td></tr>
    <tr><th>Property Name</th><th>City</th><th>State</th><th>NOI</th><th>Occupancy</th></tr>
    <tr><td>Riverbend Apartments</td><td>Austin</td><td>TX</td><td>$4,120,000</td><td>95.2%</td></tr>
    <tr><td>Gateway Logistics</td><td>Memphis</td><td>TN</td><td>$5,900,000</td><td>100.0%</td></tr>
  </table>
</body></html>`;

check("extrae tablas de un HTML", () => {
  const tables = extractFromHtml(ANNEX_HTML);
  eq(tables.length, 1, "cantidad de tablas");
});

check("fusiona encabezados partidos en dos filas", () => {
  const tables = extractFromHtml(ANNEX_HTML);
  const header = tables[0]!.rows[0]!.map((c) => String(c ?? ""));
  assert(
    header.some((h) => /underwritten/i.test(h) && /noi/i.test(h)),
    `no fusionó: ${JSON.stringify(header)}`,
  );
});

check("expande colspan para no correr las columnas", () => {
  const html = `<table>
    <tr><td colspan="3">Grupo</td><td>Suelta</td></tr>
    <tr><td>a</td><td>b</td><td>c</td><td>d</td></tr>
    <tr><td>1</td><td>2</td><td>3</td><td>4</td></tr>
  </table>`;
  const rows = extractFromHtml(html)[0]!.rows;
  const dataRow = rows[rows.length - 1]!;
  eq(dataRow.length, 4, "ancho de la fila de datos");
});

check("limpia &nbsp; y espacios de sobra", () => {
  const html = `<table>
    <tr><th>Property&nbsp;&nbsp;Name</th><th>  NOI  </th><th>Occupancy</th></tr>
    <tr><td>A</td><td>$1,000</td><td>90%</td></tr>
    <tr><td>B</td><td>$2,000</td><td>91%</td></tr>
  </table>`;
  const header = extractFromHtml(html)[0]!.rows[0]!.map((c) => String(c ?? ""));
  assert(header.includes("Property Name"), `no limpió: ${JSON.stringify(header)}`);
  assert(header.includes("NOI"), `no limpió NOI: ${JSON.stringify(header)}`);
});

check("no fusiona cuando la segunda fila trae datos", () => {
  const html = `<table>
    <tr><th>Property Name</th><th>NOI</th><th>Occupancy</th></tr>
    <tr><td>Riverbend</td><td>$4,120,000</td><td>95.2%</td></tr>
    <tr><td>Gateway</td><td>$5,900,000</td><td>100%</td></tr>
  </table>`;
  const rows = extractFromHtml(html)[0]!.rows;
  eq(String(rows[0]![0]), "Property Name", "fusionó de más");
  eq(rows.length, 3, "perdió filas");
});

check("ignora tablas de layout", () => {
  const html = `<table><tr><td>solo layout</td></tr></table>
                <table>
                  <tr><th>Property Name</th><th>NOI</th><th>Occupancy</th></tr>
                  <tr><td>A</td><td>$1</td><td>90%</td></tr>
                  <tr><td>B</td><td>$2</td><td>91%</td></tr>
                </table>`;
  eq(extractFromHtml(html).length, 1, "debería quedar una sola");
});

check("el HTML llega hasta observations con el pipeline sin cambios", () => {
  const tables = extractFromHtml(ANNEX_HTML);
  const h = findHeaderRow(tables[0]!.rows, { minMatches: 3 });
  assert(h, "no encontró encabezados en el HTML");

  const result = rowsToObservations(tables[0]!.rows, h!.rowIndex, SOURCE, { minObservationsPerRow: 3 });
  eq(result.stats.propertiesKept, 2, "propiedades");
  eq(result.properties[0]!.label.property_name, "Riverbend Apartments", "nombre");

  const occ = result.properties[0]!.observations.find((o) => o.metric_key === "occupancy");
  eq(occ?.value, "0.952", "ocupancia");
});

check("extractTables elige el parser por extensión", () => {
  const htmlBuf = Buffer.from(ANNEX_HTML, "utf8");
  eq(extractTables(htmlBuf, "annexa1.htm").length, 1, "html");

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]), "S1");
  const xlsxBuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  eq(extractTables(xlsxBuf, "annexa1.xlsx").length, 1, "xlsx");

  let threw = false;
  try { extractTables(Buffer.from(""), "doc.pdf"); } catch { threw = true; }
  assert(threw, "debería fallar con un formato no soportado");
});

// ---------------------------------------------------------------------------

console.log("\nRoundtrip por xlsx real");

check("lee un xlsx generado y lo cosecha de punta a punta", () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(buildRows(HEADERS_TERSE, [
    ["L1", "Aster Ridge", "900 Aster Rd", "Nashville", "TN", "37203", "Multifamily",
     2019, 288, null, "93.1%", "$3,400,000", "$3,250,000", "$52,000,000",
     "$78,000,000", "66.7%", "1.38x", "9.1%", "5.25%"],
  ]));
  XLSX.utils.book_append_sheet(wb, ws, "Annex A-1");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const parsed = XLSX.read(buf, { type: "buffer" });
  const sheet = parsed.Sheets[parsed.SheetNames[0]!]!;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });

  const h = findHeaderRow(rows);
  assert(h, "no encontró headers tras el roundtrip");

  const result = rowsToObservations(rows, h!.rowIndex, SOURCE);
  eq(result.stats.propertiesKept, 1, "propiedades");
  eq(result.properties[0]!.label.property_name, "Aster Ridge", "nombre");

  const occ = result.properties[0]!.observations.find((o) => o.metric_key === "occupancy")!;
  eq(occ.value, "0.931", "ocupancia");
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Los seis nombres del identificador de préstamo
// ---------------------------------------------------------------------------

/**
 * Las emisiones 2020-2021 nombran esta columna de seis formas distintas. Sin
 * cubrirlas, 33 emisiones y 2.919 préstamos quedaban sin identificador —se
 * cosechaban bien, pero después no pegaban contra su desempeño—.
 *
 * Los casos negativos importan más que los positivos: "Mortgage Loan Seller"
 * aparece en nueve filings y matchea /mortgage\s*loan/ perfectamente. Un patrón
 * generoso sin exclusiones guardaría el nombre del banco como identificador, que
 * es peor que no tener ninguno: el join daría cero y parecería un problema de
 * datos en vez de uno de mapeo.
 */
check("identificador: los seis nombres reales", () => {
  const positivos = [
    "Loan ID", "Loan ID Number", "Mortgage Loan Number",
    "Control Number", "Loan #", "Loan No.",
  ];
  for (const header of positivos) {
    const { matches } = mapColumns([header, "Property Name", "UW NOI", "Cut-off Date Balance"]);
    const hit = matches.find((m) => m.metric.key === "loan_id");
    assert(hit?.header === header, `"${header}" no mapeó a loan_id`);
  }
});

check("identificador: lo que NO debe llevarse", () => {
  const negativos = [
    "Mortgage Loan Seller",
    "Net Mortgage Loan Rate (%)",
    "Crossed Loan",
    "Cross Collateralized and Cross Defaulted Loan Flag",
    "Loan per Net Rentable Area (SF/Units/Rooms) $",
    "Pari Passu Companion Loan Annual Debt Service ($)",
    "Loan Purpose",
    "Original Loan Term",
    "Loan Amount",
  ];
  for (const header of negativos) {
    const { matches } = mapColumns([header, "Property Name", "City"]);
    const hit = matches.find((m) => m.metric.key === "loan_id");
    assert(!hit, `"${header}" se mapeó a loan_id y no debería`);
  }
});

/**
 * "Loan" y "Loan/Prop." son la misma columna con dos nombres, y ninguno es el
 * identificador. El primero lo mapeé mal y la suite lo bendijo: había un test
 * afirmando que "Loan" iba a loan_id. Un test puede fijar un error igual que
 * fija un acierto.
 */
check("Loan y Loan/Prop. son el flag, no el identificador", () => {
  for (const header of ["Loan/Prop.", "Loan"]) {
    const { matches } = mapColumns([header, "Property Name", "UW NOI", "City"]);
    const flag = matches.find((m) => m.metric.key === "loan_property_flag");
    const id = matches.find((m) => m.metric.key === "loan_id");
    assert(flag?.header === header, `"${header}" no mapeó al flag`);
    assert(!id, `"${header}" se lo llevó loan_id: las filas de propiedad se contarían como préstamos`);
  }
});

check("Loan/Prop. sigue yendo al flag", () => {
  const { matches } = mapColumns(["Loan/Prop.", "Property Name", "UW NOI", "City"]);
  const flag = matches.find((m) => m.metric.key === "loan_property_flag");
  const id = matches.find((m) => m.metric.key === "loan_id");
  assert(flag?.header === "Loan/Prop.", "no mapeó al flag");
  assert(!id, "se lo llevó loan_id: las filas de propiedad volverían a contarse como préstamos");
});

check("conviven identificador y flag en el mismo Annex A", () => {
  const { matches } = mapColumns([
    "Mortgage Loan Number", "Loan/Prop.", "Property Name", "UW NOI",
  ]);
  const keys = matches.map((m) => m.metric.key);
  assert(keys.includes("loan_id" as never), "falta loan_id");
  assert(keys.includes("loan_property_flag" as never), "falta loan_property_flag");
});

check("Total Debt Cut-off Date Balance tiene métrica propia", () => {
  const { matches } = mapColumns([
    "Cut-off Date Balance ($)",
    "Total Debt Cut-off Date Balance ($)",
    "Whole Loan Cut-off Date Balance ($)",
  ]);
  const byKey = new Map(matches.map((m) => [m.metric.key, m.header]));
  assert(byKey.get("loan_amount" as never) === "Cut-off Date Balance ($)", "loan_amount tomó otra");
  assert(
    byKey.get("balance_total_debt" as never) === "Total Debt Cut-off Date Balance ($)",
    "balance_total_debt no mapeó",
  );
  assert(
    byKey.get("balance_whole_loan" as never) === "Whole Loan Cut-off Date Balance ($)",
    "balance_whole_loan no mapeó",
  );
});

/**
 * El encabezado de dos columnas de las emisiones 2020.
 *
 * Fila real de Benchmark 2020-B16:
 *
 *   | Loan | ID | Property Name | ... |
 *   | Loan | 1  | Harrison Retail | ... |
 *
 * La primera es el flag y la segunda el identificador. Sin cubrir el "ID"
 * pelado, ningún bloque de esos Annex A tiene clave de unión y el join
 * horizontal colapsa 83 préstamos en 1.
 */
check("formato 2020: Loan es el flag e ID es el identificador", () => {
  const { matches } = mapColumns([
    "Loan", "ID", "Property Name", "Cut-off Date Balance($)", "Underwritten NOI($)",
  ]);
  const byKey = new Map(matches.map((m) => [m.metric.key, m.header]));
  assert(byKey.get("loan_property_flag" as never) === "Loan", "el flag no tomó 'Loan'");
  assert(byKey.get("loan_id" as never) === "ID", "el identificador no tomó 'ID'");
});

check("un ID pelado no se confunde con otras columnas", () => {
  for (const header of ["Property ID", "Loan ID Number", "Identification"]) {
    const { matches } = mapColumns([header, "ID", "Property Name", "UW NOI"]);
    const id = matches.find((m) => m.metric.key === "loan_id");
    assert(id?.header === "ID" || id?.header === "Loan ID Number",
      `con "${header}" presente, loan_id tomó ${JSON.stringify(id?.header)}`);
  }
});

/**
 * Números partidos por un espacio.
 *
 * Aparecen en Annex A reales como error de tipeo del emisor: Benchmark 2020-B16
 * publica "48 5%" donde va "48.5%". Sacar el espacio junto con las comas lo
 * convertía en 485% y lo metía al corpus como 4.85.
 */
check("un número con espacio en el medio no es un número", () => {
  for (const raw of ["13 1%", "48 5%", "1 234", "12 5", "$1 500 000"]) {
    assert(parseValue(raw, "percent") === null, `"${raw}" produjo un porcentaje`);
    assert(parseValue(raw, "currency") === null, `"${raw}" produjo un monto`);
  }
});

check("los formatos legítimos siguen andando", () => {
  assert(parseValue("13.1%", "percent") === "0.131", "13.1% se rompió");
  assert(parseValue("1,234,567", "currency") === "1234567", "los miles con coma se rompieron");
  assert(parseValue(" 65.8% ", "percent") === "0.658", "los espacios alrededor se rompieron");
  assert(parseValue("(1,234)", "currency") === "-1234", "los paréntesis se rompieron");
  assert(parseValue("1.45x", "ratio") === "1.45", "el sufijo x se rompió");
});

console.log(
  `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} ok · ${failed} fallidos\x1b[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);

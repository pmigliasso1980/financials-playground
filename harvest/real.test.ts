/**
 * Test contra la estructura REAL de un Annex A.
 *
 * Los encabezados y las filas de este archivo están copiados de un documento
 * de verdad en EDGAR:
 *
 *   Wells Fargo Commercial Mortgage Trust 2025-C64
 *   FWP · ANNEX A-1 · 2025-02-03
 *   https://www.sec.gov/Archives/edgar/data/2053102/000153949725000290/n4801_x5-annexa1.htm
 *
 * Es la referencia contra la que conviene medir cualquier cambio al mapeo. Los
 * fixtures sintéticos son más limpios que la realidad en cuatro sentidos, y
 * cada uno rompía algo:
 *
 *   1. La tabla viene partida en bloques horizontales unidos por Loan ID.
 *   2. Hay filas de préstamo y filas de propiedad mezcladas.
 *   3. Los encabezados están duplicados con matices ("NOI DSCR" vs "NCF DSCR").
 *   4. Usa NAP, NAV y "Various" como marcadores de dato ausente.
 *
 *   npm run harvest:real
 */

import { findHeaderRow, mapColumns, parseValue } from "./normalize/columnMap.js";
import {
  attachContinuationTables, classifyRow, joinAnnexTables, keepLoanRows,
  stackPagedTables, type AnnexTable,
} from "./normalize/annexStructure.js";
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

function eq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) throw new Error(`${label}: esperaba ${String(expected)}, recibí ${String(actual)}`);
}

// ---------------------------------------------------------------------------
// Bloque 1 — características del préstamo y la propiedad
// ---------------------------------------------------------------------------

const BLOCK_1_HEADERS = [
  "Loan ID Number", "Loan / Property Flag",
  "Footnotes (for Loan and Property Information)", "# of Properties",
  "Property Name", "General Property Type", "Detailed Property Type",
  "Year Built", "Year Renovated", "Number of Units", "Unit of Measure",
  "Loan Per Unit ($)", "Original Balance ($)", "Cut-off Date Balance ($)",
  "Maturity/ARD Balance ($)", "Interest Rate %", "Administrative Fee Rate %(2)",
  "Net Mortgage Rate %", "Monthly Debt Service (P&I) ($)", "Monthly Debt Service (IO) ($)",
];

const BLOCK_1_DATA: unknown[][] = [
  ["1.00", "Loan", "", 1, "TheWit Chicago", "Hospitality", "Full Service", "2009", "2019, 2023", 310, "Rooms", "261,290.32", "81,000,000", "81,000,000", "81,000,000", "7.26900%", "0.01873%", "7.25027%", "NAP", "497,472.19"],
  ["2.00", "Loan", "5", 1, "Ventana Residences", "Multifamily", "Mid Rise", "2023", "NAP", 193, "Units", "380,829.02", "73,500,000", "73,500,000", "73,500,000", "6.16600%", "0.01623%", "6.14977%", "NAP", "382,912.88"],
  ["3.00", "Loan", "6,7,8,9", 2, "Soho Grand & The Roxy Hotel", "Hospitality", "Full Service", "Various", "Various", 548, "Rooms", "371,350.36", "70,000,000", "70,000,000", "70,000,000", "5.54000%", "0.01748%", "5.52252%", "NAP", "327,655.09"],
  ["3.01", "Property", "", 1, "Soho Grand Hotel", "Hospitality", "Full Service", "1996", "2018-2021", 347, "Rooms", "", "45,059,055", "45,059,055", "45,059,055", "", "", "", "", ""],
  ["3.02", "Property", "", 1, "Roxy Hotel", "Hospitality", "Full Service", "2000", "2016", 201, "Rooms", "", "24,940,945", "24,940,945", "24,940,945", "", "", "", "", ""],
];

// ---------------------------------------------------------------------------
// Bloque 2 — datos financieros, mismas claves, otras columnas
// ---------------------------------------------------------------------------

const BLOCK_2_HEADERS = [
  "Loan ID Number", "Loan / Property Flag",
  "Footnotes (for Loan and Property Information)", "# of Properties", "Property Name",
  "Second Most Recent Description", "Third Most Recent EGI ($)",
  "Third Most Recent Expenses ($)", "Third Most Recent NOI ($)",
  "Third Most Recent NOI Date", "Third Most Recent Description",
  "Underwritten Economic Occupancy (%)", "Underwritten EGI ($)",
  "Underwritten Expenses ($)", "Underwritten Net Operating Income ($)",
  "Underwritten Replacement / FF&E Reserve ($)", "Underwritten TI / LC ($)",
  "Underwritten Net Cash Flow ($)", "Underwritten NOI DSCR (x)",
  "Underwritten NCF DSCR (x)", "Underwritten NOI Debt Yield (%)",
  "Underwritten NCF Debt Yield (%)",
];

const BLOCK_2_DATA: unknown[][] = [
  ["1.00", "Loan", "", 1, "TheWit Chicago", "T-12", "31,964,606", "22,233,345", "9,731,261", "12/31/2022", "T-12", "69.8%", "36,619,834", "25,687,567", "10,932,267", "1,429,166", "0", "9,503,101", "1.83", "1.59", "13.5%", "11.7%"],
  ["2.00", "Loan", "5", 1, "Ventana Residences", "NAV", "NAV", "NAV", "NAV", "NAV", "NAV", "95.0%", "7,923,974", "2,104,606", "5,819,367", "49,147", "12,000", "5,758,221", "1.27", "1.25", "7.9%", "7.8%"],
  ["3.00", "Loan", "6,7,8,9", 2, "Soho Grand & The Roxy Hotel", "T-12", "113,711,265", "68,750,826", "44,960,439", "12/31/2022", "T-12", "90.5%", "119,826,066", "75,169,626", "44,656,440", "4,793,043", "0", "39,863,397", "3.91", "3.49", "21.9%", "19.6%"],
  ["3.01", "Property", "", 1, "Soho Grand Hotel", "T-12", "67,875,809", "38,872,617", "29,003,193", "12/31/2022", "T-12", "91.6%", "71,231,075", "42,642,343", "28,588,732", "2,849,243", "0", "25,739,489", "", "", "", ""],
  ["3.02", "Property", "", 1, "Roxy Hotel", "T-12", "45,835,455", "29,878,209", "15,957,246", "12/31/2022", "T-12", "88.8%", "48,594,991", "32,527,283", "16,067,708", "1,943,800", "0", "14,123,909", "", "", "", ""],
];

const PREAMBLE: unknown[][] = [
  ["ANNEX A-1 — CERTAIN CHARACTERISTICS OF THE MORTGAGE LOANS AND MORTGAGED PROPERTIES"],
  [],
];

function block(headers: string[], data: unknown[][], name: string): AnnexTable {
  const rows = [...PREAMBLE, headers, ...data];
  const found = findHeaderRow(rows);
  assert(found, `no se detectaron encabezados en ${name}`);
  return { name, rows, headerRowIndex: found!.rowIndex };
}

const SOURCE: SourceRef = {
  cik: "2053102",
  accession: "0001539497-25-000290",
  companyName: "Wells Fargo Commercial Mortgage Trust 2025-C64",
  formType: "FWP",
  filedAt: "2025-02-03",
  fileName: "n4801_x5-annexa1.htm",
  fileUrl: "https://www.sec.gov/Archives/edgar/data/2053102/000153949725000290/n4801_x5-annexa1.htm",
};

// ---------------------------------------------------------------------------

console.log("\nAnnex A real — Wells Fargo 2025-C64\n");

console.log("Marcadores de dato ausente");

check("NAP, NAV y Various se leen como ausencia de dato", () => {
  for (const marker of ["NAP", "NAV", "nap", "nav", "Various", "various"]) {
    assert(parseValue(marker, "currency") === null, `"${marker}" debería ser null`);
    assert(parseValue(marker, "years") === null, `"${marker}" debería ser null`);
  }
});

check("un año compuesto como '1980-1991' no se inventa", () => {
  // Aparece cuando un préstamo cubre propiedades de distintas épocas.
  const v = parseValue("1980-1991", "years");
  assert(v === null || v === "1980", `devolvió "${v}"`);
});

// ---------------------------------------------------------------------------

console.log("\nEncabezados reales");

const headers1 = BLOCK_1_HEADERS;
const headers2 = BLOCK_2_HEADERS;

check("mapea las columnas del bloque de características", () => {
  const { matches } = mapColumns(headers1);
  const keys = new Set(matches.map((m) => m.metric.key));
  for (const expected of ["loan_id", "loan_property_flag", "property_name", "property_type", "property_type_detailed", "year_built", "year_renovated", "units", "unit_of_measure", "loan_amount", "interest_rate"]) {
    assert(keys.has(expected as never), `falta ${expected} · mapeadas: ${[...keys].join(", ")}`);
  }
});

check("mapea las columnas del bloque financiero", () => {
  const { matches } = mapColumns(headers2);
  const keys = new Set(matches.map((m) => m.metric.key));
  for (const expected of ["occupancy_economic", "noi_underwritten", "net_cash_flow", "dscr", "dscr_ncf", "debt_yield", "debt_yield_ncf"]) {
    assert(keys.has(expected as never), `falta ${expected} · mapeadas: ${[...keys].join(", ")}`);
  }
});

check("cada añada de NOI va a su propia métrica", () => {
  /**
   * Encontrado corriendo el Index sobre datos reales: el fact "Net Operating
   * Income" de TheWit Chicago devolvía $9.731.261, que es el NOI de hace TRES
   * períodos. El patrón genérico /most recent.*noi/ matchea "Third Most
   * Recent NOI" y se quedaba con la columna más vieja.
   *
   * Para un analista es peor que un dato faltante: un número plausible,
   * correctamente extraído, con la etiqueta equivocada.
   */
  const vintages = [
    "Property Name",
    "Third Most Recent NOI ($)",
    "Second Most Recent NOI ($)",
    "Most Recent NOI ($)",
    "Underwritten Net Operating Income ($)",
  ];
  const { matches } = mapColumns(vintages);

  const byKey = new Map(matches.map((m) => [m.metric.key, m.header]));
  assert(/third/i.test(byKey.get("noi_third_most_recent") ?? ""), `third → "${byKey.get("noi_third_most_recent")}"`);
  assert(/second/i.test(byKey.get("noi_second_most_recent") ?? ""), `second → "${byKey.get("noi_second_most_recent")}"`);
  assert(
    /^most recent/i.test((byKey.get("noi_most_recent") ?? "").trim()),
    `most recent → "${byKey.get("noi_most_recent")}"`,
  );
  assert(/underwritten/i.test(byKey.get("noi_underwritten") ?? ""), `uw → "${byKey.get("noi_underwritten")}"`);
});

check("las añadas de EGI y gastos también se separan", () => {
  /**
   * Las ocho columnas, en el orden en que las trae el Annex A conduit.
   *
   * La versión anterior pasaba solo cuatro —third y underwritten de cada
   * familia— porque con la taxonomía vieja no había más claves donde ponerlas.
   * Con ocho claves hay que dar las ocho columnas: si se afirma sobre una que
   * no está en la entrada, el test falla por ausencia y no por mapeo.
   */
  const { matches } = mapColumns([
    "Most Recent EGI ($)", "Second Most Recent EGI ($)",
    "Third Most Recent EGI ($)", "Underwritten EGI ($)",
    "Most Recent Expenses ($)", "Second Most Recent Expenses ($)",
    "Third Most Recent Expenses ($)", "Underwritten Expenses ($)",
  ]);
  const byKey = new Map(matches.map((m) => [m.metric.key, m.header]));

  /**
   * Una clave por columna. La versión anterior afirmaba esto mismo con cuatro
   * claves para ocho columnas, y pasaba por el orden del fixture: los pares
   * empataban en el puntaje y el desempate era posicional. Con las claves
   * separadas, si el mapeo se rompe la afirmación falla.
   */
  assert(/underwritten/i.test(byKey.get("egi_underwritten") ?? ""), "EGI underwritten");
  assert(/most recent/i.test(byKey.get("egi_most_recent") ?? ""), "EGI most recent");
  assert(/second/i.test(byKey.get("egi_second_most_recent") ?? ""), "EGI second most recent");
  assert(/third/i.test(byKey.get("egi_third_most_recent") ?? ""), "EGI third most recent");
  assert(/underwritten/i.test(byKey.get("expenses_underwritten") ?? ""), "gastos underwritten");
  assert(/most recent/i.test(byKey.get("expenses_most_recent") ?? ""), "gastos most recent");
  assert(/second/i.test(byKey.get("expenses_second_most_recent") ?? ""), "gastos second most recent");
  assert(/third/i.test(byKey.get("expenses_third_most_recent") ?? ""), "gastos third most recent");
});

check("las estructuras de deuda no se confunden entre sí", () => {
  /**
   * Encontrado en el corpus persistido: `ltv` tenía 25% de cobertura. El valor
   * era correcto pero de otra métrica — habíamos mapeado "Whole Loan Cut-off
   * Date LTV", que solo existe para préstamos partidos en notas pari passu.
   *
   * No es un matiz: el whole loan incluye los pedazos que quedaron en otros
   * trusts, y el total debt suma mezzanine. Son denominadores distintos, así
   * que el mismo préstamo puede tener 60% de whole loan LTV y 45% del trust.
   */
  const headers = [
    "Cut-off Date LTV Ratio (%)",
    "Whole Loan Cut-off Date LTV Ratio (%)",
    "Total Debt Cut-off Date LTV Ratio (%)",
    "LTV Ratio at Maturity / ARD (%)",
  ];
  const { matches, unmapped } = mapColumns(headers);
  const byKey = new Map(matches.map((m) => [m.metric.key, m.header]));

  eq(byKey.get("ltv"), "Cut-off Date LTV Ratio (%)", "LTV del trust");
  eq(byKey.get("ltv_whole_loan"), "Whole Loan Cut-off Date LTV Ratio (%)", "whole loan");
  eq(byKey.get("ltv_total_debt"), "Total Debt Cut-off Date LTV Ratio (%)", "total debt");
  eq(byKey.get("ltv_maturity"), "LTV Ratio at Maturity / ARD (%)", "al vencimiento");
  eq(unmapped.length, 0, `quedaron sin mapear: ${unmapped.map((u) => u.header).join(", ")}`);
});

check("DSCR y debt yield tampoco se cruzan entre estructuras", () => {
  const { matches } = mapColumns([
    "Underwritten NOI DSCR (x)",
    "Underwritten NCF DSCR (x)",
    "Whole Loan Underwritten NCF DSCR (x)",
    "Total Debt Underwritten NCF DSCR (x)",
    "Underwritten NOI Debt Yield (%)",
    "Whole Loan Underwritten NOI Debt Yield (%)",
  ]);
  const byKey = new Map(matches.map((m) => [m.metric.key, m.header]));

  assert(!/whole|total/i.test(byKey.get("dscr") ?? ""), `dscr tomó "${byKey.get("dscr")}"`);
  assert(!/whole|total/i.test(byKey.get("dscr_ncf") ?? ""), `dscr_ncf tomó "${byKey.get("dscr_ncf")}"`);
  assert(!/whole|total/i.test(byKey.get("debt_yield") ?? ""), `debt_yield tomó "${byKey.get("debt_yield")}"`);
  assert(byKey.has("dscr_whole_loan"), "no capturó el DSCR de whole loan");
  assert(byKey.has("debt_yield_whole_loan"), "no capturó el debt yield de whole loan");
});

check("el NOI real no se lo roba el DSCR ni el debt yield", () => {
  // El bug que encontró este test: "Underwritten NOI DSCR (x)" contiene
  // "Underwritten" y "NOI", así que matcheaba noi_underwritten con puntaje
  // máximo y dejaba huérfana a "Underwritten Net Operating Income ($)".
  const { matches } = mapColumns(headers2);
  const noi = matches.find((m) => m.metric.key === "noi_underwritten");
  assert(noi, "noi_underwritten no se mapeó");
  assert(
    /net operating income/i.test(noi!.header),
    `noi_underwritten tomó "${noi!.header}"`,
  );
});

check("NOI DSCR y NCF DSCR no se confunden", () => {
  const { matches } = mapColumns(headers2);
  const noi = matches.find((m) => m.metric.key === "dscr");
  const ncf = matches.find((m) => m.metric.key === "dscr_ncf");
  assert(noi && ncf, "faltó alguno de los dos");
  assert(/noi/i.test(noi!.header), `dscr tomó "${noi!.header}"`);
  assert(/ncf/i.test(ncf!.header), `dscr_ncf tomó "${ncf!.header}"`);
});

check("NOI Debt Yield y NCF Debt Yield no se confunden", () => {
  const { matches } = mapColumns(headers2);
  const noi = matches.find((m) => m.metric.key === "debt_yield");
  const ncf = matches.find((m) => m.metric.key === "debt_yield_ncf");
  assert(noi && ncf, "faltó alguno de los dos");
  assert(/noi/i.test(noi!.header), `debt_yield tomó "${noi!.header}"`);
  assert(/ncf/i.test(ncf!.header), `debt_yield_ncf tomó "${ncf!.header}"`);
});

check("la ocupancia económica se mapea a su propia métrica", () => {
  // Este Annex solo publica ocupancia económica. Antes la exclusión /economic/
  // de `occupancy` la descartaba y quedábamos sin ninguna ocupancia.
  const { matches } = mapColumns(headers2);
  const eco = matches.find((m) => m.metric.key === "occupancy_economic");
  assert(eco, "no mapeó la ocupancia económica");
  assert(/economic/i.test(eco!.header), `tomó "${eco!.header}"`);
});

check("ocupancia física y económica no se pisan cuando están las dos", () => {
  const { matches } = mapColumns(["Physical Occupancy (%)", "Underwritten Economic Occupancy (%)"]);
  const phys = matches.find((m) => m.metric.key === "occupancy");
  const eco = matches.find((m) => m.metric.key === "occupancy_economic");
  assert(phys && eco, "faltó alguna de las dos");
  assert(phys!.columnIndex !== eco!.columnIndex, "cayeron en la misma columna");
});

check("'Unit of Measure' no se roba la columna de conteo de unidades", () => {
  const { matches } = mapColumns(headers1);
  const units = matches.find((m) => m.metric.key === "units");
  const measure = matches.find((m) => m.metric.key === "unit_of_measure");
  assert(units, "units no se mapeó");
  assert(measure, "unit_of_measure no se mapeó");
  assert(/number of units/i.test(units!.header), `units tomó "${units!.header}"`);
  assert(/measure/i.test(measure!.header), `unit_of_measure tomó "${measure!.header}"`);
});

check("'Loan Per Unit ($)' no se confunde con Loan Amount", () => {
  const { matches } = mapColumns(headers1);
  const loan = matches.find((m) => m.metric.key === "loan_amount");
  assert(loan, "no mapeó loan_amount");
  assert(
    !/per\s*unit/i.test(loan!.header),
    `loan_amount tomó "${loan!.header}", que es un valor por unidad`,
  );
});

// ---------------------------------------------------------------------------

console.log("\nFilas de préstamo vs. de propiedad");

check("classifyRow distingue los dos tipos", () => {
  eq(classifyRow("Loan"), "loan", "Loan");
  eq(classifyRow("Property"), "property", "Property");
  eq(classifyRow(""), "unknown", "vacío");
});

const t1 = block(headers1, BLOCK_1_DATA, "block-1");

check("descarta las filas de propiedad y conserva los préstamos", () => {
  const filtered = keepLoanRows(t1.rows, t1.headerRowIndex);
  assert(filtered.hadFlagColumn, "no detectó la columna de flag");
  eq(filtered.loanRows, 3, "préstamos");
  eq(filtered.propertyRows, 2, "filas de propiedad descartadas");
});

check("sin columna de flag, el Loan ID distingue préstamos de propiedades", () => {
  /**
   * La columna de flag solo aparece en el 79% de los filings. Sin este
   * respaldo, en el 21% restante cada propiedad de un portfolio entraba como
   * préstamo: BANK5 2026-5YR23 figuraba con 173 préstamos teniendo 33.
   *
   * El delator fue aritmético: 173 IDs distintos con máximo 33.
   */
  const noFlag = headers1.filter((h) => !/flag/i.test(h));
  const data = BLOCK_1_DATA.map((r) => r.filter((_, i) => i !== 1));
  const table = block(noFlag, data, "sin-flag");
  const filtered = keepLoanRows(table.rows, table.headerRowIndex);

  // Los datos traen 1.00, 2.00, 3.00 (préstamos) y 3.01, 3.02 (propiedades).
  eq(filtered.loanRows, 3, "préstamos");
  eq(filtered.propertyRows, 2, "filas de propiedad descartadas");
});

check("con IDs enteros no descarta nada", () => {
  // Los filings que numeran 1, 2, 3 no tienen filas de propiedad separadas.
  const noFlag = headers1.filter((h) => !/flag/i.test(h));
  const data = BLOCK_1_DATA.slice(0, 3).map((r, i) => {
    const row = r.filter((_, j) => j !== 1);
    row[0] = String(i + 1);
    return row;
  });
  const table = block(noFlag, data, "ids-enteros");
  const filtered = keepLoanRows(table.rows, table.headerRowIndex);
  eq(filtered.loanRows, 3, "debería conservar los tres");
  eq(filtered.propertyRows, 0, "no hay filas de propiedad");
});

check("descarta la fila que numera las columnas", () => {
  /**
   * El caso real: en el Annex A conduit la primera fila después del encabezado
   * numera las columnas (1, 2, 3...) y entraba como préstamo. Aparecían 7 en la
   * cohorte 2026, con property_type = "2" — el número de columna leído como tipo.
   *
   * No se puede filtrar por cantidad de observations: tenían exactamente 3, y
   * sobre las 9.751 filas del corpus la distribución es continua desde 3. Un
   * préstamo tiene nombre o tiene saldo; esta fila no tiene ninguno.
   */
  /**
   * La fila se construye con la forma REAL, no con una plausible.
   *
   * La primera versión de este test ponía un número en cada columna, así que la
   * fila tenía valor en "Property Name" y el filtro —correctamente— no la
   * descartaba. Las 5 fantasma que se encontraron en el corpus tienen el nombre
   * vacío, el conteo nulo y la unidad nula: el único valor que sobrevive es el
   * número de columna en la posición del tipo de propiedad.
   *
   * El test fallaba por estar mal escrito, no por el filtro. Vale como
   * recordatorio de que un caso inventado "parecido" no prueba lo mismo que el
   * caso observado.
   */
  /**
   * La fila numeradora REAL: un número en cada columna, no celdas vacías.
   *
   * Esta era la primera versión del test. Falló, y en vez de arreglar el filtro
   * cambié el test a celdas vacías para que pasara — con el resultado de que las
   * dos filas de BMO 2026-5C15 sobrevivieron a una recosecha completa. Vuelve a
   * la forma real, que es la que el filtro tiene que aguantar.
   */
  const numeradora = headers1.map((_, i) => String(i + 1));

  /**
   * Y hacen falta suficientes filas reales para no chocar con la guarda del 15%.
   * Con 3 préstamos, descartar 1 es el 25% y el filtro se abstiene — que es el
   * comportamiento correcto y hacía fallar el test por otra razón.
   */
  const prestamos = BLOCK_1_DATA.filter((r) => r[1] === "Loan");
  const muchos = [numeradora, ...prestamos, ...prestamos, ...prestamos, ...prestamos];
  const table = block(headers1, muchos, "con-numeradora");
  const filtered = keepLoanRows(table.rows, table.headerRowIndex);

  eq(filtered.phantomRows, 1, "la fila numeradora");
  eq(filtered.loanRows, 12, "los 12 préstamos reales quedan");
  assert(
    !filtered.rows.slice(table.headerRowIndex + 1).some((r) => r === numeradora),
    "la numeradora no debería quedar entre los datos",
  );
});

check("con pocas filas la guarda gana sobre el filtro", () => {
  /**
   * El mismo caso con 3 préstamos en vez de 12: descartar 1 sería el 25% y el
   * filtro se abstiene. Preferimos una fila fantasma de más a borrar un cuarto
   * de un pool chico por una hipótesis sobre dos columnas.
   */
  const numeradora = headers1.map((_, i) => String(i + 1));
  const prestamos = BLOCK_1_DATA.filter((r) => r[1] === "Loan");
  const table = block(headers1, [numeradora, ...prestamos], "pocas-filas");
  const filtered = keepLoanRows(table.rows, table.headerRowIndex);
  eq(filtered.phantomRows, 0, "debería abstenerse con 1 de 4");
});

check("se abstiene si tendría que descartar demasiadas filas", () => {
  /**
   * La guarda que importa: si el filtro quiere borrar más del 15% de las filas,
   * lo más probable es que las columnas de nombre y saldo no estén donde creemos
   * —no que el 20% del pool sean fantasmas—. Borrar medio Annex A en silencio es
   * peor que dejar entrar unas filas de más.
   */
  const vacias = BLOCK_1_DATA.map((r) => r.map(() => ""));
  const table = block(headers1, vacias, "todas-vacias");
  const filtered = keepLoanRows(table.rows, table.headerRowIndex);
  eq(filtered.phantomRows, 0, "debería abstenerse, no vaciar la tabla");
});

check("sin flag ni Loan ID conserva todo", () => {
  // Preferimos datos de más a datos silenciosamente perdidos.
  const headers = headers1.filter((h) => !/flag/i.test(h) && !/loan id/i.test(h));
  const data = BLOCK_1_DATA.map((r) => r.filter((_, i) => i !== 0 && i !== 1));
  const table = block(headers, data, "sin-nada");
  const filtered = keepLoanRows(table.rows, table.headerRowIndex);
  eq(filtered.loanRows, 5, "debería conservar todas");
  eq(filtered.propertyRows, 0, "sin forma de distinguir");
});

// ---------------------------------------------------------------------------

console.log("\nUnión de bloques horizontales");

const t2 = block(headers2, BLOCK_2_DATA, "block-2");
const joined = joinAnnexTables([t1, t2]);

check("une los dos bloques por Loan ID", () => {
  assert(joined, "no devolvió nada");
  eq(joined!.tablesJoined, 2, "tablas unidas");
});

check("la unión conserva las columnas de ambos bloques", () => {
  const { matches } = mapColumns(joined!.rows[joined!.headerRowIndex]!.map((c) => String(c ?? "")));
  const keys = new Set(matches.map((m) => m.metric.key));
  // Del bloque 1
  assert(keys.has("units"), "perdió units");
  assert(keys.has("interest_rate"), "perdió interest_rate");
  // Del bloque 2
  assert(keys.has("noi_underwritten"), "perdió noi_underwritten");
  assert(keys.has("dscr_ncf"), "perdió dscr_ncf");
});

check("no duplica las columnas clave repetidas entre bloques", () => {
  const headers = joined!.rows[joined!.headerRowIndex]!.map((c) => String(c ?? "").trim().toLowerCase());
  const nonEmpty = headers.filter(Boolean);
  eq(new Set(nonEmpty).size, nonEmpty.length, `duplicados: ${nonEmpty.filter((h, i) => nonEmpty.indexOf(h) !== i).join(", ")}`);
});

check("los datos quedan alineados con su préstamo", () => {
  const headers = joined!.rows[joined!.headerRowIndex]!.map((c) => String(c ?? ""));
  const { matches } = mapColumns(headers);
  const nameCol = matches.find((m) => m.metric.key === "property_name")!.columnIndex;
  const noiCol = matches.find((m) => m.metric.key === "noi_underwritten")!.columnIndex;

  const dataRows = joined!.rows.slice(joined!.headerRowIndex + 1);
  const theWit = dataRows.find((r) => String(r[nameCol]).includes("TheWit"));
  assert(theWit, "no encontró TheWit Chicago");
  // Su NOI underwritten en el documento real es 10.932.267
  eq(String(theWit![noiCol]), "10,932,267", "NOI de TheWit");
});

check("apila las páginas del mismo bloque en vez de cruzarlas", () => {
  // Caso real: un Annex A trae una tabla POR PÁGINA, no por bloque de columnas.
  // Wells Fargo 2025-C64 tiene 126 tablas. Si cada página se toma como bloque
  // distinto, la unión por Loan ID deja solo los préstamos que aparecen en la
  // primera página de todos — en la primera corrida real, 7 de un pool entero.
  const page1 = block(headers1, BLOCK_1_DATA.slice(0, 2), "b1-p1");
  const page2 = block(headers1, [
    ["4.00", "Loan", "", 1, "Cuarto Préstamo", "Retail", "Strip", "1999", "NAP", 42, "Units", "150,000.00", "6,300,000", "6,300,000", "6,300,000", "6.50000%", "0.01800%", "6.48200%", "NAP", "39,800.00"],
  ], "b1-p2");

  const { tables: stacked, groups } = stackPagedTables([page1, page2]);
  eq(groups, 1, "debería quedar un solo bloque lógico");
  const data = stacked[0]!.rows.slice(stacked[0]!.headerRowIndex + 1);
  eq(data.length, 3, "filas apiladas");
});

check("no apila bloques con encabezados distintos", () => {
  const { groups } = stackPagedTables([t1, t2]);
  eq(groups, 2, "son bloques de columnas distintos, no páginas");
});

check("apilar y unir se combinan bien", () => {
  // Dos bloques, cada uno partido en dos páginas.
  const b1p1 = block(headers1, BLOCK_1_DATA.slice(0, 3), "b1-p1");
  const b1p2 = block(headers1, BLOCK_1_DATA.slice(3), "b1-p2");
  const b2p1 = block(headers2, BLOCK_2_DATA.slice(0, 3), "b2-p1");
  const b2p2 = block(headers2, BLOCK_2_DATA.slice(3), "b2-p2");

  const result = joinAnnexTables([b1p1, b1p2, b2p1, b2p2]);
  assert(result, "no devolvió nada");
  eq(result!.stackedGroups, 2, "grupos tras apilar");
  eq(result!.tablesJoined, 2, "bloques unidos");

  const headers = result!.rows[result!.headerRowIndex]!.map((c) => String(c ?? ""));
  const { matches } = mapColumns(headers);
  const keys = new Set(matches.map((m) => m.metric.key));
  assert(keys.has("units") && keys.has("noi_underwritten"), "perdió columnas al combinar");

  const dataRows = result!.rows.slice(result!.headerRowIndex + 1);
  eq(dataRows.length, 5, "debería tener las 5 filas del bloque");
});

check("adopta las páginas de continuación sin encabezado", () => {
  // Caso real: de las 126 tablas del Annex A de Wells Fargo, solo 18 traen
  // encabezados. Las otras 108 son continuaciones —páginas siguientes del
  // mismo bloque— y descartarlas dejaba 7 préstamos de un pool entero.
  const headed = block(headers1, BLOCK_1_DATA.slice(0, 2), "pagina-1");
  const continuation = {
    name: "pagina-2",
    rows: [
      ["4.00", "Loan", "", 1, "Cuarto", "Retail", "Strip", "1999", "NAP", 42, "Units", "150,000.00", "6,300,000", "6,300,000", "6,300,000", "6.50000%", "0.01800%", "6.48200%", "NAP", "39,800.00"],
      ["5.00", "Loan", "", 1, "Quinto", "Office", "Class B", "1988", "2015", 0, "SF", "210.00", "8,100,000", "8,100,000", "8,100,000", "6.90000%", "0.01800%", "6.88200%", "NAP", "51,200.00"],
    ],
  };

  const { tables: adoptedTables, adopted, orphans } = attachContinuationTables(
    [{ name: headed.name, rows: headed.rows }, continuation],
    (rows) => findHeaderRow(rows),
  );

  eq(adoptedTables.length, 1, "debería quedar un solo bloque");
  eq(adopted, 1, "continuaciones adoptadas");
  eq(orphans, 0, "huérfanas");

  const data = adoptedTables[0]!.rows.slice(adoptedTables[0]!.headerRowIndex + 1);
  eq(data.length, 4, "filas totales tras adoptar");
});

check("no adopta una tabla con otra cantidad de columnas", () => {
  // Adoptar el bloque equivocado desalinea todos los datos: peor que perderlos.
  const headed = block(headers1, BLOCK_1_DATA.slice(0, 2), "bloque");
  const ajena = { name: "otra-cosa", rows: [["a", "b"], ["c", "d"]] };

  const { adopted, orphans } = attachContinuationTables(
    [{ name: headed.name, rows: headed.rows }, ajena],
    (rows) => findHeaderRow(rows),
  );

  eq(adopted, 0, "no debería adoptar");
  eq(orphans, 1, "debería quedar huérfana");
});

check("Number of Units + Unit of Measure = SF se guarda como superficie", () => {
  // El Annex usa una sola columna de conteo; Unit of Measure dice qué se cuenta.
  // Un galpón con 425.000 "unidades" son metros cuadrados.
  const rows = [
    ["Property Name", "Number of Units", "Unit of Measure", "UW NOI", "Original Balance"],
    ["Galpón Memphis", "425,000", "SF", "$5,900,000", "$72,000,000"],
    ["Hotel Chicago", "310", "Rooms", "$10,932,267", "$81,000,000"],
  ];
  const h = findHeaderRow(rows, { minMatches: 3 })!;
  const res = rowsToObservations(rows, h.rowIndex, SOURCE, { minObservationsPerRow: 3 });

  const galpon = res.properties.find((p) => p.label.property_name?.includes("Galpón"))!;
  const hotel = res.properties.find((p) => p.label.property_name?.includes("Hotel"))!;

  eq(galpon.observations.find((o) => o.metric_key === "square_feet")?.value, "425000", "superficie del galpón");
  assert(
    !galpon.observations.some((o) => o.metric_key === "units"),
    "el galpón no debería tener units",
  );
  eq(hotel.observations.find((o) => o.metric_key === "units")?.value, "310", "habitaciones del hotel");
});

check("con columna de superficie propia, el conteo en SF se descarta", () => {
  // Caso real de Wells Fargo: el Annex trae `Number of Units` + `Unit of
  // Measure` Y ADEMÁS columnas de superficie dedicadas. Para una propiedad
  // medida en SF, el valor de `Number of Units` no es un conteo de unidades y
  // guardarlo como tal contamina cualquier comparación entre activos.
  const rows = [
    ["Property Name", "Number of Units", "Unit of Measure", "Net Rentable Area (SF)", "UW NOI", "Original Balance"],
    ["Galpón", "425,000", "SF", "425,000", "$5,900,000", "$72,000,000"],
    ["Torre", "180", "Units", "", "$3,100,000", "$38,000,000"],
  ];
  const h = findHeaderRow(rows, { minMatches: 3 })!;
  const res = rowsToObservations(rows, h.rowIndex, SOURCE, { minObservationsPerRow: 3 });

  const galpon = res.properties.find((p) => p.label.property_name === "Galpón")!;
  assert(
    !galpon.observations.some((o) => o.metric_key === "units"),
    "425.000 no son unidades: debería descartarse",
  );
  eq(galpon.observations.find((o) => o.metric_key === "square_feet")?.value, "425000", "superficie");

  const torre = res.properties.find((p) => p.label.property_name === "Torre")!;
  eq(torre.observations.find((o) => o.metric_key === "units")?.value, "180", "unidades reales intactas");
});

check("sin Loan ID común devuelve la mejor tabla sola", () => {
  const noId1 = block(headers1.slice(1), BLOCK_1_DATA.map((r) => r.slice(1)), "sin-id-1");
  const noId2 = block(headers2.slice(1), BLOCK_2_DATA.map((r) => r.slice(1)), "sin-id-2");
  const result = joinAnnexTables([noId1, noId2]);
  assert(result, "no devolvió nada");
  eq(result!.tablesJoined, 1, "no debería haber unido");
});

// ---------------------------------------------------------------------------

console.log("\nPipeline completo sobre datos reales");

const filtered = keepLoanRows(joined!.rows, joined!.headerRowIndex);
const result = rowsToObservations(filtered.rows, joined!.headerRowIndex, SOURCE);

check("produce un deal por préstamo, no por fila", () => {
  eq(result.stats.propertiesKept, 3, "préstamos");
});

check("los valores reales se parsean bien", () => {
  const theWit = result.properties.find((p) => p.label.property_name?.includes("TheWit"));
  assert(theWit, "no encontró TheWit");

  const get = (key: string) => theWit!.observations.find((o) => o.metric_key === key)?.value;

  eq(get("noi_underwritten"), "10932267", "NOI underwritten");
  eq(get("occupancy_economic"), "0.698", "ocupancia económica");
  eq(get("dscr"), "1.83", "NOI DSCR");
  eq(get("dscr_ncf"), "1.59", "NCF DSCR");
  eq(get("debt_yield"), "0.135", "NOI debt yield");
  eq(get("units"), "310", "habitaciones");
  eq(get("unit_of_measure"), "Rooms", "unidad de medida");
});

check("las filas con NAV no generan observations falsas", () => {
  const ventana = result.properties.find((p) => p.label.property_name?.includes("Ventana"));
  assert(ventana, "no encontró Ventana Residences");
  // Todo su histórico es NAV; solo debería tener los datos underwritten.
  const hasNav = ventana!.observations.some((o) => /^(nav|nap)$/i.test(o.value));
  assert(!hasNav, "se coló un NAV como valor");
  eq(ventana!.observations.find((o) => o.metric_key === "noi_underwritten")?.value, "5819367", "NOI");
});

check("un hotel de 548 habitaciones no se guarda como 548 unidades", () => {
  const soho = result.properties.find((p) => p.label.property_name?.includes("Soho"));
  assert(soho, "no encontró Soho Grand");
  const measure = soho!.observations.find((o) => o.metric_key === "unit_of_measure")?.value;
  eq(measure, "Rooms", "unidad de medida");
});

check("los chequeos de sanidad pasan sobre datos reales", () => {
  const issues = checkSanity(result);
  const errors = issues.filter((i) => i.severity === "error");
  assert(errors.length === 0, errors.map((e) => `[${e.metric}] ${e.message}`).join("; "));
});

// ---------------------------------------------------------------------------

console.log(
  `\n  columnas mapeadas: ${result.columnsMapped.length}` +
    `\n  sin mapear: ${result.columnsUnmapped.length ? result.columnsUnmapped.join(" | ") : "(ninguna)"}`,
);

console.log(
  `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} ok · ${failed} fallidos\x1b[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);

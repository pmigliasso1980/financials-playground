/**
 * Tests del parser del informe del servicer.
 *
 *   npx tsx harvest/servicer.test.ts
 *
 * El HTML de acá reproduce la estructura real observada en el EX-99.1 de
 * Benchmark 2024-V7 (10-D de julio 2026), incluidas las cuatro trampas:
 * encabezado partido en tres filas y no al principio de la tabla, períodos de
 * NOI de distinta longitud, filas no reportadas como "0.00" con fechas "--", y
 * tramos pari passu repitiendo el NOI de la misma propiedad.
 *
 * Los números salen del documento real. Si el parser los devuelve, sabemos que
 * lee lo que se ve, no lo que asumimos.
 */

import {
  mergeServicerReports,
  parseServicerReport,
  parseMoney,
  parseShortDate,
  MIN_PERIOD_DAYS,
} from "./parse/servicerReport.js";
import { normalizeProsId, hasTrancheSuffix, scoreServicerExhibit } from "./edgar/servicer.js";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${label}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function ok(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${label}${detail ? `\n    ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture: estructura real del informe
// ---------------------------------------------------------------------------

/**
 * Cada página del informe es una `<table>` propia que contiene título de
 * sección, filas en blanco, encabezado en tres niveles, datos y pie de página.
 * El encabezado NO está en la fila 0 — por eso el parser se ancla en "Pros ID".
 */
function page(dataRows: string[][], pageNo: number): string {
  const cells = (values: string[], tag = "td") =>
    `<tr>${values.map((v) => `<${tag}>${v}</${tag}>`).join("")}</tr>`;

  return `
<table>
  ${cells(["", "", "", "", "", "Mortgage Loan Detail (Part 2)", "", ""])}
  ${cells(["", "", "", "", "", "", "", ""])}
  ${cells(["", "", "", "Most Recent Most Recent Appraisal", "", "", "", ""])}
  ${cells(["", "Most Recent", "Most Recent", "NOI Start", "NOI End", "Reduction", "Appraisal", "Cumulative"])}
  ${cells(["Pros ID", "Fiscal NOI", "NOI", "Date", "Date", "Date", "Reduction Amount", "ASER"])}
  ${dataRows.map((r) => cells(r)).join("\n  ")}
  ${cells(["&#169; 2021 Computershare. All rights reserved. Confidential.", "", "", "", "", "", "", `Page ${pageNo} of 27`])}
</table>`;
}

const REPORT_HTML = `
<html><body>
${page(
  [
    // Tres tramos del mismo préstamo, mismo NOI de propiedad, período trimestral.
    ["1A-1", "21,466,533.53", "6,590,191.56", "01/01/26", "03/31/26", "--", "0.00", "0.00"],
    ["1A-4", "21,466,533.53", "6,590,191.56", "01/01/26", "03/31/26", "--", "0.00", "0.00"],
    ["1A-5", "21,466,533.53", "6,590,191.56", "01/01/26", "03/31/26", "--", "0.00", "0.00"],
    ["2A-1-1", "19,947,724.67", "2,876,344.33", "01/01/26", "03/31/26", "--", "0.00", "0.00"],
    // No reportado: número cero con fechas vacías. NO es NOI de cero.
    ["3A-1", "8,195,455.96", "0.00", "--", "--", "--", "0.00", "0.00"],
    // Período de doce meses: no hay que extrapolar nada.
    ["4A-2", "12,379,213.40", "12,854,060.24", "04/01/25", "03/31/26", "--", "0.00", "0.00"],
    ["4A-3", "12,379,213.40", "12,854,060.24", "04/01/25", "03/31/26", "--", "0.00", "0.00"],
    ["5", "5,065,434.64", "0.00", "--", "--", "--", "0.00", "0.00"],
  ],
  15,
)}
${page(
  [
    ["14A-3-C1", "85,517,191.01", "22,662,585.88", "01/01/26", "03/31/26", "--", "0.00", "0.00"],
    ["14A-3-C2", "85,517,191.01", "22,662,585.88", "01/01/26", "03/31/26", "--", "0.00", "0.00"],
    ["20A-1-3", "10,184,366.28", "2,454,958.65", "01/01/26", "03/31/26", "--", "0.00", "0.00"],
    ["27", "269,522.32", "0.00", "--", "--", "--", "0.00", "0.00"],
    ["Totals", "438,091,454.19", "128,346,856.64", "", "", "", "0.00", "0.00"],
  ],
  16,
)}
</body></html>`;

// ---------------------------------------------------------------------------

console.log("\nParser del informe del servicer\n");

const result = parseServicerReport(REPORT_HTML);

// --- ubicación de la tabla ---------------------------------------------------

check("encuentra las dos páginas de la tabla", result.diagnostics.tablesMatched, 2);
// 13 filas en el fixture, menos la de Totals que es pie de página.
check("lee las filas de datos y descarta el Totals", result.diagnostics.rowsFound, 12);

// --- la trampa del cero sin fechas ------------------------------------------

check("descarta los no reportados por falta de fechas", result.diagnostics.droppedNoDates, 3);

const notReported = result.rows.find((r) => r.prosId === "3A-1");
ok("un 0.00 sin fechas no produce NOI", notReported?.annualizedNoi === null);
ok("pero conserva el valor crudo para trazabilidad", notReported?.recentNoi === 0);

const zeroInLoans = result.loans.some((l) => l.annualizedNoi === 0);
ok("ningún préstamo entra con NOI cero", !zeroInLoans);

// --- la trampa de la anualización -------------------------------------------

const quarterly = result.rows.find((r) => r.prosId === "1A-1")!;
check("mide el período trimestral en días", quarterly.periodDays, 90);
ok("marca que no es año completo", quarterly.isFullYear === false);
ok(
  "anualiza el trimestre",
  Math.abs(quarterly.annualizedNoi! - (6_590_191.56 * 365) / 90) < 0.01,
  `obtenido ${quarterly.annualizedNoi}`,
);

const annual = result.rows.find((r) => r.prosId === "4A-2")!;
check("mide el período anual en días", annual.periodDays, 365);
ok("marca que es año completo", annual.isFullYear === true);
check("no extrapola un año completo", annual.annualizedNoi, 12_854_060.24);

ok(
  "sin anualizar, el trimestral parecería la mitad del anual",
  quarterly.recentNoi! < annual.recentNoi! && quarterly.annualizedNoi! > annual.annualizedNoi!,
  "esta es exactamente la comparación que estaría mal sin mirar fechas",
);

// --- la trampa del pari passu ------------------------------------------------

check("1A-1 normaliza al préstamo 1", normalizeProsId("1A-1"), "1");
check("14A-3-C1 normaliza al préstamo 14", normalizeProsId("14A-3-C1"), "14");
check("20A-1-3 normaliza al préstamo 20", normalizeProsId("20A-1-3"), "20");
check("un entero solo queda igual", normalizeProsId("27"), "27");
check("Pros ID sin número no mapea", normalizeProsId("Totals"), null);

ok("detecta sufijo de tramo", hasTrancheSuffix("1A-1") && !hasTrancheSuffix("27"));

const loan1 = result.loans.find((l) => l.loanId === "1");
check("los tres tramos del préstamo 1 colapsan en uno", loan1?.tranches, 3);
check("préstamos únicos tras deduplicar", result.loans.length, 5);
check("sin conflictos entre tramos", result.diagnostics.trancheConflicts.length, 0);

const sumRaw = result.rows
  .filter((r) => r.annualizedNoi !== null)
  .reduce((a, r) => a + r.recentNoi!, 0);
const sumDeduped = result.loans.reduce((a, l) => a + l.annualizedNoi, 0);
ok(
  "deduplicar cambia el total de forma material",
  Math.abs(sumRaw - sumDeduped) / sumRaw > 0.3,
  `crudo ${Math.round(sumRaw)} vs deduplicado ${Math.round(sumDeduped)}`,
);

// --- el pie de página no es un préstamo --------------------------------------

ok(
  "la fila Totals no entra como préstamo",
  !result.rows.some((r) => /totals/i.test(r.prosId)),
);
ok(
  "el copyright no entra como préstamo",
  !result.rows.some((r) => /computershare/i.test(r.prosId)),
);

// --- avisos ------------------------------------------------------------------

ok(
  "avisa cuando casi todo viene extrapolado",
  result.issues.some((i) => /año completo/.test(i)),
  `issues: ${JSON.stringify(result.issues)}`,
);

// --- parseo de valores -------------------------------------------------------

check("money con separadores", parseMoney("21,466,533.53"), 21_466_533.53);
check("money con guiones es nulo", parseMoney("--"), null);
check("money vacío es nulo", parseMoney(""), null);
check("money entre paréntesis es negativo", parseMoney("(1,234.50)"), -1234.5);
check("cero explícito es cero, no nulo", parseMoney("0.00"), 0);
check("texto no es money", parseMoney("Defeased"), null);

check("fecha corta a ISO", parseShortDate("03/31/26"), "2026-03-31");
check("fecha de enero", parseShortDate("01/01/26"), "2026-01-01");
check("año de cuatro dígitos", parseShortDate("04/01/2025"), "2025-04-01");
check("guiones no son fecha", parseShortDate("--"), null);
check("fecha imposible se rechaza", parseShortDate("02/31/26"), null);
check("mes fuera de rango se rechaza", parseShortDate("13/01/26"), null);

// --- período corto -----------------------------------------------------------

const shortPeriod = parseServicerReport(
  REPORT_HTML.replace(
    `["2A-1-1", "19,947,724.67", "2,876,344.33", "01/01/26", "03/31/26"`,
    `["2A-1-1", "19,947,724.67", "2,876,344.33", "03/01/26", "03/31/26"`,
  ).replace(
    "<td>2A-1-1</td><td>19,947,724.67</td><td>2,876,344.33</td><td>01/01/26</td><td>03/31/26</td>",
    "<td>2A-1-1</td><td>19,947,724.67</td><td>2,876,344.33</td><td>03/01/26</td><td>03/31/26</td>",
  ),
);
ok(
  `un período de 31 días queda afuera (piso ${MIN_PERIOD_DAYS})`,
  shortPeriod.diagnostics.droppedShortPeriod === 1,
  `obtenido ${shortPeriod.diagnostics.droppedShortPeriod}`,
);

// --- scoring de exhibits -----------------------------------------------------

ok(
  "el EX-99.1 grande gana",
  scoreServicerExhibit({ name: "bmk24v07_ex991-202607.htm", sizeBytes: 300_000 }) > 0.8,
);
ok(
  "la carátula del 10-D no compite",
  scoreServicerExhibit({ name: "bmk24v07_10d-202607.htm", sizeBytes: 60_000 }) === 0,
);
ok(
  "un certificado chico puntúa bajo",
  scoreServicerExhibit({ name: "ex-99_2cert.htm", sizeBytes: 3_000 }) < 0.5,
);
ok(
  "acepta la variante con guion bajo",
  scoreServicerExhibit({ name: "abc_ex-99_1-202601.htm", sizeBytes: 250_000 }) > 0.8,
);
ok("un PDF no se puede parsear", scoreServicerExhibit({ name: "x_ex991.pdf", sizeBytes: 500_000 }) === 0);


// ---------------------------------------------------------------------------
// Combinación de varios meses y exclusión de extrapolados
// ---------------------------------------------------------------------------

const fy = (loanId: string, noi: number, label: string) => ({
  loanId, annualizedNoi: noi, noiStart: "2025-01-01", noiEnd: "2025-12-31",
  periodDays: 365, isFullYear: true, tranches: 1, label,
});
const partial = (loanId: string, noi: number, days: number, label: string) => ({
  loanId, annualizedNoi: noi, noiStart: "2025-01-01", noiEnd: "2025-06-30",
  periodDays: days, isFullYear: false, tranches: 1, label,
});

const strip = <T extends { label: string }>(x: T) => {
  const { label, ...rest } = x;
  return rest;
};

const merged = mergeServicerReports([
  {
    label: "2026-07",
    loans: [strip(partial("2", 11_665_174, 90, "")), strip(partial("17", 11_120_924, 90, ""))],
  },
  {
    label: "2026-04",
    loans: [
      strip(fy("2", 19_947_725, "")),
      strip(fy("3", 8_195_456, "")),
      strip(partial("17", 24_594_743, 181, "")),
    ],
  },
]);

check("prefiere el año completo sobre el extrapolado", merged.loans.find((l) => l.loanId === "2")?.annualizedNoi, 19_947_725);
check("toma el mes que aporta el dato bueno", merged.loans.find((l) => l.loanId === "2")?.sourceLabel, "2026-04");
check("excluye el préstamo sin ninguna medición completa", merged.excludedExtrapolated, ["17"]);
check("solo quedan los de año completo", merged.loans.map((l) => l.loanId), ["2", "3"]);

ok(
  "detecta el conflicto entre meses del préstamo 2",
  merged.conflicts.some((c) => c.loanId === "2" && c.ratio > 1.5),
  `conflictos: ${JSON.stringify(merged.conflicts.map((c) => [c.loanId, c.ratio.toFixed(1)]))}`,
);
ok(
  "y también el del 17, que no tiene ancla",
  merged.conflicts.some((c) => c.loanId === "17"),
);

const permissive = mergeServicerReports(
  [
    { label: "2026-07", loans: [strip(partial("17", 11_120_924, 90, ""))] },
    { label: "2026-04", loans: [strip(partial("17", 24_594_743, 181, ""))] },
  ],
  { requireFullYear: false },
);
check("con la opción abierta, el extrapolado entra", permissive.loans.length, 1);
check("y elige el período más largo", permissive.loans[0]?.periodDays, 181);


// ---------------------------------------------------------------------------
// Segunda familia de plantilla: Citigroup
// ---------------------------------------------------------------------------

/**
 * Estructura real del EX-99.1 de BMO 2024-C8 (10-D de abril 2026), sección
 * "NOI DETAIL". Valores textuales del documento.
 *
 * Lo que este fixture protege: la columna llamada "Loan ID" acá es el
 * identificador interno del servicer, y el número del prospecto está en "OMCR".
 * En Computershare la relación es la inversa. Si alguien "simplifica" el
 * localizador anclándolo en "Loan ID", este test falla; sin él, el pipeline
 * devolvería cero coincidencias en silencio, indistinguible de un trust que no
 * reporta.
 */
const CITI_HTML = `
<html><body>
<table>
  <tr><td>BMO 2024-C8 Mortgage Trust</td></tr>
  <tr><td>NOI DETAIL</td></tr>
  <tr><td></td><td></td><td></td><td>Property</td><td></td><td></td><td>Ending</td><td>Preceding</td><td>Most</td><td>Most Recent</td><td>Most Recent</td></tr>
  <tr><td></td><td></td><td></td><td>Type</td><td></td><td></td><td>Scheduled</td><td>Fiscal</td><td>Recent</td><td>Financial As of</td><td>Financial Asof</td></tr>
  <tr><td>Loan ID</td><td>OMCR</td><td></td><td>(1)</td><td>City</td><td>State</td><td>Balance</td><td>Year NOI</td><td>NOI</td><td>Start Date</td><td>End Date</td></tr>
  <tr><td>328061011</td><td>11</td><td></td><td>RT</td><td>Schaumburg</td><td>IL</td><td>10,000,000.00</td><td>45,810,952.00</td><td>29,285,689.11</td><td>01/01/2025</td><td>09/30/2025</td></tr>
  <tr><td>328061111</td><td>11</td><td>A</td><td>N/A</td><td></td><td></td><td>5,000,000.00</td><td>-</td><td>-</td><td>Not Available</td><td>Not Available</td></tr>
  <tr><td>328060011</td><td>11</td><td>B</td><td>N/A</td><td></td><td></td><td>5,000,000.00</td><td>-</td><td>-</td><td>Not Available</td><td>Not Available</td></tr>
  <tr><td>328061001</td><td>1</td><td></td><td>RT</td><td>Danbury</td><td>CT</td><td>46,750,000.00</td><td>28,637,691.60</td><td>21,899,786.23</td><td>Not Available</td><td>Not Available</td></tr>
  <tr><td>328061020</td><td>20</td><td></td><td>LO</td><td>Denver</td><td>CO</td><td>6,404,833.85</td><td>781,458.80</td><td>825,372.59</td><td>10/01/2024</td><td>09/30/2025</td></tr>
  <tr><td>Reports Available at sf.citidirect.com</td><td>v. 21.09.28</td><td>Page 16 of 32</td><td>&#169; Copyright 2026 Citigroup</td></tr>
</table>
</body></html>`;

const citi = parseServicerReport(CITI_HTML);

check("reconoce la plantilla de Citigroup", citi.diagnostics.families, ["citigroup"]);
check("ubica la sección NOI Detail", citi.diagnostics.tablesMatched, 1);

ok(
  "ancla en OMCR y no en la columna llamada Loan ID",
  citi.rows.every((r) => Number(r.prosId) < 1000),
  `prosIds obtenidos: ${JSON.stringify(citi.rows.map((r) => r.prosId))}`,
);
ok(
  "el id interno del servicer nunca entra como préstamo",
  !citi.loans.some((l) => l.loanId.startsWith("3280")),
);

check('"Not Available" es ausencia, no un valor', citi.diagnostics.droppedNoDates, 1);
ok(
  "el préstamo sin fechas queda afuera aunque traiga NOI",
  !citi.loans.some((l) => l.loanId === "1"),
);

const citi11 = citi.loans.find((l) => l.loanId === "11");
ok("el préstamo 11 entra por su fila principal", citi11 !== undefined);
check("con período de nueve meses", citi11?.periodDays, 273);
ok("marcado como extrapolado", citi11?.isFullYear === false);

const citi20 = citi.loans.find((l) => l.loanId === "20");
check("el de doce meses no se extrapola", citi20?.annualizedNoi, 825_372.59);
ok("y queda marcado como año completo", citi20?.isFullYear === true);

check("el pie de Citigroup no entra como préstamo", 
  citi.rows.filter((r) => /citidirect|copyright/i.test(r.prosId)).length, 0);

ok(
  "las dos familias conviven sin pisarse",
  result.diagnostics.families.length === 1 && result.diagnostics.families[0] === "computershare",
  `computershare detectó: ${JSON.stringify(result.diagnostics.families)}`,
);

check('parseShortDate rechaza "Not Available"', parseShortDate("Not Available"), null);
check("parseMoney rechaza Not Available", parseMoney("Not Available"), null);

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} ok, ${failed} failed\n`);
if (failed > 0) process.exit(1);

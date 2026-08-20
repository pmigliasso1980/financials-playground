/**
 * Tests for the servicer report parser.
 *
 *   npx tsx harvest/servicer.test.ts
 *
 * The HTML here reproduces the real structure observed in the EX-99.1 of
 * Benchmark 2024-V7 (10-D from July 2026), including all four traps: a header
 * split across three rows and not at the start of the table, NOI periods of
 * different lengths, unreported rows as "0.00" with "--" dates, and pari passu
 * tranches repeating the same property's NOI.
 *
 * The numbers come from the real document. If the parser returns them, we know
 * it reads what is there, not what we assumed.
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
// Fixture: the report's real structure
// ---------------------------------------------------------------------------

/**
 * Each page of the report is its own `<table>` containing a section title,
 * blank rows, a three-level header, data and a page footer. The header is NOT
 * in row 0 — which is why the parser anchors on "Pros ID".
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
    // Three tranches of the same loan, same property NOI, quarterly period.
    ["1A-1", "21,466,533.53", "6,590,191.56", "01/01/26", "03/31/26", "--", "0.00", "0.00"],
    ["1A-4", "21,466,533.53", "6,590,191.56", "01/01/26", "03/31/26", "--", "0.00", "0.00"],
    ["1A-5", "21,466,533.53", "6,590,191.56", "01/01/26", "03/31/26", "--", "0.00", "0.00"],
    ["2A-1-1", "19,947,724.67", "2,876,344.33", "01/01/26", "03/31/26", "--", "0.00", "0.00"],
    // Not reported: a zero number with empty dates. It is NOT an NOI of zero.
    ["3A-1", "8,195,455.96", "0.00", "--", "--", "--", "0.00", "0.00"],
    // Twelve-month period: nothing to extrapolate.
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

console.log("\nServicer report parser\n");

const result = parseServicerReport(REPORT_HTML);

// --- locating the table ------------------------------------------------------

check("finds both pages of the table", result.diagnostics.tablesMatched, 2);
// 13 rows in the fixture, minus the Totals one which is a page footer.
check("reads the data rows and discards the Totals", result.diagnostics.rowsFound, 12);

// --- the zero-without-dates trap --------------------------------------------

check("discards the unreported ones for missing dates", result.diagnostics.droppedNoDates, 3);

const notReported = result.rows.find((r) => r.prosId === "3A-1");
ok("a 0.00 with no dates produces no NOI", notReported?.annualizedNoi === null);
ok("but keeps the raw value for traceability", notReported?.recentNoi === 0);

const zeroInLoans = result.loans.some((l) => l.annualizedNoi === 0);
ok("no loan enters with an NOI of zero", !zeroInLoans);

// --- the annualisation trap --------------------------------------------------

const quarterly = result.rows.find((r) => r.prosId === "1A-1")!;
check("measures the quarterly period in days", quarterly.periodDays, 90);
ok("marks it as not a full year", quarterly.isFullYear === false);
ok(
  "anualiza el trimestre",
  Math.abs(quarterly.annualizedNoi! - (6_590_191.56 * 365) / 90) < 0.01,
  `got ${quarterly.annualizedNoi}`,
);

const annual = result.rows.find((r) => r.prosId === "4A-2")!;
check("measures the annual period in days", annual.periodDays, 365);
ok("marks it as a full year", annual.isFullYear === true);
check("does not extrapolate a full year", annual.annualizedNoi, 12_854_060.24);

ok(
  "unannualised, the quarterly would look like half the annual",
  quarterly.recentNoi! < annual.recentNoi! && quarterly.annualizedNoi! > annual.annualizedNoi!,
  "this is exactly the comparison that would be wrong without looking at dates",
);

// --- the pari passu trap -----------------------------------------------------

check("1A-1 normalises to loan 1", normalizeProsId("1A-1"), "1");
check("14A-3-C1 normalises to loan 14", normalizeProsId("14A-3-C1"), "14");
check("20A-1-3 normalises to loan 20", normalizeProsId("20A-1-3"), "20");
check("a bare integer stays the same", normalizeProsId("27"), "27");
check("a Pros ID with no number does not map", normalizeProsId("Totals"), null);

ok("detects a tranche suffix", hasTrancheSuffix("1A-1") && !hasTrancheSuffix("27"));

const loan1 = result.loans.find((l) => l.loanId === "1");
check("the three tranches of loan 1 collapse into one", loan1?.tranches, 3);
check("unique loans after deduplicating", result.loans.length, 5);
check("no conflicts between tranches", result.diagnostics.trancheConflicts.length, 0);

const sumRaw = result.rows
  .filter((r) => r.annualizedNoi !== null)
  .reduce((a, r) => a + r.recentNoi!, 0);
const sumDeduped = result.loans.reduce((a, l) => a + l.annualizedNoi, 0);
ok(
  "deduplicating changes the total materially",
  Math.abs(sumRaw - sumDeduped) / sumRaw > 0.3,
  `crudo ${Math.round(sumRaw)} vs deduplicado ${Math.round(sumDeduped)}`,
);

// --- the page footer is not a loan -------------------------------------------

ok(
  "the Totals row does not enter as a loan",
  !result.rows.some((r) => /totals/i.test(r.prosId)),
);
ok(
  "the copyright does not enter as a loan",
  !result.rows.some((r) => /computershare/i.test(r.prosId)),
);

// --- avisos ------------------------------------------------------------------

ok(
  "warns when almost everything comes extrapolated",
  result.issues.some((i) => /full year/.test(i)),
  `issues: ${JSON.stringify(result.issues)}`,
);

// --- value parsing -----------------------------------------------------------

check("money with separators", parseMoney("21,466,533.53"), 21_466_533.53);
check("money with dashes is null", parseMoney("--"), null);
check("empty money is null", parseMoney(""), null);
check("money in parentheses is negative", parseMoney("(1,234.50)"), -1234.5);
check("an explicit zero is zero, not null", parseMoney("0.00"), 0);
check("text is not money", parseMoney("Defeased"), null);

check("short date to ISO", parseShortDate("03/31/26"), "2026-03-31");
check("a January date", parseShortDate("01/01/26"), "2026-01-01");
check("a four-digit year", parseShortDate("04/01/2025"), "2025-04-01");
check("dashes are not a date", parseShortDate("--"), null);
check("an impossible date is rejected", parseShortDate("02/31/26"), null);
check("a month out of range is rejected", parseShortDate("13/01/26"), null);

// --- short period ------------------------------------------------------------

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
  `a 31-day period is left out (floor ${MIN_PERIOD_DAYS})`,
  shortPeriod.diagnostics.droppedShortPeriod === 1,
  `got ${shortPeriod.diagnostics.droppedShortPeriod}`,
);

// --- exhibit scoring ---------------------------------------------------------

ok(
  "the large EX-99.1 wins",
  scoreServicerExhibit({ name: "bmk24v07_ex991-202607.htm", sizeBytes: 300_000 }) > 0.8,
);
ok(
  "the 10-D cover page does not compete",
  scoreServicerExhibit({ name: "bmk24v07_10d-202607.htm", sizeBytes: 60_000 }) === 0,
);
ok(
  "a small certificate scores low",
  scoreServicerExhibit({ name: "ex-99_2cert.htm", sizeBytes: 3_000 }) < 0.5,
);
ok(
  "accepts the underscore variant",
  scoreServicerExhibit({ name: "abc_ex-99_1-202601.htm", sizeBytes: 250_000 }) > 0.8,
);
ok("a PDF cannot be parsed", scoreServicerExhibit({ name: "x_ex991.pdf", sizeBytes: 500_000 }) === 0);


// ---------------------------------------------------------------------------
// Combining several months and excluding extrapolated values
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

check("prefers the full year over the extrapolated one", merged.loans.find((l) => l.loanId === "2")?.annualizedNoi, 19_947_725);
check("takes the month that carries the good datum", merged.loans.find((l) => l.loanId === "2")?.sourceLabel, "2026-04");
check("excludes the loan with no complete measurement", merged.excludedExtrapolated, ["17"]);
check("only the full-year ones remain", merged.loans.map((l) => l.loanId), ["2", "3"]);

ok(
  "detects the conflict between months for loan 2",
  merged.conflicts.some((c) => c.loanId === "2" && c.ratio > 1.5),
  `conflictos: ${JSON.stringify(merged.conflicts.map((c) => [c.loanId, c.ratio.toFixed(1)]))}`,
);
ok(
  "and also the one for 17, which has no anchor",
  merged.conflicts.some((c) => c.loanId === "17"),
);

const permissive = mergeServicerReports(
  [
    { label: "2026-07", loans: [strip(partial("17", 11_120_924, 90, ""))] },
    { label: "2026-04", loans: [strip(partial("17", 24_594_743, 181, ""))] },
  ],
  { requireFullYear: false },
);
check("with the option open, the extrapolated one enters", permissive.loans.length, 1);
check("and it picks the longest period", permissive.loans[0]?.periodDays, 181);


// ---------------------------------------------------------------------------
// Second template family: Citigroup
// ---------------------------------------------------------------------------

/**
 * The real structure of BMO 2024-C8's EX-99.1 (10-D from April 2026), "NOI
 * DETAIL" section. Values taken verbatim from the document.
 *
 * What this fixture protects: the column called "Loan ID" here is the servicer's
 * internal identifier, and the prospectus number is in "OMCR". In Computershare
 * the relationship is the reverse. If someone "simplifies" the locator by
 * anchoring it on "Loan ID", this test fails; without it, the pipeline would
 * return zero matches silently, indistinguishable from a trust that does not
 * report at all.
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

check("recognises the Citigroup template", citi.diagnostics.families, ["citigroup"]);
check("locates the NOI Detail section", citi.diagnostics.tablesMatched, 1);

ok(
  "anchors on OMCR and not on the column called Loan ID",
  citi.rows.every((r) => Number(r.prosId) < 1000),
  `prosIds obtained: ${JSON.stringify(citi.rows.map((r) => r.prosId))}`,
);
ok(
  "the servicer's internal id never enters as a loan",
  !citi.loans.some((l) => l.loanId.startsWith("3280")),
);

check('"Not Available" is an absence, not a value', citi.diagnostics.droppedNoDates, 1);
ok(
  "the loan with no dates stays out even though it carries NOI",
  !citi.loans.some((l) => l.loanId === "1"),
);

const citi11 = citi.loans.find((l) => l.loanId === "11");
ok("loan 11 enters through its main row", citi11 !== undefined);
check("with a nine-month period", citi11?.periodDays, 273);
ok("marcado como extrapolado", citi11?.isFullYear === false);

const citi20 = citi.loans.find((l) => l.loanId === "20");
check("the twelve-month one is not extrapolated", citi20?.annualizedNoi, 825_372.59);
ok("and is marked as a full year", citi20?.isFullYear === true);

check("the Citigroup footer does not enter as a loan", 
  citi.rows.filter((r) => /citidirect|copyright/i.test(r.prosId)).length, 0);

ok(
  "the two families coexist without stepping on each other",
  result.diagnostics.families.length === 1 && result.diagnostics.families[0] === "computershare",
  `computershare detected: ${JSON.stringify(result.diagnostics.families)}`,
);

check('parseShortDate rechaza "Not Available"', parseShortDate("Not Available"), null);
check("parseMoney rechaza Not Available", parseMoney("Not Available"), null);

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} ok, ${failed} failed\n`);
if (failed > 0) process.exit(1);

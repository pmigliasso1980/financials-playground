/**
 * Test against the REAL structure of an Annex A.
 *
 * The headers and rows in this file are copied from an actual document on
 * EDGAR:
 *
 *   Wells Fargo Commercial Mortgage Trust 2025-C64
 *   FWP · ANNEX A-1 · 2025-02-03
 *   https://www.sec.gov/Archives/edgar/data/2053102/000153949725000290/n4801_x5-annexa1.htm
 *
 * It is the reference to measure any mapping change against. The synthetic
 * fixtures are cleaner than reality in four ways, and each one broke something:
 *
 *   1. The table comes split into horizontal blocks joined by Loan ID.
 *   2. There are loan rows and property rows mixed together.
 *   3. The headers are duplicated with nuances ("NOI DSCR" vs "NCF DSCR").
 *   4. It uses NAP, NAV and "Various" as absent-data markers.
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
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

// ---------------------------------------------------------------------------
// Block 1 — loan and property characteristics
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
// Block 2 — financial data, same keys, different columns
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
  assert(found, `no headers detected in ${name}`);
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

console.log("Absent-data markers");

check("NAP, NAV and Various read as an absence of data", () => {
  for (const marker of ["NAP", "NAV", "nap", "nav", "Various", "various"]) {
    assert(parseValue(marker, "currency") === null, `"${marker}" should be null`);
    assert(parseValue(marker, "years") === null, `"${marker}" should be null`);
  }
});

check("a compound year like '1980-1991' is not invented", () => {
  // It appears when a loan covers properties from different eras.
  const v = parseValue("1980-1991", "years");
  assert(v === null || v === "1980", `returned "${v}"`);
});

// ---------------------------------------------------------------------------

console.log("\nHeaders reales");

const headers1 = BLOCK_1_HEADERS;
const headers2 = BLOCK_2_HEADERS;

check("maps the characteristics block's columns", () => {
  const { matches } = mapColumns(headers1);
  const keys = new Set(matches.map((m) => m.metric.key));
  for (const expected of ["loan_id", "loan_property_flag", "property_name", "property_type", "property_type_detailed", "year_built", "year_renovated", "units", "unit_of_measure", "loan_amount", "interest_rate"]) {
    assert(keys.has(expected as never), `missing ${expected} · mapped: ${[...keys].join(", ")}`);
  }
});

check("maps the financial block's columns", () => {
  const { matches } = mapColumns(headers2);
  const keys = new Set(matches.map((m) => m.metric.key));
  for (const expected of ["occupancy_economic", "noi_underwritten", "net_cash_flow", "dscr", "dscr_ncf", "debt_yield", "debt_yield_ncf"]) {
    assert(keys.has(expected as never), `missing ${expected} · mapped: ${[...keys].join(", ")}`);
  }
});

check("each NOI vintage goes to its own metric", () => {
  /**
   * Found by running the Index over real data: the "Net Operating Income" fact
   * for TheWit Chicago returned $9,731,261, which is the NOI from THREE periods
   * ago. The generic /most recent.*noi/ pattern matches "Third Most Recent NOI"
   * and was keeping the oldest column.
   *
   * For an analyst that is worse than a missing datum: a plausible number,
   * correctly extracted, under the wrong label.
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

check("the EGI and expense vintages separate too", () => {
  /**
   * All eight columns, in the order the conduit Annex A carries them.
   *
   * The previous version passed only four —third and underwritten of each
   * family— because under the old taxonomy there were no more keys to put them
   * in. With eight keys you have to supply all eight columns: asserting on one
   * that is not in the input fails for absence, not for mapping.
   */
  const { matches } = mapColumns([
    "Most Recent EGI ($)", "Second Most Recent EGI ($)",
    "Third Most Recent EGI ($)", "Underwritten EGI ($)",
    "Most Recent Expenses ($)", "Second Most Recent Expenses ($)",
    "Third Most Recent Expenses ($)", "Underwritten Expenses ($)",
  ]);
  const byKey = new Map(matches.map((m) => [m.metric.key, m.header]));

  /**
   * One key per column. The previous version asserted this same thing with four
   * keys for eight columns, and passed because of the fixture's order: the pairs
   * tied on score and the tie-break was positional. With the keys separated, if
   * the mapping breaks the assertion fails.
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

check("the debt structures do not get confused with each other", () => {
  /**
   * Found in the persisted corpus: `ltv` had 25% coverage. The value was
   * correct but belonged to another metric — we had mapped "Whole Loan Cut-off
   * Date LTV", which only exists for loans split into pari passu notes.
   *
   * It is not a nuance: the whole loan includes the pieces left in other
   * trusts, and total debt adds mezzanine. They are different denominators, so
   * the same loan can have 60% whole loan LTV and 45% at the trust.
   */
  const headers = [
    "Cut-off Date LTV Ratio (%)",
    "Whole Loan Cut-off Date LTV Ratio (%)",
    "Total Debt Cut-off Date LTV Ratio (%)",
    "LTV Ratio at Maturity / ARD (%)",
  ];
  const { matches, unmapped } = mapColumns(headers);
  const byKey = new Map(matches.map((m) => [m.metric.key, m.header]));

  eq(byKey.get("ltv"), "Cut-off Date LTV Ratio (%)", "trust LTV");
  eq(byKey.get("ltv_whole_loan"), "Whole Loan Cut-off Date LTV Ratio (%)", "whole loan");
  eq(byKey.get("ltv_total_debt"), "Total Debt Cut-off Date LTV Ratio (%)", "total debt");
  eq(byKey.get("ltv_maturity"), "LTV Ratio at Maturity / ARD (%)", "at maturity");
  eq(unmapped.length, 0, `left unmapped: ${unmapped.map((u) => u.header).join(", ")}`);
});

check("DSCR and debt yield do not cross between structures either", () => {
  const { matches } = mapColumns([
    "Underwritten NOI DSCR (x)",
    "Underwritten NCF DSCR (x)",
    "Whole Loan Underwritten NCF DSCR (x)",
    "Total Debt Underwritten NCF DSCR (x)",
    "Underwritten NOI Debt Yield (%)",
    "Whole Loan Underwritten NOI Debt Yield (%)",
  ]);
  const byKey = new Map(matches.map((m) => [m.metric.key, m.header]));

  assert(!/whole|total/i.test(byKey.get("dscr") ?? ""), `dscr took "${byKey.get("dscr")}"`);
  assert(!/whole|total/i.test(byKey.get("dscr_ncf") ?? ""), `dscr_ncf took "${byKey.get("dscr_ncf")}"`);
  assert(!/whole|total/i.test(byKey.get("debt_yield") ?? ""), `debt_yield took "${byKey.get("debt_yield")}"`);
  assert(byKey.has("dscr_whole_loan"), "did not capture the whole loan DSCR");
  assert(byKey.has("debt_yield_whole_loan"), "did not capture the whole loan debt yield");
});

check("the real NOI is not stolen by the DSCR or the debt yield", () => {
  // The bug this test found: "Underwritten NOI DSCR (x)" contains
  // "Underwritten" and "NOI", so it matched noi_underwritten at the maximum
  // score and orphaned "Underwritten Net Operating Income ($)".
  const { matches } = mapColumns(headers2);
  const noi = matches.find((m) => m.metric.key === "noi_underwritten");
  assert(noi, "noi_underwritten was not mapped");
  assert(
    /net operating income/i.test(noi!.header),
    `noi_underwritten took "${noi!.header}"`,
  );
});

check("NOI DSCR y NCF DSCR no se confunden", () => {
  const { matches } = mapColumns(headers2);
  const noi = matches.find((m) => m.metric.key === "dscr");
  const ncf = matches.find((m) => m.metric.key === "dscr_ncf");
  assert(noi && ncf, "one of the two is missing");
  assert(/noi/i.test(noi!.header), `dscr took "${noi!.header}"`);
  assert(/ncf/i.test(ncf!.header), `dscr_ncf took "${ncf!.header}"`);
});

check("NOI Debt Yield y NCF Debt Yield no se confunden", () => {
  const { matches } = mapColumns(headers2);
  const noi = matches.find((m) => m.metric.key === "debt_yield");
  const ncf = matches.find((m) => m.metric.key === "debt_yield_ncf");
  assert(noi && ncf, "one of the two is missing");
  assert(/noi/i.test(noi!.header), `debt_yield took "${noi!.header}"`);
  assert(/ncf/i.test(ncf!.header), `debt_yield_ncf took "${ncf!.header}"`);
});

check("economic occupancy maps to its own metric", () => {
  // This Annex publishes only economic occupancy. Previously the /economic/
  // exclusion on `occupancy` discarded it and we were left with none at all.
  const { matches } = mapColumns(headers2);
  const eco = matches.find((m) => m.metric.key === "occupancy_economic");
  assert(eco, "economic occupancy was not mapped");
  assert(/economic/i.test(eco!.header), `took "${eco!.header}"`);
});

check("physical and economic occupancy do not clash when both are present", () => {
  const { matches } = mapColumns(["Physical Occupancy (%)", "Underwritten Economic Occupancy (%)"]);
  const phys = matches.find((m) => m.metric.key === "occupancy");
  const eco = matches.find((m) => m.metric.key === "occupancy_economic");
  assert(phys && eco, "one of the two is missing");
  assert(phys!.columnIndex !== eco!.columnIndex, "they landed on the same column");
});

check("'Unit of Measure' does not steal the unit-count column", () => {
  const { matches } = mapColumns(headers1);
  const units = matches.find((m) => m.metric.key === "units");
  const measure = matches.find((m) => m.metric.key === "unit_of_measure");
  assert(units, "units was not mapped");
  assert(measure, "unit_of_measure was not mapped");
  assert(/number of units/i.test(units!.header), `units took "${units!.header}"`);
  assert(/measure/i.test(measure!.header), `unit_of_measure took "${measure!.header}"`);
});

check("'Loan Per Unit ($)' is not confused with Loan Amount", () => {
  const { matches } = mapColumns(headers1);
  const loan = matches.find((m) => m.metric.key === "loan_amount");
  assert(loan, "loan_amount was not mapped");
  assert(
    !/per\s*unit/i.test(loan!.header),
    `loan_amount took "${loan!.header}", which is a per-unit value`,
  );
});

// ---------------------------------------------------------------------------

console.log("\nLoan rows vs. property rows");

check("classifyRow tells the two apart", () => {
  eq(classifyRow("Loan"), "loan", "Loan");
  eq(classifyRow("Property"), "property", "Property");
  eq(classifyRow(""), "unknown", "empty");
});

const t1 = block(headers1, BLOCK_1_DATA, "block-1");

check("discards the property rows and keeps the loans", () => {
  const filtered = keepLoanRows(t1.rows, t1.headerRowIndex);
  assert(filtered.hadFlagColumn, "the flag column was not detected");
  eq(filtered.loanRows, 3, "loans");
  eq(filtered.propertyRows, 2, "property rows discarded");
});

check("without a flag column, the Loan ID separates loans from properties", () => {
  /**
   * The flag column only appears in 79% of filings. Without this fallback, in
   * the remaining 21% each property of a portfolio entered as a loan: BANK5
   * 2026-5YR23 showed 173 loans while having 33.
   *
   * The giveaway was arithmetic: 173 distinct IDs with a maximum of 33.
   */
  const noFlag = headers1.filter((h) => !/flag/i.test(h));
  const data = BLOCK_1_DATA.map((r) => r.filter((_, i) => i !== 1));
  const table = block(noFlag, data, "no-flag");
  const filtered = keepLoanRows(table.rows, table.headerRowIndex);

  // The data carries 1.00, 2.00, 3.00 (loans) and 3.01, 3.02 (properties).
  eq(filtered.loanRows, 3, "loans");
  eq(filtered.propertyRows, 2, "property rows discarded");
});

check("with integer IDs it discards nothing", () => {
  // Filings that number 1, 2, 3 have no separate property rows.
  const noFlag = headers1.filter((h) => !/flag/i.test(h));
  const data = BLOCK_1_DATA.slice(0, 3).map((r, i) => {
    const row = r.filter((_, j) => j !== 1);
    row[0] = String(i + 1);
    return row;
  });
  const table = block(noFlag, data, "ids-enteros");
  const filtered = keepLoanRows(table.rows, table.headerRowIndex);
  eq(filtered.loanRows, 3, "should keep all three");
  eq(filtered.propertyRows, 0, "there are no property rows");
});

check("discards the row that numbers the columns", () => {
  /**
   * The real case: in the conduit Annex A the first row after the header
   * numbers the columns (1, 2, 3...) and was entering as a loan. Seven appeared
   * in the 2026 cohort, with property_type = "2" — the column number read as
   * the type.
   *
   * It cannot be filtered by observation count: they had exactly 3, and across
   * the corpus's 9,751 rows the distribution is continuous from 3. A loan has a
   * name or has a balance; this row has neither.
   */
  /**
   * The row is built in its REAL shape, not a plausible one.
   *
   * The first version of this test put a number in every column, so the row had
   * a value in "Property Name" and the filter —correctly— did not discard it.
   * The 5 phantoms found in the corpus have an empty name, a null count and a
   * null unit: the only value that survives is the column number in the
   * position of the property type.
   *
   * The test was failing because it was badly written, not because of the
   * filter. It stands as a reminder that an invented "similar" case does not
   * prove the same thing as the observed one.
   */
  /**
   * The REAL numbering row: a number in every column, not empty cells.
   *
   * This was the first version of the test. It failed, and instead of fixing
   * the filter I changed the test to empty cells so it would pass — with the
   * result that the two rows of BMO 2026-5C15 survived a full re-harvest. It
   * goes back to the real shape, which is what the filter has to handle.
   */
  const numberingRow = headers1.map((_, i) => String(i + 1));

  /**
   * And enough real rows are needed not to hit the 15% guard. With 3 loans,
   * discarding 1 is 25% and the filter abstains — which is the correct
   * behaviour and was making the test fail for another reason.
   */
  const loans = BLOCK_1_DATA.filter((r) => r[1] === "Loan");
  const many = [numberingRow, ...loans, ...loans, ...loans, ...loans];
  const table = block(headers1, many, "with-numbering-row");
  const filtered = keepLoanRows(table.rows, table.headerRowIndex);

  eq(filtered.phantomRows, 1, "the numbering row");
  eq(filtered.loanRows, 12, "the 12 real loans remain");
  assert(
    !filtered.rows.slice(table.headerRowIndex + 1).some((r) => r === numberingRow),
    "the numbering row should not remain among the data",
  );
});

check("with few rows the guard beats the filter", () => {
  /**
   * The same case with 3 loans instead of 12: discarding 1 would be 25% and the
   * filter abstains. We prefer one extra phantom row to deleting a quarter of a
   * small pool on a hypothesis about two columns.
   */
  const numberingRow = headers1.map((_, i) => String(i + 1));
  const loans = BLOCK_1_DATA.filter((r) => r[1] === "Loan");
  const table = block(headers1, [numberingRow, ...loans], "few-rows");
  const filtered = keepLoanRows(table.rows, table.headerRowIndex);
  eq(filtered.phantomRows, 0, "should abstain with 1 of 4");
});

check("it abstains if it would have to discard too many rows", () => {
  /**
   * The guard that matters: if the filter wants to delete more than 15% of the
   * rows, the likeliest explanation is that the name and balance columns are
   * not where we think —not that 20% of the pool are phantoms. Deleting half an
   * Annex A silently is worse than letting a few extra rows through.
   */
  const empties = BLOCK_1_DATA.map((r) => r.map(() => ""));
  const table = block(headers1, empties, "all-empty");
  const filtered = keepLoanRows(table.rows, table.headerRowIndex);
  eq(filtered.phantomRows, 0, "should abstain, not empty the table");
});

check("with no flag and no Loan ID it keeps everything", () => {
  // We prefer too much data to data silently lost.
  const headers = headers1.filter((h) => !/flag/i.test(h) && !/loan id/i.test(h));
  const data = BLOCK_1_DATA.map((r) => r.filter((_, i) => i !== 0 && i !== 1));
  const table = block(headers, data, "nothing");
  const filtered = keepLoanRows(table.rows, table.headerRowIndex);
  eq(filtered.loanRows, 5, "should keep them all");
  eq(filtered.propertyRows, 0, "no way to tell them apart");
});

// ---------------------------------------------------------------------------

console.log("\nJoining horizontal blocks");

const t2 = block(headers2, BLOCK_2_DATA, "block-2");
const joined = joinAnnexTables([t1, t2]);

check("joins the two blocks by Loan ID", () => {
  assert(joined, "returned nothing");
  eq(joined!.tablesJoined, 2, "tablas unidas");
});

check("the join keeps the columns of both blocks", () => {
  const { matches } = mapColumns(joined!.rows[joined!.headerRowIndex]!.map((c) => String(c ?? "")));
  const keys = new Set(matches.map((m) => m.metric.key));
  // From block 1
  assert(keys.has("units"), "lost units");
  assert(keys.has("interest_rate"), "lost interest_rate");
  // From block 2
  assert(keys.has("noi_underwritten"), "lost noi_underwritten");
  assert(keys.has("dscr_ncf"), "lost dscr_ncf");
});

check("it does not duplicate the key columns repeated across blocks", () => {
  const headers = joined!.rows[joined!.headerRowIndex]!.map((c) => String(c ?? "").trim().toLowerCase());
  const nonEmpty = headers.filter(Boolean);
  eq(new Set(nonEmpty).size, nonEmpty.length, `duplicados: ${nonEmpty.filter((h, i) => nonEmpty.indexOf(h) !== i).join(", ")}`);
});

check("the data stays aligned with its loan", () => {
  const headers = joined!.rows[joined!.headerRowIndex]!.map((c) => String(c ?? ""));
  const { matches } = mapColumns(headers);
  const nameCol = matches.find((m) => m.metric.key === "property_name")!.columnIndex;
  const noiCol = matches.find((m) => m.metric.key === "noi_underwritten")!.columnIndex;

  const dataRows = joined!.rows.slice(joined!.headerRowIndex + 1);
  const theWit = dataRows.find((r) => String(r[nameCol]).includes("TheWit"));
  assert(theWit, "TheWit Chicago not found");
  // Its underwritten NOI in the real document is 10,932,267
  eq(String(theWit![noiCol]), "10,932,267", "TheWit's NOI");
});

check("stacks the pages of the same block instead of crossing them", () => {
  // Real case: an Annex A carries one table PER PAGE, not per column block.
  // Wells Fargo 2025-C64 has 126 tables. If each page is taken as a different
  // block, joining by Loan ID leaves only the loans appearing on the first page
  // of all of them — in the first real run, 7 out of a whole pool.
  const page1 = block(headers1, BLOCK_1_DATA.slice(0, 2), "b1-p1");
  const page2 = block(headers1, [
    ["4.00", "Loan", "", 1, "Fourth Loan", "Retail", "Strip", "1999", "NAP", 42, "Units", "150,000.00", "6,300,000", "6,300,000", "6,300,000", "6.50000%", "0.01800%", "6.48200%", "NAP", "39,800.00"],
  ], "b1-p2");

  const { tables: stacked, groups } = stackPagedTables([page1, page2]);
  eq(groups, 1, "should end up as a single logical block");
  const data = stacked[0]!.rows.slice(stacked[0]!.headerRowIndex + 1);
  eq(data.length, 3, "stacked rows");
});

check("it does not stack blocks with different headers", () => {
  const { groups } = stackPagedTables([t1, t2]);
  eq(groups, 2, "they are different column blocks, not pages");
});

check("stacking and joining combine correctly", () => {
  // Two blocks, each split across two pages.
  const b1p1 = block(headers1, BLOCK_1_DATA.slice(0, 3), "b1-p1");
  const b1p2 = block(headers1, BLOCK_1_DATA.slice(3), "b1-p2");
  const b2p1 = block(headers2, BLOCK_2_DATA.slice(0, 3), "b2-p1");
  const b2p2 = block(headers2, BLOCK_2_DATA.slice(3), "b2-p2");

  const result = joinAnnexTables([b1p1, b1p2, b2p1, b2p2]);
  assert(result, "returned nothing");
  eq(result!.stackedGroups, 2, "groups after stacking");
  eq(result!.tablesJoined, 2, "bloques unidos");

  const headers = result!.rows[result!.headerRowIndex]!.map((c) => String(c ?? ""));
  const { matches } = mapColumns(headers);
  const keys = new Set(matches.map((m) => m.metric.key));
  assert(keys.has("units") && keys.has("noi_underwritten"), "lost columns when combining");

  const dataRows = result!.rows.slice(result!.headerRowIndex + 1);
  eq(dataRows.length, 5, "should have the block's 5 rows");
});

check("adopts the continuation pages with no header", () => {
  // Real case: of the 126 tables in the Wells Fargo Annex A, only 18 carry
  // headers. The other 108 are continuations —following pages of the same
  // block— and discarding them left 7 loans out of a whole pool.
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

  eq(adoptedTables.length, 1, "should end up as a single block");
  eq(adopted, 1, "continuations adopted");
  eq(orphans, 0, "orphaned");

  const data = adoptedTables[0]!.rows.slice(adoptedTables[0]!.headerRowIndex + 1);
  eq(data.length, 4, "total rows after adopting");
});

check("it does not adopt a table with a different column count", () => {
  // Adopting the wrong block misaligns all the data: worse than losing it.
  const headed = block(headers1, BLOCK_1_DATA.slice(0, 2), "block");
  const foreign = { name: "something-else", rows: [["a", "b"], ["c", "d"]] };

  const { adopted, orphans } = attachContinuationTables(
    [{ name: headed.name, rows: headed.rows }, foreign],
    (rows) => findHeaderRow(rows),
  );

  eq(adopted, 0, "should not adopt");
  eq(orphans, 1, "should be left orphaned");
});

check("Number of Units + Unit of Measure = SF is stored as area", () => {
  // The Annex uses a single count column; Unit of Measure says what is counted.
  // A warehouse with 425,000 "units" is square feet.
  const rows = [
    ["Property Name", "Number of Units", "Unit of Measure", "UW NOI", "Original Balance"],
    ["Warehouse Memphis", "425,000", "SF", "$5,900,000", "$72,000,000"],
    ["Hotel Chicago", "310", "Rooms", "$10,932,267", "$81,000,000"],
  ];
  const h = findHeaderRow(rows, { minMatches: 3 })!;
  const res = rowsToObservations(rows, h.rowIndex, SOURCE, { minObservationsPerRow: 3 });

  const warehouse = res.properties.find((p) => p.label.property_name?.includes("Warehouse"))!;
  const hotel = res.properties.find((p) => p.label.property_name?.includes("Hotel"))!;

  eq(warehouse.observations.find((o) => o.metric_key === "square_feet")?.value, "425000", "the warehouse's area");
  assert(
    !warehouse.observations.some((o) => o.metric_key === "units"),
    "the warehouse should not have units",
  );
  eq(hotel.observations.find((o) => o.metric_key === "units")?.value, "310", "the hotel's rooms");
});

check("with a dedicated area column, the SF count is discarded", () => {
  // Real Wells Fargo case: the Annex carries `Number of Units` + `Unit of
  // Measure` AND dedicated area columns as well. For a property measured in SF,
  // the `Number of Units` value is not a unit count and storing it as one
  // contaminates any comparison between assets.
  const rows = [
    ["Property Name", "Number of Units", "Unit of Measure", "Net Rentable Area (SF)", "UW NOI", "Original Balance"],
    ["Warehouse", "425,000", "SF", "425,000", "$5,900,000", "$72,000,000"],
    ["Torre", "180", "Units", "", "$3,100,000", "$38,000,000"],
  ];
  const h = findHeaderRow(rows, { minMatches: 3 })!;
  const res = rowsToObservations(rows, h.rowIndex, SOURCE, { minObservationsPerRow: 3 });

  const warehouse = res.properties.find((p) => p.label.property_name === "Warehouse")!;
  assert(
    !warehouse.observations.some((o) => o.metric_key === "units"),
    "425,000 are not units: it should be discarded",
  );
  eq(warehouse.observations.find((o) => o.metric_key === "square_feet")?.value, "425000", "superficie");

  const torre = res.properties.find((p) => p.label.property_name === "Torre")!;
  eq(torre.observations.find((o) => o.metric_key === "units")?.value, "180", "unidades reales intactas");
});

check("with no common Loan ID it returns the best table alone", () => {
  const noId1 = block(headers1.slice(1), BLOCK_1_DATA.map((r) => r.slice(1)), "no-id-1");
  const noId2 = block(headers2.slice(1), BLOCK_2_DATA.map((r) => r.slice(1)), "no-id-2");
  const result = joinAnnexTables([noId1, noId2]);
  assert(result, "returned nothing");
  eq(result!.tablesJoined, 1, "should not have joined");
});

// ---------------------------------------------------------------------------

console.log("\nFull pipeline over real data");

const filtered = keepLoanRows(joined!.rows, joined!.headerRowIndex);
const result = rowsToObservations(filtered.rows, joined!.headerRowIndex, SOURCE);

check("produces one deal per loan, not per row", () => {
  eq(result.stats.propertiesKept, 3, "loans");
});

check("the real values parse correctly", () => {
  const theWit = result.properties.find((p) => p.label.property_name?.includes("TheWit"));
  assert(theWit, "TheWit not found");

  const get = (key: string) => theWit!.observations.find((o) => o.metric_key === key)?.value;

  eq(get("noi_underwritten"), "10932267", "NOI underwritten");
  eq(get("occupancy_economic"), "0.698", "economic occupancy");
  eq(get("dscr"), "1.83", "NOI DSCR");
  eq(get("dscr_ncf"), "1.59", "NCF DSCR");
  eq(get("debt_yield"), "0.135", "NOI debt yield");
  eq(get("units"), "310", "habitaciones");
  eq(get("unit_of_measure"), "Rooms", "unit of measure");
});

check("rows with NAV do not generate false observations", () => {
  const ventana = result.properties.find((p) => p.label.property_name?.includes("Ventana"));
  assert(ventana, "Ventana Residences not found");
  // Its whole history is NAV; it should only have the underwritten data.
  const hasNav = ventana!.observations.some((o) => /^(nav|nap)$/i.test(o.value));
  assert(!hasNav, "a NAV slipped in as a value");
  eq(ventana!.observations.find((o) => o.metric_key === "noi_underwritten")?.value, "5819367", "NOI");
});

check("a 548-room hotel is not stored as 548 units", () => {
  const soho = result.properties.find((p) => p.label.property_name?.includes("Soho"));
  assert(soho, "Soho Grand not found");
  const measure = soho!.observations.find((o) => o.metric_key === "unit_of_measure")?.value;
  eq(measure, "Rooms", "unit of measure");
});

check("the sanity checks pass over real data", () => {
  const issues = checkSanity(result);
  const errors = issues.filter((i) => i.severity === "error");
  assert(errors.length === 0, errors.map((e) => `[${e.metric}] ${e.message}`).join("; "));
});

// ---------------------------------------------------------------------------

console.log(
  `\n  columns mapped: ${result.columnsMapped.length}` +
    `\n  unmapped: ${result.columnsUnmapped.length ? result.columnsUnmapped.join(" | ") : "(none)"}`,
);

console.log(
  `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} ok · ${failed} failed\x1b[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);

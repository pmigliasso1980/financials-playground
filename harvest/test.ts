/**
 * Offline harvester test.
 *
 * Tests everything that does NOT depend on the network: header row detection,
 * column mapping, value parsing, normalisation to observations and the sanity
 * checks.
 *
 * The fixtures imitate the header variants different CMBS issuers use. If you
 * ever get hold of a real Annex A and the mapping fails, add that variant here
 * before touching the patterns — that way the fix stays covered.
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
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Fixtures: real header variants across issuers
// ---------------------------------------------------------------------------

/** "Classic" style: long, explicit names. */
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

/** Style with symbols and units in parentheses. */
const HEADERS_SYMBOLS = [
  "#", "Property Name", "Address", "City", "State", "Zip",
  "Property Type", "YOC", "# of Units", "NRA (SF)", "Occupancy Rate (%)",
  "U/W NOI ($)", "Original Balance ($)", "Appraised Value ($)",
  "LTV (%)", "DSCR (x)", "Interest Rate (%)",
];

function buildRows(headers: string[], dataRows: unknown[][], preamble = 3): unknown[][] {
  // Real Annex A files start with titles and notes before the table.
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

console.log("Value parsing");

check("currency with $ and commas", () => {
  eq(parseValue("$1,234,567", "currency"), "1234567", "moneda");
});

check("accounting negative in parentheses", () => {
  eq(parseValue("(45,000)", "currency"), "-45000", "negativo");
});

check("percentage with a sign → fraction", () => {
  eq(parseValue("94.5%", "percent"), "0.945", "pct with sign");
});

check("percentage without a sign but > 1.5 → fraction", () => {
  eq(parseValue("94.5", "percent"), "0.945", "pct without sign");
});

check("an already normalised fraction is respected", () => {
  eq(parseValue("0.945", "percent"), "0.945", "fraction");
});

check("ratio with an x suffix", () => {
  eq(parseValue("1.25x", "ratio"), "1.25", "ratio");
});

check("N/A y variantes → null", () => {
  for (const v of ["N/A", "n/a", "NA", "-", "—", "", "   ", "None"]) {
    assert(parseValue(v, "currency") === null, `"${v}" should be null`);
  }
});

check("year out of range → null", () => {
  eq(parseValue("1985", "years"), "1985", "valid year");
  assert(parseValue("0", "years") === null, "year 0 should be null");
  assert(parseValue("99999", "years") === null, "an absurd year should be null");
});

check("zero is a value, not an absence", () => {
  eq(parseValue("0", "currency"), "0", "zero");
  eq(parseValue("$0", "currency"), "0", "zero with a symbol");
});

// ---------------------------------------------------------------------------

console.log("\nColumn mapping");

check("verbose headers: maps the core metrics", () => {
  const { matches } = mapColumns(HEADERS_VERBOSE);
  const keys = new Set(matches.map((m) => m.metric.key));
  for (const expected of ["noi_underwritten", "noi_most_recent", "occupancy", "units", "loan_amount", "ltv", "dscr"]) {
    assert(keys.has(expected as never), `missing ${expected}`);
  }
});

check("headers abreviados: mapea igual", () => {
  const { matches } = mapColumns(HEADERS_TERSE);
  const keys = new Set(matches.map((m) => m.metric.key));
  for (const expected of ["noi_underwritten", "noi_most_recent", "occupancy", "units", "ltv", "dscr"]) {
    assert(keys.has(expected as never), `missing ${expected}`);
  }
});

check("headers with symbols: maps just the same", () => {
  const { matches } = mapColumns(HEADERS_SYMBOLS);
  const keys = new Set(matches.map((m) => m.metric.key));
  for (const expected of ["noi_underwritten", "occupancy", "units", "ltv", "dscr", "interest_rate"]) {
    assert(keys.has(expected as never), `missing ${expected}`);
  }
});

check("UW NOI and Most Recent NOI do not get confused", () => {
  const { matches } = mapColumns(HEADERS_VERBOSE);
  const uw = matches.find((m) => m.metric.key === "noi_underwritten");
  const recent = matches.find((m) => m.metric.key === "noi_most_recent");
  assert(uw && recent, "both should be mapped");
  assert(uw!.columnIndex !== recent!.columnIndex, "they landed on the same column");
  assert(/underwritten/i.test(uw!.header), `UW mapped to "${uw!.header}"`);
  assert(/most recent/i.test(recent!.header), `Most Recent mapped to "${recent!.header}"`);
});

check("'Occupancy Date' is not taken for occupancy", () => {
  const { matches } = mapColumns(["Occupancy", "Occupancy Date"]);
  const occ = matches.find((m) => m.metric.key === "occupancy");
  assert(occ, "Occupancy should map");
  eq(occ!.header, "Occupancy", "picked the wrong column");
});

check("'per unit' and '/SF' are not taken for units or square feet", () => {
  const { matches } = mapColumns(["Price per Unit", "Rent / SF", "Units", "NRA (SF)"]);
  const units = matches.find((m) => m.metric.key === "units");
  const sf = matches.find((m) => m.metric.key === "square_feet");
  eq(units?.header, "Units", "units mapped wrong");
  eq(sf?.header, "NRA (SF)", "square feet mapped wrong");
});

check("a column is not assigned to two metrics", () => {
  const { matches } = mapColumns(HEADERS_VERBOSE);
  const cols = matches.map((m) => m.columnIndex);
  eq(new Set(cols).size, cols.length, "there are duplicate columns");
});

check("a metric does not take two columns", () => {
  const { matches } = mapColumns(HEADERS_VERBOSE);
  const keys = matches.map((m) => m.metric.key);
  eq(new Set(keys).size, keys.length, "there are duplicate metrics");
});

// ---------------------------------------------------------------------------

console.log("\nHeader row detection");

check("skips the preamble of titles", () => {
  const rows = buildRows(HEADERS_VERBOSE, [[1, "Test", "1 Main St"]]);
  const found = findHeaderRow(rows);
  assert(found, "no headers found");
  eq(found!.rowIndex, 3, "row index");
});

check("picks the row with the most metrics when there are several candidates", () => {
  const rows: unknown[][] = [
    ["Loan No.", "City", "State", "Zip", "Notes"],   // few metrics
    HEADERS_VERBOSE,                                  // muchas
    [1, "Test"],
  ];
  const found = findHeaderRow(rows);
  eq(found?.rowIndex, 1, "picked the wrong row");
});

check("no recognisable table returns null", () => {
  const rows: unknown[][] = [["Title"], ["Footnote"], []];
  assert(findHeaderRow(rows) === null, "should be null");
});

// ---------------------------------------------------------------------------

console.log("\nNormalisation to observations");

const DATA_VERBOSE: unknown[][] = [
  [1, "Harbor Point Plaza", "925 Harbor Point Dr", "Charleston", "SC", "29403",
   "Multifamily", 2016, null, 248, null, "94.5%", "2018-03-31",
   "$2,970,696", "$2,850,000", "$31,700,000", "$48,000,000", "66.0%", "1.42x", "4.85%"],
  [2, "Mesa Crossing", "4400 E Mesa Blvd", "Phoenix", "AZ", "85018",
   "Retail", 1998, 2015, null, 84000, "91.2%", "2018-03-31",
   "$1,140,000", "$1,085,000", "$12,400,000", "$19,000,000", "65.3%", "1.35x", "5.10%"],
  // Junk row: a subtotal, with almost no data.
  [null, "TOTAL", null, null, null, null, null, null, null, null, null, null, null,
   "$4,110,696", null, "$44,100,000", null, null, null, null],
];

const rowsVerbose = buildRows(HEADERS_VERBOSE, DATA_VERBOSE);
const headerVerbose = findHeaderRow(rowsVerbose)!;
const harvest = rowsToObservations(rowsVerbose, headerVerbose.rowIndex, SOURCE);

check("discards the subtotal rows", () => {
  eq(harvest.stats.propertiesKept, 2, "properties");
  eq(harvest.stats.rowsSkipped, 1, "rows discarded");
});

check("every observation carries its provenance", () => {
  const obs = harvest.properties[0]!.observations[0]!;
  assert(obs.source.accession === SOURCE.accession, "the accession is missing");
  assert(obs.source.fileUrl.startsWith("https://www.sec.gov/"), "the file URL is missing");
  assert(obs.source_header.length > 0, "the original header is missing");
  assert(typeof obs.source_column_index === "number", "the column index is missing");
});

check("keeps the raw value alongside the parsed one", () => {
  const noi = harvest.properties[0]!.observations.find((o) => o.metric_key === "noi_underwritten")!;
  eq(noi.value, "2970696", "valor parseado");
  eq(noi.raw_value, "$2,970,696", "valor crudo");
});

check("occupancy ends up as a fraction", () => {
  const occ = harvest.properties[0]!.observations.find((o) => o.metric_key === "occupancy")!;
  eq(occ.value, "0.945", "ocupancia");
});

check("the text labels stay accessible", () => {
  eq(harvest.properties[0]!.label.property_name, "Harbor Point Plaza", "name");
  eq(harvest.properties[0]!.label.state, "SC", "state");
  eq(harvest.properties[1]!.label.property_type, "Retail", "type");
});

check("empty cells generate no observations", () => {
  const p0 = harvest.properties[0]!;
  assert(!p0.observations.some((o) => o.metric_key === "square_feet"), "multifamily had no SF");
  assert(!p0.observations.some((o) => o.metric_key === "year_renovated"), "it had no renovation");
});

check("the observation ids are stable and unique", () => {
  const ids = harvest.properties.flatMap((p) => p.observations.map((o) => o.id));
  eq(new Set(ids).size, ids.length, "hay ids duplicados");
  const again = rowsToObservations(rowsVerbose, headerVerbose.rowIndex, SOURCE);
  eq(again.properties[0]!.observations[0]!.id, harvest.properties[0]!.observations[0]!.id, "it is not stable");
});

// ---------------------------------------------------------------------------

console.log("\nSanity checks");

check("a correct harvest raises no errors", () => {
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
    "did not detect the NOI/loan crossover",
  );
});

check("detects occupancy out of range", () => {
  // We force the bug: values already in fraction but > 1 after parsing.
  const rows = buildRows(["Property Name", "Occupancy", "UW NOI", "Original Balance", "Units"], [
    ["A", 9450, "$1,000,000", "$10,000,000", 100],
  ]);
  const h = findHeaderRow(rows, { minMatches: 3 });
  assert(h, "should find headers");
  const bad = rowsToObservations(rows, h!.rowIndex, SOURCE, { minObservationsPerRow: 2 });
  const issues = checkSanity(bad);
  assert(issues.some((i) => i.metric === "occupancy"), "did not detect the broken occupancy");
});

check("warns when a core concept is missing", () => {
  // The warning is by CONCEPT, not by metric: an Annex A may carry only
  // economic occupancy or only underwritten NOI, and that is not a problem.
  const rows = buildRows(["Property Name", "City", "State", "Units", "Year Built"], [
    ["A", "X", "SC", 100, 2000],
    ["B", "Y", "AZ", 200, 2010],
  ]);
  const h = findHeaderRow(rows, { minMatches: 3 })!;
  const thin = rowsToObservations(rows, h.rowIndex, SOURCE, { minObservationsPerRow: 2 });
  const issues = checkSanity(thin);
  assert(issues.some((i) => i.metric === "NOI"), `avisos: ${issues.map((i) => i.metric).join(", ")}`);
});

check("does not warn if the concept is covered by a variant", () => {
  // Economic occupancy only: it should not complain about the physical one.
  const rows = buildRows(
    ["Property Name", "Underwritten Economic Occupancy (%)", "UW NOI", "Original Balance"],
    [["A", "94.0%", "$1,000,000", "$11,000,000"], ["B", "91.0%", "$2,000,000", "$22,000,000"]],
  );
  const h = findHeaderRow(rows, { minMatches: 3 })!;
  const result = rowsToObservations(rows, h.rowIndex, SOURCE, { minObservationsPerRow: 3 });
  const issues = checkSanity(result);
  assert(
    !issues.some((i) => i.metric === "occupancy"),
    `it warned anyway: ${issues.map((i) => i.message).join("; ")}`,
  );
});

// ---------------------------------------------------------------------------

console.log("\nSelecting the filing with the Annex A");

/**
 * Real filings observed on EDGAR (August 2026), from three different issuer
 * families. Each names and describes its Annex A in its own way.
 *
 * If an issuer turns up that breaks the mapping, add its case HERE before
 * touching scoreAnnexFiling's weights.
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
  // Generic "FWP" description, and the term sheet weighs almost the same.
  { issuer: "Benchmark", form: "FWP", documentName: "n5676_x3-annexa.htm", documentDescription: "FWP", sizeBytes: 8_910_695, isAnnex: true },
  { issuer: "Benchmark", form: "FWP", documentName: "n5676_x4-ts.htm", documentDescription: "FWP", sizeBytes: 6_899_495, isAnnex: false },
  { issuer: "Benchmark", form: "FWP", documentName: "n5676_x12-xafinpricdetails.htm", documentDescription: "FWP", sizeBytes: 16_009, isAnnex: false },
  { issuer: "Benchmark", form: "424H", documentName: "n5676_x5-424h.htm", documentDescription: "424H", sizeBytes: 21_777_523, isAnnex: false },

  // BANK5 2026-5YR20 (CIK 2104049)
  // Description "FREE WRITING PROSPECTUS" — yet another spelling.
  { issuer: "BANK5", form: "FWP", documentName: "n5543_x4-annexa1.htm", documentDescription: "FREE WRITING PROSPECTUS", sizeBytes: 15_798_735, isAnnex: true },
  { issuer: "BANK5", form: "FWP", documentName: "n5543_x5-ts.htm", documentDescription: "FWP", sizeBytes: 8_465_975, isAnnex: false },
  { issuer: "BANK5", form: "FWP", documentName: "n5543_x9-xapricingdetails.htm", documentDescription: "FWP", sizeBytes: 15_796, isAnnex: false },

  // BANK 2026-BNK52 (CIK 2138709)
  // Abbreviates the annex to "a1" without writing "annex". In a run of 100
  // trusts this format was part of the 29 lost for not being recognised.
  { issuer: "BNK52", form: "FWP", documentName: "n5947_x2-a1.htm", documentDescription: "FWP", sizeBytes: 3_774_325, isAnnex: true },
  { issuer: "BNK52", form: "FWP", documentName: "n5947_x3-ts.htm", documentDescription: "FWP", sizeBytes: 8_028_283, isAnnex: false },
  { issuer: "BNK52", form: "FWP", documentName: "n5947_x15-xapricing.htm", documentDescription: "FWP", sizeBytes: 16_003, isAnnex: false },
  { issuer: "BNK52", form: "424H", documentName: "n5947_x5-424h.htm", documentDescription: "424H", sizeBytes: 18_131_627, isAnnex: false },

  // The "anx" family: "annex" abbreviated. It came from diagnosing 36 failed
  // trusts. Careful with the term sheets of the same family: they weigh MORE
  // than the annex, so a size threshold would let them through and leave the
  // annex out.
  { issuer: "anx-a", form: "FWP", documentName: "n4501-x4_anxa.htm", documentDescription: "FREE WRITING PROSPECTUS", sizeBytes: 3_300_000, isAnnex: true },
  { issuer: "anx-a", form: "FWP", documentName: "n4501_x8-premktts.htm", documentDescription: "", sizeBytes: 5_700_000, isAnnex: false },
  { issuer: "anx-b", form: "FWP", documentName: "n4385-x4anxa1.htm", documentDescription: "FREE WRITING PROSPECTUS", sizeBytes: 2_600_000, isAnnex: true },
  { issuer: "anx-b", form: "FWP", documentName: "n4385-x5ts.htm", documentDescription: "FREE WRITING PROSPECTUS", sizeBytes: 7_400_000, isAnnex: false },
  { issuer: "anx-c", form: "FWP", documentName: "n4706-x6_anx1.htm", documentDescription: "ANNEX A-1", sizeBytes: 2_800_000, isAnnex: true },
  { issuer: "anx-c", form: "FWP", documentName: "n4706-x7_ts.htm", documentDescription: "PRELIMINARY TERM SHEET", sizeBytes: 7_900_000, isAnnex: false },
];

check("recognises the Annex A of all three issuer families", () => {
  for (const f of REAL_FILINGS.filter((x) => x.isAnnex)) {
    const score = scoreAnnexFiling(f);
    assert(score >= 0.5, `${f.issuer} "${f.documentName}" tuvo ${score.toFixed(2)}, esperaba ≥ 0.5`);
  }
});

check("no non-Annex-A document passes the threshold", () => {
  for (const f of REAL_FILINGS.filter((x) => !x.isAnnex)) {
    const score = scoreAnnexFiling(f);
    assert(score < 0.5, `${f.issuer} "${f.documentName}" scored ${score.toFixed(2)}, it should be left out`);
  }
});

check("within each issuer, the Annex A wins", () => {
  for (const issuer of new Set(REAL_FILINGS.map((f) => f.issuer))) {
    const scored = REAL_FILINGS.filter((f) => f.issuer === issuer)
      .map((f) => ({ ...f, score: scoreAnnexFiling(f) }))
      .sort((a, b) => b.score - a.score);
    assert(scored[0]!.isAnnex, `in ${issuer} the winner was "${scored[0]!.documentName}" (${scored[0]!.score.toFixed(2)})`);
  }
});

check("the term sheet does not slip through despite weighing 6-8 MB", () => {
  // This is the case that broke the size-based heuristic.
  for (const f of REAL_FILINGS.filter((x) => /-ts\.htm$/.test(x.documentName))) {
    const score = scoreAnnexFiling(f);
    assert(score < 0.5, `"${f.documentName}" (${(f.sizeBytes / 1e6).toFixed(1)} MB) tuvo ${score.toFixed(2)}`);
  }
});

check("the description varies between issuers and is not relied on", () => {
  const descriptions = new Set(REAL_FILINGS.filter((f) => f.isAnnex).map((f) => f.documentDescription));
  assert(descriptions.size >= 3, `expected variety, there are: ${[...descriptions].join(" | ")}`);
  // Even with an empty description, the name should be enough.
  const score = scoreAnnexFiling({
    form: "FWP", documentName: "n5676_x3-annexa.htm", documentDescription: "", sizeBytes: 8_910_695,
  });
  assert(score >= 0.5, `with no description it scored ${score.toFixed(2)}`);
});

check("discards forms that never carry an Annex A", () => {
  for (const form of ["10-D", "10-K", "ABS-EE", "8-K", "ABS-15G"]) {
    eq(scoreAnnexFiling({ form, documentName: "annexa1.htm", documentDescription: "ANNEX A-1", sizeBytes: 4_000_000 }), 0, form);
  }
});

check("the prospectus works as a fallback when there is no dedicated Annex", () => {
  // 11 of 36 failed trusts publish the annex inside the prospectus rather than
  // as a filing of its own. The parser is format-agnostic, so it is worth
  // trying —but only as a fallback: these are 15-22 MB documents.
  assert(
    scoreProspectusFallback({ form: "424B2", documentName: "n4362_x19-424b2.htm", sizeBytes: 17_400_000 }) > 0,
    "a large 424B2 should work as a fallback",
  );
  assert(
    scoreProspectusFallback({ form: "424H", documentName: "n4501_x5-424h.htm", sizeBytes: 15_700_000 }) > 0,
    "a large 424H too",
  );
  eq(
    scoreProspectusFallback({ form: "424B2", documentName: "small.htm", sizeBytes: 1_000_000 }),
    0,
    "a small prospectus does not carry the full pool",
  );
  eq(
    scoreProspectusFallback({ form: "FWP", documentName: "n4385-x5ts.htm", sizeBytes: 7_400_000 }),
    0,
    "an FWP is not a prospectus",
  );
});

check("the final prospectus is preferred over the preliminary one", () => {
  const final = scoreProspectusFallback({ form: "424B2", documentName: "a.htm", sizeBytes: 17_000_000 });
  const preliminary = scoreProspectusFallback({ form: "424H", documentName: "b.htm", sizeBytes: 17_000_000 });
  assert(final > preliminary, `424B2 ${final} should beat 424H ${preliminary}`);
});

check("an unrecognisable name does NOT reach the threshold on size alone", () => {
  // It is the known failure mode: if an issuer does not put "annex" in the
  // name, the harvester does not find it and you have to inspect with
  // `filings <cik>`.
  const score = scoreAnnexFiling({
    form: "FWP", documentName: "d123456dfwp.htm", documentDescription: "", sizeBytes: 3_500_000,
  });
  assert(score < 0.5, `it scored ${score.toFixed(2)} — size alone should not be enough`);
});

// ---------------------------------------------------------------------------

console.log("\nHTML table parsing");

/** HTML shaped like an Annex A: headers across two rows and colspan. */
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

check("extracts tables from an HTML document", () => {
  const tables = extractFromHtml(ANNEX_HTML);
  eq(tables.length, 1, "number of tables");
});

check("merges headers split across two rows", () => {
  const tables = extractFromHtml(ANNEX_HTML);
  const header = tables[0]!.rows[0]!.map((c) => String(c ?? ""));
  assert(
    header.some((h) => /underwritten/i.test(h) && /noi/i.test(h)),
    `did not merge: ${JSON.stringify(header)}`,
  );
});

check("expands colspan so the columns do not shift", () => {
  const html = `<table>
    <tr><td colspan="3">Group</td><td>Loose</td></tr>
    <tr><td>a</td><td>b</td><td>c</td><td>d</td></tr>
    <tr><td>1</td><td>2</td><td>3</td><td>4</td></tr>
  </table>`;
  const rows = extractFromHtml(html)[0]!.rows;
  const dataRow = rows[rows.length - 1]!;
  eq(dataRow.length, 4, "width of the data row");
});

check("cleans &nbsp; and surplus whitespace", () => {
  const html = `<table>
    <tr><th>Property&nbsp;&nbsp;Name</th><th>  NOI  </th><th>Occupancy</th></tr>
    <tr><td>A</td><td>$1,000</td><td>90%</td></tr>
    <tr><td>B</td><td>$2,000</td><td>91%</td></tr>
  </table>`;
  const header = extractFromHtml(html)[0]!.rows[0]!.map((c) => String(c ?? ""));
  assert(header.includes("Property Name"), `did not clean: ${JSON.stringify(header)}`);
  assert(header.includes("NOI"), `did not clean NOI: ${JSON.stringify(header)}`);
});

check("does not merge when the second row carries data", () => {
  const html = `<table>
    <tr><th>Property Name</th><th>NOI</th><th>Occupancy</th></tr>
    <tr><td>Riverbend</td><td>$4,120,000</td><td>95.2%</td></tr>
    <tr><td>Gateway</td><td>$5,900,000</td><td>100%</td></tr>
  </table>`;
  const rows = extractFromHtml(html)[0]!.rows;
  eq(String(rows[0]![0]), "Property Name", "merged too much");
  eq(rows.length, 3, "lost rows");
});

check("ignores layout tables", () => {
  const html = `<table><tr><td>solo layout</td></tr></table>
                <table>
                  <tr><th>Property Name</th><th>NOI</th><th>Occupancy</th></tr>
                  <tr><td>A</td><td>$1</td><td>90%</td></tr>
                  <tr><td>B</td><td>$2</td><td>91%</td></tr>
                </table>`;
  eq(extractFromHtml(html).length, 1, "only one should remain");
});

check("HTML reaches observations through the pipeline unchanged", () => {
  const tables = extractFromHtml(ANNEX_HTML);
  const h = findHeaderRow(tables[0]!.rows, { minMatches: 3 });
  assert(h, "no headers found in the HTML");

  const result = rowsToObservations(tables[0]!.rows, h!.rowIndex, SOURCE, { minObservationsPerRow: 3 });
  eq(result.stats.propertiesKept, 2, "propiedades");
  eq(result.properties[0]!.label.property_name, "Riverbend Apartments", "nombre");

  const occ = result.properties[0]!.observations.find((o) => o.metric_key === "occupancy");
  eq(occ?.value, "0.952", "ocupancia");
});

check("extractTables picks the parser by extension", () => {
  const htmlBuf = Buffer.from(ANNEX_HTML, "utf8");
  eq(extractTables(htmlBuf, "annexa1.htm").length, 1, "html");

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]), "S1");
  const xlsxBuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  eq(extractTables(xlsxBuf, "annexa1.xlsx").length, 1, "xlsx");

  let threw = false;
  try { extractTables(Buffer.from(""), "doc.pdf"); } catch { threw = true; }
  assert(threw, "it should fail on an unsupported format");
});

// ---------------------------------------------------------------------------

console.log("\nRoundtrip through a real xlsx");

check("reads a generated xlsx and harvests it end to end", () => {
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
  assert(h, "no headers found after the roundtrip");

  const result = rowsToObservations(rows, h!.rowIndex, SOURCE);
  eq(result.stats.propertiesKept, 1, "propiedades");
  eq(result.properties[0]!.label.property_name, "Aster Ridge", "nombre");

  const occ = result.properties[0]!.observations.find((o) => o.metric_key === "occupancy")!;
  eq(occ.value, "0.931", "ocupancia");
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The six names of the loan identifier
// ---------------------------------------------------------------------------

/**
/**
 * The 2020-2021 issuances name this column in six different ways. Without
 * covering them, 33 issuances and 2,919 loans were left with no identifier —they
 * harvested fine, but afterwards did not match their performance.
 *
 * The negative cases matter more than the positive ones: "Mortgage Loan Seller"
 * appears in nine filings and matches /mortgage\s*loan/ perfectly. A generous
 * pattern with no exclusions would store the bank's name as the identifier,
 * which is worse than having none: the join would return zero and it would look
 * like a data problem rather than a mapping one.
 */
check("identifier: the six real names", () => {
  const positivos = [
    "Loan ID", "Loan ID Number", "Mortgage Loan Number",
    "Control Number", "Loan #", "Loan No.",
  ];
  for (const header of positivos) {
    const { matches } = mapColumns([header, "Property Name", "UW NOI", "Cut-off Date Balance"]);
    const hit = matches.find((m) => m.metric.key === "loan_id");
    assert(hit?.header === header, `"${header}" did not map to loan_id`);
  }
});

check("identifier: what must NOT be taken", () => {
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
    assert(!hit, `"${header}" mapped to loan_id and should not have`);
  }
});

/**
 * "Loan" and "Loan/Prop." are the same column under two names, and neither is
 * the identifier. I mapped the first one wrong and the suite blessed it: there
 * was a test asserting that "Loan" went to loan_id. A test can fix an error just
 * as firmly as it fixes a correct behaviour.
 */
check("Loan and Loan/Prop. are the flag, not the identifier", () => {
  for (const header of ["Loan/Prop.", "Loan"]) {
    const { matches } = mapColumns([header, "Property Name", "UW NOI", "City"]);
    const flag = matches.find((m) => m.metric.key === "loan_property_flag");
    const id = matches.find((m) => m.metric.key === "loan_id");
    assert(flag?.header === header, `"${header}" did not map to the flag`);
    assert(!id, `"${header}" was taken by loan_id: the property rows would be counted as loans`);
  }
});

check("Loan/Prop. still goes to the flag", () => {
  const { matches } = mapColumns(["Loan/Prop.", "Property Name", "UW NOI", "City"]);
  const flag = matches.find((m) => m.metric.key === "loan_property_flag");
  const id = matches.find((m) => m.metric.key === "loan_id");
  assert(flag?.header === "Loan/Prop.", "did not map to the flag");
  assert(!id, "taken by loan_id: the property rows would again be counted as loans");
});

check("identifier and flag coexist in the same Annex A", () => {
  const { matches } = mapColumns([
    "Mortgage Loan Number", "Loan/Prop.", "Property Name", "UW NOI",
  ]);
  const keys = matches.map((m) => m.metric.key);
  assert(keys.includes("loan_id" as never), "loan_id is missing");
  assert(keys.includes("loan_property_flag" as never), "loan_property_flag is missing");
});

check("Total Debt Cut-off Date Balance has its own metric", () => {
  const { matches } = mapColumns([
    "Cut-off Date Balance ($)",
    "Total Debt Cut-off Date Balance ($)",
    "Whole Loan Cut-off Date Balance ($)",
  ]);
  const byKey = new Map(matches.map((m) => [m.metric.key, m.header]));
  assert(byKey.get("loan_amount" as never) === "Cut-off Date Balance ($)", "loan_amount took another one");
  assert(
    byKey.get("balance_total_debt" as never) === "Total Debt Cut-off Date Balance ($)",
    "balance_total_debt did not map",
  );
  assert(
    byKey.get("balance_whole_loan" as never) === "Whole Loan Cut-off Date Balance ($)",
    "balance_whole_loan did not map",
  );
});

/**
 * The two-column header of the 2020 issuances.
 *
 * A real row from Benchmark 2020-B16:
 *
 *   | Loan | ID | Property Name | ... |
 *   | Loan | 1  | Harrison Retail | ... |
 *
 * The first is the flag and the second the identifier. Without covering the
 * bare "ID", no block of those Annex A files has a join key and the horizontal
 * join collapses 83 loans into 1.
 */
check("2020 format: Loan is the flag and ID is the identifier", () => {
  const { matches } = mapColumns([
    "Loan", "ID", "Property Name", "Cut-off Date Balance($)", "Underwritten NOI($)",
  ]);
  const byKey = new Map(matches.map((m) => [m.metric.key, m.header]));
  assert(byKey.get("loan_property_flag" as never) === "Loan", "the flag did not take 'Loan'");
  assert(byKey.get("loan_id" as never) === "ID", "the identifier did not take 'ID'");
});

check("a bare ID is not confused with other columns", () => {
  for (const header of ["Property ID", "Loan ID Number", "Identification"]) {
    const { matches } = mapColumns([header, "ID", "Property Name", "UW NOI"]);
    const id = matches.find((m) => m.metric.key === "loan_id");
    assert(id?.header === "ID" || id?.header === "Loan ID Number",
      `with "${header}" present, loan_id took ${JSON.stringify(id?.header)}`);
  }
});

/**
 * Numbers split by a space.
 *
 * They appear in real Annex A files as issuer typos: Benchmark 2020-B16
 * publishes "48 5%" where "48.5%" belongs. Stripping the space along with the
 * commas turned it into 485% and put it into the corpus as 4.85.
 */
check("a number with a space in the middle is not a number", () => {
  for (const raw of ["13 1%", "48 5%", "1 234", "12 5", "$1 500 000"]) {
    assert(parseValue(raw, "percent") === null, `"${raw}" produjo un porcentaje`);
    assert(parseValue(raw, "currency") === null, `"${raw}" produjo un monto`);
  }
});

check("the legitimate formats still work", () => {
  assert(parseValue("13.1%", "percent") === "0.131", "13.1% broke");
  assert(parseValue("1,234,567", "currency") === "1234567", "thousands with commas broke");
  assert(parseValue(" 65.8% ", "percent") === "0.658", "surrounding spaces broke");
  assert(parseValue("(1,234)", "currency") === "-1234", "parentheses broke");
  assert(parseValue("1.45x", "ratio") === "1.45", "the x suffix broke");
});

console.log(
  `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} ok · ${failed} failed\x1b[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);

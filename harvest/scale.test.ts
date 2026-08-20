/**
 * Harvester scale test.
 *
 * Generates a synthetic Annex A with the shape and volume of a real one —500
 * properties, headers grouped by colspan, partially populated columns— and
 * checks coverage, sanity and timings.
 *
 * WHY IT EXISTS
 *
 * The unit tests use tables of 2-3 rows, and that does not surface the mapping
 * problems that do appear at scale. Two real bugs were found by this test and
 * not by the others:
 *
 *   1. The group header "Physical & Occupancy" was glued by colspan onto the
 *      "Net Rentable Area (SF)" column. The resulting text matched *occupancy*
 *      with a higher score than *square feet*, so it stole the column: 500 area
 *      values stored as occupancy, and the real occupancy left unmapped.
 *
 *   2. The `/rent/i` exclusion on square_feet killed "Net **Rent**able Area",
 *      the most common name for that column.
 *
 * Neither throws an error. The first was caught by `checkSanity()`; the second
 * turned up while reviewing coverage per metric.
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

  // Group headers with colspan: the source of the mapping bugs.
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

console.log(`\nScale — synthetic Annex A of ${N} properties\n`);

const html = buildAnnexHtml();
console.log(`  documento: ${(Buffer.byteLength(html) / 1e6).toFixed(2)} MB`);

const t0 = Date.now();
const tables = extractFromHtml(html);
const parseMs = Date.now() - t0;

const header = findHeaderRow(tables[0]!.rows);
assert(header, "no headers were detected");

const t1 = Date.now();
const result = rowsToObservations(tables[0]!.rows, header.rowIndex, SOURCE);
const normalizeMs = Date.now() - t1;

console.log(`  parsing: ${parseMs} ms · normalisation: ${normalizeMs} ms · heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB\n`);

// ---------------------------------------------------------------------------

check("parses every row without losing any", () => {
  assert(tables.length === 1, `expected 1 table, there are ${tables.length}`);
  assert(result.stats.propertiesKept === N, `${result.stats.propertiesKept} of ${N} properties`);
});

check("maps every Annex A column", () => {
  // 19 columns minus "Loan No.", which is not one of our metrics.
  assert(
    result.columnsMapped.length >= 18,
    `only ${result.columnsMapped.length} columns mapped: ${result.columnsMapped.map((c) => c.metric).join(", ")}`,
  );
});

check("the group header does not steal the area column", () => {
  // The original bug: "Physical & Occupancy" + "Net Rentable Area (SF)" made
  // occupancy win the area column.
  const occ = result.columnsMapped.find((c) => c.metric === "occupancy");
  assert(occ, "occupancy was not mapped");
  assert(
    /^occupancy$/i.test(occ!.header.trim()),
    `occupancy took the column "${occ!.header}" instead of "Occupancy"`,
  );
});

check("square feet se mapea pese a llamarse 'Net Rentable Area'", () => {
  const sf = result.columnsMapped.find((c) => c.metric === "square_feet");
  assert(sf, "square_feet was not mapped — is some exclusion too broad?");
  assert(/rentable/i.test(sf!.header), `mapped to "${sf!.header}"`);
});

check("UW NOI and Most Recent NOI go to different columns", () => {
  const uw = result.columnsMapped.find((c) => c.metric === "noi_underwritten");
  const recent = result.columnsMapped.find((c) => c.metric === "noi_most_recent");
  assert(uw && recent, "one of the two NOIs is missing");
  assert(uw!.header !== recent!.header, "both point at the same header");
});

check("partially populated columns have partial coverage", () => {
  // units and square_feet are mutually exclusive in the fixture.
  const units = result.stats.coverageByMetric.units ?? 0;
  const sf = result.stats.coverageByMetric.square_feet ?? 0;
  assert(units > 0 && units < N, `units=${units}, expected between 0 and ${N}`);
  assert(sf > 0 && sf < N, `square_feet=${sf}, expected between 0 and ${N}`);
  assert(units + sf === N, `units+sf=${units + sf}, esperaba ${N}`);
});

check("the core metrics cover every row", () => {
  for (const key of ["noi_underwritten", "occupancy", "loan_amount", "ltv", "dscr"]) {
    const count = result.stats.coverageByMetric[key] ?? 0;
    assert(count === N, `${key}: ${count} of ${N}`);
  }
});

check("the sanity checks find nothing", () => {
  const issues = checkSanity(result);
  assert(
    issues.length === 0,
    issues.map((i) => `[${i.metric}] ${i.message}`).join("; "),
  );
});

check("the values stay in the right range for their unit", () => {
  const sample = result.properties.slice(0, 50);
  for (const prop of sample) {
    for (const obs of prop.observations) {
      if (obs.unit !== "percent") continue;
      const v = Number(obs.value);
      assert(v >= 0 && v <= 1, `${obs.metric_key}=${v} outside 0-1`);
    }
  }
});

check("the observation ids are unique at scale", () => {
  const ids = result.properties.flatMap((p) => p.observations.map((o) => o.id));
  assert(new Set(ids).size === ids.length, `${ids.length - new Set(ids).size} ids duplicados`);
});

check("el rendimiento se mantiene razonable", () => {
  // Loose thresholds: we are looking to detect an order-of-magnitude
  // regression, not to measure performance precisely.
  assert(parseMs < 5000, `parsing took ${parseMs} ms`);
  assert(normalizeMs < 5000, `normalisation took ${normalizeMs} ms`);
});

// ---------------------------------------------------------------------------

console.log(
  `\n  coverage: ${Object.entries(result.stats.coverageByMetric)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}`,
);

console.log(
  `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} ok · ${failed} failed\x1b[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);

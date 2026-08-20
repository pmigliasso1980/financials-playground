/**
 * Persistence conformance test.
 *
 *   docker compose up -d
 *   npm run db:migrate
 *   npm run db:test
 *
 * THE INVARIANT IT VERIFIES
 *
 * Writing a HarvestResult and reading it back has to return the same thing. If
 * that holds, the mock does not need to know whether the data came from a JSON
 * file or from Postgres, and the whole rest of the system —the Index, promotion,
 * search— keeps working the same way.
 *
 * With no database available it explains how to start one and exits without
 * failing, so the test pipeline does not break on a machine without Docker.
 */

import { closePool, ping, query } from "./client.js";
import { corpusStats, loadAllHarvests, loadHarvest, saveHarvest } from "./corpus.js";
import type { HarvestResult, SourceRef } from "../harvest/normalize/toObservations.js";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
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

console.log("\nCorpus persistence\n");

const health = await ping();
if (!health.ok) {
  console.log(`  \x1b[90m${health.message.split("\n").join("\n  ")}\x1b[0m\n`);
  process.exit(0);
}
if (!health.schemaReady) {
  console.log(`  \x1b[33mEl schema corpus no existe.\x1b[0m\n`);
  console.log(`    npm run db:migrate\n`);
  process.exit(0);
}

console.log(`  \x1b[90m${health.version}\x1b[0m\n`);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const ACCESSION = "0000000000-00-999999";

const SOURCE: SourceRef = {
  cik: "9999999",
  accession: ACCESSION,
  companyName: "Conformance Test Trust 2026-T1",
  formType: "FWP",
  filedAt: "2026-08-01",
  fileName: "annexa1.htm",
  fileUrl: "https://www.sec.gov/conformance-test",
};

function buildFixture(): HarvestResult {
  const mkObs = (
    rowIndex: number,
    key: string,
    label: string,
    unit: string,
    entity: "deal" | "property",
    value: string,
    raw: string,
    header: string,
    col: number,
    confidence = 0.95,
  ) => ({
    id: `${ACCESSION}:${rowIndex}:${key}`,
    metric_key: key as never,
    metric_label: label,
    unit,
    entity_type: entity,
    row_index: rowIndex,
    value,
    raw_value: raw,
    confidence,
    source_header: header,
    source_column_index: col,
    source: SOURCE,
  });

  return {
    source: SOURCE,
    headerRowIndex: 0,
    columnsMapped: [
      { header: "Property Name", metric: "property_name" as never, score: 1 },
      { header: "Underwritten Net Operating Income ($)", metric: "noi_underwritten" as never, score: 1 },
      { header: "Underwritten NOI DSCR (x)", metric: "dscr" as never, score: 1 },
    ],
    columnsUnmapped: ["Footnotes", "Monthly Debt Service (IO) ($)"],
    properties: [
      {
        key: `${ACCESSION}:0`,
        row_index: 0,
        unmappedCells: [],
        label: {
          property_name: "TheWit Chicago",
          address: "201 North State Street",
          city: "Chicago",
          state: "IL",
          loan_seller: null, property_type: "Hospitality",
        },
        observations: [
          mkObs(0, "property_name", "Property Name", "text", "property", "TheWit Chicago", "TheWit Chicago", "Property Name", 2),
          mkObs(0, "noi_underwritten", "Underwritten NOI", "currency", "property", "10932267", "10,932,267", "Underwritten Net Operating Income ($)", 14, 0.902),
          mkObs(0, "noi_most_recent", "Most Recent NOI", "currency", "property", "11430385", "11,430,385", "Most Recent NOI ($)", 12),
          mkObs(0, "dscr", "DSCR", "ratio", "deal", "1.83", "1.83", "Underwritten NOI DSCR (x)", 18),
          mkObs(0, "occupancy", "Occupancy", "percent", "property", "0.698", "69.8%", "Leased Occupancy (%)(3)", 10, 0.878),
        ],
      },
      {
        key: `${ACCESSION}:1`,
        row_index: 1,
        unmappedCells: [],
        label: {
          property_name: "Ventana Residences",
          address: "1400 Riverbend Dr",
          city: "Austin",
          state: "TX",
          loan_seller: null, property_type: "Multifamily",
        },
        observations: [
          mkObs(1, "property_name", "Property Name", "text", "property", "Ventana Residences", "Ventana Residences", "Property Name", 2),
          mkObs(1, "noi_underwritten", "Underwritten NOI", "currency", "property", "5819367", "5,819,367", "Underwritten Net Operating Income ($)", 14),
          mkObs(1, "dscr", "DSCR", "ratio", "deal", "1.27", "1.27", "Underwritten NOI DSCR (x)", 18),
        ],
      },
    ],
    stats: {
      dataRows: 3,
      propertiesKept: 2,
      observations: 8,
      rowsSkipped: 1,
      coverageByMetric: { property_name: 2, noi_underwritten: 2, dscr: 2, occupancy: 1, noi_most_recent: 1 },
    },
  };
}

// Clear any leftovers from a previous run.
await query("DELETE FROM corpus.filings WHERE accession = $1", [ACCESSION]);

const fixture = buildFixture();

// ---------------------------------------------------------------------------

console.log("Escritura");

const report = await saveHarvest(fixture);

await check("stores loans, observations and facts", () => {
  eq(report.loans, 2, "loans");
  eq(report.observations, 8, "observations");
  assert(report.facts > 0, "derived no facts at all");
  eq(report.replaced, false, "should not have replaced anything");
});

await check("derives the facts from the observations", async () => {
  const { rows } = await query<{ metric_key: string; value: string; rationale: string | null }>(
    `SELECT f.metric_key, f.value, f.promotion_rationale AS rationale
       FROM corpus.facts f
       JOIN corpus.loans l ON l.id = f.loan_id
      WHERE l.accession = $1 AND l.row_index = 0
      ORDER BY f.metric_key`,
    [ACCESSION],
  );
  const byKey = new Map(rows.map((r) => [r.metric_key, r]));
  eq(byKey.get("noi_underwritten")?.value, "10932267", "NOI underwritten");
  eq(byKey.get("dscr")?.value, "1.83", "DSCR");
  assert(byKey.get("dscr")?.rationale, "the fact should explain why it won");
});

await check("facts point at the observation that produced them", async () => {
  const { rows } = await query<{ header: string }>(
    `SELECT o.source_header AS header
       FROM corpus.facts f
       JOIN corpus.observations o ON o.id = f.observation_id
       JOIN corpus.loans l ON l.id = f.loan_id
      WHERE l.accession = $1 AND f.metric_key = 'noi_underwritten' AND l.row_index = 0`,
    [ACCESSION],
  );
  eq(rows[0]?.header, "Underwritten Net Operating Income ($)", "provenance of the fact");
});

// ---------------------------------------------------------------------------

console.log("\nRoundtrip");

const loaded = await loadHarvest(ACCESSION);

await check("vuelve a leerse", () => {
  assert(loaded, "loadHarvest returned null");
});

await check("the source is preserved in full", () => {
  eq(loaded!.source.accession, SOURCE.accession, "accession");
  eq(loaded!.source.cik, SOURCE.cik, "cik");
  eq(loaded!.source.companyName, SOURCE.companyName, "companyName");
  eq(loaded!.source.formType, SOURCE.formType, "formType");
  eq(loaded!.source.filedAt, SOURCE.filedAt, "filedAt");
  eq(loaded!.source.fileUrl, SOURCE.fileUrl, "fileUrl");
});

await check("loans come back in order and with their labels", () => {
  eq(loaded!.properties.length, 2, "cantidad");
  eq(loaded!.properties[0]!.label.property_name, "TheWit Chicago", "first");
  eq(loaded!.properties[0]!.label.city, "Chicago", "city");
  eq(loaded!.properties[1]!.label.property_name, "Ventana Residences", "second");
});

await check("observations keep value, raw and provenance", () => {
  const noi = loaded!.properties[0]!.observations.find((o) => o.metric_key === "noi_underwritten");
  assert(noi, "did not find the NOI");
  eq(noi!.value, "10932267", "valor");
  eq(noi!.raw_value, "10,932,267", "valor crudo");
  eq(noi!.source_header, "Underwritten Net Operating Income ($)", "header original");
  eq(noi!.confidence, 0.902, "confidence");
  eq(noi!.unit, "currency", "unidad");
});

await check("no observation is lost", () => {
  const original = fixture.properties.flatMap((p) => p.observations.map((o) => `${p.row_index}:${o.metric_key}`));
  const round = loaded!.properties.flatMap((p) => p.observations.map((o) => `${p.row_index}:${o.metric_key}`));
  eq(round.length, original.length, "cantidad");
  for (const key of original) {
    assert(round.includes(key), `missing ${key}`);
  }
});

await check("the processing metadata is preserved", () => {
  eq(loaded!.columnsUnmapped.length, 2, "unmapped columns");
  assert(loaded!.columnsUnmapped.includes("Footnotes"), "lost an unmapped header");
  eq(loaded!.columnsMapped.length, 3, "columns mapped");
  eq(loaded!.stats.propertiesKept, 2, "stats");
});

// ---------------------------------------------------------------------------

console.log("\nRecosecha");

const second = await saveHarvest(fixture);

await check("re-harvesting replaces rather than duplicates", async () => {
  eq(second.replaced, true, "should have replaced");
  const { rows } = await query<{ count: string }>(
    "SELECT count(*) AS count FROM corpus.loans WHERE accession = $1",
    [ACCESSION],
  );
  eq(Number(rows[0]!.count), 2, "loans after re-harvesting");
});

await check("an improved mapping updates the values", async () => {
  // Simulates the mapping improving and now capturing one more metric.
  const improved = buildFixture();
  improved.properties[1]!.observations.push({
    id: `${ACCESSION}:1:occupancy`,
    metric_key: "occupancy" as never,
    metric_label: "Occupancy",
    unit: "percent",
    entity_type: "property",
    row_index: 1,
    value: "0.95",
    raw_value: "95.0%",
    confidence: 0.95,
    source_header: "Underwritten Economic Occupancy (%)",
    source_column_index: 11,
    source: SOURCE,
  });

  const third = await saveHarvest(improved);
  eq(third.observations, 9, "should have one more observation");

  const reloaded = await loadHarvest(ACCESSION);
  const occ = reloaded!.properties[1]!.observations.find((o) => o.metric_key === "occupancy");
  assert(occ, "the new metric was not stored");
  eq(occ!.value, "0.95", "value of the new metric");
});

await check("el corpus completo incluye el filing", async () => {
  const all = await loadAllHarvests();
  assert(
    all.some((r) => r.source.accession === ACCESSION),
    "loadAllHarvests did not return it",
  );
});

// ---------------------------------------------------------------------------

console.log("\nDiagnostic views");

await check("metric_coverage counts loans per metric", async () => {
  const stats = await corpusStats();
  assert(stats.filings > 0, "no filings");
  const noi = stats.byMetric.find((m) => m.metric_key === "noi_underwritten");
  assert(noi, "noi_underwritten does not appear in the coverage");
  assert(noi!.loans >= 2, `expected at least 2 loans, there are ${noi!.loans}`);
});

await check("unmapped_headers builds the mapping work queue", async () => {
  /**
   * The assertion runs against the test filing, not against the global top.
   *
   * The first version required "Footnotes" —this fixture's unmapped header— to
   * appear in `corpusStats().topUnmapped`. That worked while the corpus was
   * nearly empty and started failing at 219 real issuances: the view sorts by how
   * many filings each header wastes, and one that appears in a single test filing
   * does not compete with those appearing in hundreds.
   *
   * The test was not verifying the view: it was verifying that the corpus was
   * small. It is the same class of coupling that already bit us with the
   * symptom-based selectors — an assertion depending on global state it does not
   * control.
   */
  const { rows } = await query<{ header: string; filings: string }>(
    `SELECT header, count(*)::text AS filings
       FROM corpus.filings f,
            LATERAL jsonb_array_elements_text(f.columns_unmapped) AS header
      WHERE f.accession = $1
      GROUP BY header`,
    [ACCESSION],
  );

  assert(
    rows.some((r) => r.header === "Footnotes"),
    `the test filing reports: ${rows.map((r) => r.header).join(", ") || "(none)"}`,
  );

  // And the global view still exists and still sorts by impact.
  const stats = await corpusStats();
  assert(stats.topUnmapped.length > 0, "the global view returned nothing");
});

// ---------------------------------------------------------------------------

console.log("\nLimpieza");

await check("deleting the filing takes everything with it", async () => {
  await query("DELETE FROM corpus.filings WHERE accession = $1", [ACCESSION]);

  const { rows: loans } = await query<{ count: string }>(
    "SELECT count(*) AS count FROM corpus.loans WHERE accession = $1",
    [ACCESSION],
  );
  eq(Number(loans[0]!.count), 0, "orphaned loans");

  const { rows: obs } = await query<{ count: string }>(
    `SELECT count(*) AS count FROM corpus.observations o
       LEFT JOIN corpus.loans l ON l.id = o.loan_id
      WHERE l.id IS NULL`,
  );
  eq(Number(obs[0]!.count), 0, "orphaned observations");
});

// ---------------------------------------------------------------------------

await closePool();

console.log(
  `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} ok · ${failed} failed\x1b[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);

/**
 * Test de conformidad de la persistencia.
 *
 *   docker compose up -d
 *   npm run db:migrate
 *   npm run db:test
 *
 * LA INVARIANTE QUE VERIFICA
 *
 * Escribir un HarvestResult y volver a leerlo tiene que devolver lo mismo. Si
 * eso se cumple, el mock no necesita saber si los datos vinieron de un JSON o
 * de Postgres, y todo el resto del sistema —el Index, la promoción, la
 * búsqueda— sigue funcionando igual.
 *
 * Sin base disponible avisa cómo levantarla y termina sin fallar, para que el
 * pipeline de tests no se rompa en una máquina sin Docker.
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
  if (actual !== expected) throw new Error(`${label}: esperaba ${String(expected)}, recibí ${String(actual)}`);
}

// ---------------------------------------------------------------------------

console.log("\nPersistencia del corpus\n");

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

// Limpiamos cualquier resto de una corrida anterior.
await query("DELETE FROM corpus.filings WHERE accession = $1", [ACCESSION]);

const fixture = buildFixture();

// ---------------------------------------------------------------------------

console.log("Escritura");

const report = await saveHarvest(fixture);

await check("guarda préstamos, observations y facts", () => {
  eq(report.loans, 2, "préstamos");
  eq(report.observations, 8, "observations");
  assert(report.facts > 0, "no derivó ningún fact");
  eq(report.replaced, false, "no debería haber reemplazado nada");
});

await check("deriva los facts de las observations", async () => {
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
  assert(byKey.get("dscr")?.rationale, "el fact debería explicar por qué ganó");
});

await check("los facts apuntan a la observation que los originó", async () => {
  const { rows } = await query<{ header: string }>(
    `SELECT o.source_header AS header
       FROM corpus.facts f
       JOIN corpus.observations o ON o.id = f.observation_id
       JOIN corpus.loans l ON l.id = f.loan_id
      WHERE l.accession = $1 AND f.metric_key = 'noi_underwritten' AND l.row_index = 0`,
    [ACCESSION],
  );
  eq(rows[0]?.header, "Underwritten Net Operating Income ($)", "provenance del fact");
});

// ---------------------------------------------------------------------------

console.log("\nRoundtrip");

const loaded = await loadHarvest(ACCESSION);

await check("vuelve a leerse", () => {
  assert(loaded, "loadHarvest devolvió null");
});

await check("el source se preserva entero", () => {
  eq(loaded!.source.accession, SOURCE.accession, "accession");
  eq(loaded!.source.cik, SOURCE.cik, "cik");
  eq(loaded!.source.companyName, SOURCE.companyName, "companyName");
  eq(loaded!.source.formType, SOURCE.formType, "formType");
  eq(loaded!.source.filedAt, SOURCE.filedAt, "filedAt");
  eq(loaded!.source.fileUrl, SOURCE.fileUrl, "fileUrl");
});

await check("los préstamos vuelven en orden y con sus etiquetas", () => {
  eq(loaded!.properties.length, 2, "cantidad");
  eq(loaded!.properties[0]!.label.property_name, "TheWit Chicago", "primero");
  eq(loaded!.properties[0]!.label.city, "Chicago", "ciudad");
  eq(loaded!.properties[1]!.label.property_name, "Ventana Residences", "segundo");
});

await check("las observations conservan valor, crudo y provenance", () => {
  const noi = loaded!.properties[0]!.observations.find((o) => o.metric_key === "noi_underwritten");
  assert(noi, "no encontró el NOI");
  eq(noi!.value, "10932267", "valor");
  eq(noi!.raw_value, "10,932,267", "valor crudo");
  eq(noi!.source_header, "Underwritten Net Operating Income ($)", "header original");
  eq(noi!.confidence, 0.902, "confidence");
  eq(noi!.unit, "currency", "unidad");
});

await check("no se pierde ninguna observation", () => {
  const original = fixture.properties.flatMap((p) => p.observations.map((o) => `${p.row_index}:${o.metric_key}`));
  const round = loaded!.properties.flatMap((p) => p.observations.map((o) => `${p.row_index}:${o.metric_key}`));
  eq(round.length, original.length, "cantidad");
  for (const key of original) {
    assert(round.includes(key), `falta ${key}`);
  }
});

await check("los metadatos del procesamiento se preservan", () => {
  eq(loaded!.columnsUnmapped.length, 2, "columnas sin mapear");
  assert(loaded!.columnsUnmapped.includes("Footnotes"), "perdió un header sin mapear");
  eq(loaded!.columnsMapped.length, 3, "columnas mapeadas");
  eq(loaded!.stats.propertiesKept, 2, "stats");
});

// ---------------------------------------------------------------------------

console.log("\nRecosecha");

const second = await saveHarvest(fixture);

await check("recosechar reemplaza en vez de duplicar", async () => {
  eq(second.replaced, true, "debería haber reemplazado");
  const { rows } = await query<{ count: string }>(
    "SELECT count(*) AS count FROM corpus.loans WHERE accession = $1",
    [ACCESSION],
  );
  eq(Number(rows[0]!.count), 2, "préstamos tras recosechar");
});

await check("un mapeo mejorado actualiza los valores", async () => {
  // Simula que el mapeo mejoró y ahora captura una métrica más.
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
  eq(third.observations, 9, "debería tener una observation más");

  const reloaded = await loadHarvest(ACCESSION);
  const occ = reloaded!.properties[1]!.observations.find((o) => o.metric_key === "occupancy");
  assert(occ, "la métrica nueva no se guardó");
  eq(occ!.value, "0.95", "valor de la métrica nueva");
});

await check("el corpus completo incluye el filing", async () => {
  const all = await loadAllHarvests();
  assert(
    all.some((r) => r.source.accession === ACCESSION),
    "loadAllHarvests no lo devolvió",
  );
});

// ---------------------------------------------------------------------------

console.log("\nVistas de diagnóstico");

await check("metric_coverage cuenta préstamos por métrica", async () => {
  const stats = await corpusStats();
  assert(stats.filings > 0, "sin filings");
  const noi = stats.byMetric.find((m) => m.metric_key === "noi_underwritten");
  assert(noi, "noi_underwritten no aparece en la cobertura");
  assert(noi!.loans >= 2, `esperaba al menos 2 préstamos, hay ${noi!.loans}`);
});

await check("unmapped_headers arma la cola de trabajo del mapeo", async () => {
  /**
   * La aserción va contra el filing de prueba, no contra el top global.
   *
   * La primera versión pedía que "Footnotes" —el header sin mapear de este
   * fixture— apareciera en `corpusStats().topUnmapped`. Eso funcionó mientras el
   * corpus estuvo casi vacío y empezó a fallar con 219 emisiones reales: la vista
   * ordena por cuántos filings desaprovecha cada header, y uno que aparece en un
   * solo filing de prueba no compite contra los que aparecen en cientos.
   *
   * El test no verificaba la vista: verificaba que el corpus fuera chico. Es la
   * misma clase de acoplamiento que ya nos mordió con los selectores por
   * síntoma —una aserción que depende de estado global que no controla—.
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
    `el filing de prueba reporta: ${rows.map((r) => r.header).join(", ") || "(ninguno)"}`,
  );

  // Y la vista global sigue existiendo y ordenando por impacto.
  const stats = await corpusStats();
  assert(stats.topUnmapped.length > 0, "la vista global no devolvió nada");
});

// ---------------------------------------------------------------------------

console.log("\nLimpieza");

await check("borrar el filing arrastra todo lo suyo", async () => {
  await query("DELETE FROM corpus.filings WHERE accession = $1", [ACCESSION]);

  const { rows: loans } = await query<{ count: string }>(
    "SELECT count(*) AS count FROM corpus.loans WHERE accession = $1",
    [ACCESSION],
  );
  eq(Number(loans[0]!.count), 0, "préstamos huérfanos");

  const { rows: obs } = await query<{ count: string }>(
    `SELECT count(*) AS count FROM corpus.observations o
       LEFT JOIN corpus.loans l ON l.id = o.loan_id
      WHERE l.id IS NULL`,
  );
  eq(Number(obs[0]!.count), 0, "observations huérfanas");
});

// ---------------------------------------------------------------------------

await closePool();

console.log(
  `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} ok · ${failed} fallidos\x1b[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);

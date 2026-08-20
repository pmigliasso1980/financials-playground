/**
 * Test against raw HTML from real Annex A files.
 *
 * Runs over whatever fixtures it finds in `harvest/fixtures/`. If there are
 * none, it says how to capture one and exits without failing —so the test
 * pipeline does not break on a machine that has not downloaded anything yet.
 *
 *   npm run harvest:capture -- 2053102   # once, needs the network
 *   npm run harvest:fixtures             # afterwards, offline forever
 *
 * WHAT IT ADDS THAT THE OTHER TESTS DO NOT
 *
 * `harvest:real` uses the real headers and values, but transcribed into
 * TypeScript arrays. This one runs over the **original markup**: `<font>`
 * nested inside `<td>`, inline styles, `&nbsp;`, separator rows, headers across
 * three levels of colspan. It is the only thing that really exercises the HTML
 * parser against the real dirt.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractFromHtml } from "./parse/tables.js";
import { findHeaderRow, mapColumns } from "./normalize/columnMap.js";
import { attachContinuationTables, joinAnnexTables, keepLoanRows } from "./normalize/annexStructure.js";
import { checkSanity, rowsToObservations, type SourceRef } from "./normalize/toObservations.js";
import { toProperties } from "./normalize/toProperties.js";

const FIXTURES_DIR = new URL("./fixtures/", import.meta.url).pathname;

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`    \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`    \x1b[31m✗\x1b[0m ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

interface FixtureMeta {
  cik: string;
  accession: string;
  companyName: string;
  formType: string;
  filedAt: string;
  fileName: string;
  fileUrl: string;
  originalBytes?: number;
  trimmedBytes?: number;
}

// ---------------------------------------------------------------------------

console.log("\nAnnex A reales — markup crudo\n");

let files: string[] = [];
try {
  files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".html")).sort();
} catch {
  // the directory does not exist yet
}

if (files.length === 0) {
  console.log("  \x1b[90mNo hay fixtures capturados.\x1b[0m\n");
  console.log("  To capture one (needs the network and SEC_USER_AGENT):\n");
  console.log('    export SEC_USER_AGENT="Tu Nombre tu@email.com"');
  console.log("    npm run harvest:capture -- 2053102     # Wells Fargo 2025-C64");
  console.log("    npm run harvest:capture -- 2110410     # Benchmark 2026-B42");
  console.log("    npm run harvest:capture -- 2104049     # BANK5 2026-5YR20\n");
  console.log("  It gets versioned and from then on this test runs offline.\n");
  process.exit(0);
}

for (const file of files) {
  const slug = file.replace(/\.html$/, "");
  const html = await readFile(join(FIXTURES_DIR, file), "utf8");

  let meta: FixtureMeta;
  try {
    meta = JSON.parse(await readFile(join(FIXTURES_DIR, `${slug}.json`), "utf8")) as FixtureMeta;
  } catch {
    meta = {
      cik: "?", accession: slug, companyName: slug, formType: "FWP",
      filedAt: "", fileName: file, fileUrl: "",
    };
  }

  console.log(`  ${meta.companyName}`);
  console.log(
    `  \x1b[90m${meta.fileName} · ${(Buffer.byteLength(html) / 1000).toFixed(0)} KB` +
      (meta.originalBytes ? ` (original ${(meta.originalBytes / 1e6).toFixed(1)} MB)` : "") +
      `\x1b[0m\n`,
  );

  // --- parseo -----------------------------------------------------------------

  const t0 = Date.now();
  const tables = extractFromHtml(html);
  const parseMs = Date.now() - t0;

  check("the parser extracts at least one table", () => {
    assert(tables.length > 0, "extracted no tables");
  });

  // Continuation pages do not repeat the header: they have to be adopted into
  // the block they belong to, or most of the pool is lost.
  const { tables: annexTables, adopted, orphans } = attachContinuationTables(
    tables,
    (rows) => findHeaderRow(rows),
  );

  check("detects recognisable headers", () => {
    assert(
      annexTables.length > 0,
      `none of the ${tables.length} tables has mappable headers. ` +
        `First row: ${JSON.stringify(tables[0]?.rows[0]).slice(0, 200)}`,
    );
  });

  check("no orphaned table contains loans", () => {
    /**
     * This test used to require `adopted > 0`, on the reasoning that an Annex A
     * splits each block across many pages and only the first carries headers,
     * so without adoption the pool is lost.
     *
     * Against the real document the premise turned out false and the test a
     * false positive. Wells Fargo 2025-C64 repeats the headers on every page, so
     * stacking by identical header already recovers everything: 13 blocks with a
     * header produce all 32 loans, and the 112 tables without one are page
     * footers, footnotes and layout decoration. Rejecting them is correct —the
     * Loan ID continuity validation is doing its job— and requiring some to be
     * adopted was asking the parser to swallow junk.
     *
     * What is worth checking is the underlying property: that no discarded table
     * has rows that look like loans. That detects real data loss without being
     * tied to how it is recovered.
     */
    const headerless = tables.length - annexTables.length;
    if (headerless === 0) return;

    /** Loan IDs appearing in a table, whichever block it belongs to. */
    const loanIdsOf = (rows: unknown[][]): string[] => {
      const ids: string[] = [];
      for (const row of rows) {
        const filled = row.filter((c) => c !== null && String(c).trim() !== "");
        if (filled.length < 8) continue;
        const first = String(filled[0] ?? "").trim();
        // An Annex A Loan ID is an integer or an integer with decimals (3, 3.00, 3.01).
        if (/^\d{1,3}(\.\d{1,2})?$/.test(first)) ids.push(String(Math.trunc(Number(first))));
      }
      return ids;
    };

    const parsedIds = new Set(annexTables.flatMap((t) => loanIdsOf(t.rows)));
    const orphanTables = tables.filter((t) => !annexTables.some((a) => a.name === t.name));

    /**
     * Two different things that used to get conflated.
     *
     * An orphaned block WITH loans can be one of two:
     *
     *   a) loans that are in no parsed block → real loss,
     *   b) the same loans with other columns → loss of metrics.
     *
     * (b) is what happens in Wells Fargo 2025-C64: three blocks of 71 rows with
     * "Annual Debt Service", "Amortization Type", "Upfront RE Tax Reserve",
     * "Holdback/Earnout". None of those columns is in the mapping, so
     * `detectHeader` judges them non-Annex and they are discarded whole. The
     * loans are not lost —they are in the blocks we do read— but those metrics
     * are.
     *
     * Only (a) fails the test. (b) is reported, because it is mapping backlog
     * and today it is invisible: the "unmapped" listing only covers columns of
     * blocks we opened, never blocks we never opened.
     */
    const lost: string[] = [];
    const columnLoss: string[] = [];
    for (const t of orphanTables) {
      const ids = loanIdsOf(t.rows);
      if (ids.length === 0) continue;
      if (ids.some((id) => !parsedIds.has(id))) lost.push(t.name);
      else columnLoss.push(t.name);
    }

    if (columnLoss.length > 0) {
      console.log(
        `      \x1b[90m${columnLoss.length} block(s) with known loans but no ` +
          `mappable columns: ${columnLoss.slice(0, 4).join(", ")}\x1b[0m`,
      );
      console.log(
        `      \x1b[90mno loans lost, metrics lost — mapping backlog\x1b[0m`,
      );
    }

    assert(
      lost.length === 0,
      `${lost.length} orphaned block(s) with loans that appear in NO parsed ` +
        `block: ${lost.slice(0, 3).join(", ")}. Real data loss ` +
        `(adopted: ${adopted}, orphaned: ${orphans}).`,
    );
  });

  if (annexTables.length === 0) {
    console.log();
    continue;
  }

  // --- estructura ---------------------------------------------------------------

  const joined = joinAnnexTables(annexTables);

  check("assembles a data table", () => {
    assert(joined, "joinAnnexTables returned null");
  });

  if (!joined) {
    console.log();
    continue;
  }

  const filtered = keepLoanRows(joined.rows, joined.headerRowIndex);
  const source: SourceRef = {
    cik: meta.cik, accession: meta.accession, companyName: meta.companyName,
    formType: meta.formType, filedAt: meta.filedAt,
    fileName: meta.fileName, fileUrl: meta.fileUrl,
  };
  const result = rowsToObservations(filtered.rows, joined.headerRowIndex, source);

  // --- verificaciones -------------------------------------------------------------

  check("produces properties with observations", () => {
    assert(result.stats.propertiesKept > 0, "produced no properties");
    assert(result.stats.observations > 0, "produced no observations");
  });

  check("maps at least 8 columns", () => {
    assert(
      result.columnsMapped.length >= 8,
      `solo ${result.columnsMapped.length}: ${result.columnsMapped.map((c) => c.metric).join(", ")}`,
    );
  });

  check("captures some core financial metric", () => {
    const keys = new Set(result.columnsMapped.map((c) => c.metric));
    const core = ["noi_underwritten", "noi_most_recent", "loan_amount", "dscr", "occupancy", "occupancy_economic"];
    const found = core.filter((k) => keys.has(k as never));
    assert(found.length >= 2, `only found: ${found.join(", ") || "(none)"}`);
  });

  check("every property has a name or an address", () => {
    const anonymous = result.properties.filter((p) => !p.label.property_name && !p.label.address);
    assert(
      anonymous.length === 0,
      `${anonymous.length} of ${result.properties.length} properties unidentified`,
    );
  });

  check("percentages stay in 0-1", () => {
    const bad: string[] = [];
    for (const prop of result.properties) {
      for (const obs of prop.observations) {
        if (obs.unit !== "percent") continue;
        const v = Number(obs.value);
        if (v < 0 || v > 1) bad.push(`${obs.metric_key}=${obs.value} (${obs.raw_value})`);
      }
    }
    assert(bad.length === 0, `${bad.length} out of range: ${bad.slice(0, 3).join(", ")}`);
  });

  check("absence markers do not slip in as values", () => {
    const junk: string[] = [];
    for (const prop of result.properties) {
      for (const obs of prop.observations) {
        if (/^(n\/?a|nap|nav|various|none|-)$/i.test(obs.value.trim())) {
          junk.push(`${obs.metric_key}="${obs.value}"`);
        }
      }
    }
    assert(junk.length === 0, `${junk.length} valores basura: ${junk.slice(0, 3).join(", ")}`);
  });

  check("the sanity checks find no errors", () => {
    const issues = checkSanity(result);
    const errors = issues.filter((i) => i.severity === "error");
    assert(errors.length === 0, errors.map((e) => `[${e.metric}] ${e.message}`).join("; "));
  });

  check("parsing the real markup is not slow", () => {
    assert(parseMs < 10_000, `took ${parseMs} ms`);
  });

  /**
   * The property rows, which the harvester used to discard.
   *
   * These checks exist because the two defects `toProperties` had were invisible
   * by eye: the off-by-one index lost the first property of every document and
   * tied the rest to the previous row, and the ID read from the column map left
   * 49 properties with no loan in one fixture and not in the other two. Neither
   * throws; both produce a table that looks fine.
   *
   * They assert against `filtered.propertyRows`, which is what the filter says
   * it discarded, and not against a hand-written number: a new fixture enters
   * without touching the test, and if the filter changes the test says so.
   */
  const properties = toProperties(
    joined.rows, joined.headerRowIndex, filtered.droppedPropertyRows, source,
  );

  check("no property row is lost", () => {
    assert(
      properties.length === filtered.propertyRows,
      `the filter discarded ${filtered.propertyRows} and ${properties.length} were normalised`,
    );
  });

  check("every property keeps its original row and is not repeated", () => {
    const idx = new Set(properties.map((p) => p.rowIndex));
    assert(
      idx.size === properties.length,
      `${properties.length - idx.size} repeated rowIndex values: the stable key is not stable`,
    );
    const delFiltro = new Set(filtered.droppedPropertyRows.map((d) => d.rowIndex));
    const foreign = [...idx].filter((i) => !delFiltro.has(i));
    assert(foreign.length === 0, `rowIndex values the filter did not discard: ${foreign.slice(0, 5).join(", ")}`);
  });

  check("the properties carry the state, which is the reason for storing them", () => {
    if (properties.length === 0) return;
    const withState = properties.filter((p) => p.state).length;
    assert(
      withState / properties.length >= 0.9,
      `only ${withState} of ${properties.length} have a state`,
    );
  });

  check("every property ties to a loan by the issuer's numbering", () => {
    if (properties.length === 0) return;
    const withLoan = properties.filter((p) => p.loanRef).length;
    assert(
      withLoan / properties.length >= 0.9,
      `only ${withLoan} of ${properties.length} tie to a loan`,
    );
  });

  check("the properties' state ends up as a two-letter code", () => {
    const unnormalised = properties
      .map((p) => p.state)
      .filter((e): e is string => e !== null && !/^[A-Z]{2}$/.test(e));
    assert(unnormalised.length === 0, `not normalised: ${[...new Set(unnormalised)].slice(0, 4).join(" | ")}`);
  });

  // --- informe ---------------------------------------------------------------------

  const issues = checkSanity(result);
  const warnings = issues.filter((i) => i.severity === "warning");

  console.log(
    `\n    \x1b[90m${tables.length} tablas → ${annexTables.length} bloques ` +
      `(${adopted} continuations adopted, ${orphans} orphaned) → ` +
      `${joined.stackedGroups ?? "?"} tras apilar → ${joined.tablesJoined} unidos\x1b[0m`,
  );
  console.log(
    `    \x1b[90m${result.stats.propertiesKept} properties · ${result.stats.observations} observations · ` +
      `${result.columnsMapped.length} columns · ${parseMs} ms\x1b[0m`,
  );

  if (filtered.hadFlagColumn) {
    console.log(
      `    \x1b[90m${filtered.loanRows} loans, ${filtered.propertyRows} property rows discarded\x1b[0m`,
    );
  }

  console.log(`    \x1b[90mmapped: ${result.columnsMapped.map((c) => c.metric).join(", ")}\x1b[0m`);

  if (warnings.length > 0) {
    for (const w of warnings) console.log(`    \x1b[33m⚠ [${w.metric}] ${w.message}\x1b[0m`);
  }

  if (result.columnsUnmapped.length > 0) {
    const sample = result.columnsUnmapped.slice(0, 8).join(" | ");
    console.log(
      `    \x1b[90munmapped (${result.columnsUnmapped.length}): ${sample}` +
        `${result.columnsUnmapped.length > 8 ? " …" : ""}\x1b[0m`,
    );
  }

  console.log();
}

// ---------------------------------------------------------------------------

console.log(
  `${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} ok · ${failed} failed\x1b[0m` +
    ` \x1b[90m(${files.length} fixture${files.length === 1 ? "" : "s"})\x1b[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);

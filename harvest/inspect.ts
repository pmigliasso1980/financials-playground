/**
 * Fixture inspector.
 *
 *   npm run harvest:inspect                      # summary of all of them
 *   npm run harvest:inspect -- <accession>       # detail of one
 *   npm run harvest:inspect -- <accession> -v    # with a sample of cells
 *
 * It exists because diagnosing blind is expensive. Twice I accepted a wrong
 * hypothesis about why loans were being lost —first "the pages repeat headers",
 * then "the continuations are discarded"— and both times the number did not
 * move. What was missing was seeing the structure.
 *
 * Shows, per table: how many rows, how many columns, whether it has
 * recognisable headers, and which block it ends up assigned to.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractFromHtml } from "./parse/tables.js";
import { findHeaderRow, mapColumns } from "./normalize/columnMap.js";
import { attachContinuationTables, joinAnnexTables, keepLoanRows } from "./normalize/annexStructure.js";
import { rowsToObservations, type SourceRef } from "./normalize/toObservations.js";

const FIXTURES_DIR = new URL("./fixtures/", import.meta.url).pathname;

const [, , target, ...flags] = process.argv;
const verbose = flags.includes("-v") || flags.includes("--verbose");

let files: string[] = [];
try {
  files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".html")).sort();
} catch {
  /* no directory */
}

if (files.length === 0) {
  console.log("\n  No fixtures. Capture one with:  npm run harvest:capture -- 2053102\n");
  process.exit(0);
}

const selected = target ? files.filter((f) => f.includes(target)) : files;

if (selected.length === 0) {
  console.log(`\n  No fixture matches "${target}".`);
  console.log(`  Disponibles: ${files.map((f) => f.replace(".html", "")).join(", ")}\n`);
  process.exit(1);
}

for (const file of selected) {
  const slug = file.replace(/\.html$/, "");
  const html = await readFile(join(FIXTURES_DIR, file), "utf8");

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(await readFile(join(FIXTURES_DIR, `${slug}.json`), "utf8"));
  } catch { /* no metadata */ }

  console.log(`\n${"═".repeat(78)}`);
  console.log(`${meta.companyName ?? slug}`);
  console.log(`${(Buffer.byteLength(html) / 1000).toFixed(0)} KB`);
  console.log(`${"═".repeat(78)}\n`);

  const tables = extractFromHtml(html);

  // --- table inventory --------------------------------------------------------

  const inventory = tables.map((t) => {
    const header = findHeaderRow(t.rows);
    const widths = new Map<number, number>();
    for (const row of t.rows) {
      const w = row.filter((c) => c !== null && c !== undefined).length;
      if (w > 0) widths.set(w, (widths.get(w) ?? 0) + 1);
    }
    let modeWidth = 0;
    let modeCount = 0;
    for (const [w, c] of widths) {
      if (c > modeCount) { modeWidth = w; modeCount = c; }
    }
    return {
      name: t.name,
      rows: t.rows.length,
      width: modeWidth,
      hasHeader: header !== null,
      matchCount: header?.matchCount ?? 0,
      firstCell: String(t.rows[0]?.[0] ?? "").slice(0, 28),
    };
  });

  const withHeader = inventory.filter((t) => t.hasHeader);
  const without = inventory.filter((t) => !t.hasHeader);

  console.log(`Tables: ${tables.length}  ·  with header: ${withHeader.length}  ·  without: ${without.length}\n`);

  // Width distribution: reveals how many distinct blocks there are.
  const byWidth = new Map<number, { total: number; headed: number }>();
  for (const t of inventory) {
    const e = byWidth.get(t.width) ?? { total: 0, headed: 0 };
    e.total++;
    if (t.hasHeader) e.headed++;
    byWidth.set(t.width, e);
  }

  console.log("Distribution by column width:");
  console.log(`  ${"cols".padStart(5)} ${"tables".padStart(7)} ${"w/hdr".padStart(6)}  interpretation`);
  for (const [width, e] of [...byWidth].sort((a, b) => b[1].total - a[1].total)) {
    // Tables of 1-2 columns are EDGAR layout (separators, page numbers,
    // titles): that they have no headers is expected, not a problem. Only the
    // wide ones with no associated block are a concern.
    const isLayout = width <= 2;
    const note = isLayout
      ? "\x1b[90mEDGAR layout, no data\x1b[0m"
      : e.headed === 0
        ? "\x1b[33m⚠ data with no block: check the header mapping\x1b[0m"
        : e.total > e.headed
          ? `${e.total - e.headed} continuations of ${e.headed} block(s)`
          : `${e.headed} bloque(s)`;
    console.log(`  ${String(width).padStart(5)} ${String(e.total).padStart(7)} ${String(e.headed).padStart(6)}  ${note}`);
  }

  const dataOrphans = [...byWidth]
    .filter(([w, e]) => w > 2 && e.headed === 0)
    .reduce((sum, [, e]) => sum + e.total, 0);
  if (dataOrphans > 0) {
    console.log(`\n  \x1b[33m${dataOrphans} wide tables with no recognisable header — there is data being lost there.\x1b[0m`);
  }

  if (verbose) {
    console.log("\nDetail by table:");
    for (const t of inventory) {
      const mark = t.hasHeader ? `\x1b[32mhdr(${t.matchCount})\x1b[0m` : "\x1b[90m—\x1b[0m";
      console.log(
        `  ${t.name.padEnd(12)} ${String(t.rows).padStart(4)} rows  ${String(t.width).padStart(3)} cols  ${mark}  \x1b[90m${t.firstCell}\x1b[0m`,
      );
    }
  }

  // --- pipeline ------------------------------------------------------------------

  const { tables: annexTables, adopted, orphans } = attachContinuationTables(
    tables,
    (rows) => findHeaderRow(rows),
  );

  console.log(`\nAfter adopting continuations: ${annexTables.length} blocks (${adopted} adopted, ${orphans} orphaned)`);

  for (const t of annexTables) {
    const headers = (t.rows[t.headerRowIndex] ?? []).map((c) => String(c ?? ""));
    const { matches } = mapColumns(headers);
    const dataRows = t.rows.length - t.headerRowIndex - 1;
    console.log(
      `  ${t.name.padEnd(16)} ${String(dataRows).padStart(4)} rows  ${String(matches.length).padStart(2)} metrics  ` +
        `\x1b[90m${matches.slice(0, 5).map((m) => m.metric.key).join(", ")}${matches.length > 5 ? " …" : ""}\x1b[0m`,
    );
  }

  const joined = joinAnnexTables(annexTables);
  if (!joined) {
    console.log("\n  \x1b[31mCould not assemble the data table.\x1b[0m\n");
    continue;
  }

  const filtered = keepLoanRows(joined.rows, joined.headerRowIndex);
  const source: SourceRef = {
    cik: String(meta.cik ?? "?"), accession: String(meta.accession ?? slug),
    companyName: String(meta.companyName ?? slug), formType: String(meta.formType ?? ""),
    filedAt: String(meta.filedAt ?? ""), fileName: String(meta.fileName ?? file),
    fileUrl: String(meta.fileUrl ?? ""),
  };
  const result = rowsToObservations(filtered.rows, joined.headerRowIndex, source);

  console.log(
    `\nResult: ${result.stats.propertiesKept} loans · ${result.stats.observations} observations · ` +
      `${result.columnsMapped.length} columns mapped`,
  );
  console.log(
    `  \x1b[90mapilados ${joined.stackedGroups} · unidos ${joined.tablesJoined} · ` +
      `discarded ${joined.skipped.length} · property rows ${filtered.propertyRows}\x1b[0m`,
  );

  /**
   * The fixture's trim limits how many loans get in. Since an Annex A mixes
   * loan rows with property rows, a trim of N rows leaves considerably fewer
   * than N loans. It is worth saying explicitly: the first reading of the result
   * was "the parser is losing data" when in fact the fixture was trimmed.
   */
  const rowsPerTable = Number(meta.rowsKeptPerTable) || 0;
  const totalRows = result.stats.propertiesKept + filtered.propertyRows;
  if (rowsPerTable > 0 && totalRows >= rowsPerTable - 2) {
    console.log(
      `\n  \x1b[33mThe fixture is capped: ${rowsPerTable} rows per table were kept and ${totalRows} were used.\x1b[0m`,
    );
    console.log(
      `  \x1b[90mThere are more loans in the original document. Recapture with more rows:\x1b[0m`,
    );
    console.log(`  \x1b[90m  npm run harvest:capture -- ${meta.cik} --rows 300\x1b[0m`);
  }

  if (joined.skipped.length > 0) {
    console.log(`  \x1b[33mbloques no unidos: ${joined.skipped.join(", ")}\x1b[0m`);
    console.log(`  \x1b[90m(they do not share a Loan ID with the base block, or contribute no new columns)\x1b[0m`);
  }

  console.log();
}

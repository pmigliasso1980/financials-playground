/**
 * Inspector de fixtures.
 *
 *   npm run harvest:inspect                      # resumen de todos
 *   npm run harvest:inspect -- <accession>       # detalle de uno
 *   npm run harvest:inspect -- <accession> -v    # con muestra de celdas
 *
 * Existe porque diagnosticar a ciegas cuesta caro. Dos veces di por buena una
 * hipótesis equivocada sobre por qué se perdían préstamos —primero "las páginas
 * repiten encabezados", después "las continuaciones se descartan"— y las dos
 * veces el número no se movió. Lo que faltaba era ver la estructura.
 *
 * Muestra, por tabla: cuántas filas, cuántas columnas, si tiene encabezados
 * reconocibles, y a qué bloque termina asignada.
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
  /* sin directorio */
}

if (files.length === 0) {
  console.log("\n  Sin fixtures. Capturá uno con:  npm run harvest:capture -- 2053102\n");
  process.exit(0);
}

const selected = target ? files.filter((f) => f.includes(target)) : files;

if (selected.length === 0) {
  console.log(`\n  Ningún fixture coincide con "${target}".`);
  console.log(`  Disponibles: ${files.map((f) => f.replace(".html", "")).join(", ")}\n`);
  process.exit(1);
}

for (const file of selected) {
  const slug = file.replace(/\.html$/, "");
  const html = await readFile(join(FIXTURES_DIR, file), "utf8");

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(await readFile(join(FIXTURES_DIR, `${slug}.json`), "utf8"));
  } catch { /* sin metadata */ }

  console.log(`\n${"═".repeat(78)}`);
  console.log(`${meta.companyName ?? slug}`);
  console.log(`${(Buffer.byteLength(html) / 1000).toFixed(0)} KB`);
  console.log(`${"═".repeat(78)}\n`);

  const tables = extractFromHtml(html);

  // --- inventario de tablas ---------------------------------------------------

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

  console.log(`Tablas: ${tables.length}  ·  con encabezado: ${withHeader.length}  ·  sin encabezado: ${without.length}\n`);

  // Distribución de anchos: revela cuántos bloques distintos hay.
  const byWidth = new Map<number, { total: number; headed: number }>();
  for (const t of inventory) {
    const e = byWidth.get(t.width) ?? { total: 0, headed: 0 };
    e.total++;
    if (t.hasHeader) e.headed++;
    byWidth.set(t.width, e);
  }

  console.log("Distribución por ancho de columna:");
  console.log(`  ${"cols".padStart(5)} ${"tablas".padStart(7)} ${"c/hdr".padStart(6)}  interpretación`);
  for (const [width, e] of [...byWidth].sort((a, b) => b[1].total - a[1].total)) {
    // Las tablas de 1-2 columnas son layout de EDGAR (separadores, números de
    // página, títulos): que no tengan encabezados es lo esperable, no un
    // problema. Solo preocupan las anchas sin bloque asociado.
    const isLayout = width <= 2;
    const note = isLayout
      ? "\x1b[90mlayout de EDGAR, sin datos\x1b[0m"
      : e.headed === 0
        ? "\x1b[33m⚠ datos sin bloque: revisá el mapeo de encabezados\x1b[0m"
        : e.total > e.headed
          ? `${e.total - e.headed} continuaciones de ${e.headed} bloque(s)`
          : `${e.headed} bloque(s)`;
    console.log(`  ${String(width).padStart(5)} ${String(e.total).padStart(7)} ${String(e.headed).padStart(6)}  ${note}`);
  }

  const dataOrphans = [...byWidth]
    .filter(([w, e]) => w > 2 && e.headed === 0)
    .reduce((sum, [, e]) => sum + e.total, 0);
  if (dataOrphans > 0) {
    console.log(`\n  \x1b[33m${dataOrphans} tablas anchas sin encabezado reconocible — ahí hay datos perdiéndose.\x1b[0m`);
  }

  if (verbose) {
    console.log("\nDetalle por tabla:");
    for (const t of inventory) {
      const mark = t.hasHeader ? `\x1b[32mhdr(${t.matchCount})\x1b[0m` : "\x1b[90m—\x1b[0m";
      console.log(
        `  ${t.name.padEnd(12)} ${String(t.rows).padStart(4)} filas  ${String(t.width).padStart(3)} cols  ${mark}  \x1b[90m${t.firstCell}\x1b[0m`,
      );
    }
  }

  // --- pipeline ------------------------------------------------------------------

  const { tables: annexTables, adopted, orphans } = attachContinuationTables(
    tables,
    (rows) => findHeaderRow(rows),
  );

  console.log(`\nTras adoptar continuaciones: ${annexTables.length} bloques (${adopted} adoptadas, ${orphans} huérfanas)`);

  for (const t of annexTables) {
    const headers = (t.rows[t.headerRowIndex] ?? []).map((c) => String(c ?? ""));
    const { matches } = mapColumns(headers);
    const dataRows = t.rows.length - t.headerRowIndex - 1;
    console.log(
      `  ${t.name.padEnd(16)} ${String(dataRows).padStart(4)} filas  ${String(matches.length).padStart(2)} métricas  ` +
        `\x1b[90m${matches.slice(0, 5).map((m) => m.metric.key).join(", ")}${matches.length > 5 ? " …" : ""}\x1b[0m`,
    );
  }

  const joined = joinAnnexTables(annexTables);
  if (!joined) {
    console.log("\n  \x1b[31mNo se pudo armar la tabla de datos.\x1b[0m\n");
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
    `\nResultado: ${result.stats.propertiesKept} préstamos · ${result.stats.observations} observations · ` +
      `${result.columnsMapped.length} columnas mapeadas`,
  );
  console.log(
    `  \x1b[90mapilados ${joined.stackedGroups} · unidos ${joined.tablesJoined} · ` +
      `descartados ${joined.skipped.length} · filas de propiedad ${filtered.propertyRows}\x1b[0m`,
  );

  /**
   * El recorte del fixture limita cuántos préstamos entran. Como un Annex A
   * mezcla filas de préstamo con filas de propiedad, un recorte de N filas deja
   * bastante menos de N préstamos. Conviene decirlo explícitamente: la primera
   * lectura del resultado fue "el parser pierde datos" cuando en realidad el
   * fixture estaba recortado.
   */
  const rowsPerTable = Number(meta.rowsKeptPerTable) || 0;
  const totalRows = result.stats.propertiesKept + filtered.propertyRows;
  if (rowsPerTable > 0 && totalRows >= rowsPerTable - 2) {
    console.log(
      `\n  \x1b[33mEl fixture está topado: se conservaron ${rowsPerTable} filas por tabla y se usaron ${totalRows}.\x1b[0m`,
    );
    console.log(
      `  \x1b[90mHay más préstamos en el documento original. Recapturá con más filas:\x1b[0m`,
    );
    console.log(`  \x1b[90m  npm run harvest:capture -- ${meta.cik} --rows 300\x1b[0m`);
  }

  if (joined.skipped.length > 0) {
    console.log(`  \x1b[33mbloques no unidos: ${joined.skipped.join(", ")}\x1b[0m`);
    console.log(`  \x1b[90m(no comparten Loan ID con el bloque base, o no aportan columnas nuevas)\x1b[0m`);
  }

  console.log();
}

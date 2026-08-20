/**
 * Table extraction, indifferent to the source format.
 *
 * Both xlsx and HTML end up in the same shape —`unknown[][]`— so the rest of
 * the pipeline (column mapping, normalisation) does not have to know where the
 * data came from.
 */

import * as XLSX from "xlsx";
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { mapsToSomeMetric } from "../normalize/columnMap.js";

export interface ExtractedTable {
  /** Sheet name (xlsx) or table index (html). */
  name: string;
  rows: unknown[][];
}

/** Chooses the parser by file extension. */
export function extractTables(buffer: Buffer, fileName: string): ExtractedTable[] {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";

  if (["xlsx", "xls", "xlsm"].includes(ext)) return extractFromXlsx(buffer);
  if (["htm", "html"].includes(ext)) return extractFromHtml(buffer.toString("utf8"));

  throw new Error(
    `I do not know how to read "${fileName}" (extension "${ext}"). Supported formats: xlsx, xls, xlsm, htm, html.`,
  );
}

// ---------------------------------------------------------------------------

export function extractFromXlsx(buffer: Buffer): ExtractedTable[] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });

  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) return { name, rows: [] };
    return {
      name,
      rows: XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true }),
    };
  }).filter((t) => t.rows.length > 0);
}

// ---------------------------------------------------------------------------

/**
 * Extracts tables from an HTML document.
 *
 * HTML Annex A files have peculiarities that have to be handled:
 *
 *   - They weigh several MB with a single giant table of hundreds of rows.
 *   - They use `colspan` to group headers. Without expanding it, the columns
 *     misalign and all the downstream mapping is shifted.
 *   - Headers come split across several rows ("Underwritten" above, "NOI"
 *     below), so they have to be merged.
 *   - They stuff `&nbsp;`, line breaks and extra spaces into every cell.
 *
 * Returns one entry per table; the caller picks whichever maps best.
 */
export interface ExtractOptions {
  /**
   * Minimum rows to keep a table. Default 1.
   *
   * Careful about raising it: in a real Annex A the continuation pages can have
   * one or two rows, and discarding them loses whole loans. A threshold of 3
   * left 18 tables out of 126 in the Wells Fargo document.
   */
  minRows?: number;
  /**
   * Discard single-cell tables (layout, page headers).
   * Default true: they carry no data and pollute the count.
   */
  dropSingleCell?: boolean;
  /**
   * Merge headers split across several rows. Default true.
   *
   * The servicer reports do not want this: their header is not at the start of
   * the table —above it are the section title and blank rows— so the merging
   * heuristic, designed for the Annex A, mixes things that do not belong
   * together. That parser resolves its own header by anchoring on "Pros ID".
   */
  mergeHeaders?: boolean;
}

export function extractFromHtml(html: string, opts: ExtractOptions = {}): ExtractedTable[] {
  const minRows = opts.minRows ?? 1;
  const dropSingleCell = opts.dropSingleCell ?? true;
  const shouldMerge = opts.mergeHeaders ?? true;

  const root = parseHtml(html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: { script: false, noscript: false, style: false },
  });

  const tables = root.querySelectorAll("table");
  const out: ExtractedTable[] = [];

  tables.forEach((table, i) => {
    const rows = tableToRows(table);
    if (rows.length < minRows) return;

    if (dropSingleCell) {
      const maxWidth = Math.max(0, ...rows.map((r) => r.length));
      if (maxWidth <= 1) return;
    }

    // We only attempt header merging if the table is large enough to have
    // headers. A two-row continuation is all data.
    out.push({
      name: `table[${i}]`,
      rows: shouldMerge && rows.length >= 3 ? mergeHeaderRows(rows) : rows,
    });
  });

  return out;
}

function tableToRows(table: HTMLElement): unknown[][] {
  const rows: unknown[][] = [];

  for (const tr of table.querySelectorAll("tr")) {
    const cells = tr.querySelectorAll("td, th");
    if (cells.length === 0) continue;

    const row: unknown[] = [];
    for (const cell of cells) {
      const text = cleanCellText(cell.textContent ?? "");
      const colspan = Math.min(Number(cell.getAttribute("colspan")) || 1, 50);

      row.push(text === "" ? null : text);
      // Expand colspan: without this the columns end up shifted and the mapping
      // assigns values to the wrong metric.
      for (let c = 1; c < colspan; c++) row.push(null);
    }

    rows.push(row);
  }

  return rows;
}

function cleanCellText(raw: string): string {
  return raw
    .replace(/ /g, " ") // &nbsp;
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Merges headers split across several rows.
 *
 * A typical Annex A carries:
 *
 *   row 0:  |         | Underwritten |              |
 *   row 1:  | Property|     NOI      | Occupancy    |
 *
 * which have to be joined into `["Property", "Underwritten NOI", "Occupancy"]`.
 *
 * Heuristic: if among the first rows there is one with many empty cells
 * followed by another well populated, and neither appears to carry numeric
 * data, they are merged. When in doubt it touches nothing: a wrong merge does
 * more damage than a split header.
 */
function mergeHeaderRows(rows: unknown[][], maxScan = 6): unknown[][] {
  if (rows.length < 2) return rows;

  let mergeUntil = -1;

  for (let i = 0; i < Math.min(rows.length - 1, maxScan); i++) {
    const current = rows[i]!;
    const next = rows[i + 1]!;

    const currentFilled = current.filter((c) => c !== null && String(c).trim()).length;
    const nextFilled = next.filter((c) => c !== null && String(c).trim()).length;

    // The following row has to be clearly better populated.
    if (nextFilled <= currentFilled * 1.4) continue;
    // Neither of the two can look like a data row.
    if (looksNumeric(current) || looksNumeric(next)) continue;
    if (currentFilled === 0) continue;

    mergeUntil = i + 1;
  }

  if (mergeUntil < 1) return rows;

  const width = Math.max(...rows.slice(0, mergeUntil + 1).map((r) => r.length));
  const merged: unknown[] = [];

  for (let col = 0; col < width; col++) {
    const leafCell = rows[mergeUntil]?.[col];
    const leaf = leafCell === null || leafCell === undefined ? "" : String(leafCell).trim();

    /**
     * If the leaf header stands on its own, it is used as-is.
     *
     * This avoids an error that ruins the mapping: group headers span several
     * columns via colspan, and gluing them onto each leaf contaminates its
     * text. A "Physical & Occupancy" group over a "Net Rentable Area (SF)"
     * column produces "Physical & Occupancy Net Rentable Area (SF)", which
     * matches *occupancy* with a higher score than *square feet* and steals the
     * column. The real occupancy is left unmapped and the values end up in the
     * wrong metric.
     *
     * When the leaf is NOT enough —plain "NOI", which could be underwritten or
     * trailing— the group IS needed to disambiguate.
     */
    if (leaf && mapsToSomeMetric(leaf)) {
      merged.push(leaf);
      continue;
    }

    const parts: string[] = [];
    for (let r = 0; r <= mergeUntil; r++) {
      const cell = rows[r]?.[col];
      const text = cell === null || cell === undefined ? "" : String(cell).trim();
      // Do not repeat the same text if colspan propagated it.
      if (text && !parts.includes(text)) parts.push(text);
    }
    merged.push(parts.length > 0 ? parts.join(" ") : null);
  }

  return [merged, ...rows.slice(mergeUntil + 1)];
}

/** Does the row look like it carries data rather than headers? */
function looksNumeric(row: unknown[]): boolean {
  const filled = row.filter((c) => c !== null && String(c).trim());
  if (filled.length === 0) return false;

  const numeric = filled.filter((c) => {
    const s = String(c).replace(/[$,%()\s]/g, "");
    return s.length > 0 && Number.isFinite(Number(s));
  }).length;

  return numeric / filled.length > 0.4;
}

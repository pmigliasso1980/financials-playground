/**
 * Extracción de tablas, indiferente al formato de origen.
 *
 * Tanto el xlsx como el HTML terminan en la misma forma —`unknown[][]`— para
 * que el resto del pipeline (mapeo de columnas, normalización) no tenga que
 * saber de dónde vino el dato.
 */

import * as XLSX from "xlsx";
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { mapsToSomeMetric } from "../normalize/columnMap.js";

export interface ExtractedTable {
  /** Nombre de hoja (xlsx) o índice de tabla (html). */
  name: string;
  rows: unknown[][];
}

/** Elige el parser según la extensión del archivo. */
export function extractTables(buffer: Buffer, fileName: string): ExtractedTable[] {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";

  if (["xlsx", "xls", "xlsm"].includes(ext)) return extractFromXlsx(buffer);
  if (["htm", "html"].includes(ext)) return extractFromHtml(buffer.toString("utf8"));

  throw new Error(
    `No sé leer "${fileName}" (extensión "${ext}"). Formatos soportados: xlsx, xls, xlsm, htm, html.`,
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
 * Extrae tablas de un HTML.
 *
 * Los Annex A en HTML tienen particularidades que hay que manejar:
 *
 *   - Pesan varios MB con una sola tabla gigante de cientos de filas.
 *   - Usan `colspan` para agrupar encabezados. Sin expandirlo, las columnas se
 *     desalinean y todo el mapeo posterior queda corrido.
 *   - Los encabezados vienen partidos en varias filas ("Underwritten" arriba,
 *     "NOI" abajo), así que hay que fusionarlas.
 *   - Meten `&nbsp;`, saltos de línea y espacios de sobra en cada celda.
 *
 * Devuelve una entrada por tabla; el que llama elige la que mejor mapee.
 */
export interface ExtractOptions {
  /**
   * Mínimo de filas para conservar una tabla. Default 1.
   *
   * Ojo con subirlo: en un Annex A real las páginas de continuación pueden
   * tener una o dos filas, y descartarlas pierde préstamos enteros. Un umbral
   * de 3 dejaba 18 tablas de 126 en el documento de Wells Fargo.
   */
  minRows?: number;
  /**
   * Descartar tablas de una sola celda (layout, encabezados de página).
   * Default true: no aportan datos y ensucian el conteo.
   */
  dropSingleCell?: boolean;
  /**
   * Fusionar encabezados partidos en varias filas. Default true.
   *
   * Los informes del servicer no lo quieren: su encabezado no está al principio
   * de la tabla —arriba hay título de sección y filas en blanco— así que la
   * heurística de fusión, pensada para el Annex A, mezcla cosas que no van
   * juntas. Ese parser resuelve su propio encabezado anclándose en "Pros ID".
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

    // Solo intentamos fusionar encabezados si la tabla es lo bastante grande
    // como para tenerlos. Una continuación de dos filas es todo datos.
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
      // Expandir colspan: sin esto las columnas quedan corridas y el mapeo
      // asigna valores a la métrica equivocada.
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
 * Fusiona encabezados partidos en varias filas.
 *
 * Un Annex A típico trae:
 *
 *   fila 0:  |         | Underwritten |              |
 *   fila 1:  | Property|     NOI      | Occupancy    |
 *
 * que hay que unir en `["Property", "Underwritten NOI", "Occupancy"]`.
 *
 * Heurística: si entre las primeras filas hay una con muchas celdas vacías
 * seguida de otra bien poblada, y ninguna parece traer datos numéricos, se
 * fusionan. Ante la duda, no toca nada: un merge equivocado hace más daño que
 * un encabezado partido.
 */
function mergeHeaderRows(rows: unknown[][], maxScan = 6): unknown[][] {
  if (rows.length < 2) return rows;

  let mergeUntil = -1;

  for (let i = 0; i < Math.min(rows.length - 1, maxScan); i++) {
    const current = rows[i]!;
    const next = rows[i + 1]!;

    const currentFilled = current.filter((c) => c !== null && String(c).trim()).length;
    const nextFilled = next.filter((c) => c !== null && String(c).trim()).length;

    // La fila siguiente tiene que estar claramente mejor poblada.
    if (nextFilled <= currentFilled * 1.4) continue;
    // Ninguna de las dos puede parecer una fila de datos.
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
     * Si el encabezado hoja se entiende solo, se usa tal cual.
     *
     * Esto evita un error que arruina el mapeo: los encabezados de grupo
     * ocupan varias columnas por colspan, y al pegarlos a cada hoja
     * contaminan su texto. Un grupo "Physical & Occupancy" sobre una columna
     * "Net Rentable Area (SF)" produce "Physical & Occupancy Net Rentable
     * Area (SF)", que matchea *occupancy* con más puntaje que *square feet*
     * y se roba la columna. La ocupancia real queda sin mapear y los valores
     * terminan en la métrica equivocada.
     *
     * Cuando la hoja NO alcanza —"NOI" a secas, que puede ser underwritten o
     * trailing— sí hace falta el grupo para desambiguar.
     */
    if (leaf && mapsToSomeMetric(leaf)) {
      merged.push(leaf);
      continue;
    }

    const parts: string[] = [];
    for (let r = 0; r <= mergeUntil; r++) {
      const cell = rows[r]?.[col];
      const text = cell === null || cell === undefined ? "" : String(cell).trim();
      // No repetir el mismo texto si el colspan lo propagó.
      if (text && !parts.includes(text)) parts.push(text);
    }
    merged.push(parts.length > 0 ? parts.join(" ") : null);
  }

  return [merged, ...rows.slice(mergeUntil + 1)];
}

/** ¿La fila parece traer datos en vez de encabezados? */
function looksNumeric(row: unknown[]): boolean {
  const filled = row.filter((c) => c !== null && String(c).trim());
  if (filled.length === 0) return false;

  const numeric = filled.filter((c) => {
    const s = String(c).replace(/[$,%()\s]/g, "");
    return s.length > 0 && Number.isFinite(Number(s));
  }).length;

  return numeric / filled.length > 0.4;
}

/**
 * Recorte de un Annex A conservando el markup original.
 *
 * Un Annex A pesa entre 4 y 16 MB —cientos de préstamos— y eso no se versiona.
 * Pero necesitamos el markup real como fixture de test, porque es más sucio que
 * cualquier cosa que uno escriba a mano: `<font>` anidados dentro de `<td>`,
 * estilos inline, `&nbsp;`, filas de separación, encabezados en varios niveles
 * de colspan.
 *
 * La solución: eliminar elementos `<tr>` sobrantes del árbol y serializar el
 * resto **tal cual venía**. Nada se reescribe, así que el recorte conserva toda
 * la suciedad estructural del original en una fracción del tamaño.
 */

import { parse as parseHtml, type HTMLElement } from "node-html-parser";

export interface TrimReport {
  tablesTotal: number;
  tablesKept: number;
  rowsTotal: number;
  rowsKept: number;
}

export function trimAnnexHtml(
  html: string,
  keepRows: number,
): { html: string; report: TrimReport } {
  const root = parseHtml(html, {
    lowerCaseTagName: false,
    comment: false,
    blockTextElements: { script: false, noscript: false, style: true },
  });

  const tables = root.querySelectorAll("table");
  const report: TrimReport = {
    tablesTotal: tables.length,
    tablesKept: 0,
    rowsTotal: 0,
    rowsKept: 0,
  };

  for (const table of tables) {
    const trs = table.querySelectorAll("tr");
    report.rowsTotal += trs.length;

    if (trs.length <= 3) {
      // Tablas chicas (layout, encabezado de página): se dejan enteras.
      report.rowsKept += trs.length;
      report.tablesKept++;
      continue;
    }

    const firstDataRow = findFirstDataRow(trs);
    const limit = firstDataRow + keepRows;

    let removed = 0;
    trs.forEach((tr, i) => {
      if (i >= limit) {
        tr.remove();
        removed++;
      }
    });

    report.rowsKept += trs.length - removed;
    report.tablesKept++;
  }

  return { html: root.toString(), report };
}

/**
 * Primera fila que parece de datos.
 *
 * Un Annex A tiene entre 1 y 3 filas de encabezado (grupos con colspan más los
 * nombres de columna). Se reconocen porque tienen poco contenido numérico.
 */
function findFirstDataRow(trs: HTMLElement[]): number {
  for (let i = 0; i < Math.min(trs.length, 8); i++) {
    const cells = trs[i]!.querySelectorAll("td, th");
    const texts = cells
      .map((c) => (c.textContent ?? "").replace(/ /g, " ").trim())
      .filter(Boolean);

    if (texts.length === 0) continue;

    const numeric = texts.filter((t) => {
      const s = t.replace(/[$,%()\sx]/g, "");
      return s.length > 0 && Number.isFinite(Number(s));
    }).length;

    if (numeric / texts.length > 0.4) return i;
  }
  // Sin fila de datos clara: asumimos 2 de encabezado.
  return Math.min(2, trs.length);
}

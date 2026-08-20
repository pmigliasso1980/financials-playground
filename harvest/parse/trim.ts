/**
 * Trimming an Annex A while keeping the original markup.
 *
 * An Annex A weighs between 4 and 16 MB —hundreds of loans— and that does not
 * get versioned. But we need the real markup as a test fixture, because it is
 * dirtier than anything you would write by hand: `<font>` nested inside `<td>`,
 * inline styles, `&nbsp;`, separator rows, headers across several levels of
 * colspan.
 *
 * The solution: remove surplus `<tr>` elements from the tree and serialise the
 * rest **exactly as it came**. Nothing is rewritten, so the trimmed file keeps
 * all the structural dirt of the original at a fraction of the size.
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
      // Small tables (layout, page header): left whole.
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
 * The first row that looks like data.
 *
 * An Annex A has between 1 and 3 header rows (colspan groups plus the column
 * names). They are recognised because they have little numeric content.
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
  // No clear data row: assume 2 header rows.
  return Math.min(2, trs.length);
}

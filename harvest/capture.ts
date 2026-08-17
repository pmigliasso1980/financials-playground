/**
 * Captura un Annex A real de EDGAR y lo recorta como fixture permanente.
 *
 *   npm run harvest:capture -- <cik>
 *   npm run harvest:capture -- 2053102
 *
 * POR QUÉ EXISTE
 *
 * Los fixtures sintéticos son más limpios que la realidad: markup prolijo,
 * encabezados de una sola línea, sin tags anidados ni estilos inline. Un Annex A
 * de verdad tiene `<font>`, `<div>` dentro de `<td>`, `&nbsp;` por todos lados,
 * filas de separación, y encabezados partidos en tres niveles de `colspan`.
 *
 * Este comando baja el documento real y guarda un recorte con el **markup
 * intacto** pero solo las primeras N filas de datos. Un Annex A pesa entre 4 y
 * 16 MB; recortado a 25 préstamos queda en cientos de KB, que sí se puede
 * versionar y usar como test offline para siempre.
 *
 * La idea es que el corpus crezca: cada emisor nuevo que rompa el mapeo se
 * captura, se commitea, y queda cubierto.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EdgarError, fetchBuffer } from "./edgar/client.js";
import { findAnnexFilings } from "./edgar/discover.js";
import { trimAnnexHtml } from "./parse/trim.js";

export const FIXTURES_DIR = new URL("./fixtures/", import.meta.url).pathname;

/**
 * Cuántas filas de datos conservar por tabla.
 *
 * 25 parecía suficiente hasta ver el resultado real: un Annex A mezcla filas de
 * préstamo con filas de propiedad, y en un pool con portfolios de varios
 * activos las 25 primeras filas contienen apenas 7 préstamos. El fixture
 * quedaba técnicamente correcto pero demasiado chico para ser representativo.
 *
 * 120 deja un fixture de unos pocos MB con la mayor parte del pool.
 */
const DEFAULT_KEEP_ROWS = 120;

const [, , cikArg, ...rest] = process.argv;

if (!cikArg) {
  console.log(`
Captura un Annex A real como fixture de test.

  npm run harvest:capture -- <cik> [--rows N]

Ejemplos de CIK (trusts de CMBS observados en agosto 2026):

  2053102   Wells Fargo Commercial Mortgage Trust 2025-C64
  2110410   Benchmark 2026-B42 Mortgage Trust
  2104049   BANK5 2026-5YR20
  2104401   BBCMS Mortgage Trust 2026-5C40

Necesita:
  export SEC_USER_AGENT="Tu Nombre tu@email.com"
`);
  process.exit(1);
}

const rowsIdx = rest.indexOf("--rows");
const keepRows = rowsIdx >= 0 ? Number(rest[rowsIdx + 1]) || DEFAULT_KEEP_ROWS : DEFAULT_KEEP_ROWS;

try {
  await capture(cikArg, keepRows);
} catch (err) {
  if (err instanceof EdgarError) {
    console.error(`\n✗ EDGAR: ${err.message}`);
    if (err.url) console.error(`  ${err.url}`);
  } else {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------

async function capture(cik: string, rows: number) {
  console.log(`\nBuscando el Annex A del CIK ${cik}...\n`);

  const picks = await findAnnexFilings(cik, { max: 1 });
  if (picks.length === 0) {
    console.error(`  ✗ Sin Annex A identificable.`);
    console.error(`    Inspeccioná con: npm run harvest -- filings ${cik}\n`);
    process.exit(1);
  }

  const { filing, score } = picks[0]!;
  console.log(`  ${filing.companyName}`);
  console.log(`  ${filing.documentName} · ${fmtBytes(filing.sizeBytes)} · score ${score.toFixed(2)}`);
  console.log(`  ${filing.documentUrl}\n`);

  const started = Date.now();
  const buffer = await fetchBuffer(filing.documentUrl, { timeoutMs: 180_000 });
  console.log(`  descargado: ${fmtBytes(buffer.length)} en ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const original = buffer.toString("utf8");
  const { html, report } = trimAnnexHtml(original, rows);

  console.log(
    `  recortado: ${report.tablesKept} tabla(s), ${report.rowsKept} filas conservadas ` +
      `de ${report.rowsTotal} · ${fmtBytes(Buffer.byteLength(html))}`,
  );

  await mkdir(FIXTURES_DIR, { recursive: true });

  const slug = `${filing.accession}`;
  const htmlPath = join(FIXTURES_DIR, `${slug}.html`);
  const metaPath = join(FIXTURES_DIR, `${slug}.json`);

  await writeFile(htmlPath, html);
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        cik: filing.cik,
        accession: filing.accession,
        companyName: filing.companyName,
        formType: filing.formType,
        filedAt: filing.filedAt,
        fileName: filing.documentName,
        fileUrl: filing.documentUrl,
        capturedAt: new Date().toISOString(),
        originalBytes: buffer.length,
        trimmedBytes: Buffer.byteLength(html),
        rowsKeptPerTable: rows,
        ...report,
      },
      null,
      2,
    ),
  );

  console.log(`\n  → harvest/fixtures/${slug}.html`);
  console.log(`  → harvest/fixtures/${slug}.json`);
  console.log(`\n  Ahora corré:  npm run harvest:fixtures\n`);
  console.log(`  El fixture queda versionado y el test lo levanta solo.\n`);
}

// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n > 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n > 1000) return `${Math.round(n / 1000)} KB`;
  return `${n} B`;
}

/**
 * Captures a real Annex A from EDGAR and trims it into a permanent fixture.
 *
 *   npm run harvest:capture -- <cik>
 *   npm run harvest:capture -- 2053102
 *
 * WHY IT EXISTS
 *
 * Synthetic fixtures are cleaner than reality: tidy markup, single-line headers,
 * no nested tags and no inline styles. A real Annex A has `<font>`, `<div>`
 * inside `<td>`, `&nbsp;` everywhere, separator rows, and headers split across
 * three levels of `colspan`.
 *
 * This command downloads the real document and stores a trimmed copy with the
 * markup **intact** but only the first N data rows. An Annex A weighs between 4
 * and 16 MB; trimmed to 25 loans it comes down to hundreds of KB, which can be
 * versioned and used as an offline test forever.
 *
 * The idea is for the corpus to grow: every new issuer that breaks the mapping
 * gets captured, committed, and covered from then on.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EdgarError, fetchBuffer } from "./edgar/client.js";
import { findAnnexFilings } from "./edgar/discover.js";
import { trimAnnexHtml } from "./parse/trim.js";

export const FIXTURES_DIR = new URL("./fixtures/", import.meta.url).pathname;

/**
 * How many data rows to keep per table.
 *
 * 25 seemed enough until we saw the real result: an Annex A mixes loan rows with
 * property rows, and in a pool with multi-asset portfolios the first 25 rows
 * contain barely 7 loans. The fixture was technically correct but too small to
 * be representative.
 *
 * 120 leaves a fixture of a few MB with most of the pool.
 */
const DEFAULT_KEEP_ROWS = 120;

const [, , cikArg, ...rest] = process.argv;

if (!cikArg) {
  console.log(`
Captures a real Annex A as a test fixture.

  npm run harvest:capture -- <cik> [--rows N]

Example CIKs (CMBS trusts observed in August 2026):

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
  console.log(`\nLooking for the Annex A of CIK ${cik}...\n`);

  const picks = await findAnnexFilings(cik, { max: 1 });
  if (picks.length === 0) {
    console.error(`  ✗ No identifiable Annex A.`);
    console.error(`    Inspect with: npm run harvest -- filings ${cik}\n`);
    process.exit(1);
  }

  const { filing, score } = picks[0]!;
  console.log(`  ${filing.companyName}`);
  console.log(`  ${filing.documentName} · ${fmtBytes(filing.sizeBytes)} · score ${score.toFixed(2)}`);
  console.log(`  ${filing.documentUrl}\n`);

  const started = Date.now();
  const buffer = await fetchBuffer(filing.documentUrl, { timeoutMs: 180_000 });
  console.log(`  downloaded: ${fmtBytes(buffer.length)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const original = buffer.toString("utf8");
  const { html, report } = trimAnnexHtml(original, rows);

  console.log(
    `  trimmed: ${report.tablesKept} table(s), ${report.rowsKept} rows kept ` +
      `of ${report.rowsTotal} · ${fmtBytes(Buffer.byteLength(html))}`,
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
  console.log(`\n  Now run:  npm run harvest:fixtures\n`);
  console.log(`  The fixture is versioned and the test picks it up on its own.\n`);
}

// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n > 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n > 1000) return `${Math.round(n / 1000)} KB`;
  return `${n} B`;
}

/**
 * What does the seller column actually contain, before re-harvesting 222 issuances?
 *
 *   npm run harvest:seller
 *
 * WHY IT EXISTS
 *
 * The fixtures show that `loan_seller` maps in all three test issuances. That
 * says a header matched — it does not say the cell contains a bank's name.
 *
 * Confusing those two is the error this project made five times in one week: a
 * diagnostic that confirms what you expect and is never audited. "The table was
 * located" was not "the table has data"; "the SIR correlates with coverage" was
 * not "the SIR measures coverage"; "the fiscal column has a median of 1" was not
 * "the fiscal column is usable".
 *
 * The re-harvest costs half an hour and takes the performance of 2,213 loans
 * with it. Looking at the raw values costs twenty seconds and runs offline.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractFromHtml } from "./parse/tables.js";
import { findHeaderRow } from "./normalize/columnMap.js";
import {
  attachContinuationTables,
  joinAnnexTables,
  keepLoanRows,
} from "./normalize/annexStructure.js";
import { rowsToObservations, type SourceRef } from "./normalize/toObservations.js";

const DIR = new URL("./fixtures/", import.meta.url).pathname;
const files = (await readdir(DIR)).filter((f) => /\.html?$/.test(f));

if (files.length === 0) {
  console.error(`\n✗ No fixtures in ${DIR}. Capture one with: npm run harvest:capture\n`);
  process.exit(1);
}

console.log(`\n${"═".repeat(78)}`);
console.log("Seller column: which header matched and what values it carries");
console.log(`${"═".repeat(78)}`);

for (const file of files) {
  const html = await readFile(join(DIR, file), "utf8");
  const slug = file.replace(/\.html?$/, "");

  let name = slug;
  try {
    const meta = JSON.parse(await readFile(join(DIR, `${slug}.json`), "utf8")) as {
      companyName?: string;
    };
    name = meta.companyName ?? slug;
  } catch {
    /* no metadata: the slug is enough */
  }

  const tables = extractFromHtml(html);
  const { tables: annexTables } = attachContinuationTables(tables, (rows) =>
    findHeaderRow(rows),
  );
  const joined = joinAnnexTables(annexTables);
  if (!joined) {
    console.log(`\n  \x1b[33m${name}: could not assemble the table\x1b[0m`);
    continue;
  }

  const filtered = keepLoanRows(joined.rows, joined.headerRowIndex);
  const source: SourceRef = {
    cik: "0", accession: slug, companyName: name, formType: "FWP",
    filedAt: "", fileName: file, fileUrl: "",
  };
  const result = rowsToObservations(filtered.rows, joined.headerRowIndex, source);

  const col = result.columnsMapped.find((c) => c.metric === "loan_seller");
  const values = result.properties
    .map((p) => p.label.loan_seller)
    .filter((v): v is string => Boolean(v && v.trim()));
  const distinct = [...new Set(values)];

  console.log(`\n  \x1b[1m${name.slice(0, 50)}\x1b[0m`);
  if (!col) {
    console.log(`    \x1b[33mno seller column\x1b[0m`);
    continue;
  }

  console.log(
    `    header      \x1b[90m"${col.header.replace(/\s+/g, " ").slice(0, 58)}"\x1b[0m`,
  );
  console.log(
    `    ${values.length} of ${result.properties.length} rows with a value · ` +
      `${distinct.length} distinct sellers`,
  );

  /**
   * The raw values. A bank's name confirms the mapping; a number, a date or a
   * code confirm it grabbed the column next door.
   */
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const [v, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`      ${String(n).padStart(3)}×  \x1b[90m"${v.replace(/\s+/g, " ").slice(0, 56)}"\x1b[0m`);
  }
  if (distinct.length > 6) {
    console.log(`      \x1b[90m... and ${distinct.length - 6} more\x1b[0m`);
  }

  /**
   * A conduit has between two and six sellers. Dozens of unique values over
   * thirty rows means the column has row cardinality —an identifier, an amount,
   * a property name— and is not the seller.
   */
  if (values.length > 0 && distinct.length > Math.max(6, values.length * 0.5)) {
    console.log(
      `    \x1b[31m← too many unique values to be a seller: the mapping grabbed something else\x1b[0m`,
    );
  } else if (values.length > 0) {
    console.log(`    \x1b[32m← cardinality consistent with a seller\x1b[0m`);
  }
}

console.log();

/**
 * ¿Qué trae la columna del vendedor, antes de recosechar 222 emisiones?
 *
 *   npm run harvest:seller
 *
 * POR QUÉ EXISTE
 *
 * Los fixtures muestran que `loan_seller` se mapea en las tres emisiones de
 * prueba. Eso dice que un encabezado matcheó — no dice que la celda contenga el
 * nombre de un banco.
 *
 * Confundir esas dos cosas es el error que este proyecto cometió cinco veces en
 * una semana: un diagnóstico que confirma lo que uno espera y no se audita.
 * "La tabla se ubicó" no era "la tabla tiene datos"; "el SIR correlaciona con
 * la cobertura" no era "el SIR mide cobertura"; "la columna fiscal tiene
 * mediana 1" no era "la columna fiscal sirve".
 *
 * La recosecha cuesta media hora y se lleva puesto el desempeño de 2.213
 * préstamos. Mirar los valores crudos cuesta veinte segundos y corre offline.
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
const archivos = (await readdir(DIR)).filter((f) => /\.html?$/.test(f));

if (archivos.length === 0) {
  console.error(`\n✗ Sin fixtures en ${DIR}. Capturá con: npm run harvest:capture\n`);
  process.exit(1);
}

console.log(`\n${"═".repeat(78)}`);
console.log("Columna del vendedor: qué encabezado matcheó y qué valores trae");
console.log(`${"═".repeat(78)}`);

for (const archivo of archivos) {
  const html = await readFile(join(DIR, archivo), "utf8");
  const slug = archivo.replace(/\.html?$/, "");

  let nombre = slug;
  try {
    const meta = JSON.parse(await readFile(join(DIR, `${slug}.json`), "utf8")) as {
      companyName?: string;
    };
    nombre = meta.companyName ?? slug;
  } catch {
    /* sin metadatos: alcanza con el slug */
  }

  const tables = extractFromHtml(html);
  const { tables: annexTables } = attachContinuationTables(tables, (rows) =>
    findHeaderRow(rows),
  );
  const joined = joinAnnexTables(annexTables);
  if (!joined) {
    console.log(`\n  \x1b[33m${nombre}: no se pudo armar la tabla\x1b[0m`);
    continue;
  }

  const filtered = keepLoanRows(joined.rows, joined.headerRowIndex);
  const source: SourceRef = {
    cik: "0", accession: slug, companyName: nombre, formType: "FWP",
    filedAt: "", fileName: archivo, fileUrl: "",
  };
  const result = rowsToObservations(filtered.rows, joined.headerRowIndex, source);

  const col = result.columnsMapped.find((c) => c.metric === "loan_seller");
  const valores = result.properties
    .map((p) => p.label.loan_seller)
    .filter((v): v is string => Boolean(v && v.trim()));
  const distintos = [...new Set(valores)];

  console.log(`\n  \x1b[1m${nombre.slice(0, 50)}\x1b[0m`);
  if (!col) {
    console.log(`    \x1b[33msin columna de vendedor\x1b[0m`);
    continue;
  }

  console.log(
    `    encabezado  \x1b[90m"${col.header.replace(/\s+/g, " ").slice(0, 58)}"\x1b[0m`,
  );
  console.log(
    `    ${valores.length} de ${result.properties.length} filas con valor · ` +
      `${distintos.length} vendedores distintos`,
  );

  /**
   * Los valores crudos. Un nombre de banco confirma el mapeo; un número, una
   * fecha o un código confirman que agarró la columna de al lado.
   */
  const conteo = new Map<string, number>();
  for (const v of valores) conteo.set(v, (conteo.get(v) ?? 0) + 1);
  for (const [v, n] of [...conteo].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`      ${String(n).padStart(3)}×  \x1b[90m"${v.replace(/\s+/g, " ").slice(0, 56)}"\x1b[0m`);
  }
  if (distintos.length > 6) {
    console.log(`      \x1b[90m... y ${distintos.length - 6} más\x1b[0m`);
  }

  /**
   * Un conduit tiene entre dos y seis vendedores. Decenas de valores únicos
   * sobre treinta filas significa que la columna tiene cardinalidad de fila —un
   * identificador, un monto, un nombre de propiedad— y no es el vendedor.
   */
  if (valores.length > 0 && distintos.length > Math.max(6, valores.length * 0.5)) {
    console.log(
      `    \x1b[31m← demasiados valores únicos para ser un vendedor: el mapeo agarró otra cosa\x1b[0m`,
    );
  } else if (valores.length > 0) {
    console.log(`    \x1b[32m← cardinalidad compatible con un vendedor\x1b[0m`);
  }
}

console.log();

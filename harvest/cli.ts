/**
 * Harvester de Annex A desde SEC EDGAR.
 *
 *   export SEC_USER_AGENT="Tu Nombre tu@email.com"
 *
 *   npm run harvest -- preflight            verificar acceso
 *   npm run harvest -- trusts               listar trusts de CMBS
 *   npm run harvest -- filings <cik>        ver todos los filings de un trust
 *   npm run harvest -- fetch <cik>          cosechar el Annex A de un trust
 *   npm run harvest -- run --limit 3        descubrir y cosechar en lote
 *
 * La salida va a harvest/out/ como JSON.
 *
 * El comando `filings` es el de diagnóstico: muestra el puntaje de cada filing
 * como candidato a Annex A. Si `fetch` no encuentra nada, empezá por ahí.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EdgarError, fetchBuffer, preflight } from "./edgar/client.js";
import {
  findAnnexFilings, findCmbsTrusts, listRecentFilings,
  LARGE_DOCUMENT_WARN_BYTES, type FilingRef,
} from "./edgar/discover.js";
import { extractTables } from "./parse/tables.js";
import { findHeaderRow } from "./normalize/columnMap.js";
import {
  attachContinuationTables, joinAnnexTables, keepLoanRows,
} from "./normalize/annexStructure.js";
import { checkSanity, rowsToObservations, type SourceRef } from "./normalize/toObservations.js";

const OUT_DIR = new URL("./out/", import.meta.url).pathname;

const [, , command = "help", ...args] = process.argv;

try {
  switch (command) {
    case "preflight": await cmdPreflight(); break;
    case "trusts":    await cmdTrusts(); break;
    case "filings":   await cmdFilings(args[0]); break;
    case "fetch":     await cmdFetch(args[0]); break;
    case "run":       await cmdRun(args); break;
    default:          printHelp();
  }
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

function printHelp() {
  console.log(`
Harvester de Annex A (SEC EDGAR)

  preflight              verificar User-Agent y conectividad
  trusts                 listar trusts de CMBS
  filings <cik>          ver los filings de un trust, con su puntaje
  fetch <cik>            cosechar el Annex A de un trust
  run [--limit N]        descubrir y cosechar en lote

Antes de empezar:
  export SEC_USER_AGENT="Tu Nombre tu@email.com"
`);
}

async function cmdPreflight() {
  console.log("\nVerificando acceso a EDGAR...\n");
  const result = await preflight();
  console.log(result.ok ? `  ✓ ${result.message}` : `  ✗ ${result.message}`);
  console.log();
  if (!result.ok) process.exit(1);
}

async function cmdTrusts() {
  console.log("\nBuscando trusts de CMBS...\n");
  const trusts = await findCmbsTrusts({ limit: 15 });

  if (trusts.length === 0) {
    console.log("  Sin resultados.\n");
    return;
  }

  for (const t of trusts) {
    console.log(`  cik ${t.cik.padEnd(9)} ${t.name}`);
  }
  console.log(`\n  ${trusts.length} trusts. Inspeccioná uno con:\n     npm run harvest -- filings <cik>\n`);
}

async function cmdFilings(cik?: string) {
  if (!cik) throw new Error("Uso: filings <cik>");

  const filings = await listRecentFilings(cik, { limit: 60 });
  if (filings.length === 0) {
    console.log("\n  Sin filings.\n");
    return;
  }

  console.log(`\n${filings.length} filings recientes (score = candidato a Annex A):\n`);
  console.log(`  ${"score".padEnd(6)} ${"form".padEnd(8)} ${"tamaño".padStart(10)}  documento / descripción`);
  console.log(`  ${"─".repeat(70)}`);

  for (const f of filings) {
    if (f.score === 0 && f.sizeBytes < 500_000) continue; // ruido
    const mark = f.score >= 0.5 ? "\x1b[32m" : f.score > 0 ? "\x1b[33m" : "\x1b[90m";
    console.log(
      `  ${mark}${f.score.toFixed(2).padEnd(6)}\x1b[0m ${f.form.padEnd(8)} ${fmtBytes(f.sizeBytes).padStart(10)}  ${f.document}` +
        (f.description ? `  \x1b[90m(${f.description})\x1b[0m` : ""),
    );
  }
  console.log();
}

async function cmdFetch(cik?: string) {
  if (!cik) throw new Error("Uso: fetch <cik>");

  const picks = await findAnnexFilings(cik, { max: 1 });
  if (picks.length === 0) {
    await reportNoAnnex(cik);
    return;
  }

  const result = await harvestFiling(picks[0]!.filing, picks[0]!.score);
  if (result) await saveResult(result);
}

/**
 * Cuando no se identifica el Annex A, mostrar los candidatos más cercanos.
 *
 * El modo de falla conocido es un emisor que no pone "annex" en el nombre del
 * archivo. En ese caso el documento correcto casi siempre está entre los FWP
 * más grandes, así que los listamos en vez de dejar al usuario a ciegas.
 */
async function reportNoAnnex(cik: string) {
  console.log(`\n  ⚠ Sin Annex A identificable para el CIK ${cik}.`);

  const filings = await listRecentFilings(cik, { limit: 60 });
  const candidates = filings
    .filter((f) => /^(FWP|424B[0-9]?|424H)$/i.test(f.form) && f.sizeBytes > 500_000)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 5);

  if (candidates.length > 0) {
    console.log(`\n    Documentos grandes que podrían serlo:\n`);
    for (const c of candidates) {
      console.log(
        `      ${fmtBytes(c.sizeBytes).padStart(9)}  ${c.form.padEnd(7)} ${c.document}` +
          (c.description ? `  \x1b[90m(${c.description})\x1b[0m` : ""),
      );
    }
    console.log(
      `\n    Si alguno es el Annex A, agregá su caso a harvest/test.ts y ajustá\n` +
        `    scoreAnnexFiling() en harvest/edgar/discover.ts.`,
    );
  }

  console.log(`\n    Lista completa:  npm run harvest -- filings ${cik}\n`);
}

async function cmdRun(args: string[]) {
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 3 : 3;

  console.log(`\nDescubriendo trusts de CMBS (límite ${limit})...\n`);
  const trusts = await findCmbsTrusts({ limit });

  let ok = 0;
  for (const trust of trusts) {
    try {
      const picks = await findAnnexFilings(trust.cik, { max: 1 });
      if (picks.length === 0) {
        console.log(`\n${trust.name}`);
        await reportNoAnnex(trust.cik);
        continue;
      }
      const result = await harvestFiling(picks[0]!.filing, picks[0]!.score);
      if (result) {
        await saveResult(result);
        ok++;
      }
    } catch (err) {
      console.error(`  ✗ ${trust.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${ok}/${trusts.length} trusts cosechados → harvest/out/\n`);
}

// ---------------------------------------------------------------------------

async function harvestFiling(filing: FilingRef, score: number) {
  console.log(`\n${filing.companyName}`);
  console.log(
    `  ${filing.documentName} · ${fmtBytes(filing.sizeBytes)} · ${filing.formType}` +
      ` · ${filing.filedAt} · score ${score.toFixed(2)}`,
  );

  if (filing.sizeBytes > LARGE_DOCUMENT_WARN_BYTES) {
    console.log(
      `  ⚠ documento grande (${fmtBytes(filing.sizeBytes)}): la descarga y el parseo pueden tardar`,
    );
  }

  const startedAt = Date.now();
  const buffer = await fetchBuffer(filing.documentUrl, { timeoutMs: 180_000 });
  console.log(`  descargado en ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  let tables;
  try {
    const parseStart = Date.now();
    tables = extractTables(buffer, filing.documentName);
    console.log(
      `  ${tables.length} tabla(s) · parseado en ${((Date.now() - parseStart) / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    console.log(`  ⚠ ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // El Annex A viene partido en bloques horizontales que comparten Loan ID, y
  // cada bloque se reparte en páginas donde solo la primera trae encabezados.
  const { tables: annexTables, adopted, orphans } = attachContinuationTables(
    tables,
    (rows) => findHeaderRow(rows),
  );

  if (adopted > 0) {
    console.log(`  ${adopted} tablas de continuación adoptadas${orphans ? `, ${orphans} huérfanas` : ""}`);
  }

  if (annexTables.length === 0) {
    console.log(`  ⚠ ninguna tabla tiene encabezados reconocibles`);
    const sample = tables[0]?.rows[0];
    if (sample) console.log(`     primera fila de la tabla 0: ${JSON.stringify(sample).slice(0, 200)}`);
    return null;
  }

  const joined = joinAnnexTables(annexTables);
  if (!joined) {
    console.log(`  ⚠ no se pudo armar la tabla de datos`);
    return null;
  }

  if (joined.tablesJoined > 1) {
    console.log(`  unidas ${joined.tablesJoined} tablas por Loan ID: ${joined.sources.join(", ")}`);
  } else {
    console.log(`  tabla ${joined.sources[0]} (sin unión: no hay Loan ID común)`);
  }
  if (joined.skipped.length > 0) {
    console.log(`  \x1b[90mdescartadas: ${joined.skipped.join(", ")}\x1b[0m`);
  }

  // Un préstamo sobre varias propiedades genera una fila por cada una.
  const filtered = keepLoanRows(joined.rows, joined.headerRowIndex);
  if (filtered.hadFlagColumn) {
    console.log(
      `  ${filtered.loanRows} préstamos · ${filtered.propertyRows} filas de propiedad descartadas`,
    );
  }

  const source: SourceRef = {
    cik: filing.cik,
    accession: filing.accession,
    companyName: filing.companyName,
    formType: filing.formType,
    filedAt: filing.filedAt,
    fileName: filing.documentName,
    fileUrl: filing.documentUrl,
  };

  const result = rowsToObservations(filtered.rows, joined.headerRowIndex, source);

  console.log(
    `  ${result.stats.propertiesKept} propiedades · ${result.stats.observations} observations` +
      ` · ${result.stats.rowsSkipped} filas descartadas`,
  );

  if (result.columnsMapped.length > 0) {
    console.log(`  mapeadas: ${result.columnsMapped.map((c) => c.metric).join(", ")}`);
  }

  const issues = checkSanity(result);
  for (const issue of issues) {
    const icon = issue.severity === "error" ? "✗" : "⚠";
    console.log(`  ${icon} [${issue.metric}] ${issue.message}`);
    if (issue.sampleValues.length) console.log(`      ej: ${issue.sampleValues.join(", ")}`);
  }
  if (issues.length === 0) console.log(`  ✓ chequeos de sanidad sin observaciones`);

  return result;
}

/**
 * Guarda la cosecha.
 *
 * Siempre escribe el JSON —es el formato de intercambio y hace el pipeline
 * inspeccionable sin base de datos. Con `--persist` además la guarda en
 * Postgres, que es lo que permite acumular corpus entre corridas.
 */
async function saveResult(result: Awaited<ReturnType<typeof rowsToObservations>>) {
  await mkdir(OUT_DIR, { recursive: true });
  const name = `${result.source.accession}.json`;
  await writeFile(join(OUT_DIR, name), JSON.stringify(result, null, 2));
  console.log(`  → harvest/out/${name}`);

  if (!process.argv.includes("--persist")) return;

  // Import dinámico: sin --persist no hace falta ni que Postgres exista.
  const { saveHarvest } = await import("../db/corpus.js");
  const { closePool, ping } = await import("../db/client.js");

  const health = await ping();
  if (!health.ok) {
    console.log(`  \x1b[33m⚠ no se pudo persistir\x1b[0m`);
    console.log(`  ${health.message.split("\n").join("\n  ")}`);
    await closePool();
    return;
  }
  if (!health.schemaReady) {
    console.log(`  \x1b[33m⚠ el schema no existe. Corré: npm run db:migrate\x1b[0m`);
    await closePool();
    return;
  }

  const report = await saveHarvest(result);
  console.log(
    `  → postgres: ${report.loans} préstamos · ${report.observations} observations · ` +
      `${report.facts} facts${report.replaced ? " \x1b[90m(reemplazó la versión anterior)\x1b[0m" : ""}`,
  );
  await closePool();
}

function fmtBytes(n: number): string {
  if (n > 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n > 1000) return `${Math.round(n / 1000)} KB`;
  return `${n} B`;
}

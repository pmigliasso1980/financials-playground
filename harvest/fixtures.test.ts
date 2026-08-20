/**
 * Test contra HTML crudo de Annex A reales.
 *
 * Corre sobre cualquier fixture que encuentre en `harvest/fixtures/`. Si no hay
 * ninguno, avisa cómo capturar uno y termina sin fallar —así el pipeline de
 * tests no se rompe en una máquina que todavía no descargó nada.
 *
 *   npm run harvest:capture -- 2053102   # una vez, requiere red
 *   npm run harvest:fixtures             # después, offline para siempre
 *
 * QUÉ APORTA QUE NO APORTEN LOS OTROS TESTS
 *
 * `harvest:real` usa los encabezados y valores reales, pero transcritos a
 * arrays de TypeScript. Este corre sobre el **markup original**: `<font>`
 * anidados dentro de `<td>`, estilos inline, `&nbsp;`, filas de separación,
 * encabezados en tres niveles de colspan. Es lo único que ejercita de verdad
 * el parser de HTML contra la suciedad real.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractFromHtml } from "./parse/tables.js";
import { findHeaderRow, mapColumns } from "./normalize/columnMap.js";
import { attachContinuationTables, joinAnnexTables, keepLoanRows } from "./normalize/annexStructure.js";
import { checkSanity, rowsToObservations, type SourceRef } from "./normalize/toObservations.js";
import { toProperties } from "./normalize/toProperties.js";

const FIXTURES_DIR = new URL("./fixtures/", import.meta.url).pathname;

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`    \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`    \x1b[31m✗\x1b[0m ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

interface FixtureMeta {
  cik: string;
  accession: string;
  companyName: string;
  formType: string;
  filedAt: string;
  fileName: string;
  fileUrl: string;
  originalBytes?: number;
  trimmedBytes?: number;
}

// ---------------------------------------------------------------------------

console.log("\nAnnex A reales — markup crudo\n");

let files: string[] = [];
try {
  files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".html")).sort();
} catch {
  // el directorio no existe todavía
}

if (files.length === 0) {
  console.log("  \x1b[90mNo hay fixtures capturados.\x1b[0m\n");
  console.log("  Para capturar uno (requiere red y SEC_USER_AGENT):\n");
  console.log('    export SEC_USER_AGENT="Tu Nombre tu@email.com"');
  console.log("    npm run harvest:capture -- 2053102     # Wells Fargo 2025-C64");
  console.log("    npm run harvest:capture -- 2110410     # Benchmark 2026-B42");
  console.log("    npm run harvest:capture -- 2104049     # BANK5 2026-5YR20\n");
  console.log("  Queda versionado y a partir de ahí este test corre offline.\n");
  process.exit(0);
}

for (const file of files) {
  const slug = file.replace(/\.html$/, "");
  const html = await readFile(join(FIXTURES_DIR, file), "utf8");

  let meta: FixtureMeta;
  try {
    meta = JSON.parse(await readFile(join(FIXTURES_DIR, `${slug}.json`), "utf8")) as FixtureMeta;
  } catch {
    meta = {
      cik: "?", accession: slug, companyName: slug, formType: "FWP",
      filedAt: "", fileName: file, fileUrl: "",
    };
  }

  console.log(`  ${meta.companyName}`);
  console.log(
    `  \x1b[90m${meta.fileName} · ${(Buffer.byteLength(html) / 1000).toFixed(0)} KB` +
      (meta.originalBytes ? ` (original ${(meta.originalBytes / 1e6).toFixed(1)} MB)` : "") +
      `\x1b[0m\n`,
  );

  // --- parseo -----------------------------------------------------------------

  const t0 = Date.now();
  const tables = extractFromHtml(html);
  const parseMs = Date.now() - t0;

  check("el parser extrae al menos una tabla", () => {
    assert(tables.length > 0, "no extrajo ninguna tabla");
  });

  // Las páginas de continuación no repiten el encabezado: hay que adoptarlas
  // en el bloque al que pertenecen o se pierde la mayor parte del pool.
  const { tables: annexTables, adopted, orphans } = attachContinuationTables(
    tables,
    (rows) => findHeaderRow(rows),
  );

  check("detecta encabezados reconocibles", () => {
    assert(
      annexTables.length > 0,
      `ninguna de las ${tables.length} tablas tiene encabezados mapeables. ` +
        `Primera fila: ${JSON.stringify(tables[0]?.rows[0]).slice(0, 200)}`,
    );
  });

  check("ninguna tabla huérfana contiene préstamos", () => {
    /**
     * Esta prueba antes exigía `adopted > 0`, con el razonamiento de que un
     * Annex A reparte cada bloque en muchas páginas y solo la primera trae
     * encabezados, así que sin adopción se pierde el pool.
     *
     * Sobre el documento real la premisa resultó falsa y la prueba falsa-positiva.
     * Wells Fargo 2025-C64 repite los encabezados en cada página, así que el
     * apilado por encabezado idéntico ya recupera todo: 13 bloques con
     * encabezado producen los 32 préstamos, y las 112 tablas sin encabezado son
     * pies de página, notas al pie y adornos de maquetación. Rechazarlas es
     * correcto —la validación por continuidad de Loan ID está haciendo su
     * trabajo— y exigir que se adopte alguna pedía que el parser tragara basura.
     *
     * Lo que sí importa verificar es la propiedad de fondo: que ninguna tabla
     * descartada tenga filas con pinta de préstamo. Eso detecta la pérdida real
     * de datos sin atarse a cómo se recuperan.
     */
    const headerless = tables.length - annexTables.length;
    if (headerless === 0) return;

    /** Loan IDs que aparecen en una tabla, sean del bloque que sean. */
    const loanIdsOf = (rows: unknown[][]): string[] => {
      const ids: string[] = [];
      for (const row of rows) {
        const filled = row.filter((c) => c !== null && String(c).trim() !== "");
        if (filled.length < 8) continue;
        const first = String(filled[0] ?? "").trim();
        // Un Loan ID de Annex A es entero o entero con decimales (3, 3.00, 3.01).
        if (/^\d{1,3}(\.\d{1,2})?$/.test(first)) ids.push(String(Math.trunc(Number(first))));
      }
      return ids;
    };

    const parsedIds = new Set(annexTables.flatMap((t) => loanIdsOf(t.rows)));
    const orphanTables = tables.filter((t) => !annexTables.some((a) => a.name === t.name));

    /**
     * Dos cosas distintas que antes se confundían.
     *
     * Un bloque huérfano CON préstamos puede ser una de dos:
     *
     *   a) préstamos que no están en ningún bloque parseado → pérdida real,
     *   b) los mismos préstamos con otras columnas → pérdida de métricas.
     *
     * (b) es lo que pasa en Wells Fargo 2025-C64: tres bloques de 71 filas con
     * "Annual Debt Service", "Amortization Type", "Upfront RE Tax Reserve",
     * "Holdback/Earnout". Ninguna de esas columnas está en el mapeo, así que
     * `detectHeader` los da por no-Annex y se descartan enteros. Los préstamos
     * no se pierden —están en los bloques que sí leemos— pero esas métricas sí.
     *
     * Solo (a) hace fallar la prueba. (b) se reporta, porque es cola de trabajo
     * del mapeo y hoy es invisible: el listado de "sin mapear" solo cubre
     * columnas de bloques que abrimos, nunca bloques que nunca abrimos.
     */
    const lost: string[] = [];
    const columnLoss: string[] = [];
    for (const t of orphanTables) {
      const ids = loanIdsOf(t.rows);
      if (ids.length === 0) continue;
      if (ids.some((id) => !parsedIds.has(id))) lost.push(t.name);
      else columnLoss.push(t.name);
    }

    if (columnLoss.length > 0) {
      console.log(
        `      \x1b[90m${columnLoss.length} bloque(s) con préstamos conocidos pero sin ` +
          `columnas mapeables: ${columnLoss.slice(0, 4).join(", ")}\x1b[0m`,
      );
      console.log(
        `      \x1b[90mno se pierden préstamos, se pierden métricas — cola de trabajo del mapeo\x1b[0m`,
      );
    }

    assert(
      lost.length === 0,
      `${lost.length} bloque(s) huérfanos con préstamos que NO aparecen en ningún ` +
        `bloque parseado: ${lost.slice(0, 3).join(", ")}. Pérdida real de datos ` +
        `(adoptadas: ${adopted}, huérfanas: ${orphans}).`,
    );
  });

  if (annexTables.length === 0) {
    console.log();
    continue;
  }

  // --- estructura ---------------------------------------------------------------

  const joined = joinAnnexTables(annexTables);

  check("arma una tabla de datos", () => {
    assert(joined, "joinAnnexTables devolvió null");
  });

  if (!joined) {
    console.log();
    continue;
  }

  const filtered = keepLoanRows(joined.rows, joined.headerRowIndex);
  const source: SourceRef = {
    cik: meta.cik, accession: meta.accession, companyName: meta.companyName,
    formType: meta.formType, filedAt: meta.filedAt,
    fileName: meta.fileName, fileUrl: meta.fileUrl,
  };
  const result = rowsToObservations(filtered.rows, joined.headerRowIndex, source);

  // --- verificaciones -------------------------------------------------------------

  check("produce propiedades con observations", () => {
    assert(result.stats.propertiesKept > 0, "no produjo ninguna propiedad");
    assert(result.stats.observations > 0, "no produjo ninguna observation");
  });

  check("mapea al menos 8 columnas", () => {
    assert(
      result.columnsMapped.length >= 8,
      `solo ${result.columnsMapped.length}: ${result.columnsMapped.map((c) => c.metric).join(", ")}`,
    );
  });

  check("captura alguna métrica financiera central", () => {
    const keys = new Set(result.columnsMapped.map((c) => c.metric));
    const core = ["noi_underwritten", "noi_most_recent", "loan_amount", "dscr", "occupancy", "occupancy_economic"];
    const found = core.filter((k) => keys.has(k as never));
    assert(found.length >= 2, `solo encontró: ${found.join(", ") || "(ninguna)"}`);
  });

  check("cada propiedad tiene nombre o dirección", () => {
    const anonymous = result.properties.filter((p) => !p.label.property_name && !p.label.address);
    assert(
      anonymous.length === 0,
      `${anonymous.length} de ${result.properties.length} propiedades sin identificar`,
    );
  });

  check("los porcentajes quedan en 0-1", () => {
    const bad: string[] = [];
    for (const prop of result.properties) {
      for (const obs of prop.observations) {
        if (obs.unit !== "percent") continue;
        const v = Number(obs.value);
        if (v < 0 || v > 1) bad.push(`${obs.metric_key}=${obs.value} (${obs.raw_value})`);
      }
    }
    assert(bad.length === 0, `${bad.length} fuera de rango: ${bad.slice(0, 3).join(", ")}`);
  });

  check("no se cuelan marcadores de ausencia como valores", () => {
    const junk: string[] = [];
    for (const prop of result.properties) {
      for (const obs of prop.observations) {
        if (/^(n\/?a|nap|nav|various|none|-)$/i.test(obs.value.trim())) {
          junk.push(`${obs.metric_key}="${obs.value}"`);
        }
      }
    }
    assert(junk.length === 0, `${junk.length} valores basura: ${junk.slice(0, 3).join(", ")}`);
  });

  check("los chequeos de sanidad no encuentran errores", () => {
    const issues = checkSanity(result);
    const errors = issues.filter((i) => i.severity === "error");
    assert(errors.length === 0, errors.map((e) => `[${e.metric}] ${e.message}`).join("; "));
  });

  check("el parseo del markup real no es lento", () => {
    assert(parseMs < 10_000, `tardó ${parseMs} ms`);
  });

  /**
   * Las filas de propiedad, que el harvester descartaba.
   *
   * Estos chequeos existen porque los dos defectos que tuvo `toProperties` eran
   * invisibles a ojo: el índice desfasado en uno perdía la primera propiedad de
   * cada documento y ataba las demás a la fila anterior, y el ID leído del mapa de
   * columnas dejaba 49 propiedades sin préstamo en un fixture y no en los otros
   * dos. Ninguno tira una excepción; los dos producen una tabla que parece bien.
   *
   * Se afirma contra `filtered.propertyRows`, que es lo que el filtro dice haber
   * descartado, y no contra un número escrito a mano: un fixture nuevo entra sin
   * tocar el test, y si el filtro cambia el test lo acusa.
   */
  const propiedades = toProperties(
    joined.rows, joined.headerRowIndex, filtered.droppedPropertyRows, source,
  );

  check("no se pierde ninguna fila de propiedad", () => {
    assert(
      propiedades.length === filtered.propertyRows,
      `el filtro descartó ${filtered.propertyRows} y se normalizaron ${propiedades.length}`,
    );
  });

  check("cada propiedad conserva su fila original y no se repite", () => {
    const idx = new Set(propiedades.map((p) => p.rowIndex));
    assert(
      idx.size === propiedades.length,
      `${propiedades.length - idx.size} rowIndex repetidos: la clave estable no lo es`,
    );
    const delFiltro = new Set(filtered.droppedPropertyRows.map((d) => d.rowIndex));
    const ajenos = [...idx].filter((i) => !delFiltro.has(i));
    assert(ajenos.length === 0, `rowIndex que el filtro no descartó: ${ajenos.slice(0, 5).join(", ")}`);
  });

  check("las propiedades traen el estado, que es el motivo de guardarlas", () => {
    if (propiedades.length === 0) return;
    const con = propiedades.filter((p) => p.state).length;
    assert(
      con / propiedades.length >= 0.9,
      `solo ${con} de ${propiedades.length} tienen estado`,
    );
  });

  check("cada propiedad ata a un préstamo por la numeración del emisor", () => {
    if (propiedades.length === 0) return;
    const con = propiedades.filter((p) => p.loanRef).length;
    assert(
      con / propiedades.length >= 0.9,
      `solo ${con} de ${propiedades.length} atan a un préstamo`,
    );
  });

  check("el estado de las propiedades queda en código de dos letras", () => {
    const malos = propiedades
      .map((p) => p.state)
      .filter((e): e is string => e !== null && !/^[A-Z]{2}$/.test(e));
    assert(malos.length === 0, `sin normalizar: ${[...new Set(malos)].slice(0, 4).join(" | ")}`);
  });

  // --- informe ---------------------------------------------------------------------

  const issues = checkSanity(result);
  const warnings = issues.filter((i) => i.severity === "warning");

  console.log(
    `\n    \x1b[90m${tables.length} tablas → ${annexTables.length} bloques ` +
      `(${adopted} continuaciones adoptadas, ${orphans} huérfanas) → ` +
      `${joined.stackedGroups ?? "?"} tras apilar → ${joined.tablesJoined} unidos\x1b[0m`,
  );
  console.log(
    `    \x1b[90m${result.stats.propertiesKept} propiedades · ${result.stats.observations} observations · ` +
      `${result.columnsMapped.length} columnas · ${parseMs} ms\x1b[0m`,
  );

  if (filtered.hadFlagColumn) {
    console.log(
      `    \x1b[90m${filtered.loanRows} préstamos, ${filtered.propertyRows} filas de propiedad descartadas\x1b[0m`,
    );
  }

  console.log(`    \x1b[90mmapeadas: ${result.columnsMapped.map((c) => c.metric).join(", ")}\x1b[0m`);

  if (warnings.length > 0) {
    for (const w of warnings) console.log(`    \x1b[33m⚠ [${w.metric}] ${w.message}\x1b[0m`);
  }

  if (result.columnsUnmapped.length > 0) {
    const sample = result.columnsUnmapped.slice(0, 8).join(" | ");
    console.log(
      `    \x1b[90msin mapear (${result.columnsUnmapped.length}): ${sample}` +
        `${result.columnsUnmapped.length > 8 ? " …" : ""}\x1b[0m`,
    );
  }

  console.log();
}

// ---------------------------------------------------------------------------

console.log(
  `${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} ok · ${failed} failed\x1b[0m` +
    ` \x1b[90m(${files.length} fixture${files.length === 1 ? "" : "s"})\x1b[0m\n`,
);

process.exit(failed === 0 ? 0 : 1);

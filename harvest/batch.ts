/**
 * Cosecha en lote, para armar un corpus con el que se puedan ver distribuciones.
 *
 *   npm run harvest:batch -- --limit 30
 *   npm run harvest:batch -- --cik 2053102,2110410,2104049
 *   npm run harvest:batch -- --limit 300 --years 7
 *   npm run harvest:batch -- --limit 300 --refresh-stale
 *
 * Un solo filing no dice nada: 32 préstamos no alcanzan para distinguir una
 * mediana de un accidente. Con veinte o treinta trusts —entre 600 y 2000
 * préstamos— recién ahí las distribuciones por tipo de activo empiezan a tener
 * sentido.
 *
 * Respeta el límite de SEC (el cliente limita a 8 req/s) y salta los trusts que
 * fallan en vez de abortar: en un lote de treinta, uno o dos van a tener el
 * Annex en un formato que todavía no manejamos.
 */

import { EdgarError, preflight } from "./edgar/client.js";
import { TAXONOMY_VERSION } from "./normalize/definitions.js";
import { findAnnexFilings, findCmbsTrusts } from "./edgar/discover.js";
import { fetchBuffer } from "./edgar/client.js";
import { extractTables } from "./parse/tables.js";
import { findHeaderRow } from "./normalize/columnMap.js";
import { attachContinuationTables, joinAnnexTables, keepLoanRows } from "./normalize/annexStructure.js";
import { checkSanity, rowsToObservations, type SourceRef } from "./normalize/toObservations.js";
import { saveHarvest } from "../db/corpus.js";
import { closePool, ping } from "../db/client.js";
import { query } from "../db/client.js";

const args = process.argv.slice(2);

function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

const limit = Number(flag("limit")) || 20;
/**
 * Cuántos años hacia atrás buscar.
 *
 * EDGAR corta la paginación de una misma consulta alrededor de los 100
 * resultados, y esos 100 son los más recientes. Sin ventanas de fecha, pedir 300
 * trusts devuelve los mismos 100 de siempre.
 *
 * El default de 4 cubre 2023-2026, que es lo que hacía falta para tener añadas
 * con desempeño reportado. Para empalmar con la ventana de Griffin —que termina
 * en 2019— hay que ir más atrás:
 *
 *   npm run harvest:batch -- --limit 300 --years 7
 */
const years = Number(flag("years")) || 4;
const explicitCiks = flag("cik")?.split(",").map((c) => c.trim()).filter(Boolean) ?? [];

/**
 * Varias consultas porque una sola no alcanza.
 *
 * La búsqueda full-text de EDGAR devuelve resultados sesgados hacia los
 * emisores más frecuentes. Rotando el fraseo se llega a familias distintas
 * —Benchmark, BANK, BBCMS, Wells Fargo, Morgan Stanley— y el corpus queda menos
 * concentrado en un solo originador, que es lo que arruinaría las medianas.
 */
const DISCOVERY_QUERIES = [
  '"Commercial Mortgage Trust"',
  '"Mortgage Trust" "ANNEX A-1"',
  '"Commercial Mortgage Pass-Through Certificates"',
  '"Multifamily Mortgage Trust"',
];

try {
  await main();
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  await closePool();
  process.exit(1);
}
await closePool();

// ---------------------------------------------------------------------------

async function main() {
  const health = await ping();
  if (!health.ok) {
    console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
    process.exit(1);
  }
  if (!health.schemaReady) {
    console.error(`\n✗ El schema corpus no existe.\n\n    npm run db:migrate\n`);
    process.exit(1);
  }

  /**
   * Verificar EDGAR antes de empezar, no en la primera consulta.
   *
   * El lote chequeaba la base y arrancaba, así que un SEC_USER_AGENT faltante se
   * descubría recién adentro del bucle de descubrimiento y se manifestaba como
   * quince fallos seguidos. Una precondición se verifica una vez, al principio,
   * y con un mensaje.
   */
  const edgar = await preflight();
  if (!edgar.ok) {
    console.error(`\n✗ ${edgar.message.split("\n").join("\n  ")}\n`);
    process.exit(1);
  }

  const ciks = explicitCiks.length > 0 ? explicitCiks : await discover(limit);

  if (ciks.length === 0) {
    console.error("\n✗ No se encontraron trusts. Probá con --cik.\n");
    process.exit(1);
  }

  // Los que ya están en el corpus se saltean: el lote es reanudable.
  const { rows: existing } = await query<{ cik: string }>("SELECT DISTINCT cik FROM corpus.filings");
  const already = new Set(existing.map((r) => r.cik));

  /**
   * Recosecha dirigida cuando el mapeo mejora.
   *
   * El problema: el lote saltea lo que ya está, así que un mapeo nuevo no llega
   * a los filings viejos. La opción obvia —borrar todo y recosechar— tarda veinte
   * minutos, gasta mil pedidos contra SEC y ya nos dejó sin corpus una vez.
   *
   * `--refresh-missing-id` baja solo las emisiones cuyos préstamos no tienen
   * identificador USABLE, que son las que el mapeo nuevo puede arreglar. La
   * carga es idempotente (ON CONFLICT DO UPDATE), así que recosechar una
   * emisión la actualiza en vez de duplicarla.
   *
   * POR QUÉ "USABLE" Y NO "PRESENTE"
   *
   * La primera versión pedía `loan_ref IS NOT NULL`. Después metí un patrón que
   * mapeaba la columna de flag como identificador, y esos filings pasaron a
   * tener loan_ref con valores "Loan" y "Property" —presente, inservible—. El
   * selector los dio por sanos y los salteó: la herramienta hecha para encontrar
   * el problema quedó ciega justo al problema.
   *
   * El criterio ahora es el que el join necesita de verdad: que empiece con un
   * dígito. Un identificador que no se puede usar es lo mismo que no tenerlo.
   */
  /**
   * `--refresh-stale`: recosecha lo cosechado con un mapeo viejo.
   *
   * Es el criterio que había que usar desde el principio. Los tres anteriores
   * —"sin identificador", "sin identificador usable", "rangos disjuntos"—
   * definían la recosecha por un síntoma, y cada arreglo del mapeo cambiaba el
   * síntoma. Benchmark 2020-B16 escapó del selector tres veces seguidas: primero
   * porque tenía loan_ref basura, después porque el basura era numérico, después
   * porque un solo préstamo con id numérico alcanzaba para parecer sano.
   *
   * La versión de la taxonomía con que se cosechó no depende de si el resultado
   * se ve bien. Es el único predicado que no se mueve cuando arreglás algo.
   */
  const refreshStale = args.includes("--refresh-stale");
  const refreshMissingId = args.includes("--refresh-missing-id");
  let refresh = new Set<string>();

  if (refreshStale) {
    const { rows } = await query<{ cik: string; version: string | null; loans: string }>(
      `SELECT f.cik,
              f.stats->>'taxonomyVersion' AS version,
              count(l.id)::text AS loans
         FROM corpus.filings f
         LEFT JOIN corpus.loans l ON l.accession = f.accession
        WHERE coalesce(f.stats->>'taxonomyVersion', '') <> $1
        GROUP BY f.cik, f.stats->>'taxonomyVersion'`,
      [TAXONOMY_VERSION],
    );
    /**
     * Normalizado, porque así se consulta más abajo.
     *
     * `f.cik` puede venir con ceros a la izquierda y el filtro de `pending` usa
     * `String(Number(c))`. Guardar el crudo hacía que el `has` no matcheara
     * nunca — el conjunto se calculaba, se anunciaba, y no seleccionaba nada.
     */
    refresh = new Set(rows.map((r) => String(Number(r.cik))));
    const affected = rows.reduce((a, r) => a + Number(r.loans), 0);
    console.log(
      `\n\x1b[33m--refresh-stale:\x1b[0m ${refresh.size} emisiones cosechadas con un mapeo ` +
        `anterior a ${TAXONOMY_VERSION} (${affected} préstamos).`,
    );

    /**
     * Avisar que la recosecha se lleva puesto el desempeño.
     *
     * Recosechar borra el filing entero antes de reescribirlo, y
     * `corpus.performance` referencia `loans(id)` con ON DELETE CASCADE. El
     * desempeño de esos préstamos desaparece con ellos.
     *
     * No es recuperable desde acá: los 10-D hay que volver a bajarlos de EDGAR.
     * Y no se nota después —las identidades siguen cerrando, el corpus sigue
     * completo— así que el único momento útil para decirlo es ANTES.
     */
    const { rows: perf } = await query<{ filas: string; prestamos: string }>(
      `SELECT count(*)::text AS filas, count(DISTINCT p.loan_id)::text AS prestamos
         FROM corpus.performance p
         JOIN corpus.loans l ON l.id = p.loan_id
         JOIN corpus.filings f ON f.accession = l.accession
        WHERE f.cik = ANY($1)`,
      [[...refresh]],
    );

    const perdidos = Number(perf[0]?.prestamos ?? 0);
    if (perdidos > 0) {
      console.log(
        `\x1b[31m  Se van a borrar ${Number(perf[0]!.filas).toLocaleString("en-US")} filas de ` +
          `desempeño de ${perdidos.toLocaleString("en-US")} préstamos.\x1b[0m`,
      );
      console.log(
        `\x1b[90m  El CASCADE viene de loans(id). Reconstruir después con:\x1b[0m ` +
          `\x1b[1mnpm run db:performance\x1b[0m`,
      );
    }
  }

  if (refreshMissingId) {
    const { rows } = await query<{ cik: string; loans: string }>(
      `SELECT f.cik, count(l.id)::text AS loans
         FROM corpus.filings f
         JOIN corpus.loans l ON l.accession = f.accession
        WHERE f.accession NOT IN (
                SELECT DISTINCT accession FROM corpus.loans
                 WHERE loan_ref ~ '^[0-9]'
              )
        GROUP BY f.cik`,
    );
    for (const r of rows) refresh.add(r.cik);
    const affected = rows.reduce((a, r) => a + Number(r.loans), 0);
    console.log(
      `\n\x1b[33m--refresh-missing-id:\x1b[0m ${refresh.size} emisiones sin identificador usable ` +
        `(${affected} préstamos) se van a recosechar.`,
    );
  }

  /**
   * Lo descubierto MÁS lo que hay que recosechar, no lo descubierto FILTRADO.
   *
   * Esta línea decía `ciks.filter(... || refresh.has(...))`. Como `ciks` sale
   * del descubrimiento —que por definición busca trusts que NO están en el
   * corpus— una emisión vieja no aparecía ahí y el `||` no tenía sobre qué
   * actuar. El flag calculaba 222 emisiones obsoletas, imprimía una advertencia
   * en rojo sobre borrar 2.213 filas de desempeño, y después cosechaba otra
   * cosa: veinte trusts nuevos de 2011-2014.
   *
   * Es la peor forma de este error. No falló en silencio: falló anunciando en
   * voz alta que estaba haciendo lo correcto.
   */
  const norm = (c: string) => String(Number(c));
  const descubiertos = ciks.filter((c) => !already.has(norm(c)));
  const enLista = new Set(descubiertos.map(norm));

  /**
   * `--refresh-limit N`: recosechar N emisiones y parar.
   *
   * Recosechar 222 emisiones son ~30 minutos y borra el desempeño de 2.213
   * préstamos por CASCADE. El código que las selecciona acababa de tener un bug
   * que lo hacía no seleccionar ninguna mientras anunciaba lo contrario.
   *
   * Correr cinco primero cuesta un minuto y responde si el arreglo funciona.
   * Es la misma lógica que la sonda del vendedor: verificar antes de la
   * operación cara, no después de que el resultado sorprenda.
   */
  const refreshLimitFlag = args.indexOf("--refresh-limit");
  const refreshLimit =
    refreshLimitFlag === -1 ? Infinity : Number(args[refreshLimitFlag + 1] ?? Infinity);

  const aRecosechar = [...refresh]
    .filter((c) => !enLista.has(c))
    .slice(0, refreshLimit);
  const pending = [...descubiertos, ...aRecosechar];
  const skipped = ciks.length - descubiertos.length;

  console.log(
    `\n${ciks.length} trusts descubiertos · ${descubiertos.length} nuevos por cosechar` +
      `${skipped ? ` · ${skipped} ya en el corpus` : ""}` +
      `${aRecosechar.length ? ` · \x1b[33m${aRecosechar.length} a recosechar por mapeo viejo\x1b[0m` : ""}\n`,
  );

  const started = Date.now();
  let ok = 0;
  let failed = 0;
  let loans = 0;
  let observations = 0;
  const problems: Array<{ cik: string; reason: string }> = [];

  for (const [i, cik] of pending.entries()) {
    const prefix = `[${String(i + 1).padStart(2)}/${pending.length}]`;

    try {
      const result = await harvestOne(cik);
      if (!result) {
        failed++;
        problems.push({ cik, reason: "sin Annex A identificable" });
        console.log(`${prefix} \x1b[33m—\x1b[0m cik ${cik}: sin Annex A`);
        continue;
      }

      const report = await saveHarvest(result);
      ok++;
      loans += report.loans;
      observations += report.observations;

      const issues = checkSanity(result);
      const errors = issues.filter((s) => s.severity === "error").length;
      const mark = errors > 0 ? "\x1b[33m⚠\x1b[0m" : "\x1b[32m✓\x1b[0m";

      console.log(
        `${prefix} ${mark} ${result.source.companyName.slice(0, 44).padEnd(44)} ` +
          `${String(report.loans).padStart(3)} préstamos · ${String(report.observations).padStart(4)} obs` +
          `${errors > 0 ? ` · \x1b[33m${errors} error(es) de sanidad\x1b[0m` : ""}`,
      );
    } catch (err) {
      failed++;
      const reason = err instanceof EdgarError ? `EDGAR ${err.status}` : String(err).slice(0, 60);
      problems.push({ cik, reason });
      console.log(`${prefix} \x1b[31m✗\x1b[0m cik ${cik}: ${reason}`);
    }
  }

  const mins = ((Date.now() - started) / 60_000).toFixed(1);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  ${ok} cosechados · ${failed} fallidos · ${mins} min`);
  console.log(`  ${loans} préstamos · ${observations} observations agregadas`);

  if (problems.length > 0) {
    console.log(`\n  No se pudieron cosechar:`);
    for (const p of problems) {
      console.log(`    cik ${p.cik.padEnd(9)} ${p.reason}`);
    }
    console.log(`\n  \x1b[90mInspeccioná alguno con: npm run harvest -- filings <cik>\x1b[0m`);
  }

  const { rows: totals } = await query<{ filings: string; loans: string }>(
    "SELECT (SELECT count(*) FROM corpus.filings) AS filings, (SELECT count(*) FROM corpus.loans) AS loans",
  );
  console.log(
    `\n  Corpus: ${totals[0]!.filings} filings · ${totals[0]!.loans} préstamos\n`,
  );
  console.log(`  Siguiente:  npm run db:analyze\n`);
}

// ---------------------------------------------------------------------------

/**
 * Ventanas anuales para llegar más atrás.
 *
 * EDGAR corta la paginación de una misma consulta alrededor de los 100
 * resultados, y esos 100 son los más recientes. Para juntar cientos de trusts
 * hay que combinar consultas distintas con ventanas de fechas distintas.
 */
function yearWindows(years: number): Array<{ from: string; to: string }> {
  const currentYear = new Date().getFullYear();
  const windows: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < years; i++) {
    const y = currentYear - i;
    windows.push({ from: `${y}-01-01`, to: `${y}-12-31` });
  }
  return windows;
}

async function discover(target: number): Promise<string[]> {
  const span = target > 40 ? yearWindows(years) : [];
  const range = span.length
    ? ` · ${span[span.length - 1]!.from.slice(0, 4)}-${span[0]!.to.slice(0, 4)}`
    : "";
  console.log(`\nDescubriendo trusts de CMBS (objetivo ${target}${range})...`);

  const found = new Map<string, string>();
  // Con pocos trusts alcanza el año en curso; para cientos hay que ir atrás.
  const windows = target > 40 ? yearWindows(years) : [{ from: "", to: "" }];

  for (const win of windows) {
    for (const q of DISCOVERY_QUERIES) {
      if (found.size >= target) break;

      try {
        const trusts = await findCmbsTrusts({
          query: q,
          limit: target,
          ...(win.from ? { dateFrom: win.from, dateTo: win.to } : {}),
        });

        const before = found.size;
        for (const t of trusts) {
          if (!found.has(t.cik)) found.set(t.cik, t.name);
          if (found.size >= target) break;
        }

        const added = found.size - before;
        if (added > 0) {
          const label = win.from ? `${win.from.slice(0, 4)} · ` : "";
          console.log(`  ${label}${q.slice(0, 46).padEnd(46)} +${String(added).padStart(3)} → ${found.size}`);
        }
      } catch (err) {
        /**
         * Un problema de configuración no se reintenta.
         *
         * Este catch trataba todo igual: si faltaba SEC_USER_AGENT, las quince
         * combinaciones de consulta y año fallaban por lo mismo y el mismo
         * mensaje se imprimía quince veces, terminando en un "no se encontraron
         * trusts" que sugería revisar la consulta. Reintentar algo que no puede
         * funcionar no es robustez, es ruido que oculta la causa.
         */
        const msg = err instanceof Error ? err.message : String(err);
        if (/SEC_USER_AGENT/.test(msg)) throw err;
        console.log(`  \x1b[90m${q} falló: ${msg}\x1b[0m`);
      }
    }
    if (found.size >= target) break;
  }

  if (found.size < target) {
    console.log(
      `\n  \x1b[33mSe encontraron ${found.size} de ${target}.\x1b[0m EDGAR limita la paginación por consulta;`,
    );
    console.log(
      `  \x1b[90mpara más, agregá consultas a DISCOVERY_QUERIES o pasá CIKs con --cik.\x1b[0m`,
    );
  }

  return [...found.keys()].slice(0, target);
}

async function harvestOne(cik: string) {
  const picks = await findAnnexFilings(cik, { max: 1 });
  if (picks.length === 0) return null;

  const { filing } = picks[0]!;
  const buffer = await fetchBuffer(filing.documentUrl, { timeoutMs: 180_000 });
  const tables = extractTables(buffer, filing.documentName);

  const { tables: annexTables } = attachContinuationTables(tables, (rows) => findHeaderRow(rows));
  if (annexTables.length === 0) return null;

  const joined = joinAnnexTables(annexTables);
  if (!joined) return null;

  const filtered = keepLoanRows(joined.rows, joined.headerRowIndex);

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
  /**
   * Cuántas filas de propiedad tiró `keepLoanRows`.
   *
   * Un Annex A trae una fila por préstamo y una por cada propiedad que lo
   * garantiza, con la dirección, la ciudad y el estado de cada una. Nos quedamos
   * con las de préstamo, así que la geografía de las carteras multi-propiedad se
   * descarta acá — y hasta ahora no quedaba registro de cuánta.
   *
   * Intenté estimarlo por resta sobre `stats` y me dio ~0, porque `dataRows` se
   * cuenta DESPUÉS de este filtro. El proxy medía otra cosa y contestaba con
   * confianza: casi cierra una línea de investigación que era correcta.
   */
  result.stats.propertyRowsDropped = filtered.propertyRows;
  return result.properties.length > 0 ? result : null;
}

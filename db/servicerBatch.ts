/**
 * Cosecha en lote del desempeño del servicer.
 *
 *   npm run db:performance
 *   npm run db:performance -- --before 2025-07-01
 *
 * ALCANCE: SOLO LO QUE YA MADURÓ
 *
 * Para comparar suscripción contra resultado hace falta un año completo de
 * operación posterior al cierre. Un deal de 2026 todavía no lo tiene, así que
 * intentarlo solo gasta requests contra SEC.
 *
 * El corte por defecto es el 1 de enero de 2025: los trusts originados antes de
 * esa fecha tienen el ejercicio 2025 cerrado y reportado en el informe de abril
 * de 2026. Sobre el corpus actual eso son los ~31 trusts de la añada 2024.
 *
 * QUÉ SE GUARDA Y QUÉ NO
 *
 * Solo préstamos con NOI de año completo medido, unidos a un préstamo que ya
 * está en el corpus. Un préstamo del servicer que no pegue contra el Annex A no
 * se inventa: se cuenta como no coincidente y se reporta.
 */

import { closePool, ping, query } from "./client.js";
import { fetchText, preflight } from "../harvest/edgar/client.js";
import { findServicerReports } from "../harvest/edgar/servicer.js";
import { extractParties, parseServicerReport } from "../harvest/parse/servicerReport.js";
import { extractFromHtml } from "../harvest/parse/tables.js";

const args = process.argv.slice(2);
const beforeFlag = args.indexOf("--before");
const ORIGINATED_BEFORE = beforeFlag === -1 ? "2025-01-01" : args[beforeFlag + 1]!;
const limitFlag = args.indexOf("--limit");
const LIMIT = limitFlag === -1 ? 500 : Number(args[limitFlag + 1] ?? 500);

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}
const edgar = await preflight();
if (!edgar.ok) {
  console.error(`\n✗ ${edgar.message}\n`);
  await closePool();
  process.exit(1);
}

function loanInt(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^\s*(\d+)/.exec(raw);
  return m ? String(Number(m[1])) : null;
}

const { rows: targets } = await query<{
  accession: string; cik: string; company_name: string; filed_at: string | null;
}>(
  `SELECT accession, cik, company_name, filed_at::text
     FROM corpus.filings
    WHERE filed_at IS NOT NULL AND filed_at < $1
    ORDER BY filed_at
    LIMIT $2`,
  [ORIGINATED_BEFORE, LIMIT],
);

console.log(`\nDesempeño del servicer`);
console.log(`  ${targets.length} trusts originados antes de ${ORIGINATED_BEFORE}\n`);

if (targets.length === 0) {
  console.log(`  Nada que cosechar. Probá con --before más tarde.\n`);
  await closePool();
  process.exit(0);
}

const started = Date.now();
let ok = 0;
let failed = 0;
/** Informe parseado y registrado, sin NOI de año completo. Observable, no fallido. */
let sinNoi = 0;
let totalDelinquent = 0;
/** Filas de morosidad del informe que no encontraron préstamo: cobertura perdida. */
let totalSinPegar = 0;
/** Filas que pegaron sobre un préstamo ya visto: tramos pari passu, no pérdida. */
let totalColapsadas = 0;
let totalMatched = 0;
let totalUnmatched = 0;
const problems: string[] = [];

for (const [i, t] of targets.entries()) {
  const tag = `[${String(i + 1).padStart(2)}/${targets.length}]`;
  const name = t.company_name.slice(0, 38).padEnd(38);

  try {
    /**
     * Se prueban varios meses hasta conseguir un rendimiento decente.
     *
     * Abril es el mejor mes en promedio, pero no para todos los trusts: el
     * ejercicio fiscal del prestatario no siempre cierra en diciembre, y los
     * administradores no consolidan todos el mismo mes. En la primera corrida
     * catorce de treinta y un trusts devolvieron entre uno y cuatro préstamos
     * mientras trece devolvían más de veinte —dos comportamientos distintos que
     * un solo intento no distingue.
     *
     * Nos detenemos apenas un mes rinde bien; solo los que rinden mal pagan
     * requests extra.
     */
    const reports = await findServicerReports(t.cik, { max: 3 });
    if (reports.length === 0) {
      console.log(`${tag} — ${name} sin 10-D`);
      failed++;
      problems.push(`${t.company_name}: sin 10-D con EX-99.1`);
      continue;
    }

    let report = reports[0]!;
    /**
     * El HTML del informe elegido se guarda: las partes del trust salen de la
     * carátula, que `parseServicerReport` no devuelve, y bajarlo de nuevo sería
     * un request contra SEC por algo que ya está en memoria.
     */
    let html = await fetchText(report.documentUrl);
    let parsed = parseServicerReport(html);
    let usable = parsed.loans.filter((l) => l.isFullYear);
    let attempts = 1;

    const GOOD_YIELD = 0.5;
    const yieldOf = (p: typeof parsed, u: typeof usable) =>
      p.diagnostics.rowsFound ? u.length / p.diagnostics.rowsFound : 0;

    for (const alt of reports.slice(1)) {
      if (yieldOf(parsed, usable) >= GOOD_YIELD) break;
      attempts++;
      const altHtml = await fetchText(alt.documentUrl);
      const altParsed = parseServicerReport(altHtml);
      const altUsable = altParsed.loans.filter((l) => l.isFullYear);
      if (altUsable.length > usable.length) {
        report = alt;
        html = altHtml;
        parsed = altParsed;
        usable = altUsable;
      }
    }

    /**
     * `minRows: 1` y no 2: la carátula tiene filas sueltas que el umbral del
     * parser de tablas descarta. Es la misma extracción, con otro piso.
     */
    const partes = extractParties(
      extractFromHtml(html, { mergeHeaders: false, minRows: 1 }),
    );
    const rolDe = (r: string) => partes.find((p) => p.rol === r)?.nombre ?? null;

    /**
     * El informe se registra ANTES de mirar si dio NOI.
     *
     * Hasta acá el INSERT a `servicer_reports` y el de morosidad estaban después
     * del `continue` de "sin años completos". Consecuencia: una emisión cuyo
     * informe se parseó bien pero no dio NOI utilizable salía sin registrarse y
     * sin guardar su morosidad —aunque el bloque de delincuencia estuviera
     * parseado, en memoria, dos variables más allá—.
     *
     * Como los análisis gatean con `JOIN corpus.performance` para decir "acá el
     * evento es observable", el shelf BANK entero quedaba fuera de la pregunta
     * de morosidad por no tener NOI. Una pregunta pagando la dependencia de otra.
     *
     * Registrar siempre es lo que separa "no hubo evento" de "no lo observamos".
     * Sin eso las dos cosas son la misma fila ausente, que es el confundido que
     * ya nos mordió con el stock de special servicing y con las añadas jóvenes.
     */
    if (parsed.diagnostics.tablesMatched === 0) {
      failed++;
      console.log(`${tag} — ${name} \x1b[31mformato\x1b[0m`);
      problems.push(
        `${t.company_name} [${report.periodOfReport}, ${attempts} intento(s)]: ` +
          `NO SE ENCONTRÓ la tabla en ${parsed.diagnostics.tablesScanned} tablas — formato distinto`,
      );
      continue;
    }

    // Índice de los préstamos del corpus por su Loan ID normalizado.
    const { rows: corpusLoans } = await query<{ id: string; loan_ref: string | null }>(
      `SELECT id::text, loan_ref FROM corpus.loans WHERE accession = $1`,
      [t.accession],
    );
    const byInt = new Map<string, string>();
    for (const l of corpusLoans) {
      const key = loanInt(l.loan_ref);
      if (key && !byInt.has(key)) byInt.set(key, l.id);
    }

    await query(
      `INSERT INTO corpus.servicer_reports
         (accession, cik, company_name, filed_at, period_of_report,
          file_name, file_url, deal_accession, master_servicer, special_servicer, stats)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (accession) DO UPDATE SET
         harvested_at = now(), stats = EXCLUDED.stats,
         deal_accession = EXCLUDED.deal_accession,
         master_servicer = EXCLUDED.master_servicer,
         special_servicer = EXCLUDED.special_servicer`,
      [
        report.accession,
        String(Number(t.cik)),
        report.companyName,
        report.filedAt || null,
        report.periodOfReport || null,
        report.documentName,
        report.documentUrl,
        t.accession,
        rolDe("master servicer"),
        rolDe("special servicer"),
        JSON.stringify({
          rowsFound: parsed.diagnostics.rowsFound,
          loansParsed: parsed.loans.length,
          fullYear: usable.length,
          droppedNoDates: parsed.diagnostics.droppedNoDates,
          delinquencyRows: parsed.delinquency.length,
          delinquencyMatched: parsed.delinquency.filter(
            (d) => byInt.has(loanInt(d.loanId) ?? ""),
          ).length,
          /**
           * Para poder preguntar "¿cuántas emisiones declaran cero morosos?"
           * sobre las 148 en vez de sobre la que tenía a mano.
           *
           * BANK 2021-BNK36 dice "No delinquent loans this period" en el
           * documento; de eso concluí algo sobre un shelf de 24 emisiones. Con
           * estos tres números la conclusión se puede sacar del corpus entero.
           */
          delinquencyTables: parsed.diagnostics.delinquencyTables,
          delinquencyDataRows: parsed.diagnostics.delinquencyDataRows,
          delinquencyDropped: parsed.diagnostics.delinquencyDropped,
          delinquencyDroppedSamples: parsed.diagnostics.delinquencyDroppedSamples,
          poolLoans: corpusLoans.length,
          trancheConflicts: parsed.diagnostics.trancheConflicts.length,
        }),
      ],
    );

    /**
     * Morosidad y special servicing, del mismo informe.
     *
     * Va antes que el NOI a propósito: no depende de él, y ponerlo después ya
     * costó que el shelf BANK quedara fuera del análisis.
     *
     * A diferencia del NOI, acá NO se filtra por período posterior al cierre:
     * el estado de pago es del momento del informe, no de un rango.
     */
    /**
     * Tres contadores, no uno.
     *
     * El lote informaba 341 morosos y la tabla tenía 282, sobre 349 parseadas.
     * Un solo contador no distingue "no pegó contra el corpus" de "pegó sobre
     * un préstamo que ya tenía fila" —tramos pari passu que el servicer numera
     * 1, 1A, 1B y `loanInt` colapsa a propósito—. La diferencia importa: la
     * primera es cobertura perdida, la segunda es deduplicación correcta.
     */
    let delinquent = 0;
    let sinPegar = 0;
    const vistos = new Set<string>();
    for (const d of parsed.delinquency) {
      const corpusId = byInt.get(loanInt(d.loanId) ?? "");
      if (!corpusId) {
        sinPegar++;
        continue;
      }
      await query(
        `INSERT INTO corpus.delinquency
           (report_accession, loan_id, pros_id, period, paid_through, months_delinquent,
            status, transfer_date, foreclosure_date, reo_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (report_accession, loan_id) DO UPDATE SET
           pros_id = EXCLUDED.pros_id,
           paid_through = EXCLUDED.paid_through,
           months_delinquent = EXCLUDED.months_delinquent,
           status = EXCLUDED.status,
           transfer_date = EXCLUDED.transfer_date,
           foreclosure_date = EXCLUDED.foreclosure_date,
           reo_date = EXCLUDED.reo_date`,
        [
          report.accession, corpusId, d.prosId, report.periodOfReport || null,
          d.paidThrough, d.monthsDelinquent, d.status,
          d.transferDate, d.foreclosureDate, d.reoDate,
        ],
      );
      delinquent++;
      vistos.add(corpusId);
    }
    totalDelinquent += delinquent;
    totalSinPegar += sinPegar;
    totalColapsadas += delinquent - vistos.size;

    /**
     * Sin NOI utilizable ya no es un fracaso: es un informe registrado que
     * aporta morosidad y no aporta NOI. Se sigue reportando —el rendimiento
     * bajo puede ser un formato a soportar— pero la emisión queda observable.
     */
    if (usable.length === 0) {
      sinNoi++;
      console.log(
        `${tag} \x1b[90m○\x1b[0m ${name} \x1b[90msin NOI\x1b[0m  ` +
          `${String(delinquent).padStart(3)} morosos de ${String(corpusLoans.length).padStart(3)} del pool` +
          `${attempts > 1 ? ` \x1b[90m(${attempts} meses)\x1b[0m` : ""}`,
      );
      problems.push(
        `${t.company_name} [${report.periodOfReport}, ${attempts} intento(s)]: ` +
          `tabla ubicada, ${parsed.diagnostics.rowsFound} filas, ninguna con año completo ` +
          `(${parsed.diagnostics.droppedNoDates} sin fechas) — registrado igual, ${delinquent} filas de morosidad`,
      );
      continue;
    }

    let matched = 0;
    let unmatched = 0;
    for (const loan of usable) {
      const corpusId = byInt.get(loanInt(loan.loanId) ?? "");
      if (!corpusId) {
        unmatched++;
        continue;
      }
      await query(
        `INSERT INTO corpus.performance
           (report_accession, loan_id, pros_id, annualized_noi,
            noi_start, noi_end, period_days, is_full_year, tranches)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (report_accession, loan_id) DO UPDATE SET
           annualized_noi = EXCLUDED.annualized_noi,
           noi_start = EXCLUDED.noi_start, noi_end = EXCLUDED.noi_end,
           period_days = EXCLUDED.period_days, tranches = EXCLUDED.tranches`,
        [
          report.accession, corpusId, loan.loanId, loan.annualizedNoi,
          loan.noiStart, loan.noiEnd, loan.periodDays, loan.isFullYear, loan.tranches,
        ],
      );
      matched++;
    }

    totalMatched += matched;
    totalUnmatched += unmatched;
    ok++;

    /**
     * Un join que falla tiene que decir POR QUÉ.
     *
     * "33 sin pegar" es un síntoma con al menos tres causas distintas y un
     * arreglo distinto para cada una:
     *
     *   - el corpus no tiene Loan ID para ese filing   → falta mapear la columna
     *   - los rangos no se superponen                   → otra numeración
     *   - se superponen parcialmente                    → préstamos dados de baja
     *
     * Sin distinguirlas, veinte trusts que aportan cero se ven todos iguales y
     * uno termina persiguiendo la hipótesis equivocada. Es el mismo problema que
     * ya tuvimos con "no se encontraron trusts" cuando faltaba el User-Agent.
     */
    const rate = usable.length ? matched / usable.length : 0;
    let diagnosis = "";
    if (matched === 0 && usable.length > 0) {
      if (byInt.size === 0) {
        /**
         * Dos causas distintas producen un índice vacío, y la primera versión
         * las confundía: decía "el corpus no tiene Loan ID (83 de 83 filas con
         * loan_ref)", que se contradice a sí misma.
         *
         * O no hay identificador, o lo hay pero no arranca con un número —el
         * servicer numera 1, 2, 3 y el Annex A puede usar códigos como "B16-01"
         * o "A-1"—. La segunda necesita ver los valores reales, no un conteo.
         */
        const withRef = corpusLoans.filter((l) => l.loan_ref?.trim());
        if (withRef.length === 0) {
          diagnosis =
            ` \x1b[31m✗ sin identificador\x1b[0m ` +
            `\x1b[90m(0 de ${corpusLoans.length} filas)\x1b[0m`;
        } else {
          const sample = withRef.slice(0, 3).map((l) => `"${l.loan_ref}"`).join(", ");
          diagnosis =
            ` \x1b[31m✗ identificador no numérico\x1b[0m ` +
            `\x1b[90m(${withRef.length} filas: ${sample})\x1b[0m`;
        }
      } else {
        const corpusKeys = [...byInt.keys()].map(Number).sort((a, b) => a - b);
        const servKeys = usable
          .map((l) => Number(loanInt(l.loanId)))
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        diagnosis =
          ` \x1b[31m✗ rangos disjuntos\x1b[0m \x1b[90m(corpus ${corpusKeys[0]}-${corpusKeys[corpusKeys.length - 1]}, ` +
          `servicer ${servKeys[0]}-${servKeys[servKeys.length - 1]})\x1b[0m`;
      }
      problems.push(`${t.company_name}: join vacío —${diagnosis.replace(/\x1b\[[0-9;]*m/g, "").trim()}`);
    }
    const flag = diagnosis || (rate < 0.9 ? " \x1b[33m⚠ join parcial\x1b[0m" : "");
    // El rendimiento —cuántas filas del informe terminaron siendo utilizables—
    // es lo que separa a los trusts que rinden 20 de los que rinden 2.
    const y = parsed.diagnostics.rowsFound
      ? Math.round((usable.length / parsed.diagnostics.rowsFound) * 100)
      : 0;
    const yieldTag = y < 50 ? `\x1b[33m${String(y).padStart(3)}%\x1b[0m` : `\x1b[90m${String(y).padStart(3)}%\x1b[0m`;
    console.log(
      `${tag} ✓ ${name} ${String(matched).padStart(3)} préstamos  ` +
        `${yieldTag} de ${String(parsed.diagnostics.rowsFound).padStart(3)} filas` +
        `${attempts > 1 ? ` \x1b[90m(${attempts} meses)\x1b[0m` : ""}` +
        `${unmatched > 0 ? ` · ${unmatched} sin pegar` : ""}${flag}`,
    );
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${tag} ✗ ${name} ${msg.slice(0, 30)}`);
    problems.push(`${t.company_name}: ${msg.slice(0, 120)}`);
  }
}

const mins = ((Date.now() - started) / 60_000).toFixed(1);

console.log(`\n${"─".repeat(70)}`);
console.log(
  `  ${ok} con NOI · ${sinNoi} registrados sin NOI · ${failed} fallidos · ${mins} min`,
);
console.log(`  ${totalMatched} préstamos con NOI real${totalUnmatched > 0 ? ` · ${totalUnmatched} sin pegar` : ""}`);
console.log(
  `  ${totalDelinquent} filas de morosidad pegadas` +
    `${totalSinPegar > 0 ? ` · ${totalSinPegar} sin pegar \x1b[90m(cobertura perdida)\x1b[0m` : ""}` +
    `${totalColapsadas > 0 ? ` · ${totalColapsadas} colapsadas \x1b[90m(tramos del mismo préstamo)\x1b[0m` : ""}`,
);
console.log(
  `  \x1b[90mla tabla queda con ${totalDelinquent - totalColapsadas} filas: una por préstamo, no por tramo\x1b[0m`,
);

if (problems.length > 0) {
  console.log(`\n  No se pudieron cosechar:`);
  for (const p of problems.slice(0, 12)) console.log(`    ${p}`);
  if (problems.length > 12) console.log(`    ... y ${problems.length - 12} más`);
}

const { rows: coverage } = await query<{ total: string; with_uw: string; with_all: string }>(
  `SELECT count(*) AS total,
          count(*) FILTER (WHERE noi_underwritten IS NOT NULL) AS with_uw,
          count(*) FILTER (WHERE noi_underwritten IS NOT NULL AND noi_trailing IS NOT NULL) AS with_all
     FROM corpus.underwriting_outcomes`,
);
const c = coverage[0];
if (c) {
  console.log(`\n  En la vista de resultados:`);
  console.log(`    ${c.total} préstamos con NOI real`);
  console.log(`    ${c.with_uw} también con NOI suscrito  \x1b[90m(medición de Griffin)\x1b[0m`);
  console.log(`    ${c.with_all} con las tres cifras       \x1b[90m(proyectado vs. entregado)\x1b[0m`);
}

console.log(`\n  Siguiente:  npm run db:outcomes\n`);

await closePool();

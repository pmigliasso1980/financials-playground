/**
 * Sonda contra informes del servicer reales.
 *
 *   npm run harvest:servicer -- 2016841
 *   npm run harvest:servicer -- 2016841 --months 3
 *
 * Baja los 10-D de un trust, parsea el EX-99.1 y muestra qué salió. No escribe
 * nada: sirve para ver si el parser aguanta un formato antes de meterlo al
 * pipeline.
 *
 * Lo importante de mirar en la salida no es el conteo de préstamos sino tres
 * cosas:
 *
 *   - cuántos préstamos quedaron SIN NOI utilizable y por qué,
 *   - qué porcentaje viene de un año completo contra extrapolado,
 *   - si hay conflictos entre tramos, que indicarían que la normalización del
 *     Pros ID está uniendo préstamos que no van juntos.
 */

import { fetchText, preflight } from "./edgar/client.js";
import { findServicerReports } from "./edgar/servicer.js";
import {
  describeServicerHeaders,
  extractParties,
  mergeServicerReports,
  parseServicerReport,
} from "./parse/servicerReport.js";
import { extractFromHtml } from "./parse/tables.js";

const [, , cikArg, ...rest] = process.argv;

if (!cikArg) {
  console.error("\nUso: npm run harvest:servicer -- <cik> [--months N]\n");
  process.exit(1);
}

const monthsFlag = rest.indexOf("--months");
const months = monthsFlag === -1 ? 1 : Number(rest[monthsFlag + 1] ?? 1);

const health = await preflight();
if (!health.ok) {
  console.error(`\n✗ ${health.message}\n`);
  process.exit(1);
}

console.log(`\nBuscando 10-D del CIK ${cikArg}...`);

const reports = await findServicerReports(cikArg, { max: months });

if (reports.length === 0) {
  console.error(
    `\n✗ Sin 10-D con EX-99.1 identificable.\n` +
      `  Puede que el trust sea muy nuevo o que el exhibit tenga otro nombre.\n`,
  );
  process.exit(1);
}

const collected: Array<{ label: string; loans: Awaited<ReturnType<typeof collect>> }> = [];

async function collect(url: string) {
  const html = await fetchText(url);
  return parseServicerReport(html).loans;
}

for (const report of reports) {
  console.log(`\n${"─".repeat(78)}`);
  console.log(`${report.companyName}`);
  console.log(
    `  ${report.accession} · presentado ${report.filedAt} · período ${report.periodOfReport || "?"}`,
  );
  console.log(`  ${report.documentName} · ${(report.sizeBytes / 1024).toFixed(0)} KB`);

  const html = await fetchText(report.documentUrl);

  /**
   * `--headers` lista TODAS las columnas, no solo las cinco que el parser usa.
   *
   * El informe del servicer trae estado de pago, días de atraso y transferencia
   * a special servicing, y nunca los miramos porque el parser buscaba NOI. Ver
   * los nombres reales es el paso previo a decidir si se pueden mapear —y evita
   * inventar patrones contra encabezados imaginados.
   */
  if (process.argv.includes("--headers")) {
    const tables = extractFromHtml(html, { mergeHeaders: false, minRows: 2 });
    for (const t of describeServicerHeaders(tables)) {
      console.log(`\n  \x1b[1mfamilia ${t.family}\x1b[0m · ${t.headers.length} columnas`);
      t.headers.forEach((h, i) => {
        if (h) console.log(`    ${String(i).padStart(3)}  ${h}`);
      });

      /**
       * Tres filas de datos debajo del encabezado.
       *
       * "53 filas sin fechas" tiene dos causas: el servicer no publica el
       * período, o el índice de columna está corrido y leemos otra cosa. El
       * conteo no las distingue; ver la celda sí.
       *
       * Solo para el bloque de NOI, que es el que descarta filas.
       */
      /**
       * También los bloques de especialmente administrados.
       *
       * El parser saca `transfer_date` SOLO del bloque de morosidad. Pero el
       * 10-D trae además "Specially Serviced Loan Detail", con su propia
       * columna `Servicing Transfer Date` — y un préstamo puede estar en
       * special servicing pagando al día, en cuyo caso aparecería ahí y no
       * entre los morosos.
       *
       * BANK 2021-BNK36 dice "No delinquent loans this period" y nunca miramos
       * si su bloque de especialmente administrados tenía filas. Si las tiene,
       * el numerador de todo el análisis está incompleto de forma sistemática.
       */
      const esNoi = t.headers.some((h) => /noi\s*end\s*date/i.test(h));
      const esMorosidad = t.headers.some((h) => /months\s*delinquent/i.test(h));
      const esEspecial = t.headers.some((h) =>
        /servicing\s*transfer\s*date|special\s*servicing\s*comments|specially\s*serviced/i.test(h),
      );
      if (!esNoi && !esMorosidad && !esEspecial) continue;

      console.log(`    \x1b[90m── tres filas de datos ──\x1b[0m`);
      for (let r = t.headerRow + 1; r <= t.headerRow + 3 && r < t.rows.length; r++) {
        const fila = t.rows[r] ?? [];
        const celdas = t.headers
          .map((h, i) => (h ? `[${i}] ${String(fila[i] ?? "").trim() || "∅"}` : null))
          .filter(Boolean)
          .join("  ");
        console.log(`    \x1b[90m${celdas.slice(0, 150)}\x1b[0m`);
      }
    }
    continue;
  }

  /**
   * `--noi-fiscal`: ¿"Most Recent Fiscal NOI" es una cifra de doce meses?
   *
   * BANK descarta 53 de 65 filas por no publicar el período del NOI, pero la
   * columna `Most Recent Fiscal NOI` trae número en casi todas. Si esa columna
   * es un año completo, los ~800 préstamos que el corpus pierde en el shelf BANK
   * están a un mapeo de distancia.
   *
   * El test NO se corre sobre BANK, donde no hay con qué contrastar. Se corre
   * sobre las emisiones que SÍ parsean: ahí hay ventana con fechas y las dos
   * columnas a la vez, así que se puede preguntar si miden lo mismo.
   *
   *   ratio ≈ 1   → fiscal mide el mismo período: sustituir es limpio
   *   ratio ≠ 1 consistente → fiscal es otro año: recuperable, pero es OTRA
   *                           variable y hay que declararlo como tal
   *   ratio disperso → fiscal no es un año completo y no hay nada que recuperar
   *
   * Cuatro filas miradas a mano dieron 0,98 / 1,09 / 1,09 / 1,04. Eso no es
   * evidencia: es el tamaño de muestra con el que ya me equivoqué hoy.
   */
  if (process.argv.includes("--noi-fiscal")) {
    const tables = extractFromHtml(html, { mergeHeaders: false, minRows: 2 });
    const num = (v: unknown) => {
      const s = String(v ?? "").replace(/[,$\s]/g, "");
      return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
    };
    const fecha = (v: unknown) => {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(v ?? "").trim());
      if (!m) return null;
      const yy = Number(m[3]);
      return new Date(yy < 100 ? 2000 + yy : yy, Number(m[1]) - 1, Number(m[2]));
    };

    for (const t of describeServicerHeaders(tables)) {
      const fin = t.headers.findIndex((h) => /noi\s*end\s*date/i.test(h ?? ""));
      if (fin < 3) continue;
      const [ini, rec, fis] = [fin - 1, fin - 2, fin - 3];
      if (!/fiscal/i.test(t.headers[fis] ?? "")) {
        console.log(
          `\n  \x1b[33mBloque NOI con layout inesperado: [${fis}] = "${t.headers[fis]}"\x1b[0m`,
        );
        continue;
      }

      let soloFiscal = 0;
      let ambas = 0;
      const ratios: number[] = [];
      const dias: number[] = [];

      for (let r = t.headerRow + 1; r < t.rows.length; r++) {
        const f = t.rows[r] ?? [];
        const vf = num(f[fis]);
        const vr = num(f[rec]);
        const d0 = fecha(f[ini]);
        const d1 = fecha(f[fin]);

        if (vf && vf > 0 && (!vr || vr === 0 || !d0 || !d1)) soloFiscal++;
        if (!vf || vf <= 0 || !vr || vr <= 0 || !d0 || !d1) continue;

        const span = (d1.getTime() - d0.getTime()) / 86_400_000;
        if (span < 60) continue;
        ambas++;
        dias.push(span);
        ratios.push(vf / (vr * (365 / span)));
      }

      console.log(`\n  \x1b[1mfiscal vs período\x1b[0m`);
      console.log(
        `    ${ambas} filas con ambas columnas · ${soloFiscal} con fiscal pero sin período`,
      );
      if (ambas === 0) {
        console.log(`    \x1b[90msin filas comparables en esta emisión\x1b[0m`);
        continue;
      }

      const orden = [...ratios].sort((a, b) => a - b);
      const q = (p: number) => orden[Math.min(orden.length - 1, Math.floor(p * orden.length))]!;
      const cerca = ratios.filter((x) => x > 0.9 && x < 1.1).length;
      const spanMed = [...dias].sort((a, b) => a - b)[Math.floor(dias.length / 2)]!;

      console.log(
        `    ventana mediana ${spanMed.toFixed(0)} días · ` +
          `ratio fiscal/anualizado  p10 ${q(0.1).toFixed(2)}  mediana ${q(0.5).toFixed(2)}  p90 ${q(0.9).toFixed(2)}`,
      );
      console.log(
        `    dentro de ±10%: ${cerca}/${ambas} \x1b[90m(${((cerca / ambas) * 100).toFixed(0)}%)\x1b[0m`,
      );
    }
    continue;
  }

  /**
   * `--parties`: quién administra el trust, con la fila cruda al lado.
   *
   * No persiste nada. Es el paso previo a guardar el administrador: mirar si lo
   * que el parser saca coincide con lo que el documento dice, en varios trusts,
   * antes de construir un análisis encima.
   */
  if (process.argv.includes("--parties")) {
    const tables = extractFromHtml(html, { mergeHeaders: false, minRows: 1 });
    const partes = extractParties(tables);
    if (partes.length === 0) {
      console.log(`\n  \x1b[33mNo se encontró ninguna parte en la carátula\x1b[0m`);
    }
    for (const p of partes) {
      console.log(`\n  \x1b[1m${p.rol}\x1b[0m  →  ${p.nombre}`);
      console.log(`    \x1b[90m${p.crudo}\x1b[0m`);
    }
    continue;
  }

  const parsed = parseServicerReport(html);
  const d = parsed.diagnostics;

  /**
   * Morosidad, con su identidad.
   *
   * `Months Delinquent` y `Paid Through Date` son el mismo hecho por dos
   * caminos: los meses de atraso tienen que ser (fin del período − paid
   * through) / 30,44. Contrastarlos es la única forma de saber si la columna
   * dice lo que creemos ANTES de construir un análisis encima.
   *
   * En el Annex A esta clase de verificación apareció después de meses. Acá
   * está antes de la primera conclusión, que es el orden que costó aprender.
   */
  if (parsed.delinquency.length > 0) {
    const del = parsed.delinquency;
    const periodo = report.periodOfReport ? new Date(report.periodOfReport) : null;

    const atrasados = del.filter((x) => (x.monthsDelinquent ?? 0) > 0).length;
    const special = del.filter((x) => x.transferDate).length;
    const ejecucion = del.filter((x) => x.foreclosureDate || x.reoDate).length;

    console.log(
      `\n  \x1b[1mmorosidad\x1b[0m  ${del.length} filas · ` +
        `${atrasados} con atraso · ${special} en special servicing · ${ejecucion} en ejecución/REO`,
    );

    /**
     * Con pocas filas, mostrar el dato crudo en vez del conteo.
     *
     * "1 fila con 0 de atraso" tiene al menos dos causas —la tabla lista solo
     * morosos y hay uno, o el índice de columna está corrido— y el conteo no las
     * distingue. Los valores sí.
     */
    for (const x of del.slice(0, 6)) {
      console.log(
        `    \x1b[90m${x.prosId.padEnd(8)} paid ${String(x.paidThrough ?? "—").padEnd(12)} ` +
          `meses ${String(x.monthsDelinquent ?? "—").padStart(4)}  ` +
          `estado ${String(x.status ?? "—").slice(0, 14).padEnd(14)} ` +
          `transf ${String(x.transferDate ?? "—").padEnd(12)}\x1b[0m`,
      );
    }

    if (periodo) {
      let cierran = 0;
      let comparables = 0;
      const desvios: string[] = [];

      for (const x of del) {
        if (x.monthsDelinquent === null || !x.paidThrough) continue;
        const dias = (periodo.getTime() - new Date(x.paidThrough).getTime()) / 86_400_000;
        const esperado = Math.max(0, Math.floor(dias / 30.44));
        comparables++;
        if (Math.abs(esperado - x.monthsDelinquent) <= 1) cierran++;
        else if (desvios.length < 3) {
          desvios.push(
            `${x.prosId}: publica ${x.monthsDelinquent}, paid through ${x.paidThrough} → ${esperado}`,
          );
        }
      }

      if (comparables > 0) {
        const share = cierran / comparables;
        const color = share >= 0.95 ? "\x1b[32m" : share >= 0.8 ? "\x1b[33m" : "\x1b[31m";
        console.log(
          `  identidad meses ≈ (período − paid through)/30:  ${color}${(share * 100).toFixed(0)}%\x1b[0m ` +
            `de ${comparables}`,
        );
        for (const dv of desvios) console.log(`    \x1b[90m${dv}\x1b[0m`);
      }
    }
  } else {
    /**
     * Cero morosos tiene tres causas y antes las tres decían "no se encontró la
     * tabla". Con ese mensaje di por confirmado un bug de parseo que puede no
     * existir: una emisión sin morosos produce la misma salida.
     */
    const dd = parsed.diagnostics;
    if (dd.delinquencyTables === 0) {
      console.log(
        `\n  \x1b[33mmorosidad: el localizador NO ubicó el bloque\x1b[0m ` +
          `\x1b[90m(${dd.tablesScanned} tablas) — es formato\x1b[0m`,
      );
    } else if (dd.delinquencyDataRows === 0) {
      console.log(
        `\n  \x1b[90mmorosidad: bloque ubicado (${dd.delinquencyTables} tabla/s), ` +
          `sin filas de datos — la emisión no tiene morosos\x1b[0m`,
      );
    } else {
      console.log(
        `\n  \x1b[31mmorosidad: ${dd.delinquencyDataRows} filas de datos y ninguna sobrevivió` +
          ` (${dd.delinquencyDropped} descartadas) — es filtro, no formato\x1b[0m`,
      );
    }
  }

  collected.push({ label: report.periodOfReport || report.filedAt, loans: parsed.loans });

  console.log(
    `\n  tablas ${d.tablesMatched}/${d.tablesScanned} · filas ${d.rowsFound} · ` +
      `préstamos ${parsed.loans.length}`,
  );

  const dropped = d.droppedNoDates + d.droppedShortPeriod + d.droppedNoProsId;
  if (dropped > 0) {
    console.log(`  descartados: ${dropped}`);
    if (d.droppedNoDates > 0) {
      console.log(`    ${String(d.droppedNoDates).padStart(4)} sin fechas de NOI (no reportados)`);
    }
    if (d.droppedShortPeriod > 0) {
      console.log(`    ${String(d.droppedShortPeriod).padStart(4)} con período demasiado corto`);
    }
    if (d.droppedNoProsId > 0) {
      console.log(`    ${String(d.droppedNoProsId).padStart(4)} sin Pros ID reconocible`);
    }
  }

  const fullYear = parsed.loans.filter((l) => l.isFullYear).length;
  console.log(
    `  año completo: ${fullYear}/${parsed.loans.length} ` +
      `\x1b[90m(${(d.fullYearShare * 100).toFixed(0)}%)\x1b[0m`,
  );

  const withTranches = parsed.loans.filter((l) => l.tranches > 1).length;
  if (withTranches > 0) {
    console.log(
      `  pari passu: ${withTranches} préstamo(s) con tramos colapsados ` +
        `\x1b[90m(${d.rowsFound - parsed.loans.length} filas de más si no se deduplicara)\x1b[0m`,
    );
  }

  if (parsed.loans.length > 0) {
    console.log(`\n  Primeros préstamos:`);
    console.log(`    loan       NOI anualizado   período              días  tramos`);
    for (const l of parsed.loans.slice(0, 8)) {
      const money = l.annualizedNoi.toLocaleString("en-US", { maximumFractionDigits: 0 });
      console.log(
        `    ${l.loanId.padEnd(6)} ${money.padStart(16)}   ` +
          `${l.noiStart} a ${l.noiEnd}  ${String(l.periodDays).padStart(4)}  ` +
          `${String(l.tranches).padStart(4)}${l.isFullYear ? "" : "  \x1b[90mextrapolado\x1b[0m"}`,
      );
    }
    if (parsed.loans.length > 8) {
      console.log(`    \x1b[90m... y ${parsed.loans.length - 8} más\x1b[0m`);
    }
  }

  for (const issue of parsed.issues) {
    console.log(`\n  \x1b[33m⚠ ${issue}\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// Combinado
// ---------------------------------------------------------------------------

/**
 * La selección corre siempre, incluso con un solo informe.
 *
 * Antes esto estaba detrás de `collected.length > 1` y el camino de un informe
 * mostraba los préstamos crudos —extrapolados incluidos— sin aplicar la
 * política de año completo. O sea: la ruta que vamos a usar en producción era
 * justamente la que se salteaba el filtro.
 */
{
  const merged = mergeServicerReports(collected);
  const fullYear = merged.loans.filter((l) => l.isFullYear).length;

  console.log(`\n${"═".repeat(78)}`);
// Con --headers no se parsea nada, así que no hay nada que combinar.
if (
  process.argv.includes("--headers") ||
  process.argv.includes("--noi-fiscal") ||
  process.argv.includes("--parties")
) process.exit(0);

  console.log(collected.length > 1 ? `Combinando ${collected.length} informes` : "Selección");
  console.log(`${"═".repeat(78)}\n`);

  if (collected.length > 1) {
    console.log(`  período       préstamos   año completo   nuevos`);
    for (const r of merged.perReport) {
      console.log(
        `  ${r.label.padEnd(12)} ${String(r.loans).padStart(9)} ${String(r.fullYear).padStart(14)} ` +
          `${String(r.newLoans).padStart(8)}`,
      );
    }

    const bestSingle = Math.max(...merged.perReport.map((r) => r.loans));
    const bestSingleFY = Math.max(...merged.perReport.map((r) => r.fullYear));

    console.log(`\n  combinado    ${String(merged.loans.length).padStart(9)} ${String(fullYear).padStart(14)}`);
    console.log(
      `\n  \x1b[32mCobertura: ${bestSingle} → ${merged.loans.length} préstamos\x1b[0m ` +
        `\x1b[90m(+${merged.loans.length - bestSingle})\x1b[0m`,
    );
    console.log(
      `  \x1b[32mAño completo: ${bestSingleFY} → ${fullYear}\x1b[0m ` +
        `\x1b[90m(+${fullYear - bestSingleFY})\x1b[0m`,
    );

    const bestMonth = merged.perReport.reduce((a, b) => (b.fullYear > a.fullYear ? b : a));
    if (bestMonth.fullYear >= fullYear * 0.9) {
      console.log(
        `\n  \x1b[33mUn solo informe alcanza:\x1b[0m ${bestMonth.label} trae ${bestMonth.fullYear} años completos`,
      );
      console.log(
        `  de los ${fullYear} del combinado. Bajar seis meses por trust no paga.`,
      );
    }
  } else {
    const r = merged.perReport[0]!;
    console.log(`  informe de ${r.label}: ${r.loans} préstamos con NOI, ${r.fullYear} de año completo`);
    console.log(
      `\n  \x1b[90mSin un segundo informe no hay control cruzado. Para verificar que\x1b[0m`,
    );
    console.log(`  \x1b[90meste mes no miente:  npm run harvest:servicer -- ${cikArg} --months 6\x1b[0m`);
  }

  if (merged.conflicts.length > 0) {
    console.log(`\n  \x1b[31mControl cruzado: ${merged.conflicts.length} préstamo(s) incompatibles entre informes\x1b[0m\n`);
    console.log(`    loan    elegido        de           otro           de          ratio`);
    for (const c of merged.conflicts.slice(0, 6)) {
      const f = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
      console.log(
        `    ${c.loanId.padEnd(6)} ${f(c.chosen).padStart(12)} ${String(c.chosenDays).padStart(4)}d  ` +
          `${f(c.other).padStart(12)} ${String(c.otherDays).padStart(4)}d   ${c.ratio.toFixed(1)}x`,
      );
    }
    console.log(
      `\n    \x1b[90mLa sospechosa suele ser la extrapolada: un período parcial que\x1b[0m`,
    );
    console.log(
      `    \x1b[90mno lo era, o un semestre con un ingreso no recurrente adentro.\x1b[0m`,
    );
  } else if (collected.length > 1) {
    console.log(`\n  \x1b[32mControl cruzado sin conflictos\x1b[0m \x1b[90m(ningún préstamo difiere >50% entre meses)\x1b[0m`);
  }

  if (merged.excludedExtrapolated.length > 0) {
    console.log(
      `\n  \x1b[90mExcluidos por no tener ninguna medición de año completo: ` +
        `${merged.excludedExtrapolated.length} préstamo(s) (${merged.excludedExtrapolated.join(", ")})\x1b[0m`,
    );
  }
  console.log(
    `\n  \x1b[1mUtilizables: ${merged.loans.length}\x1b[0m \x1b[90m— solo NOI de año completo medido, sin extrapolar.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mNo se promedian períodos: por cada préstamo se elige una sola observación.\x1b[0m\n`,
  );
}

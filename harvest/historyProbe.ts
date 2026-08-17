/**
 * ¿Cuántos eventos compra bajar los 10-D históricos?
 *
 *   npm run harvest:history                 # piloto sobre 8 trusts
 *   npm run harvest:history -- --trusts 20 --cada 6
 *
 * LA PREGUNTA, Y POR QUÉ SE MIDE ANTES DE PAGARLA
 *
 * Todo lo que hicimos descansa sobre 168 eventos, y esa es la restricción real
 * del corpus — no los 7.000 préstamos. Cinco hipótesis murieron por falta de
 * potencia para sostener cuatro o cinco controles simultáneos.
 *
 * El 10-D lista los préstamos que están en special servicing HOY. Un préstamo
 * que transfirió en 2022 y se resolvió en 2023 es invisible: es el sesgo de
 * stock, documentado desde el principio y nunca corregido.
 *
 * Bajar la historia lo convierte en flujo. Pero son ~1.500 documentos aun
 * muestreando semestralmente, y antes de gastar eso conviene saber cuánto
 * compra. Es la misma regla que el piso de ruido antes del efecto: medir si la
 * pregunta es contestable antes de intentar contestarla.
 *
 * QUÉ MIDE EL PILOTO
 *
 * Para unos pocos trusts, baja informes cada N meses hacia atrás y cuenta
 * cuántos préstamos DISTINTOS aparecieron alguna vez en special servicing,
 * contra cuántos aparecen en el informe más reciente.
 *
 * El cociente es lo que multiplicaría los eventos del corpus entero.
 *
 * CÓMO SE LEE
 *
 *   ~1,2x   no paga: 1.500 requests para 20% más eventos
 *   ~2x     dudoso, y depende de cuánto cueste en tiempo
 *   ~3x     168 → ~500 eventos, y todo lo que murió por potencia se reabre
 *
 * NO ESCRIBE NADA. Es una medición del prize, no una cosecha.
 */

import { fetchText, preflight } from "./edgar/client.js";
import { findServicerReports } from "./edgar/servicer.js";
import { parseServicerReport } from "./parse/servicerReport.js";
import { closePool, ping, query } from "../db/client.js";

const args = process.argv.slice(2);
const flag = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : Number(args[i + 1] ?? def);
};

const CADA_MESES = flag("cada", 6);
const MAX_INFORMES = flag("informes", 10);

const nTrusts = flag("trusts", 8);

const health = await preflight();
if (!health.ok) {
  console.error(`\n✗ ${health.message}\n`);
  process.exit(1);
}
const db = await ping();
if (!db.ok) {
  console.error(`\n✗ ${db.message.split("\n").join("\n  ")}\n`);
  process.exit(1);
}

/**
 * Los trusts salen del corpus, no de una lista escrita a mano.
 *
 * La primera versión tenía ocho CIKs hardcodeados "elegidos por añada, no por
 * resultado". La intención era correcta y la ejecución no: los ocho eran
 * inventados de memoria y los ocho fallaron. Si hubiera acertado dos, el
 * piloto habría corrido sobre esos dos sin que nadie lo notara.
 *
 * Sacarlos de `servicer_reports` garantiza dos cosas: que existen, y que ya
 * sabemos que su 10-D se parsea.
 *
 * EL ORDEN ES DETERMINISTA Y NO DEPENDE DEL RESULTADO
 *
 * Se toman los de mayor pool dentro de cada añada. Es un criterio de potencia
 * —más préstamos, más eventos posibles— fijado antes de mirar nada, y no tiene
 * que ver con cuántas transferencias tenga cada uno.
 */
const { rows: TRUSTS } = await query<{ cik: string; nombre: string; anada: number }>(
  `WITH por_anada AS (
     SELECT f.cik, f.company_name AS nombre,
            extract(year FROM f.filed_at)::int AS anada,
            count(l.id) AS pool,
            row_number() OVER (
              PARTITION BY extract(year FROM f.filed_at)
              ORDER BY count(l.id) DESC, f.accession
            ) AS rn
       FROM corpus.filings f
       JOIN corpus.servicer_reports sr ON sr.deal_accession = f.accession
       JOIN corpus.loans l ON l.accession = f.accession
      WHERE extract(year FROM f.filed_at) BETWEEN 2020 AND 2024
      GROUP BY f.cik, f.company_name, f.accession, f.filed_at
   )
   SELECT cik, nombre, anada FROM por_anada
    WHERE rn <= 2 ORDER BY anada, nombre`,
);
await closePool();

if (TRUSTS.length === 0) {
  console.error(`\n✗ Ningún trust con informe registrado. Corré db:performance.\n`);
  process.exit(1);
}

console.log(`\n${"═".repeat(78)}`);
console.log("¿Cuánto compra la historia? — piloto, no escribe nada");
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  Un informe cada ${CADA_MESES} meses, hasta ${MAX_INFORMES} por trust.\x1b[0m\n`,
);
console.log(
  `  trust                    informes   período        hoy   histórico   ratio`,
);
console.log(`  ${"─".repeat(74)}`);

let totHoy = 0;
let totHist = 0;
const porAnada = new Map<number, { hoy: number; hist: number }>();

for (const t of TRUSTS.slice(0, nTrusts)) {
  try {
    const reports = await findServicerReports(t.cik, {
      max: MAX_INFORMES,
      everyMonths: CADA_MESES,
    });

    if (reports.length === 0) {
      console.log(`  ${t.nombre.slice(0, 24).padEnd(24)} \x1b[33msin 10-D\x1b[0m`);
      continue;
    }

    /**
     * Un préstamo cuenta una sola vez aunque aparezca en varios informes.
     * La clave es el Loan ID normalizado, el mismo que usa el join del corpus.
     */
    const algunaVez = new Set<string>();
    let hoy = 0;
    let periodoViejo = "";
    let periodoNuevo = "";

    for (const [i, r] of reports.entries()) {
      const parsed = parseServicerReport(await fetchText(r.documentUrl));
      const conTransferencia = new Set<string>();
      for (const d of parsed.delinquency) {
        if (d.transferDate) conTransferencia.add(d.loanId);
      }
      for (const s of parsed.specialServicing) {
        if (s.transferDate) conTransferencia.add(s.loanId);
      }

      // El primero de la lista es el más reciente: es lo que ve el corpus hoy.
      if (i === 0) {
        hoy = conTransferencia.size;
        periodoNuevo = r.periodOfReport || r.filedAt;
      }
      periodoViejo = r.periodOfReport || r.filedAt;
      for (const id of conTransferencia) algunaVez.add(id);
    }

    const hist = algunaVez.size;
    const ratio = hoy > 0 ? hist / hoy : hist > 0 ? Infinity : 1;
    totHoy += hoy;
    totHist += hist;

    const a = porAnada.get(t.anada) ?? { hoy: 0, hist: 0 };
    a.hoy += hoy;
    a.hist += hist;
    porAnada.set(t.anada, a);

    console.log(
      `  ${t.nombre.slice(0, 24).padEnd(24)} ${String(reports.length).padStart(8)}   ` +
        `${periodoViejo.slice(0, 7)}→${periodoNuevo.slice(2, 7)}  ` +
        `${String(hoy).padStart(5)}  ${String(hist).padStart(9)}   ` +
        `${Number.isFinite(ratio) ? `${ratio.toFixed(2)}x` : "—"}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${t.nombre.slice(0, 24).padEnd(24)} \x1b[31m${msg.slice(0, 34)}\x1b[0m`);
  }
}

console.log(`\n${"─".repeat(78)}\n`);

if (totHoy === 0) {
  console.log(`  \x1b[33mNingún evento en los informes recientes. Sin base de comparación.\x1b[0m\n`);
  process.exit(0);
}

const ratioGlobal = totHist / totHoy;
console.log(
  `  \x1b[1mTotal: ${totHoy} eventos hoy · ${totHist} alguna vez · ${ratioGlobal.toFixed(2)}x\x1b[0m`,
);

console.log(`\n  Por añada — el control de que esto mide lo que decimos:\n`);
for (const [anada, a] of [...porAnada].sort()) {
  const r = a.hoy > 0 ? a.hist / a.hoy : 0;
  console.log(
    `    ${anada}   ${String(a.hoy).padStart(3)} hoy · ${String(a.hist).padStart(3)} alguna vez   ` +
      `${r ? `${r.toFixed(2)}x` : "—"}`,
  );
}

/**
 * El control de sentido: las añadas viejas deberían ganar MÁS que las jóvenes.
 *
 * Un trust de 2023 tuvo poco tiempo para que un caso entre y se resuelva, así
 * que su historia no debería agregar casi nada. Si el ratio sale parejo entre
 * añadas, lo que estamos midiendo no es el sesgo de stock: es otra cosa —
 * ruido de parseo, o préstamos que entran y salen del bloque por otra razón.
 */
const suma = (xs: Array<[number, { hoy: number; hist: number }]>) => ({
  hoy: xs.reduce((s, [, a]) => s + a.hoy, 0),
  hist: xs.reduce((s, [, a]) => s + a.hist, 0),
});
const viejas = suma([...porAnada].filter(([a]) => a <= 2021));
const jovenes = suma([...porAnada].filter(([a]) => a >= 2023));

/**
 * El veredicto solo se emite si hay con qué compararlo.
 *
 * La versión anterior calculaba el ratio de las jóvenes como
 * `hist / max(1, hoy)`. Con cero eventos eso daba 0,00 y el control disparaba
 * "consistente con sesgo de stock" porque 1,29 > 0 × 1,3 — se validaba solo,
 * por una división degenerada.
 *
 * Es el mismo error que el cociente de dispersión que devolvía 29.333.333x: una
 * guarda contra la división por cero convertida en un número que parece medir
 * algo. Un grupo sin eventos no da un ratio bajo: no da ratio.
 */
console.log(
  `\n  \x1b[90mViejas (≤2021): ${viejas.hoy} hoy · ${viejas.hist} alguna vez` +
    `   ·   jóvenes (≥2023): ${jovenes.hoy} hoy · ${jovenes.hist} alguna vez\x1b[0m`,
);
if (viejas.hoy < 5 || jovenes.hoy < 5) {
  console.log(
    `  \x1b[33mNo se puede contrastar: hace falta un mínimo de 5 eventos por grupo.\x1b[0m`,
  );
} else {
  const rv = viejas.hist / viejas.hoy;
  const rj = jovenes.hist / jovenes.hoy;
  console.log(
    `  \x1b[90mratios ${rv.toFixed(2)}x contra ${rj.toFixed(2)}x\x1b[0m` +
      (rv > rj * 1.3
        ? `  \x1b[32m← consistente con sesgo de stock\x1b[0m`
        : `  \x1b[31m← NO es sesgo de stock: ganan parejo\x1b[0m`),
  );
}

/**
 * La ventana efectiva, que decide si el ratio es leíble.
 *
 * Con `--informes 10` cada 6 meses se llega 54 meses atrás: para un trust de
 * 2020 eso arranca en 2022 y se pierde el pico de COVID, cuando hotelería y
 * retail entraron a special servicing en masa. El ratio queda como cota
 * inferior, y sesgada justo contra las añadas que más deberían ganar.
 */
const alcanceMeses = MAX_INFORMES * CADA_MESES;
console.log(
  `\n  \x1b[90mVentana: ${alcanceMeses} meses hacia atrás (${MAX_INFORMES} informes × ${CADA_MESES}).\x1b[0m` +
    (alcanceMeses < 72
      ? `  \x1b[33m← no llega a la emisión de 2020\x1b[0m`
      : ""),
);
console.log(
  `\n  \x1b[90mSi el ratio global fuera ~1,2x no paga: 1.500 requests por 20% más\x1b[0m`,
);
console.log(
  `  \x1b[90meventos. Cerca de 3x los 168 pasarían a ~500 y todo lo que murió por\x1b[0m`,
);
console.log(`  \x1b[90mfalta de potencia se reabre.\x1b[0m\n`);

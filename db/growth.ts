/**
 * Cuánto corpus haría falta para resolver lo que hoy queda al filo.
 *
 *   npm run db:growth
 *
 * LA PREGUNTA, Y POR QUÉ ES LA QUE QUEDA
 *
 * Catorce ataques y ningún originador citable. LMF queda en SIR 1,51 con IC
 * [1,00 , 2,20] y UBS AG no se puede medir porque el estrato completo lo deja en
 * 121 préstamos. En los dos casos el límite no fue el método: fue el tamaño.
 *
 * Entonces la decisión siguiente —seguir cosechando o pasar al producto— depende
 * de un número que el proyecto no tiene: **cuánto más corpus haría falta**. Si es
 * 1,3x, conviene cosechar. Si es 5x, la pregunta no se contesta con EDGAR y hay
 * que dejar de intentarlo.
 *
 * LA CUENTA, QUE ES CORTA
 *
 * El error estándar de log(SIR) es aproximadamente 1/√obs, así que el SIR mínimo
 * detectable con corrección de Bonferroni es exp(z / √obs). Eso se da vuelta: para
 * detectar un SIR dado hacen falta (z / log SIR)² eventos.
 *
 * Con 13 comparaciones z = 2,89. Para un SIR de 1,51 hacen falta (2,89/0,412)² =
 * 49 eventos, y LMF tiene 27.
 *
 * LO QUE HACE QUE ESTA CUENTA NO SEA TRIVIAL
 *
 * Multiplicar el corpus por 1,8 no multiplica los eventos por 1,8. Un préstamo
 * transfiere a special servicing después de años, así que las añadas recientes
 * aportan préstamos y casi ningún evento. Cosechar las emisiones de 2026 —que son
 * las que están disponibles y limpias— sube el denominador y no el numerador, y
 * eso EMPEORA la potencia en vez de mejorarla.
 *
 * Por eso el script no reporta un multiplicador y ya: descompone de dónde podrían
 * salir los eventos, que es lo accionable.
 *
 * LO QUE ESTA CUENTA SUPONE, Y PUEDE ESTAR MAL
 *
 * Que lo que se coseche se parezca a lo cosechado. Si las emisiones que faltan son
 * sistemáticamente distintas —otro tipo de deal, otro originador, otra época— la
 * extrapolación no vale. Es la misma suposición que hizo fracasar la
 * generalización desde BANK5, así que se declara y no se esconde.
 */

import { closePool, ping, query } from "./client.js";
import { estadoCorpus, estampa } from "./procedencia.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Los mismos que usa db:seller, para que la cuenta hable de sus números. */
const MIN_POOL = 150;
const COMPARACIONES = 13;

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const num = (v: number) => v.toLocaleString("en-US");

/** z bilateral para 0,05/M. Misma implementación que db:seller. */
function erf(x: number): number {
  const signo = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) * t * Math.exp(-x * x);
  return signo * y;
}
function zBonferroni(m: number): number {
  const alfa = 0.05 / Math.max(1, m);
  const Phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
  let lo = 1, hi = 6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (Phi(mid) < 1 - alfa / 2) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// 1. Dónde está el corpus
// ---------------------------------------------------------------------------

const { rows: porAnada } = await query<{
  anada: string; emisiones: string; prestamos: string; eventos: string; con_reporte: string;
}>(
  `SELECT extract(year FROM f.filed_at)::int::text AS anada,
          count(DISTINCT f.accession)::text AS emisiones,
          count(l.id)::text AS prestamos,
          count(*) FILTER (WHERE d.transfer_date IS NOT NULL)::text AS eventos,
          count(DISTINCT f.accession) FILTER (
            WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                                   WHERE deal_accession IS NOT NULL)
          )::text AS con_reporte
     FROM corpus.filings f
     LEFT JOIN corpus.loans l ON l.accession = f.accession
     LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
    GROUP BY 1 ORDER BY 1`,
);

/** Emisiones con Annex A cosechado y sin ningún 10-D asociado. */
const { rows: sinReporte } = await query<{ emisiones: string; prestamos: string }>(
  `SELECT count(DISTINCT f.accession)::text AS emisiones,
          count(l.id)::text AS prestamos
     FROM corpus.filings f
     LEFT JOIN corpus.loans l ON l.accession = f.accession
    WHERE f.accession NOT IN (SELECT deal_accession FROM corpus.servicer_reports
                               WHERE deal_accession IS NOT NULL)`,
);

/** Cuántos 10-D distintos hay por trust: la otra vía de crecimiento. */
const { rows: periodos } = await query<{ deals: string; reportes: string; p50: string }>(
  `WITH x AS (
     SELECT deal_accession, count(*)::numeric AS n
       FROM corpus.servicer_reports
      WHERE deal_accession IS NOT NULL
      GROUP BY deal_accession
   )
   SELECT count(*)::text AS deals, sum(n)::text AS reportes,
          percentile_disc(0.5) WITHIN GROUP (ORDER BY n)::text AS p50 FROM x`,
);

const estado = await estadoCorpus();
await closePool();

console.log(`\n${"═".repeat(78)}`);
console.log("Cuánto corpus haría falta");
console.log(`${"═".repeat(78)}`);

console.log(`\n${"─".repeat(78)}`);
console.log("Dónde están los eventos hoy");
console.log(`${"─".repeat(78)}\n`);
console.log(`  añada   emisiones   con 10-D   préstamos   eventos     tasa`);
console.log(`  ${"─".repeat(62)}`);

let totalEv = 0;
let totalPr = 0;
for (const r of porAnada) {
  const ev = Number(r.eventos), pr = Number(r.prestamos);
  totalEv += ev;
  totalPr += pr;
  console.log(
    `  ${r.anada}    ${String(r.emisiones).padStart(7)} ${String(r.con_reporte).padStart(10)} ` +
      `${num(pr).padStart(11)} ${String(ev).padStart(9)}   ${(pr > 0 ? pct(ev / pr, 2) : "—").padStart(7)}` +
      (ev === 0 && pr > 0 ? `  \x1b[90m← sin madurar\x1b[0m` : ""),
  );
}

/**
 * La añada más reciente con eventos marca el horizonte de maduración: por debajo
 * de eso, cosechar suma préstamos al denominador y nada al numerador.
 */
const conEventos = porAnada.filter((r) => Number(r.eventos) > 0);
const ultimaMadura = conEventos.length > 0 ? conEventos[conEventos.length - 1]!.anada : "?";
const sinMadurar = porAnada
  .filter((r) => Number(r.eventos) === 0 && Number(r.prestamos) > 0)
  .reduce((t, r) => t + Number(r.prestamos), 0);

console.log(
  `\n  \x1b[1m${num(totalEv)} eventos sobre ${num(totalPr)} préstamos\x1b[0m` +
    `   \x1b[90m(${pct(totalEv / Math.max(1, totalPr), 2)})\x1b[0m`,
);
console.log(
  `  \x1b[90mÚltima añada con eventos: ${ultimaMadura}. ` +
    `${num(sinMadurar)} préstamos están en añadas sin ninguno todavía.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 2. La curva: qué SIR se detecta con cuántos eventos
// ---------------------------------------------------------------------------

const z = zBonferroni(COMPARACIONES);
const sirDetectable = (obs: number) => Math.exp(z / Math.sqrt(obs));
const eventosPara = (sir: number) => Math.ceil((z / Math.log(sir)) ** 2);

console.log(`\n${"═".repeat(78)}`);
console.log(`Qué hace falta para detectar cada tamaño de efecto`);
console.log(`${"═".repeat(78)}\n`);
console.log(
  `  \x1b[90mCon ${COMPARACIONES} comparaciones, Bonferroni pide z > ${z.toFixed(2)}. ` +
    `El SE de log(SIR) es 1/√obs,\x1b[0m`,
);
console.log(
  `  \x1b[90masí que para detectar un SIR hacen falta (z / log SIR)² eventos EN ESE ORIGINADOR.\x1b[0m\n`,
);
console.log(`  SIR a detectar    eventos necesarios     veces los 27 de LMF`);
console.log(`  ${"─".repeat(60)}`);
for (const sir of [3.0, 2.5, 2.0, 1.75, 1.51, 1.4, 1.3, 1.2]) {
  const n = eventosPara(sir);
  const marca = Math.abs(sir - 1.51) < 0.001 ? `  \x1b[1m← donde quedó LMF\x1b[0m` : "";
  console.log(
    `  ${sir.toFixed(2).padStart(10)}    ${String(n).padStart(14)}     ${(n / 27).toFixed(1).padStart(14)}x${marca}`,
  );
}
console.log(
  `\n  \x1b[90mCon los 27 eventos que LMF tiene hoy, lo mínimo detectable es ` +
    `SIR ${sirDetectable(27).toFixed(2)}.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 3. De dónde saldrían esos eventos
// ---------------------------------------------------------------------------

const faltanEventos = eventosPara(1.51) - 27;
const factor = eventosPara(1.51) / 27;
const tasaMadura = totalEv / Math.max(1, totalPr - sinMadurar);

console.log(`\n${"═".repeat(78)}`);
console.log("De dónde podrían salir");
console.log(`${"═".repeat(78)}\n`);
console.log(
  `  Para que LMF pase de ${sirDetectable(27).toFixed(2)} detectable a 1,51 hacen falta ` +
    `\x1b[1m${faltanEventos} eventos más suyos\x1b[0m (${factor.toFixed(1)}x).`,
);
console.log(
  `  \x1b[90mLMF es ${pct(285 / Math.max(1, totalPr), 1)} del corpus, así que eso pide un corpus ` +
    `${factor.toFixed(1)}x en préstamos MADUROS.\x1b[0m\n`,
);

const prSinReporte = Number(sinReporte[0]!.prestamos);
const emSinReporte = Number(sinReporte[0]!.emisiones);
const evEstimados = Math.round(prSinReporte * tasaMadura);

console.log(`  vía                                        préstamos   eventos est.   ¿alcanza?`);
console.log(`  ${"─".repeat(74)}`);
console.log(
  `  10-D de las ${String(emSinReporte).padStart(3)} emisiones ya cosechadas     ` +
    `${num(prSinReporte).padStart(9)} ${String(evEstimados).padStart(14)}   ` +
    `${evEstimados >= faltanEventos * (totalPr / 285) ? "\x1b[32msí\x1b[0m" : "\x1b[33mno\x1b[0m"}`,
);
console.log(
  `  \x1b[90m  Es la vía más barata: el Annex A ya está parseado y solo falta el desempeño.\x1b[0m`,
);
console.log(
  `  \x1b[90m  ${periodos[0]!.deals} trusts tienen ${periodos[0]!.reportes} reportes ` +
    `(mediana ${periodos[0]!.p50} por trust): sumar períodos agrega eventos sin agregar préstamos.\x1b[0m`,
);
console.log(
  `\n  \x1b[90m  Emisiones nuevas de EDGAR: suben el denominador. Si son de añadas recientes\x1b[0m`,
);
console.log(
  `  \x1b[90m  no traen eventos, y la potencia BAJA. Solo sirven las de ${ultimaMadura} o antes.\x1b[0m`,
);

console.log(
  `\n  \x1b[33mLo que esta cuenta supone:\x1b[0m \x1b[90mque lo que falte cosechar se parezca a lo\x1b[0m`,
);
console.log(
  `  \x1b[90mcosechado. Si las emisiones sin 10-D son sistemáticamente distintas —otra época,\x1b[0m`,
);
console.log(
  `  \x1b[90motro tipo de deal— la extrapolación no vale. Es la misma suposición que hizo\x1b[0m`,
);
console.log(`  \x1b[90mfracasar la generalización desde BANK5.\x1b[0m`);

console.log(
  `\n  \x1b[90mY el umbral de ${MIN_POOL} préstamos no se mueve con esto: UBS AG necesita cobertura\x1b[0m`,
);
console.log(
  `  \x1b[90mde subtipo, no más préstamos. Son dos problemas distintos con la misma cara.\x1b[0m`,
);

console.log(`\n\x1b[90m  ${estampa(estado)}\x1b[0m\n`);

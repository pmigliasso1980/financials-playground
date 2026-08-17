/**
 * Une el desempeño del servicer con la suscripción del Annex A.
 *
 *   npm run db:join -- 2016841
 *   npm run db:join -- 2016841 --months 6
 *
 * POR QUÉ ESTE SCRIPT EXISTE ANTES QUE EL PIPELINE
 *
 * Todo lo construido en las últimas horas apoya sobre un supuesto que todavía no
 * verificamos: que el "Pros ID" del informe del servicer y el "Loan ID" del
 * Annex A numeran los mismos préstamos de la misma manera. Es plausible —los dos
 * salen del prospecto— pero plausible no es verificado, y si la numeración
 * difiere el parser entero no sirve para nada.
 *
 * Hay una razón concreta para dudar. En el Annex A los IDs vienen con parte
 * decimal, y esa parte significa algo: "3.00" es el préstamo y "3.01", "3.02"
 * son sus propiedades. Del lado del servicer el mismo préstamo es "3", y sus
 * tramos pari passu son "3A-1", "3A-2". Son dos esquemas distintos de sufijo
 * sobre el mismo entero. Normalizamos ambos al entero y verificamos que el
 * conjunto coincida.
 *
 * QUÉ MIRAR EN LA SALIDA
 *
 * El porcentaje de coincidencia es lo primero. Si es alto, el join sirve. Si es
 * bajo, hay que entender por qué antes de escalar a 31 trusts.
 *
 * Después viene la primera medición al estilo Griffin sobre un deal: NOI
 * suscrito contra NOI real del primer año completo. Un solo trust no prueba
 * nada, pero si los números son absurdos se ve acá y no después de cosechar
 * treinta.
 */

import { closePool, ping, query } from "./client.js";
import { fetchText, preflight } from "../harvest/edgar/client.js";
import { findServicerReports } from "../harvest/edgar/servicer.js";
import { mergeServicerReports, parseServicerReport } from "../harvest/parse/servicerReport.js";

const [, , cikArg, ...rest] = process.argv;

if (!cikArg) {
  console.error("\nUso: npm run db:join -- <cik> [--months N]\n");
  process.exit(1);
}

const monthsFlag = rest.indexOf("--months");
const months = monthsFlag === -1 ? 1 : Number(rest[monthsFlag + 1] ?? 1);

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

/**
 * Normaliza un identificador de préstamo al entero que lo designa.
 *
 *   Annex A:   "3.00" → 3   ·  "3.01" → 3 (propiedad del préstamo 3)
 *   Servicer:  "3A-1" → 3   ·  "3"    → 3
 *
 * Ojo: del lado del Annex A las filas de propiedad ya se filtran antes de
 * llegar acá, así que un "3.01" no debería aparecer. Si aparece, el conteo de
 * duplicados lo va a delatar.
 */
function loanInt(raw: string | null): number | null {
  if (!raw) return null;
  const m = /^\s*(\d+)/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

const pct = (v: number | null, d = 1) => (v === null ? "—" : `${(v * 100).toFixed(d)}%`);
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// Lado corpus
// ---------------------------------------------------------------------------

const { rows: filings } = await query<{
  accession: string; company_name: string; filed_at: string | null; loans: string;
}>(
  `SELECT f.accession, f.company_name, f.filed_at::text,
          count(l.id) AS loans
     FROM corpus.filings f
     LEFT JOIN corpus.loans l ON l.accession = f.accession
    WHERE f.cik = $1
    GROUP BY 1, 2, 3
    ORDER BY f.filed_at DESC NULLS LAST`,
  [String(Number(cikArg))],
);

if (filings.length === 0) {
  console.error(
    `\n✗ El CIK ${cikArg} no está en el corpus.\n` +
      `  Cosechalo primero:  npm run harvest -- run ${cikArg}\n`,
  );
  await closePool();
  process.exit(1);
}

const filing = filings[0]!;

console.log(`\n${"═".repeat(78)}`);
console.log(`${filing.company_name}`);
console.log(`${"═".repeat(78)}`);
console.log(`\n  Annex A     ${filing.accession} · ${filing.filed_at ?? "?"} · ${filing.loans} préstamos`);

const { rows: corpusLoans } = await query<{
  loan_ref: string | null; property_type: string | null;
  uw_noi: string | null; trailing_noi: string | null; balance: string | null;
}>(
  `SELECT l.loan_ref, l.property_type,
          uw.value AS uw_noi,
          mr.value AS trailing_noi,
          amt.value AS balance
     FROM corpus.loans l
     LEFT JOIN corpus.facts uw  ON uw.loan_id  = l.id AND uw.metric_key  = 'noi_underwritten'
     LEFT JOIN corpus.facts mr  ON mr.loan_id  = l.id AND mr.metric_key  = 'noi_most_recent'
     LEFT JOIN corpus.facts amt ON amt.loan_id = l.id AND amt.metric_key = 'loan_amount'
    WHERE l.accession = $1
    ORDER BY l.row_index`,
  [filing.accession],
);

// ---------------------------------------------------------------------------
// Lado servicer
// ---------------------------------------------------------------------------

const reports = await findServicerReports(cikArg, { max: months });
if (reports.length === 0) {
  console.error(`\n✗ Sin 10-D con EX-99.1 identificable para este trust.\n`);
  await closePool();
  process.exit(1);
}

const collected: Array<{ label: string; loans: ReturnType<typeof parseServicerReport>["loans"] }> = [];
for (const report of reports) {
  const html = await fetchText(report.documentUrl);
  collected.push({
    label: report.periodOfReport || report.filedAt,
    loans: parseServicerReport(html).loans,
  });
}

const merged = mergeServicerReports(collected);

console.log(
  `  Servicer    ${reports[0]!.accession} · ${reports[0]!.periodOfReport} · ` +
    `${merged.loans.length} préstamos con NOI de año completo`,
);

// ---------------------------------------------------------------------------
// El control que decide todo
// ---------------------------------------------------------------------------

const corpusByInt = new Map<number, (typeof corpusLoans)[number]>();
let corpusNoRef = 0;
let corpusDupes = 0;

for (const l of corpusLoans) {
  const key = loanInt(l.loan_ref);
  if (key === null) {
    corpusNoRef++;
    continue;
  }
  if (corpusByInt.has(key)) corpusDupes++;
  else corpusByInt.set(key, l);
}

const servicerByInt = new Map<number, (typeof merged.loans)[number]>();
for (const l of merged.loans) {
  const key = loanInt(l.loanId);
  if (key !== null) servicerByInt.set(key, l);
}

const matched: number[] = [];
const servicerOnly: number[] = [];
for (const key of servicerByInt.keys()) {
  if (corpusByInt.has(key)) matched.push(key);
  else servicerOnly.push(key);
}
const corpusOnly = [...corpusByInt.keys()].filter((k) => !servicerByInt.has(k));

console.log(`\n${"─".repeat(78)}`);
console.log(`Correspondencia de identificadores`);
console.log(`${"─".repeat(78)}\n`);

console.log(`  corpus con Loan ID        ${String(corpusByInt.size).padStart(4)}`);
if (corpusNoRef > 0) console.log(`  corpus sin Loan ID        ${String(corpusNoRef).padStart(4)}  \x1b[33m⚠\x1b[0m`);
if (corpusDupes > 0) console.log(`  corpus con ID repetido    ${String(corpusDupes).padStart(4)}  \x1b[33m⚠ filas de propiedad sin filtrar\x1b[0m`);
console.log(`  servicer utilizables      ${String(servicerByInt.size).padStart(4)}`);
console.log(`  \x1b[1mcoinciden                 ${String(matched.length).padStart(4)}\x1b[0m`);
if (servicerOnly.length > 0) {
  console.log(`  solo en servicer          ${String(servicerOnly.length).padStart(4)}  \x1b[90m(${servicerOnly.slice(0, 10).join(", ")})\x1b[0m`);
}
if (corpusOnly.length > 0) {
  console.log(`  solo en corpus            ${String(corpusOnly.length).padStart(4)}  \x1b[90m(${corpusOnly.slice(0, 10).join(", ")})\x1b[0m`);
}

const matchRate = servicerByInt.size ? matched.length / servicerByInt.size : 0;
console.log();
if (matchRate >= 0.9) {
  console.log(`  \x1b[32mLa numeración coincide (${pct(matchRate, 0)}). El join sirve.\x1b[0m`);
} else if (matchRate >= 0.6) {
  console.log(`  \x1b[33mCoincide parcialmente (${pct(matchRate, 0)}). Revisá los que no pegan antes de escalar.\x1b[0m`);
} else {
  console.log(`  \x1b[31mLa numeración NO coincide (${pct(matchRate, 0)}).\x1b[0m`);
  console.log(`  El supuesto de que Pros ID = Loan ID es falso para este emisor.`);
  console.log(`  Habría que unir por otra clave —nombre de propiedad, saldo— antes de seguir.`);
}

// ---------------------------------------------------------------------------
// Primera medición estilo Griffin
// ---------------------------------------------------------------------------

interface Pair {
  key: number;
  type: string;
  uw: number;
  actual: number;
  trailing: number | null;
  gap: number;
}

const pairs: Pair[] = [];
for (const key of matched) {
  const c = corpusByInt.get(key)!;
  const s = servicerByInt.get(key)!;
  const uw = Number(c.uw_noi);
  if (!Number.isFinite(uw) || uw <= 0) continue;
  if (!(s.annualizedNoi > 0)) continue;

  const trailingRaw = Number(c.trailing_noi);
  pairs.push({
    key,
    type: c.property_type ?? "—",
    uw,
    actual: s.annualizedNoi,
    trailing: Number.isFinite(trailingRaw) && trailingRaw > 0 ? trailingRaw : null,
    gap: uw / s.annualizedNoi - 1,
  });
}

if (pairs.length === 0) {
  console.log(`\n  \x1b[33mNingún préstamo tiene NOI suscrito y NOI real a la vez.\x1b[0m\n`);
} else {
  pairs.sort((a, b) => b.gap - a.gap);

  console.log(`\n${"─".repeat(78)}`);
  console.log(`Suscrito contra real — primera medición estilo Griffin`);
  console.log(`${"─".repeat(78)}\n`);

  /**
   * La columna del histórico es la que distingue un hallazgo de un artefacto.
   *
   * Una brecha del 200% contra el resultado puede ser dos cosas muy distintas:
   * una proyección agresiva que no se cumplió, o un problema de escala en el
   * dato. Se separan mirando el trailing: si el suscrito también estaba muy por
   * encima del histórico, era una apuesta a crecimiento y perdió. Si el suscrito
   * estaba pegado al histórico y solo el real quedó lejos, la propiedad se
   * derrumbó —o estamos comparando cosas distintas.
   */
  console.log(`  loan  tipo             NOI suscrito     histórico     NOI real 2025    brecha`);
  const show = [...pairs.slice(0, 5), ...(pairs.length > 10 ? pairs.slice(-5) : [])];
  const shown = new Set<number>();
  for (const p of show) {
    if (shown.has(p.key)) continue;
    shown.add(p.key);
    const color = p.gap >= 0.05 ? "\x1b[33m" : p.gap < 0 ? "\x1b[32m" : "";
    console.log(
      `  ${String(p.key).padEnd(5)} ${p.type.slice(0, 14).padEnd(15)} ` +
        `${money(p.uw).padStart(13)} ${(p.trailing === null ? "—" : money(p.trailing)).padStart(13)} ` +
        `${money(p.actual).padStart(16)}   ${color}${pct(p.gap).padStart(7)}\x1b[0m`,
    );
  }
  if (pairs.length > 10) console.log(`  \x1b[90m  ... ${pairs.length - 10} en el medio\x1b[0m`);

  /**
   * Los extremos se separan del resto.
   *
   * Con n de dos dígitos, dos préstamos con brecha de 200% mueven cualquier
   * agregado. No los descartamos —pueden ser reales— pero se listan aparte con
   * su trailing al lado para que alguien los mire uno por uno antes de que
   * entren a una conclusión.
   */
  const extreme = pairs.filter((p) => Math.abs(p.gap) >= 1);
  if (extreme.length > 0) {
    console.log(
      `\n  \x1b[33m${extreme.length} préstamo(s) con brecha ≥100%: revisar a mano antes de creerles\x1b[0m`,
    );
    for (const p of extreme) {
      const vsHist = p.trailing ? p.uw / p.trailing - 1 : null;
      const growth = p.trailing ? p.actual / p.trailing - 1 : null;
      console.log(
        `    loan ${p.key} (${p.type}): suscrito ${pct(vsHist)} sobre el histórico, ` +
          `y la propiedad ${growth === null ? "?" : growth >= 0 ? `creció ${pct(growth)}` : `cayó ${pct(Math.abs(growth))}`}`,
      );
    }
    const medianExGap = (() => {
      const g = pairs.filter((p) => Math.abs(p.gap) < 1).map((p) => p.gap).sort((a, b) => a - b);
      return g.length ? g[Math.floor(g.length / 2)]! : null;
    })();
    if (medianExGap !== null) {
      console.log(
        `    \x1b[90mSin ellos la mediana queda en ${pct(medianExGap)} (n=${pairs.length - extreme.length}).\x1b[0m`,
      );
    }
  }

  const gaps = pairs.map((p) => p.gap).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  const above5 = gaps.filter((g) => g >= 0.05).length;

  console.log(`\n  n                    ${String(pairs.length).padStart(6)}`);
  console.log(`  brecha mediana       ${pct(median).padStart(6)}`);
  console.log(
    `  con brecha ≥5%       ${pct(above5 / pairs.length, 0).padStart(6)}  ` +
      `\x1b[90m(Griffin 2013-2019: 29%)\x1b[0m`,
  );

  /**
   * El contraste que un solo trust sí permite.
   *
   * Contra el trailing ya sabíamos que office se despega. Lo nuevo es contra el
   * resultado: si la brecha vs. real es parecida a la brecha vs. histórico, el
   * suscriptor acertó y solo estaba proyectando crecimiento contractual. Si es
   * mucho mayor, la proyección no se cumplió.
   */
  const withTrailing = pairs.filter((p) => p.trailing !== null);
  if (withTrailing.length >= 5) {
    const vsTrailing = withTrailing
      .map((p) => p.uw / p.trailing! - 1)
      .sort((a, b) => a - b);
    const vsActual = withTrailing.map((p) => p.gap).sort((a, b) => a - b);
    const mT = vsTrailing[Math.floor(vsTrailing.length / 2)]!;
    const mA = vsActual[Math.floor(vsActual.length / 2)]!;

    /**
     * El número que las dos brechas implican, y que ninguna muestra sola.
     *
     * Si el suscriptor proyectó X% sobre el histórico y el resultado quedó Y%
     * por debajo de lo suscrito, entonces la propiedad creció (1+X)/(1+Y) - 1.
     * Ese es el dato de negocio: cuánto creció de verdad contra cuánto se
     * esperaba que creciera. Las dos brechas por separado no lo dicen.
     */
    const realGrowth = (1 + mT) / (1 + mA) - 1;

    console.log(`\n  Sobre los ${withTrailing.length} préstamos con las tres cifras:`);
    console.log(`    suscrito vs. histórico   ${pct(mT).padStart(7)}   \x1b[90m(crecimiento proyectado)\x1b[0m`);
    console.log(`    suscrito vs. real        ${pct(mA).padStart(7)}   \x1b[90m(lo que mide Griffin)\x1b[0m`);
    console.log(`    \x1b[1mreal vs. histórico       ${pct(realGrowth).padStart(7)}\x1b[0m   \x1b[90m(crecimiento entregado)\x1b[0m`);
    console.log();
    if (mT > 0.02 && realGrowth < mT / 2) {
      console.log(
        `    \x1b[33mSe proyectó ${pct(mT)} de crecimiento y se entregó ${pct(realGrowth)}.\x1b[0m`,
      );
      console.log(`    Las propiedades quedaron esencialmente donde estaban.`);
    } else if (realGrowth >= mT) {
      console.log(`    \x1b[32mLas propiedades crecieron al menos lo proyectado.\x1b[0m`);
      console.log(`    La brecha contra el histórico era una proyección correcta.`);
    } else {
      console.log(
        `    \x1b[90mSe proyectó ${pct(mT)} y se entregó ${pct(realGrowth)}: parcialmente cumplido.\x1b[0m`,
      );
    }
  }

  console.log(
    `\n  \x1b[90mUn trust no prueba nada. Sirve para ver si los números son plausibles\x1b[0m`,
  );
  console.log(`  \x1b[90mantes de cosechar treinta.\x1b[0m\n`);
}

await closePool();

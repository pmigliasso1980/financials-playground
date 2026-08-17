/**
 * Distribuciones del corpus.
 *
 *   npm run db:analyze
 *   npm run db:analyze -- --type Multifamily
 *
 * PARA QUÉ SIRVE
 *
 * Es la prueba más chica antes de decidir un producto: si estos números no le
 * dicen nada a alguien que suscribe deals de CRE, ninguna interfaz lo va a
 * salvar. Y si le dicen algo, ya sabemos qué hay que empaquetar.
 *
 * Cuatro cortes:
 *
 *   1. Cuartiles de DSCR, LTV y debt yield por tipo de activo. Es el "¿estoy en
 *      mercado?" que un broker contesta hoy por intuición o llamando a tres
 *      lenders.
 *
 *   2. LA BRECHA DE SUSCRIPCIÓN: cuánto proyecta el originador por encima del
 *      NOI que la propiedad produjo de verdad. Nadie publica esto y sale
 *      directo de comparar dos columnas del mismo Annex A. Un promedio alto
 *      significa que el mercado está suscribiendo agresivo.
 *
 *   3. Cap rate implícito (NOI / tasación) por tipo y mercado.
 *
 *   4. Evolución por fecha de emisión: si el apalancamiento o el DSCR se
 *      movieron en el tiempo.
 */

import { closePool, ping, query } from "./client.js";

const args = process.argv.slice(2);
const typeFilter = args.includes("--type") ? args[args.indexOf("--type") + 1] : null;
const MIN_SAMPLE = 5;

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const { rows: totals } = await query<{ filings: string; loans: string }>(
  "SELECT (SELECT count(*) FROM corpus.filings) AS filings, (SELECT count(*) FROM corpus.loans) AS loans",
);
const filings = Number(totals[0]!.filings);
const loans = Number(totals[0]!.loans);

console.log(`\n${"═".repeat(76)}`);
console.log(`Distribuciones · ${filings} filings · ${loans} préstamos`);
console.log(`${"═".repeat(76)}`);

if (loans < 30) {
  console.log(
    `\n  \x1b[33mMuestra chica.\x1b[0m Con menos de 30 préstamos las medianas son ruido.\n`,
  );
  console.log(`  Cosechá más:  npm run harvest:batch -- --limit 25\n`);
}

// ---------------------------------------------------------------------------
// 1. Ratios de suscripción por tipo de activo
// ---------------------------------------------------------------------------

interface RatioRow {
  property_type: string;
  n: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
}

async function ratiosByType(metric: string): Promise<RatioRow[]> {
  const { rows } = await query<RatioRow>(
    `SELECT
       l.property_type,
       count(*) AS n,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY f.value::numeric) AS p25,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY f.value::numeric) AS p50,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY f.value::numeric) AS p75
     FROM corpus.facts f
     JOIN corpus.loans l ON l.id = f.loan_id
     WHERE f.metric_key = $1
       AND l.property_type IS NOT NULL
       AND f.value ~ '^-?[0-9.]+$'
       ${typeFilter ? "AND l.property_type = $2" : ""}
     GROUP BY l.property_type
     HAVING count(*) >= ${MIN_SAMPLE}
     ORDER BY count(*) DESC`,
    typeFilter ? [metric, typeFilter] : [metric],
  );
  return rows;
}

function fmt(v: number | null, unit: "pct" | "x"): string {
  if (v === null) return "—";
  return unit === "pct" ? `${(v * 100).toFixed(1)}%` : `${v.toFixed(2)}x`;
}

console.log(`\n\x1b[1mRatios de suscripción por tipo de activo\x1b[0m`);
console.log(`\x1b[90m  p25 / mediana / p75 — el rango donde está el mercado\x1b[0m\n`);

for (const [metric, label, unit] of [
  ["dscr", "DSCR", "x"],
  ["ltv", "LTV", "pct"],
  ["debt_yield", "Debt yield", "pct"],
] as const) {
  const rows = await ratiosByType(metric);
  if (rows.length === 0) continue;

  console.log(`  ${label}`);
  console.log(`    ${"tipo".padEnd(20)} ${"n".padStart(4)}  ${"p25".padStart(8)} ${"mediana".padStart(8)} ${"p75".padStart(8)}`);
  for (const r of rows) {
    console.log(
      `    ${r.property_type.slice(0, 20).padEnd(20)} ${String(r.n).padStart(4)}  ` +
        `${fmt(r.p25, unit).padStart(8)} \x1b[1m${fmt(r.p50, unit).padStart(8)}\x1b[0m ${fmt(r.p75, unit).padStart(8)}`,
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
// 2. La brecha de suscripción
// ---------------------------------------------------------------------------

/**
 * Cuánto proyecta el originador por encima del NOI real.
 *
 * Sale de dos columnas del mismo Annex A: `Underwritten NOI` contra
 * `Most Recent NOI`. Es una medida directa de agresividad de suscripción, por
 * tipo de activo, calculable solo con datos públicos.
 *
 * Interpretación: +8% significa que en la mediana se está proyectando un NOI
 * 8% por encima de lo que la propiedad produjo el último período cerrado. Un
 * valor alto no es necesariamente malo —una propiedad en lease-up legítimamente
 * va a producir más— pero sostenido y creciente es señal de mercado recalentado.
 */
interface GapRow {
  property_type: string;
  n: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  share_above: string;
}

const { rows: gaps } = await query<GapRow>(
  `WITH pairs AS (
     SELECT
       l.property_type,
       uw.value::numeric AS uw_noi,
       mr.value::numeric AS mr_noi
     FROM corpus.loans l
     JOIN corpus.facts uw ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten'
     JOIN corpus.facts mr ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'
     WHERE l.property_type IS NOT NULL
       AND uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$'
       AND mr.value::numeric > 0
       ${typeFilter ? "AND l.property_type = $1" : ""}
   )
   SELECT
     property_type,
     count(*) AS n,
     percentile_cont(0.25) WITHIN GROUP (ORDER BY uw_noi / mr_noi - 1) AS p25,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY uw_noi / mr_noi - 1) AS p50,
     percentile_cont(0.75) WITHIN GROUP (ORDER BY uw_noi / mr_noi - 1) AS p75,
     round(100.0 * count(*) FILTER (WHERE uw_noi > mr_noi) / count(*), 0) AS share_above
   FROM pairs
   GROUP BY property_type
   HAVING count(*) >= ${MIN_SAMPLE}
   ORDER BY count(*) DESC`,
  typeFilter ? [typeFilter] : [],
);

if (gaps.length > 0) {
  console.log(`\x1b[1mBrecha de suscripción\x1b[0m`);
  console.log(
    `\x1b[90m  Cuánto proyecta el originador sobre el NOI real del último período.\x1b[0m`,
  );
  console.log(
    `\x1b[90m  Sale de comparar dos columnas del mismo Annex A. Nadie lo publica.\x1b[0m\n`,
  );
  console.log(`  ${"tipo".padEnd(20)} ${"n".padStart(4)}  ${"p25".padStart(8)} ${"mediana".padStart(8)} ${"p75".padStart(8)}  % por encima`);
  for (const g of gaps) {
    const pct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
    const median = g.p50 ?? 0;
    const color = median > 0.15 ? "\x1b[33m" : median > 0 ? "" : "\x1b[36m";
    console.log(
      `  ${g.property_type.slice(0, 20).padEnd(20)} ${String(g.n).padStart(4)}  ` +
        `${pct(g.p25).padStart(8)} ${color}${pct(g.p50).padStart(8)}\x1b[0m ${pct(g.p75).padStart(8)}  ${String(g.share_above).padStart(9)}%`,
    );
  }
  console.log(
    `\n  \x1b[90mUn +8% en la mediana significa que se está suscribiendo un NOI 8% por\x1b[0m`,
  );
  console.log(
    `  \x1b[90mencima de lo que la propiedad produjo. Alto y sostenido = mercado agresivo.\x1b[0m\n`,
  );
}

// ---------------------------------------------------------------------------
// 3. Cap rate implícito
// ---------------------------------------------------------------------------

const { rows: capRates } = await query<RatioRow>(
  `WITH pairs AS (
     SELECT
       l.property_type,
       noi.value::numeric / NULLIF(val.value::numeric, 0) AS cap
     FROM corpus.loans l
     JOIN corpus.facts noi ON noi.loan_id = l.id AND noi.metric_key = 'noi_underwritten'
     JOIN corpus.facts val ON val.loan_id = l.id AND val.metric_key = 'appraised_value'
     WHERE l.property_type IS NOT NULL
       AND noi.value ~ '^-?[0-9.]+$' AND val.value ~ '^-?[0-9.]+$'
       ${typeFilter ? "AND l.property_type = $1" : ""}
   )
   SELECT property_type, count(*) AS n,
     percentile_cont(0.25) WITHIN GROUP (ORDER BY cap) AS p25,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY cap) AS p50,
     percentile_cont(0.75) WITHIN GROUP (ORDER BY cap) AS p75
   FROM pairs
   WHERE cap BETWEEN 0.01 AND 0.25
   GROUP BY property_type
   HAVING count(*) >= ${MIN_SAMPLE}
   ORDER BY count(*) DESC`,
  typeFilter ? [typeFilter] : [],
);

if (capRates.length > 0) {
  console.log(`\x1b[1mCap rate implícito\x1b[0m \x1b[90m(NOI underwritten / tasación)\x1b[0m\n`);
  console.log(`  ${"tipo".padEnd(20)} ${"n".padStart(4)}  ${"p25".padStart(8)} ${"mediana".padStart(8)} ${"p75".padStart(8)}`);
  for (const r of capRates) {
    console.log(
      `  ${r.property_type.slice(0, 20).padEnd(20)} ${String(r.n).padStart(4)}  ` +
        `${fmt(r.p25, "pct").padStart(8)} \x1b[1m${fmt(r.p50, "pct").padStart(8)}\x1b[0m ${fmt(r.p75, "pct").padStart(8)}`,
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
// 4. Evolución temporal
// ---------------------------------------------------------------------------

/**
 * CUIDADO CON LA SERIE TEMPORAL
 *
 * Una mediana agregada por trimestre está confundida por la mezcla de activos.
 * Multifamily tiene el DSCR más bajo y el LTV más alto de todas las categorías,
 * así que un trimestre dominado por un pool multifamily muestra apalancamiento
 * alto y cobertura baja **sin que ningún estándar de suscripción haya cambiado**.
 *
 * Con 99 filings, un solo deal grande puede ser la mitad de un trimestre: BANK
 * 2026-BNK52 aportó 165 préstamos, BBCMS 2025-C35 aportó 103.
 *
 * Por eso mostramos también la composición y la serie dentro de multifamily,
 * que es la categoría con muestra suficiente para verla sola.
 */
const { rows: overTime } = await query<{
  period: string; n: string; deals: string; dscr: number | null; ltv: number | null;
  dy: number | null; mf_share: number | null;
}>(
  `SELECT
     to_char(date_trunc('quarter', fi.filed_at), 'YYYY-"Q"Q') AS period,
     count(DISTINCT l.id) AS n,
     count(DISTINCT fi.accession) AS deals,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY d.value::numeric) AS dscr,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY v.value::numeric) AS ltv,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY y.value::numeric) AS dy,
     1.0 * count(*) FILTER (WHERE l.property_type = 'Multifamily') / NULLIF(count(*), 0) AS mf_share
   FROM corpus.filings fi
   JOIN corpus.loans l ON l.accession = fi.accession
   LEFT JOIN corpus.facts d ON d.loan_id = l.id AND d.metric_key = 'dscr'  AND d.value ~ '^-?[0-9.]+$'
   LEFT JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = 'ltv'   AND v.value ~ '^-?[0-9.]+$'
   LEFT JOIN corpus.facts y ON y.loan_id = l.id AND y.metric_key = 'debt_yield' AND y.value ~ '^-?[0-9.]+$'
   WHERE fi.filed_at IS NOT NULL
   GROUP BY 1
   HAVING count(DISTINCT l.id) >= ${MIN_SAMPLE}
   ORDER BY 1`,
);

if (overTime.length > 1) {
  console.log(`\x1b[1mEvolución por trimestre\x1b[0m \x1b[90m(medianas, TODOS los activos)\x1b[0m\n`);
  console.log(
    `  ${"período".padEnd(10)} ${"n".padStart(5)} ${"deals".padStart(6)}  ${"DSCR".padStart(8)} ${"LTV".padStart(8)} ${"debt yield".padStart(11)}  ${"% multif.".padStart(9)}`,
  );
  for (const r of overTime) {
    const n = Number(r.n);
    const deals = Number(r.deals);
    // Un trimestre con uno o dos deals no es una lectura de mercado.
    const thin = deals <= 2 || n < 100;
    const mark = thin ? "\x1b[33m" : "";
    console.log(
      `  ${mark}${r.period.padEnd(10)}\x1b[0m ${String(n).padStart(5)} ${String(deals).padStart(6)}  ` +
        `${fmt(r.dscr, "x").padStart(8)} ${fmt(r.ltv, "pct").padStart(8)} ${fmt(r.dy, "pct").padStart(11)}  ` +
        `${fmt(r.mf_share, "pct").padStart(9)}${thin ? " \x1b[33m⚠\x1b[0m" : ""}`,
    );
  }

  const thin = overTime.filter((r) => Number(r.deals) <= 2 || Number(r.n) < 100);
  if (thin.length > 0) {
    console.log(
      `\n  \x1b[33m⚠ ${thin.map((r) => r.period).join(", ")}: muestra chica o pocos deals.\x1b[0m`,
    );
    console.log(
      `  \x1b[90mUn solo pool puede dominar el trimestre. No leerlos como señal de mercado.\x1b[0m`,
    );
  }
  console.log(
    `\n  \x1b[90mLa columna "% multifamily" existe porque esa categoría tiene el DSCR más\x1b[0m`,
  );
  console.log(
    `  \x1b[90mbajo y el LTV más alto: si sube su participación, los agregados se mueven\x1b[0m`,
  );
  console.log(`  \x1b[90msin que cambie ningún estándar de suscripción.\x1b[0m\n`);

  // --- la misma serie, dentro de un solo tipo de activo --------------------
  //
  // Controlar por composición es la única forma de leer la serie como señal de
  // mercado en vez de como reflejo de qué se securitizó ese trimestre.

  const { rows: mfSeries } = await query<{
    period: string; n: string; dscr: number | null; ltv: number | null; dy: number | null;
  }>(
    `SELECT
       to_char(date_trunc('quarter', fi.filed_at), 'YYYY-"Q"Q') AS period,
       count(DISTINCT l.id) AS n,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY d.value::numeric) AS dscr,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY v.value::numeric) AS ltv,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY y.value::numeric) AS dy
     FROM corpus.filings fi
     JOIN corpus.loans l ON l.accession = fi.accession
     LEFT JOIN corpus.facts d ON d.loan_id = l.id AND d.metric_key = 'dscr'  AND d.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = 'ltv'   AND v.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts y ON y.loan_id = l.id AND y.metric_key = 'debt_yield' AND y.value ~ '^-?[0-9.]+$'
     WHERE fi.filed_at IS NOT NULL AND l.property_type = 'Multifamily'
     GROUP BY 1
     HAVING count(DISTINCT l.id) >= 20
     ORDER BY 1`,
  );

  if (mfSeries.length > 2) {
    console.log(`\x1b[1mEvolución dentro de multifamily\x1b[0m \x1b[90m(composición controlada)\x1b[0m\n`);
    console.log(`  ${"período".padEnd(10)} ${"n".padStart(5)}  ${"DSCR".padStart(8)} ${"LTV".padStart(8)} ${"debt yield".padStart(11)}`);
    for (const r of mfSeries) {
      console.log(
        `  ${r.period.padEnd(10)} ${String(r.n).padStart(5)}  ` +
          `${fmt(r.dscr, "x").padStart(8)} ${fmt(r.ltv, "pct").padStart(8)} ${fmt(r.dy, "pct").padStart(11)}`,
      );
    }
    console.log(
      `\n  \x1b[90mEsta serie sí se puede leer como señal: si acá el LTV sube y el DSCR baja,\x1b[0m`,
    );
    console.log(`  \x1b[90mes suscripción, no mezcla de activos.\x1b[0m\n`);
  }
} else if (filings > 0) {
  console.log(
    `\x1b[90mLa serie temporal necesita filings de varios trimestres. Cosechá más:\x1b[0m`,
  );
  console.log(`  npm run harvest:batch -- --limit 30\n`);
}

// ---------------------------------------------------------------------------

console.log(`${"─".repeat(76)}`);
console.log(
  `\n  \x1b[90mSi alguno de estos números le llama la atención a alguien que suscribe\x1b[0m`,
);
console.log(
  `  \x1b[90mdeals, ahí está el producto. Si no, conviene saberlo antes de construir.\x1b[0m\n`,
);

await closePool();

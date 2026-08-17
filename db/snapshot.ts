/**
 * Instantánea del corpus, y qué se movió desde la anterior.
 *
 *   npm run db:snapshot            compara contra la última y guarda
 *   npm run db:snapshot -- --dry   compara sin guardar
 *
 * QUÉ PROBLEMA RESUELVE
 *
 * Los hallazgos más valiosos de este proyecto no salieron de razonar: salieron
 * de que un número volvió distinto del esperado.
 *
 *   3.579 → 3.566 préstamos      destapó que el join horizontal cambió
 *   52% → 41% en el share        destapó que promediábamos dos mercados
 *   73% → 95% en las identidades confirmó el escalado del servicio de deuda
 *
 * Ninguno necesita criterio para DETECTARSE. Los tres lo necesitan para
 * interpretarse. Esa asimetría es la que conviene automatizar: la máquina avisa
 * que algo se movió, la persona decide si importa.
 *
 * POR QUÉ NO ES UN TEST
 *
 * Un test afirma que un valor es correcto. Acá no sabemos cuál es el valor
 * correcto —si lo supiéramos no haría falta el corpus—. Lo único que se puede
 * afirmar es que cambió, y que nadie lo explicó.
 *
 * Por eso no falla. Imprime. Un umbral que corta el pipeline por una variación
 * de tres décimas termina desactivado en una semana.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, ping, query } from "./client.js";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../.snapshots");
const dry = process.argv.includes("--dry");

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

interface Metric {
  /** Etiqueta legible. */
  label: string;
  value: number | null;
  /** Cómo formatear: entero, porcentaje, ratio. */
  kind: "count" | "pct" | "ratio";
  /**
   * Variación relativa a partir de la cual vale la pena mirar.
   *
   * No es un umbral de error: es de atención. Un conteo de préstamos que se
   * mueve 1% después de cambiar el mapeo es esperable; uno que se mueve 1% sin
   * que nadie tocara nada, no.
   */
  notable: number;
}

interface Snapshot {
  at: string;
  metrics: Record<string, Metric>;
}

// ---------------------------------------------------------------------------
// Qué se mide
// ---------------------------------------------------------------------------

const metrics: Record<string, Metric> = {};

const add = (key: string, label: string, value: number | null, kind: Metric["kind"], notable: number) => {
  metrics[key] = { label, value, kind, notable };
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// --- tamaño del corpus -------------------------------------------------------

const { rows: size } = await query<{
  filings: string; loans: string; observations: string; facts: string; metrics: string;
}>(
  `SELECT (SELECT count(*) FROM corpus.filings)      AS filings,
          (SELECT count(*) FROM corpus.loans)        AS loans,
          (SELECT count(*) FROM corpus.observations) AS observations,
          (SELECT count(*) FROM corpus.facts)        AS facts,
          (SELECT count(DISTINCT metric_key) FROM corpus.facts) AS metrics`,
);
const sz = size[0]!;
add("filings", "emisiones", num(sz.filings), "count", 0.001);
add("loans", "préstamos", num(sz.loans), "count", 0.002);
add("observations", "observations", num(sz.observations), "count", 0.01);
add("metrics", "métricas distintas", num(sz.metrics), "count", 0.001);

/**
 * Cobertura del identificador.
 *
 * Es la métrica que más silenciosamente se degrada: los préstamos se cosechan
 * bien, nadie ve un error, y después no pegan contra nada. Estuvo en 72% durante
 * toda la sesión sin que lo notáramos.
 */
const { rows: ids } = await query<{ share: number | null }>(
  `SELECT 1.0 * count(*) FILTER (WHERE loan_ref IS NOT NULL AND loan_ref <> '')
          / NULLIF(count(*), 0) AS share
     FROM corpus.loans`,
);
add("loan_ref_coverage", "préstamos con identificador", num(ids[0]?.share), "pct", 0.02);

const { rows: typed } = await query<{ share: number | null }>(
  `SELECT 1.0 * count(*) FILTER (WHERE property_type IS NOT NULL AND property_type <> '')
          / NULLIF(count(*), 0) AS share
     FROM corpus.loans`,
);
add("property_type_coverage", "préstamos con tipo", num(typed[0]?.share), "pct", 0.02);

// --- identidades aritméticas -------------------------------------------------

const TOL = 0.01;
const fact = (a: string, k: string) =>
  `LEFT JOIN corpus.facts ${a} ON ${a}.loan_id = l.id AND ${a}.metric_key = '${k}' ` +
  `AND ${a}.value ~ '^-?[0-9.]+$'`;
const SENIOR = "(amt.value::numeric + coalesce(npp.value::numeric, 0))";
const SENIOR_J = `${fact("amt", "loan_amount")} ${fact("npp", "balance_pari_passu_non_trust")}`;

async function identityShare(joins: string, expected: string, actual: string): Promise<number | null> {
  const { rows } = await query<{ share: number | null }>(
    `WITH p AS (
       SELECT ${expected} AS e, ${actual} AS a FROM corpus.loans l ${joins}
        WHERE ${expected} IS NOT NULL AND ${actual} IS NOT NULL AND ${actual} <> 0
     )
     SELECT 1.0 * count(*) FILTER (WHERE abs(e / a - 1) <= ${TOL}) / NULLIF(count(*), 0) AS share
       FROM p`,
  );
  return num(rows[0]?.share);
}

add(
  "id_debt_yield",
  "identidad · debt yield",
  await identityShare(
    `${fact("dy", "debt_yield")} ${fact("noi", "noi_underwritten")} ${SENIOR_J}`,
    `noi.value::numeric / NULLIF(${SENIOR}, 0)`,
    "dy.value::numeric",
  ),
  "pct",
  0.03,
);
add(
  "id_ltv",
  "identidad · LTV",
  await identityShare(
    `${fact("v", "ltv")} ${SENIOR_J} ${fact("val", "appraised_value")}`,
    `${SENIOR} / NULLIF(val.value::numeric, 0)`,
    "v.value::numeric",
  ),
  "pct",
  0.03,
);
add(
  "id_ncf",
  "identidad · NCF",
  await identityShare(
    `${fact("ncf", "net_cash_flow")} ${fact("noi", "noi_underwritten")} ` +
      `${fact("rep", "underwritten_replacement_reserve")} ${fact("tilc", "underwritten_tilc")}`,
    "noi.value::numeric - coalesce(rep.value::numeric, 0) - coalesce(tilc.value::numeric, 0)",
    "ncf.value::numeric",
  ),
  "pct",
  0.03,
);

// --- desempeño y hallazgo ----------------------------------------------------

const { rows: perf } = await query<{ n: string }>(
  `SELECT count(*) AS n FROM corpus.performance`,
);
add("performance_loans", "préstamos con NOI real", num(perf[0]?.n), "count", 0.02);

const POST = "gap_vs_actual IS NOT NULL AND days_after_origination >= 0";
const { rows: outcome } = await query<{
  n: string; median: number | null; share: number | null;
}>(
  `SELECT count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_actual) AS median,
          1.0 * count(*) FILTER (WHERE gap_vs_actual >= 0.05) / NULLIF(count(*), 0) AS share
     FROM corpus.underwriting_outcomes WHERE ${POST}`,
);
add("outcome_n", "muestra del hallazgo", num(outcome[0]?.n), "count", 0.02);
add("outcome_median", "brecha mediana vs real", num(outcome[0]?.median), "pct", 0.15);
add("outcome_share", "share ≥5%", num(outcome[0]?.share), "pct", 0.05);

/**
 * Las dos añadas que anclan el contraste.
 *
 * El hallazgo dice que el crecimiento proyectado se mantuvo y el entregado se
 * derrumbó. Si alguna de estas cuatro cifras se mueve sin explicación, el
 * documento hay que reescribirlo.
 */
for (const year of [2021, 2024]) {
  const { rows } = await query<{ projected: number | null; growth: number | null; n: string }>(
    `SELECT count(*) AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_trailing) AS projected,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY growth_delivered) AS growth
       FROM corpus.underwriting_outcomes
      WHERE ${POST} AND extract(year FROM originated_at) = ${year}`,
  );
  add(`v${year}_n`, `añada ${year} · n`, num(rows[0]?.n), "count", 0.05);
  add(`v${year}_projected`, `añada ${year} · proyectó`, num(rows[0]?.projected), "pct", 0.15);
  add(`v${year}_growth`, `añada ${year} · entregó`, num(rows[0]?.growth), "pct", 0.15);
}

// ---------------------------------------------------------------------------
// Comparación
// ---------------------------------------------------------------------------

const current: Snapshot = { at: new Date().toISOString(), metrics };

mkdirSync(DIR, { recursive: true });
const previousFiles = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const previous: Snapshot | null = previousFiles.length
  ? JSON.parse(readFileSync(join(DIR, previousFiles[previousFiles.length - 1]!), "utf8"))
  : null;

const fmt = (m: Metric): string => {
  if (m.value === null) return "—";
  if (m.kind === "pct") return `${(m.value * 100).toFixed(1)}%`;
  if (m.kind === "ratio") return m.value.toFixed(2);
  return Math.round(m.value).toLocaleString("en-US");
};

console.log(`\n${"═".repeat(78)}`);
console.log("Instantánea del corpus");
console.log(`${"═".repeat(78)}`);

if (!previous) {
  console.log(`\n  \x1b[90mPrimera instantánea: no hay contra qué comparar.\x1b[0m\n`);
  for (const m of Object.values(metrics)) {
    console.log(`  ${m.label.padEnd(32)} ${fmt(m).padStart(12)}`);
  }
} else {
  console.log(`\n  Contra ${previous.at.slice(0, 16).replace("T", " ")}\n`);

  const moved: Array<{ m: Metric; before: number; after: number; rel: number }> = [];
  const stable: Metric[] = [];

  for (const [key, m] of Object.entries(metrics)) {
    const before = previous.metrics[key]?.value;
    if (before === undefined || before === null || m.value === null) {
      console.log(`  ${m.label.padEnd(32)} ${fmt(m).padStart(12)}   \x1b[90mnuevo\x1b[0m`);
      continue;
    }
    const rel = before === 0 ? (m.value === 0 ? 0 : 1) : Math.abs(m.value - before) / Math.abs(before);
    if (rel >= m.notable) moved.push({ m, before, after: m.value, rel });
    else stable.push(m);
  }

  if (moved.length === 0) {
    console.log(`  \x1b[32mNada se movió por encima de su umbral de atención.\x1b[0m`);
  } else {
    console.log(`  \x1b[33mSe movieron ${moved.length}:\x1b[0m\n`);
    for (const { m, before, after, rel } of moved) {
      const dir = after > before ? "↑" : "↓";
      const b: Metric = { ...m, value: before };
      console.log(
        `  ${m.label.padEnd(32)} ${fmt(b).padStart(12)} ${dir} ${fmt(m).padStart(12)}   ` +
          `\x1b[90m${(rel * 100).toFixed(1)}%\x1b[0m`,
      );
    }
    console.log(
      `\n  \x1b[90mUn número que se mueve sin que nadie lo haya explicado es una pregunta,\x1b[0m`,
    );
    console.log(`  \x1b[90mno un error. Los tres hallazgos de esta semana salieron de acá.\x1b[0m`);
  }

  console.log(`\n  \x1b[90m${stable.length} estables\x1b[0m`);
}

if (!dry) {
  const name = `${current.at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(join(DIR, name), JSON.stringify(current, null, 2) + "\n");
  console.log(`\n  → .snapshots/${name}`);

  /**
   * No hay limpieza de archivos viejos, a propósito.
   *
   * La primera versión "limpiaba" escribiendo archivos vacíos, porque no quise
   * lidiar con permisos de borrado. Eso deja basura que el propio script después
   * intenta parsear como JSON y rompe. Peor que no hacer nada.
   *
   * Un snapshot pesa un par de KB. Cuando molesten, `rm .snapshots/*.json`.
   */
}

console.log();
await closePool();

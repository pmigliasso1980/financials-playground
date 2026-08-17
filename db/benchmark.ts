/**
 * ¿En qué se aparta esta emisión de su cohorte?
 *
 *   npm run db:benchmark                    # la más reciente
 *   npm run db:benchmark -- BNK52
 *   npm run db:benchmark -- --listar
 *
 * QUÉ ES ESTO Y QUÉ NO
 *
 * Es la primera pieza con forma de servicio en vez de diagnóstico: entra una
 * emisión, sale dónde cae respecto de las otras de su año. Tiene entrada,
 * salida, y un usuario imaginable — alguien mirando un deal que quiere saber si
 * los términos son de mercado.
 *
 * Los once scripts anteriores eran instrumentos para quien construye. Este
 * responde una pregunta que alguien más podría hacer.
 *
 * POR QUÉ CONTRA LA COHORTE Y NO CONTRA LA HISTORIA
 *
 * `db:stability` mostró que 6 de 7 métricas se desplazan más del 20% entre
 * añadas, y que condicionar por plazo no lo arregla: es macro. Una referencia
 * pooled mediría el ciclo, no la emisión.
 *
 * Además es la comparación que alguien quiere: nadie pregunta si su deal de
 * 2026 se aparta de 2013.
 *
 * LA UNIDAD DE COMPARACIÓN ES LA EMISIÓN, NO EL PRÉSTAMO
 *
 * Se compara la MEDIANA del pool contra la distribución de las medianas de las
 * otras emisiones del año. Comparar préstamo contra préstamo mezclaría la
 * variación de adentro de un pool con la de entre pools, y la pregunta es sobre
 * el pool.
 *
 * Con 27 pares, un percentil tiene una resolución de ~4 puntos. Se reporta la
 * posición ordinal —"3ª de 28"— porque es lo que el número realmente soporta.
 *
 * QUÉ EXCLUYE Y POR QUÉ
 *
 * Las emisiones de un solo tipo de propiedad no son conduits diversificados:
 * son otro producto. Compararlas contra la cohorte conduit produce diferencias
 * garantizadas que no significan nada. Se excluyen del grupo de referencia y se
 * dice cuáles.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Fijados antes de ver nada. */
const MIN_PARES = 15;
const CONCENTRACION_TIPO = 0.8;

const args = process.argv.slice(2);
const LISTAR = args.includes("--listar");
const BUSQUEDA = args.find((a) => !a.startsWith("--")) ?? null;

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

const METRICAS: Array<{
  key: string; etiqueta: string; min: number; max: number;
  fmt: (v: number) => string;
  /** Hacia dónde es "más agresivo": informa cómo leer la posición. */
  agresivo: "alto" | "bajo";
}> = [
  { key: "ltv", etiqueta: "LTV", min: 0.01, max: 2, fmt: (v) => pct(v, 1), agresivo: "alto" },
  { key: "dscr", etiqueta: "DSCR", min: 0.1, max: 20, fmt: (v) => v.toFixed(2), agresivo: "bajo" },
  { key: "debt_yield", etiqueta: "Debt yield", min: 0.01, max: 1, fmt: (v) => pct(v, 1), agresivo: "bajo" },
  { key: "interest_rate", etiqueta: "Tasa", min: 0.001, max: 0.2, fmt: (v) => pct(v, 2), agresivo: "alto" },
  { key: "loan_amount", etiqueta: "Saldo", min: 1e5, max: 1e10, fmt: (v) => `${(v / 1e6).toFixed(1)}M`, agresivo: "alto" },
  { key: "occupancy", etiqueta: "Ocupación", min: 0.1, max: 1.01, fmt: (v) => pct(v, 1), agresivo: "bajo" },
];

/**
 * Las emisiones de la cohorte, con lo que hace falta para decidir si cada una
 * entra al grupo de referencia.
 */
const { rows: candidatas } = await query<{
  accession: string; nombre: string; anada: string; filed: string;
  pool: string; tipo_dominante: string | null; share_dominante: string | null;
}>(
  /**
   * El pool se cuenta APARTE de los tipos.
   *
   * La primera versión unía `corpus.loans` con el CTE de tipos, que tiene una
   * fila por (emisión, tipo). Cada préstamo se contaba una vez por tipo
   * presente: BANK5 2026-5YR24 salió con 315 préstamos en vez de 35, nueve
   * veces inflado.
   *
   * Un fan-out de join no rompe nada visiblemente —el número sigue siendo un
   * número— y acá se detectó solo porque `db:cohort` había dicho 35 diez
   * minutos antes. Contar en un CTE separado y unir por clave única lo hace
   * imposible por construcción en vez de por atención.
   */
  `WITH pools AS (
     SELECT accession, count(*) AS pool FROM corpus.loans GROUP BY accession
   ),
   tipos AS (
     SELECT l.accession, l.property_type AS tipo, count(*) AS n,
            row_number() OVER (PARTITION BY l.accession ORDER BY count(*) DESC) AS rn,
            sum(count(*)) OVER (PARTITION BY l.accession) AS total
       FROM corpus.loans l
      WHERE l.property_type IS NOT NULL
      GROUP BY l.accession, l.property_type
   ),
   dominante AS (
     SELECT accession, tipo, (n::numeric / nullif(total, 0)) AS share
       FROM tipos WHERE rn = 1
   )
   SELECT f.accession, f.company_name AS nombre,
          extract(year FROM f.filed_at)::int::text AS anada,
          f.filed_at::text AS filed,
          p.pool::text,
          d.tipo AS tipo_dominante,
          d.share::text AS share_dominante
     FROM corpus.filings f
     JOIN pools p ON p.accession = f.accession
     LEFT JOIN dominante d ON d.accession = f.accession
    WHERE f.filed_at IS NOT NULL
    ORDER BY f.filed_at DESC`,
);

if (LISTAR) {
  console.log(`\n${"═".repeat(78)}`);
  console.log("Emisiones disponibles (más recientes primero)");
  console.log(`${"═".repeat(78)}\n`);
  for (const c of candidatas.slice(0, 30)) {
    const share = Number(c.share_dominante ?? 0);
    console.log(
      `  ${c.filed.slice(0, 10)}  ${c.nombre.slice(0, 42).padEnd(44)} ${String(c.pool).padStart(4)}` +
        (share > CONCENTRACION_TIPO
          ? `  \x1b[33mmono-tipo (${pct(share)} ${c.tipo_dominante})\x1b[0m`
          : ""),
    );
  }
  console.log();
  await closePool();
  process.exit(0);
}

const objetivo = BUSQUEDA
  ? candidatas.find((c) => c.nombre.toLowerCase().includes(BUSQUEDA.toLowerCase()))
  : candidatas[0];

if (!objetivo) {
  console.error(`\n✗ No se encontró una emisión que coincida con "${BUSQUEDA}".`);
  console.error(`  Listado:  npm run db:benchmark -- --listar\n`);
  await closePool();
  process.exit(1);
}

console.log(`\n${"═".repeat(78)}`);
console.log(`${objetivo.nombre}`);
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  ${objetivo.filed.slice(0, 10)} · ${objetivo.pool} préstamos · cohorte ${objetivo.anada}\x1b[0m`,
);

/**
 * El grupo de referencia: las OTRAS emisiones del mismo año, sin las mono-tipo.
 *
 * Excluir la propia es obvio pero fácil de olvidar, y con 28 emisiones incluirse
 * a uno mismo corre el percentil casi cuatro puntos.
 */
const pares = candidatas.filter(
  (c) =>
    c.anada === objetivo.anada &&
    c.accession !== objetivo.accession &&
    Number(c.share_dominante ?? 0) <= CONCENTRACION_TIPO,
);

const excluidas = candidatas.filter(
  (c) =>
    c.anada === objetivo.anada &&
    c.accession !== objetivo.accession &&
    Number(c.share_dominante ?? 0) > CONCENTRACION_TIPO,
);

console.log(
  `  \x1b[90m${pares.length} pares comparables` +
    (excluidas.length > 0
      ? ` · ${excluidas.length} excluida(s) por ser mono-tipo: ` +
        excluidas.map((e) => e.nombre.slice(0, 24)).join(", ")
      : "") +
    `\x1b[0m`,
);

/**
 * El rechazo, que es parte de la respuesta y no una pantalla vacía.
 */
if (pares.length < MIN_PARES) {
  console.log(
    `\n  \x1b[31mNo se puede evaluar: hacen falta ${MIN_PARES} pares y hay ${pares.length}.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mCon menos, "se aparta del mercado" sería una afirmación sobre ${pares.length}\x1b[0m`,
  );
  console.log(`  \x1b[90mdocumentos. La respuesta correcta es que no se sabe.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

if (Number(objetivo.share_dominante ?? 0) > CONCENTRACION_TIPO) {
  console.log(
    `\n  \x1b[33mEsta emisión es ${pct(Number(objetivo.share_dominante))} ${objetivo.tipo_dominante}:\x1b[0m`,
  );
  console.log(
    `  \x1b[90mno es un conduit diversificado y la comparación contra la cohorte va a\x1b[0m`,
  );
  console.log(`  \x1b[90mmostrar diferencias garantizadas que no significan nada.\x1b[0m`);
}

// ---------------------------------------------------------------------------
// Dónde cae cada métrica
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(78)}`);
console.log(`Posición dentro de la cohorte ${objetivo.anada}`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  métrica        esta emisión   cohorte (p25–mediana–p75)      posición`);
console.log(`  ${"─".repeat(72)}`);

const accessionsPares = [objetivo.accession, ...pares.map((p) => p.accession)];

for (const m of METRICAS) {
  const { rows } = await query<{ accession: string; mediana: string }>(
    `SELECT l.accession,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY fa.value::numeric)::text AS mediana
       FROM corpus.facts fa
       JOIN corpus.loans l ON l.id = fa.loan_id
      WHERE fa.metric_key = $1
        AND fa.value ~ '^-?[0-9.]+$'
        AND fa.value::numeric BETWEEN ${m.min} AND ${m.max}
        AND l.accession = ANY($2)
      GROUP BY l.accession
     HAVING count(*) >= 10`,
    [m.key, accessionsPares],
  );

  const propio = rows.find((r) => r.accession === objetivo.accession);
  const otros = rows
    .filter((r) => r.accession !== objetivo.accession)
    .map((r) => Number(r.mediana))
    .sort((a, b) => a - b);

  if (!propio || otros.length < MIN_PARES) {
    console.log(
      `  ${m.etiqueta.padEnd(14)} ` +
        `\x1b[90m${!propio ? "sin dato en esta emisión" : `solo ${otros.length} pares con dato`}\x1b[0m`,
    );
    continue;
  }

  const v = Number(propio.mediana);
  const q = (p: number) => otros[Math.min(otros.length - 1, Math.floor(p * otros.length))]!;
  const rank = otros.filter((x) => x < v).length + 1;
  const total = otros.length + 1;

  /**
   * "3ª de 28" y no "percentil 11": con 27 pares el percentil tiene una
   * resolución de ~4 puntos, y presentarlo con dos decimales sugiere una
   * precisión que no existe.
   */
  const extremo = rank <= 3 || rank >= total - 2;
  const direccion =
    (m.agresivo === "alto" && rank >= total - 2) || (m.agresivo === "bajo" && rank <= 3);

  console.log(
    `  ${m.etiqueta.padEnd(14)} ${m.fmt(v).padStart(12)}   ` +
      `${m.fmt(q(0.25)).padStart(8)} ${m.fmt(q(0.5)).padStart(8)} ${m.fmt(q(0.75)).padStart(8)}      ` +
      `${extremo ? (direccion ? "\x1b[33m" : "\x1b[36m") : "\x1b[90m"}${rank}ª de ${total}\x1b[0m` +
      (direccion ? "  \x1b[33m← más agresivo\x1b[0m" : ""),
  );
}

// ---------------------------------------------------------------------------
// Composición
// ---------------------------------------------------------------------------

const { rows: mezcla } = await query<{
  tipo: string; propio: string; cohorte: string;
}>(
  `WITH canon AS (
     SELECT l.accession,
            CASE
              WHEN l.property_type ~* 'multifamily|cooperative|garden|low rise|mid rise|student' THEN 'Multifamily'
              WHEN l.property_type ~* 'retail|anchored|single tenant' THEN 'Retail'
              WHEN l.property_type ~* 'office|cbd|suburban|medical' THEN 'Office'
              WHEN l.property_type ~* 'industrial|warehouse|flex' THEN 'Industrial'
              WHEN l.property_type ~* 'storage' THEN 'Self Storage'
              WHEN l.property_type ~* 'hospitality|hotel|service|extended stay' THEN 'Hospitality'
              WHEN l.property_type ~* 'mixed' THEN 'Mixed Use'
              WHEN l.property_type ~* 'manufactured' THEN 'Manufactured'
              ELSE 'Otro'
            END AS tipo
       FROM corpus.loans l
      WHERE l.property_type IS NOT NULL AND l.accession = ANY($1)
   ),
   totales AS (
     SELECT count(*) FILTER (WHERE accession = $2) AS n_propio,
            count(*) FILTER (WHERE accession <> $2) AS n_cohorte
       FROM canon
   )
   SELECT c.tipo,
          (count(*) FILTER (WHERE c.accession = $2)::numeric
            / nullif(t.n_propio, 0))::text AS propio,
          (count(*) FILTER (WHERE c.accession <> $2)::numeric
            / nullif(t.n_cohorte, 0))::text AS cohorte
     FROM canon c CROSS JOIN totales t
    GROUP BY c.tipo, t.n_propio, t.n_cohorte
    ORDER BY count(*) FILTER (WHERE c.accession = $2) DESC`,
  [accessionsPares, objetivo.accession],
);

console.log(`\n${"─".repeat(78)}`);
console.log("Composición contra la cohorte");
console.log(`${"─".repeat(78)}\n`);
console.log(`  tipo               esta emisión   cohorte    diferencia`);
console.log(`  ${"─".repeat(58)}`);

for (const r of mezcla) {
  const p = Number(r.propio ?? 0);
  const c = Number(r.cohorte ?? 0);
  if (p === 0 && c < 0.02) continue;
  const dif = p - c;
  const notable = Math.abs(dif) > 0.1;
  console.log(
    `  ${r.tipo.padEnd(18)} ${pct(p).padStart(12)}   ${pct(c).padStart(7)}    ` +
      `${notable ? "\x1b[33m" : "\x1b[90m"}${(dif > 0 ? "+" : "") + pct(dif)}\x1b[0m`,
  );
}

/**
 * La resolución de la composición, que el porcentaje esconde.
 *
 * Con un pool de 35 préstamos cada uno vale 2,9 puntos. Una diferencia de "+9%"
 * contra la cohorte son TRES préstamos, y presentarla en porcentaje sugiere una
 * granularidad que el pool no tiene.
 *
 * Es el mismo problema que el percentil con 24 pares, en la otra tabla.
 */
const puntoPorPrestamo = 1 / Number(objetivo.pool);
console.log(
  `\n  \x1b[90mCada préstamo vale ${pct(puntoPorPrestamo, 1)} de este pool (${objetivo.pool} préstamos):\x1b[0m`,
);
console.log(
  `  \x1b[90muna diferencia de 9 puntos son ${Math.round(0.09 / puntoPorPrestamo)} préstamos, no una tendencia.\x1b[0m`,
);
console.log(
  `\n  \x1b[90mLa posición es ordinal, no percentil: con ${pares.length} pares un percentil\x1b[0m`,
);
console.log(
  `  \x1b[90mtiene resolución de ~${(100 / (pares.length + 1)).toFixed(0)} puntos y presentarlo con decimales\x1b[0m`,
);
console.log(`  \x1b[90msugeriría una precisión que no existe.\x1b[0m\n`);

await closePool();

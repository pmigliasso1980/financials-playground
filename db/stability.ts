/**
 * ¿Las distribuciones de originación son comparables entre añadas?
 *
 *   npm run db:stability
 *
 * POR QUÉ ESTA PREGUNTA VA PRIMERA
 *
 * El corpus llegó a su techo para preguntas de resultado: la transferencia a
 * special servicing es un evento raro (2,4%) sobre un universo acotado, y la
 * historia de los 10-D solo compra 1,33x. Cuatro caminos independientes
 * llegaron a lo mismo.
 *
 * Lo que sí abunda son los datos de ORIGINACIÓN: 9.751 préstamos, 94 métricas,
 * identidades que cierran al 90-98%. Ahí las celdas tienen miles de
 * observaciones en vez de decenas.
 *
 * Pero cualquier pregunta que junte añadas —una distribución de referencia
 * histórica, o un corte transversal sobre el corpus entero— asume que un
 * préstamo de 2021 y uno de 2024 son comparables. Entre esas dos fechas la tasa
 * de interés pasó de ~3,5% a ~7%, y eso arrastra el DSCR y el debt yield por
 * construcción, no por decisión de nadie.
 *
 * Si las distribuciones no son estables, la referencia mide el ciclo y no la
 * emisión. Eso rompe el benchmark de perfil Y rompe los cortes transversales.
 * Un solo test decide las dos direcciones, y por eso va antes de escribir nada.
 *
 * CÓMO SE MIDE
 *
 * Para cada métrica, la mediana por añada y el rango entre la más alta y la más
 * baja, normalizado por la mediana global. Un desplazamiento del 10% es ruido;
 * uno del 60% significa que las añadas son poblaciones distintas.
 *
 * No es un test de hipótesis: con miles de observaciones por celda cualquier
 * diferencia sale significativa. Lo que importa es la MAGNITUD relativa al uso
 * que se le quiera dar.
 *
 * LO QUE ESTE TEST NO PUEDE DECIR
 *
 * Que una métrica sea estable no la vuelve comparable si su significado cambió.
 * El LTV se calcula contra una tasación, y las tasaciones de 2021 y 2024 no
 * miden el mismo mercado aunque el cociente dé parecido.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Fijado antes de ver nada. */
const DESPLAZAMIENTO_TOLERABLE = 0.2;
const MIN_POR_ANADA = 100;

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

/**
 * Las métricas que un benchmark de perfil usaría, y sus rangos de sanidad.
 *
 * Los rangos descartan la basura conocida —el DSCR de 91.617 que arrastramos
 * desde `db:predictors`, los LTV que vienen como porcentaje sin dividir— sin
 * los cuales la mediana aguanta pero los cuartiles no.
 */
const METRICAS: Array<{ key: string; etiqueta: string; min: number; max: number; fmt: (v: number) => string }> = [
  { key: "interest_rate", etiqueta: "Tasa de interés", min: 0.001, max: 0.2, fmt: (v) => pct(v, 2) },
  { key: "dscr", etiqueta: "DSCR", min: 0.1, max: 20, fmt: (v) => v.toFixed(2) },
  { key: "ltv", etiqueta: "LTV", min: 0.01, max: 2, fmt: (v) => pct(v, 1) },
  { key: "debt_yield", etiqueta: "Debt yield", min: 0.01, max: 1, fmt: (v) => pct(v, 1) },
  { key: "loan_amount", etiqueta: "Saldo", min: 1e5, max: 1e10, fmt: (v) => `${(v / 1e6).toFixed(1)}M` },
  { key: "occupancy", etiqueta: "Ocupación", min: 0.1, max: 1.01, fmt: (v) => pct(v, 1) },
  { key: "term_original", etiqueta: "Plazo (meses)", min: 12, max: 480, fmt: (v) => v.toFixed(0) },
];

console.log(`\n${"═".repeat(78)}`);
console.log("¿Son comparables las añadas? — el test que decide si hay referencia");
console.log(`${"═".repeat(78)}`);

const { rows: anadas } = await query<{ anada: string; n: string }>(
  `SELECT extract(year FROM f.filed_at)::int::text AS anada, count(l.id)::text AS n
     FROM corpus.filings f JOIN corpus.loans l ON l.accession = f.accession
    WHERE f.filed_at IS NOT NULL
    GROUP BY 1 HAVING count(l.id) >= ${MIN_POR_ANADA}
    ORDER BY 1`,
);

const cols = anadas.map((a) => a.anada);
console.log(
  `\n\x1b[90m  ${cols.length} añadas con ≥ ${MIN_POR_ANADA} préstamos: ` +
    `${anadas.map((a) => `${a.anada} (${a.n})`).join(" · ")}\x1b[0m\n`,
);

console.log(`  métrica          ` + cols.map((c) => c.padStart(9)).join("") + `   desplaz.`);
console.log(`  ${"─".repeat(20 + cols.length * 9 + 12)}`);

interface Resultado {
  etiqueta: string;
  desplazamiento: number;
  monotona: boolean;
}
const resultados: Resultado[] = [];

for (const m of METRICAS) {
  const { rows } = await query<{ anada: string; mediana: string | null; n: string }>(
    `SELECT extract(year FROM f.filed_at)::int::text AS anada,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY fa.value::numeric)::text AS mediana,
            count(*)::text AS n
       FROM corpus.facts fa
       JOIN corpus.loans l ON l.id = fa.loan_id
       JOIN corpus.filings f ON f.accession = l.accession
      WHERE fa.metric_key = $1
        AND fa.value ~ '^-?[0-9.]+$'
        AND fa.value::numeric BETWEEN ${m.min} AND ${m.max}
        AND f.filed_at IS NOT NULL
      GROUP BY 1 HAVING count(*) >= ${MIN_POR_ANADA}
      ORDER BY 1`,
    [m.key],
  );

  const porAnada = new Map(rows.map((r) => [r.anada, Number(r.mediana)]));
  const valores = cols.map((c) => porAnada.get(c) ?? null);
  const presentes = valores.filter((v): v is number => v !== null);

  if (presentes.length < 3) {
    console.log(`  ${m.etiqueta.padEnd(17)}` + `\x1b[90m  sin muestra suficiente\x1b[0m`);
    continue;
  }

  const alto = Math.max(...presentes);
  const bajo = Math.min(...presentes);
  const centro = presentes.slice().sort((a, b) => a - b)[Math.floor(presentes.length / 2)]!;
  const desplazamiento = centro !== 0 ? (alto - bajo) / Math.abs(centro) : 0;

  /**
   * Monótona o no: un desplazamiento grande pero en zigzag es ruido de
   * composición; uno que va siempre en la misma dirección es una tendencia del
   * mercado, y ese es el que hace que las añadas no sean intercambiables.
   */
  let subiendo = true;
  let bajando = true;
  for (let i = 1; i < presentes.length; i++) {
    if (presentes[i]! < presentes[i - 1]!) subiendo = false;
    if (presentes[i]! > presentes[i - 1]!) bajando = false;
  }
  const monotona = subiendo || bajando;

  resultados.push({ etiqueta: m.etiqueta, desplazamiento, monotona });

  const color =
    desplazamiento > DESPLAZAMIENTO_TOLERABLE ? "\x1b[31m" : "\x1b[32m";
  console.log(
    `  ${m.etiqueta.padEnd(17)}` +
      valores.map((v) => (v === null ? "—" : m.fmt(v)).padStart(9)).join("") +
      `   ${color}${pct(desplazamiento)}\x1b[0m${monotona ? " \x1b[33m↗\x1b[0m" : ""}`,
  );
}

console.log(
  `\n  \x1b[90mDesplazamiento = (máx − mín) / mediana central. Umbral ${pct(DESPLAZAMIENTO_TOLERABLE)},\x1b[0m`,
);
console.log(
  `  \x1b[90mfijado antes de mirar. ↗ marca las que se mueven siempre en la misma\x1b[0m`,
);
console.log(`  \x1b[90mdirección: tendencia del mercado, no ruido de composición.\x1b[0m`);

const inestables = resultados.filter((r) => r.desplazamiento > DESPLAZAMIENTO_TOLERABLE);
const tendencia = inestables.filter((r) => r.monotona);

console.log(`\n${"─".repeat(78)}\n`);
console.log(
  `  ${inestables.length} de ${resultados.length} métricas se desplazan más del ` +
    `${pct(DESPLAZAMIENTO_TOLERABLE)}` +
    (tendencia.length > 0 ? `, ${tendencia.length} con tendencia monótona` : ""),
);

if (inestables.length === 0) {
  console.log(
    `\n  \x1b[32mLas añadas son comparables.\x1b[0m Una referencia pooled es defendible.\n`,
  );
} else {
  console.log(
    `\n  \x1b[31mNo son intercambiables:\x1b[0m ${inestables.map((r) => r.etiqueta).join(", ")}.`,
  );
  console.log(
    `\n  \x1b[90mUna referencia histórica pooled sobre esas métricas mediría el ciclo y\x1b[0m`,
  );
  console.log(
    `  \x1b[90mno la emisión. La referencia tiene que ser POR AÑADA o contra tendencia.\x1b[0m`,
  );
  console.log(
    `\n  \x1b[90mY eso tiene un costo que conviene decir ahora: por añada, el n de cada\x1b[0m`,
  );
  console.log(
    `  \x1b[90mcelda se divide por cinco, que es la misma restricción que ya nos frenó.\x1b[0m\n`,
  );
}

// ---------------------------------------------------------------------------
// ¿El plazo explica la deriva mejor que la añada?
// ---------------------------------------------------------------------------

/**
 * El hallazgo que no vi venir, y su consecuencia.
 *
 * El plazo pasó de 120 meses a 60 entre 2022 y 2024, monótono, y es la única
 * métrica del tablero que se mueve siempre en la misma dirección. El mercado
 * cambió de préstamos a diez años a préstamos a cinco — por eso existen los
 * shelves BANK5, BBCMS 5C y BMO 5C, nombres que veníamos leyendo dos días sin
 * registrar qué querían decir.
 *
 * Eso no es un estorbo: es un cambio de producto. Y si el producto es lo que
 * cambió, el eje de comparación correcto no es la añada sino el plazo.
 *
 * POR QUÉ IMPORTA PARA LA ARITMÉTICA
 *
 * Por añada el n se divide en nueve. Por plazo se divide en dos: ~5.000
 * préstamos a diez años y ~4.700 a cinco. Es la diferencia entre tener
 * referencia y no tenerla.
 *
 * CÓMO SE LEE
 *
 * Para cada métrica, el desplazamiento entre añadas DENTRO de cada bucket de
 * plazo, contra el desplazamiento global de la tabla anterior.
 *
 *   baja mucho   →  la deriva era el cambio de producto: referencia por plazo
 *   no baja      →  es macro puro y no hay más remedio que la añada
 *
 * LO QUE NO PUEDE PASAR Y HAY QUE VIGILAR
 *
 * Los buckets están casi perfectamente separados en el tiempo: 10 años es
 * 2013-2022 y 5 años es 2023-2026. Si dentro de un bucket quedan pocas añadas,
 * el desplazamiento baja por falta de rango temporal y no porque el plazo
 * explique nada. Por eso se imprime cuántas añadas tiene cada bucket ANTES del
 * resultado.
 */
const BUCKETS: Array<{ etiqueta: string; min: number; max: number }> = [
  { etiqueta: "≤ 84 meses", min: 12, max: 84 },
  { etiqueta: "> 84 meses", min: 85, max: 480 },
];

console.log(`\n${"═".repeat(78)}`);
console.log("¿El plazo explica la deriva mejor que la añada?");
console.log(`${"═".repeat(78)}`);

for (const b of BUCKETS) {
  const { rows: cobertura } = await query<{ anadas: string; n: string }>(
    `SELECT count(DISTINCT extract(year FROM f.filed_at))::text AS anadas,
            count(*)::text AS n
       FROM corpus.facts t
       JOIN corpus.loans l ON l.id = t.loan_id
       JOIN corpus.filings f ON f.accession = l.accession
      WHERE t.metric_key = 'term_original' AND t.value ~ '^[0-9.]+$'
        AND t.value::numeric BETWEEN ${b.min} AND ${b.max}`,
  );

  const nAnadas = Number(cobertura[0]?.anadas ?? 0);
  console.log(
    `\n  \x1b[1m${b.etiqueta}\x1b[0m  ${Number(cobertura[0]?.n ?? 0).toLocaleString("en-US")} préstamos ` +
      `en ${nAnadas} añadas` +
      (nAnadas < 3
        ? `  \x1b[31m← sin rango temporal: cualquier caída es artefacto\x1b[0m`
        : ""),
  );
  if (nAnadas < 3) continue;

  console.log(`    métrica            global   dentro del bucket`);
  console.log(`    ${"─".repeat(48)}`);

  for (const m of METRICAS) {
    if (m.key === "term_original") continue;
    const prev = resultados.find((r) => r.etiqueta === m.etiqueta);
    if (!prev) continue;

    const { rows } = await query<{ mediana: string | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY fa.value::numeric)::text AS mediana
         FROM corpus.facts fa
         JOIN corpus.loans l ON l.id = fa.loan_id
         JOIN corpus.filings f ON f.accession = l.accession
         JOIN corpus.facts t ON t.loan_id = l.id AND t.metric_key = 'term_original'
                            AND t.value ~ '^[0-9.]+$'
                            AND t.value::numeric BETWEEN ${b.min} AND ${b.max}
        WHERE fa.metric_key = $1
          AND fa.value ~ '^-?[0-9.]+$'
          AND fa.value::numeric BETWEEN ${m.min} AND ${m.max}
          AND f.filed_at IS NOT NULL
        GROUP BY extract(year FROM f.filed_at)
       HAVING count(*) >= 50
        ORDER BY extract(year FROM f.filed_at)`,
      [m.key],
    );

    const vals = rows.map((r) => Number(r.mediana)).filter((v) => Number.isFinite(v));
    if (vals.length < 3) {
      console.log(`    ${m.etiqueta.padEnd(18)} ${pct(prev.desplazamiento).padStart(6)}   \x1b[90m—\x1b[0m`);
      continue;
    }

    const centro = vals.slice().sort((a, b2) => a - b2)[Math.floor(vals.length / 2)]!;
    const dentro = centro !== 0 ? (Math.max(...vals) - Math.min(...vals)) / Math.abs(centro) : 0;
    const mejora = prev.desplazamiento > 0 ? 1 - dentro / prev.desplazamiento : 0;

    console.log(
      `    ${m.etiqueta.padEnd(18)} ${pct(prev.desplazamiento).padStart(6)}   ` +
        `${(dentro <= DESPLAZAMIENTO_TOLERABLE ? "\x1b[32m" : "\x1b[31m")}${pct(dentro).padStart(6)}\x1b[0m` +
        `   \x1b[90m${mejora > 0 ? `−${pct(mejora)}` : "sin mejora"}\x1b[0m`,
    );
  }
}

console.log(
  `\n  \x1b[90mSi el desplazamiento dentro del bucket cae por debajo del ${pct(DESPLAZAMIENTO_TOLERABLE)},\x1b[0m`,
);
console.log(
  `  \x1b[90mla deriva era el cambio de producto y la referencia se arma por plazo,\x1b[0m`,
);
console.log(
  `  \x1b[90mcon miles de préstamos por celda. Si no cae, es macro y hay que ir por\x1b[0m`,
);
console.log(`  \x1b[90mañada — con el n dividido en nueve.\x1b[0m\n`);

await closePool();

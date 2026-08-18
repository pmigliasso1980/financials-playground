/**
 * ¿Le sirve este corpus a alguien que está cerrando un préstamo?
 *
 *   npm run db:comps
 *
 * LA PREGUNTA, Y POR QUÉ NO SE HIZO ANTES
 *
 * Todos los scripts de este repositorio agregan por EMISIÓN o por ORIGINADOR. Son
 * las dos unidades que le importan a alguien que compra bonos de CMBS.
 *
 * Un broker no compra bonos. Está tratando de colocar un préstamo sobre una
 * propiedad concreta, en un lugar concreto, de un tamaño concreto, ahora. Su
 * pregunta es: "¿qué términos consiguieron préstamos parecidos al mío?".
 *
 * El corpus tiene los cuatro campos que definen "parecido": estado, tipo de
 * propiedad, tamaño y fecha. Nunca se consultó así. Este script existe para
 * averiguar si el corpus sobrevive a esa pregunta ANTES de construirle una API
 * encima.
 *
 * EL DISEÑO EVITA ELEGIR LOS EJEMPLOS
 *
 * La tentación es inventar tres consultas de broker plausibles y mostrar que
 * funcionan. Eso no prueba nada: uno elige las que funcionan sin darse cuenta.
 *
 * Así que la consulta la genera el propio corpus. **Cada préstamo se trata como si
 * fuera la consulta de un broker**, y se cuenta cuántos comparables tiene el resto
 * del corpus para él. Nueve mil seiscientas consultas, ninguna elegida por mí.
 *
 * QUÉ PUEDE SALIR MAL, Y ESO ES EL PUNTO
 *
 * Si la mediana de comparables es 2, el producto de comps no existe con este
 * corpus y conviene saberlo hoy y no después de escribir las rutas. Si es 40, hay
 * algo que construir.
 *
 * El umbral se fija antes de mirar: **menos de 5 comparables no es una respuesta**
 * —un rango construido con cuatro préstamos no acota nada— y con 20 se puede dar
 * una mediana y un rango intercuartil que signifiquen algo.
 */

import { closePool, ping, query } from "./client.js";
import { estadoCorpus, estampa } from "./procedencia.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Fijados antes de mirar los datos. */
const MIN_UTIL = 5;
const MIN_BUENO = 20;
/** Un comparable es del mismo estado y tipo, ±50% de tamaño, ±18 meses. */
const BANDA_TAMANO = 0.5;
const MESES = 18;

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const num = (v: number) => v.toLocaleString("en-US");

const CANON = `CASE
    WHEN l.property_type ~* 'multifamily|cooperative|garden|low rise|mid rise|student' THEN 'Multifamily'
    WHEN l.property_type ~* 'retail|anchored|single tenant' THEN 'Retail'
    WHEN l.property_type ~* 'office|cbd|suburban|medical' THEN 'Office'
    WHEN l.property_type ~* 'industrial|warehouse|flex' THEN 'Industrial'
    WHEN l.property_type ~* 'storage' THEN 'Self Storage'
    WHEN l.property_type ~* 'hospitality|hotel|service|extended stay' THEN 'Hospitality'
    WHEN l.property_type ~* 'mixed' THEN 'Mixed Use'
    WHEN l.property_type ~* 'manufactured' THEN 'Manufactured'
    ELSE 'Otro'
  END`;

console.log(`\n${"═".repeat(78)}`);
console.log("¿Sirve el corpus para responder la pregunta de un broker?");
console.log(`${"═".repeat(78)}`);

// ---------------------------------------------------------------------------
// 1. Cobertura de los cuatro campos que definen "parecido"
// ---------------------------------------------------------------------------

/**
 * Sin los cuatro campos no hay consulta posible, así que la cobertura va primero
 * y puede cortar el script. Es el mismo orden forzado que en `db:seller`.
 */
const { rows: cob } = await query<{
  total: string; con_estado: string; con_tipo: string; con_monto: string;
  con_fecha: string; completos: string;
}>(
  `SELECT count(*)::text AS total,
          count(*) FILTER (WHERE nullif(btrim(l.state), '') IS NOT NULL)::text AS con_estado,
          count(*) FILTER (WHERE l.property_type IS NOT NULL)::text AS con_tipo,
          count(am.value)::text AS con_monto,
          count(*) FILTER (WHERE f.filed_at IS NOT NULL)::text AS con_fecha,
          count(*) FILTER (
            WHERE nullif(btrim(l.state), '') IS NOT NULL
              AND l.property_type IS NOT NULL
              AND am.value IS NOT NULL
              AND f.filed_at IS NOT NULL
          )::text AS completos
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.facts am ON am.loan_id = l.id AND am.metric_key = 'loan_amount'
                              AND am.value ~ '^[0-9.]+$'`,
);
const c = cob[0]!;
const totalPrestamos = Number(c.total);
const completos = Number(c.completos);

console.log(`\n${"─".repeat(78)}`);
console.log("Los cuatro campos que definen un comparable");
console.log(`${"─".repeat(78)}\n`);
const fila = (et: string, v: string) =>
  console.log(
    `  ${et.padEnd(28)} ${num(Number(v)).padStart(7)} de ${num(totalPrestamos)}   ` +
      `${pct(Number(v) / Math.max(1, totalPrestamos)).padStart(6)}`,
  );
fila("estado", c.con_estado);
fila("tipo de propiedad", c.con_tipo);
fila("monto del préstamo", c.con_monto);
fila("fecha", c.con_fecha);
console.log(`  ${"─".repeat(52)}`);
fila("los cuatro juntos", c.completos);

if (completos < 1000) {
  console.log(
    `\n  \x1b[31mCon ${num(completos)} préstamos consultables no hay producto de comps.\x1b[0m\n`,
  );
  await closePool();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Cada préstamo es una consulta: ¿cuántos comparables tiene?
// ---------------------------------------------------------------------------

/**
 * El self-join es el experimento: para cada préstamo, cuántos OTROS préstamos del
 * corpus cumplen las cuatro condiciones. Nadie eligió las consultas.
 */
const { rows: dist } = await query<{
  p10: string; p25: string; p50: string; p75: string; p90: string;
  inutiles: string; finos: string; buenos: string; n: string;
}>(
  `WITH base AS (
     SELECT l.id, nullif(btrim(l.state), '') AS estado, ${CANON} AS tipo,
            am.value::numeric AS monto, f.filed_at AS fecha
       FROM corpus.loans l
       JOIN corpus.filings f ON f.accession = l.accession
       JOIN corpus.facts am ON am.loan_id = l.id AND am.metric_key = 'loan_amount'
                           AND am.value ~ '^[0-9.]+$' AND am.value::numeric > 0
      WHERE nullif(btrim(l.state), '') IS NOT NULL
        AND l.property_type IS NOT NULL AND f.filed_at IS NOT NULL
   ),
   conteo AS (
     SELECT a.id, count(b.id) AS comps
       FROM base a
       LEFT JOIN base b
         ON b.id <> a.id
        AND b.estado = a.estado
        AND b.tipo = a.tipo
        AND b.monto BETWEEN a.monto * ${1 - BANDA_TAMANO} AND a.monto * ${1 + BANDA_TAMANO}
        AND b.fecha BETWEEN a.fecha - interval '${MESES} months'
                        AND a.fecha + interval '${MESES} months'
      GROUP BY a.id
   )
   SELECT count(*)::text AS n,
          percentile_disc(0.10) WITHIN GROUP (ORDER BY comps)::text AS p10,
          percentile_disc(0.25) WITHIN GROUP (ORDER BY comps)::text AS p25,
          percentile_disc(0.50) WITHIN GROUP (ORDER BY comps)::text AS p50,
          percentile_disc(0.75) WITHIN GROUP (ORDER BY comps)::text AS p75,
          percentile_disc(0.90) WITHIN GROUP (ORDER BY comps)::text AS p90,
          count(*) FILTER (WHERE comps < ${MIN_UTIL})::text AS inutiles,
          count(*) FILTER (WHERE comps >= ${MIN_UTIL} AND comps < ${MIN_BUENO})::text AS finos,
          count(*) FILTER (WHERE comps >= ${MIN_BUENO})::text AS buenos
     FROM conteo`,
);
const d = dist[0]!;
const n = Number(d.n);

console.log(`\n${"═".repeat(78)}`);
console.log(`Cada préstamo como consulta — ${num(n)} consultas, ninguna elegida`);
console.log(`${"═".repeat(78)}\n`);
console.log(
  `  \x1b[90mComparable = mismo estado y tipo, ±${pct(BANDA_TAMANO, 0)} de monto, ±${MESES} meses.\x1b[0m\n`,
);
console.log(`  cuántos comparables encuentra una consulta típica`);
console.log(`  ${"─".repeat(58)}`);
console.log(
  `     p10 ${String(d.p10).padStart(5)}   p25 ${String(d.p25).padStart(5)}   ` +
    `\x1b[1mp50 ${String(d.p50).padStart(5)}\x1b[0m   p75 ${String(d.p75).padStart(5)}   ` +
    `p90 ${String(d.p90).padStart(5)}`,
);

const inut = Number(d.inutiles), fin = Number(d.finos), bue = Number(d.buenos);
console.log(`\n  menos de ${MIN_UTIL} comparables     ${num(inut).padStart(7)}   ${pct(inut / n).padStart(6)}  \x1b[90mno es una respuesta\x1b[0m`);
console.log(`  entre ${MIN_UTIL} y ${MIN_BUENO}               ${num(fin).padStart(7)}   ${pct(fin / n).padStart(6)}  \x1b[90malcanza para una mediana, no para un rango\x1b[0m`);
console.log(`  ${MIN_BUENO} o más              ${num(bue).padStart(7)}   ${pct(bue / n).padStart(6)}  \x1b[90mmediana y rango intercuartil\x1b[0m`);

console.log(
  `\n  ${
    bue / n > 0.5
      ? `\x1b[32mHay producto.\x1b[0m ${pct(bue / n)} de las consultas encuentran ${MIN_BUENO}+ comparables.`
      : bue / n + fin / n > 0.5
        ? `\x1b[33mHay producto angosto.\x1b[0m Solo ${pct(bue / n)} llega a ${MIN_BUENO}+, pero ` +
          `${pct((bue + fin) / n)} pasa de ${MIN_UTIL}.`
        : `\x1b[31mNo hay producto de comps con este corpus.\x1b[0m ${pct(inut / n)} de las ` +
          `consultas encuentran menos de ${MIN_UTIL}.`
  }`,
);

// ---------------------------------------------------------------------------
// 3. Dónde sí y dónde no
// ---------------------------------------------------------------------------

/**
 * El promedio esconde la forma. Si el producto funciona solo en multifamily de
 * Texas, eso es un producto distinto de uno que funciona en todos lados.
 */
const { rows: porTipo } = await query<{
  tipo: string; n: string; p50: string; buenos: string;
}>(
  `WITH base AS (
     SELECT l.id, nullif(btrim(l.state), '') AS estado, ${CANON} AS tipo,
            am.value::numeric AS monto, f.filed_at AS fecha
       FROM corpus.loans l
       JOIN corpus.filings f ON f.accession = l.accession
       JOIN corpus.facts am ON am.loan_id = l.id AND am.metric_key = 'loan_amount'
                           AND am.value ~ '^[0-9.]+$' AND am.value::numeric > 0
      WHERE nullif(btrim(l.state), '') IS NOT NULL
        AND l.property_type IS NOT NULL AND f.filed_at IS NOT NULL
   ),
   conteo AS (
     SELECT a.id, a.tipo, count(b.id) AS comps
       FROM base a
       LEFT JOIN base b
         ON b.id <> a.id AND b.estado = a.estado AND b.tipo = a.tipo
        AND b.monto BETWEEN a.monto * ${1 - BANDA_TAMANO} AND a.monto * ${1 + BANDA_TAMANO}
        AND b.fecha BETWEEN a.fecha - interval '${MESES} months'
                        AND a.fecha + interval '${MESES} months'
      GROUP BY a.id, a.tipo
   )
   SELECT tipo, count(*)::text AS n,
          percentile_disc(0.50) WITHIN GROUP (ORDER BY comps)::text AS p50,
          count(*) FILTER (WHERE comps >= ${MIN_BUENO})::text AS buenos
     FROM conteo GROUP BY tipo ORDER BY count(*) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("Por tipo de propiedad — el promedio esconde la forma");
console.log(`${"─".repeat(78)}\n`);
console.log(`  tipo               préstamos   comps p50   con ${MIN_BUENO}+`);
console.log(`  ${"─".repeat(56)}`);
for (const r of porTipo) {
  const nn = Number(r.n), bb = Number(r.buenos);
  console.log(
    `  ${r.tipo.padEnd(18)} ${num(nn).padStart(9)} ${String(r.p50).padStart(11)}   ` +
      `${pct(bb / Math.max(1, nn)).padStart(6)}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Y si hay comps, ¿qué se puede decir de ellos?
// ---------------------------------------------------------------------------

/**
 * Contar comparables no alcanza: si los términos no varían entre ellos, la
 * respuesta "el DSCR típico es 1,45x" es cierta y no informa. Se mide la
 * dispersión de lo que el broker vendría a preguntar.
 */
const { rows: metricas } = await query<{
  metrica: string; n: string; p25: string; p50: string; p75: string;
}>(
  `SELECT fa.metric_key AS metrica, count(*)::text AS n,
          round(percentile_cont(0.25) WITHIN GROUP (ORDER BY fa.value::numeric)::numeric, 3)::text AS p25,
          round(percentile_cont(0.50) WITHIN GROUP (ORDER BY fa.value::numeric)::numeric, 3)::text AS p50,
          round(percentile_cont(0.75) WITHIN GROUP (ORDER BY fa.value::numeric)::numeric, 3)::text AS p75
     FROM corpus.facts fa
    WHERE fa.metric_key IN ('dscr', 'ltv', 'debt_yield', 'interest_rate')
      AND fa.value ~ '^[0-9.]+$' AND fa.value::numeric > 0 AND fa.value::numeric < 20
    GROUP BY 1 ORDER BY count(*) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("Los términos que el broker vendría a preguntar");
console.log(`${"─".repeat(78)}\n`);
console.log(`  métrica          observaciones      p25 · mediana · p75`);
console.log(`  ${"─".repeat(56)}`);
for (const r of metricas) {
  console.log(
    `  ${r.metrica.padEnd(16)} ${num(Number(r.n)).padStart(11)}      ` +
      `${r.p25.padStart(6)} · ${r.p50.padStart(6)} · ${r.p75.padStart(6)}`,
  );
}
console.log(
  `\n  \x1b[90mSi el rango intercuartil es angosto, la respuesta es cierta y no informa:\x1b[0m`,
);
console.log(
  `  \x1b[90mtodos los préstamos conduit se parecen y el broker ya lo sabe. Lo que hace\x1b[0m`,
);
console.log(
  `  \x1b[90mútil un comp es que su cohorte tenga dispersión y la suya caiga en un lado.\x1b[0m`,
);

console.log(
  `\n  \x1b[33mLímite estructural que hay que decir en el producto:\x1b[0m \x1b[90meste corpus es\x1b[0m`,
);
console.log(
  `  \x1b[90mSOLO conduit CMBS. No tiene préstamos de bancos, agencias, deuda puente ni\x1b[0m`,
);
console.log(
  `  \x1b[90mvida. Un broker que compara contra esto compara contra un canal, no contra\x1b[0m`,
);
console.log(`  \x1b[90mel mercado.\x1b[0m`);

const estado = await estadoCorpus();
await closePool();
console.log(`\n\x1b[90m  ${estampa(estado)}\x1b[0m\n`);

/**
 * ¿Alcanza la cohorte para servir de referencia?
 *
 *   npm run db:cohort
 *   npm run db:cohort -- --anada 2025
 *
 * LA PREGUNTA
 *
 * `db:stability` cerró la referencia pooled: 6 de 7 métricas se desplazan más
 * del 20% entre añadas y condicionar por plazo no lo arregla. La referencia
 * tiene que ser contra la COHORTE — las emisiones del mismo año.
 *
 * Eso además es lo que un usuario quiere: nadie pregunta si su deal de 2026 se
 * aparta de 2013, pregunta si se aparta de lo que se está originando ahora.
 *
 * Pero una cohorte sirve de referencia solo si tiene suficientes emisiones
 * PARES. Comparar una emisión contra su cohorte significa compararla contra las
 * OTRAS, y si son ocho, "se aparta del mercado" es una afirmación sobre ocho
 * documentos.
 *
 * QUÉ SE MIDE, Y POR QUÉ EN ESTE ORDEN
 *
 *   1. cuántas emisiones tiene la cohorte      → cuántos pares hay
 *   2. cuántos préstamos aporta cada una       → si una domina el agregado
 *   3. concentración                            → una emisión de 90 préstamos
 *                                                 sobre 900 mueve la mediana
 *   4. cobertura contra el mercado              → cuánto del universo tenemos
 *
 * El paso 3 es el que más se olvida: si dos emisiones grandes son el 40% de la
 * cohorte, la "referencia de mercado" es en buena medida esas dos, y una
 * emisión parecida a ellas va a parecer normal por construcción.
 *
 * NO ES UN ANÁLISIS DE MERCADO
 *
 * Es la medición previa que decide si el benchmark se puede construir. Igual
 * que el piso de ruido antes del efecto, y que el piloto de historia antes de
 * bajar 1.500 documentos.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const aFlag = process.argv.indexOf("--anada");
const ANADA = aFlag === -1 ? null : Number(process.argv[aFlag + 1]);

/**
 * Fijados antes de ver nada.
 *
 * MIN_PARES sale de una cuenta simple: para decir que una emisión está en el
 * decil superior de algo hacen falta al menos diez pares, y para que ese decil
 * no dependa de un solo documento, bastante más. Quince es el piso donde la
 * afirmación "está entre las más agresivas de su cohorte" empieza a significar
 * algo.
 */
const MIN_PARES = 15;
/**
 * Cuánto puede pesar el top-2 por encima de su piso antes de llamarlo concentrado.
 *
 * No es un porcentaje del total: es un múltiplo de 2/N, que es lo que pesarían las
 * dos más grandes si todos los pools fueran iguales. 1,6x significa que las dos
 * más grandes se llevan un 60% más de lo que les tocaría.
 */
const EXCESO_MAXIMO = 1.6;

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

console.log(`\n${"═".repeat(78)}`);
console.log("¿Alcanza la cohorte para ser referencia?");
console.log(`${"═".repeat(78)}`);

const { rows: cohortes } = await query<{
  anada: string; emisiones: string; prestamos: string;
  mediana_pool: string; top2: string;
}>(
  `WITH por_emision AS (
     SELECT extract(year FROM f.filed_at)::int AS anada,
            f.accession, count(l.id) AS pool
       FROM corpus.filings f
       JOIN corpus.loans l ON l.accession = f.accession
      WHERE f.filed_at IS NOT NULL
      GROUP BY 1, 2
   ),
   rankeado AS (
     SELECT *, row_number() OVER (PARTITION BY anada ORDER BY pool DESC) AS rn,
            sum(pool) OVER (PARTITION BY anada) AS total
       FROM por_emision
   )
   SELECT anada::text,
          count(*)::text AS emisiones,
          sum(pool)::text AS prestamos,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY pool)::text AS mediana_pool,
          (sum(pool) FILTER (WHERE rn <= 2)::numeric / nullif(max(total), 0))::text AS top2
     FROM rankeado
    GROUP BY anada
    ORDER BY anada DESC`,
);

console.log(`\n  añada   emisiones   préstamos   pool mediano   top-2 del total`);
console.log(`  ${"─".repeat(64)}`);

for (const c of cohortes) {
  const em = Number(c.emisiones);
  const top2 = Number(c.top2);
  const suficiente = em - 1 >= MIN_PARES;

  /**
   * EL TOP-2 SE COMPARA CONTRA SU PISO, NO CONTRA UN NÚMERO FIJO.
   *
   * La versión anterior marcaba `top2 > 0,3` sin mirar cuántas emisiones tiene
   * la añada. Pero el top-2 de N emisiones tiene un piso de 2/N incluso con
   * pools perfectamente iguales: con 6 emisiones el piso es 33%, con 3 es 67%.
   * O sea que para cualquier añada de 6 o menos la marca se encendía siempre,
   * tuviera o no concentración real. Un test que no puede no disparar no informa.
   *
   * Es la misma clase de error que el "50% fuera del rango intercuartil" de
   * `db:page --todas`: el observado y el valor de referencia coincidían por
   * construcción y lo leí como hallazgo.
   *
   * El cociente contra el piso sí es comparable entre añadas: 1,0 significa
   * pools del mismo tamaño y 2,0 que las dos más grandes pesan el doble de lo
   * que les tocaría. El umbral se aplica ahí.
   */
  /**
   * El piso se topea en 1: con una o dos emisiones el top-2 ES el total.
   *
   * La primera versión calculaba 2/N sin tope e imprimía "piso 200%" para las
   * añadas de una sola emisión, con un exceso de 0,50x. Un piso mayor al 100% no
   * existe, y el cociente contra él invierte el sentido: la añada más concentrada
   * posible aparecía como la menos.
   *
   * Arreglando una clase B introduje una clase A en la misma línea.
   */
  const piso = Math.min(1, 2 / Math.max(1, em));
  const exceso = top2 / piso;
  /** Con 2 o menos emisiones el cociente es siempre 1,0: no hay nada que medir. */
  const medible = em > 2;
  const concentrada = medible && exceso > EXCESO_MAXIMO;

  console.log(
    `  ${c.anada}   ${String(em).padStart(9)}   ${String(c.prestamos).padStart(9)}   ` +
      `${Number(c.mediana_pool).toFixed(0).padStart(12)}   ` +
      `${(concentrada ? "\x1b[31m" : "\x1b[90m")}${pct(top2).padStart(7)}\x1b[0m` +
      ` \x1b[90m(piso ${pct(piso)}${medible ? `, ${exceso.toFixed(2)}x` : ", sin medir"})\x1b[0m` +
      (suficiente ? "  \x1b[32m✓\x1b[0m" : `  \x1b[31m← ${em - 1} pares\x1b[0m`),
  );
}

console.log(
  `\n  \x1b[90mUna emisión se compara contra las OTRAS de su añada: con ${MIN_PARES} pares\x1b[0m`,
);
console.log(
  `  \x1b[90mmínimos, "está entre las más agresivas de su cohorte" significa algo.\x1b[0m`,
);
console.log(
  `  \x1b[90mEl top-2 se compara contra su piso de 2/N, no contra un porcentaje fijo: con\x1b[0m`,
);
console.log(
  `  \x1b[90m6 emisiones el piso ya es 33% aunque los pools sean iguales. Se marca arriba\x1b[0m`,
);
console.log(
  `  \x1b[90mde ${EXCESO_MAXIMO}x el piso, que sí significa que la referencia son esas dos.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// La cohorte viva, en detalle
// ---------------------------------------------------------------------------

const objetivo = ANADA ?? Number(cohortes[0]?.anada ?? new Date().getFullYear());

const { rows: emisiones } = await query<{
  nombre: string; pool: string; con_dscr: string; con_ltv: string; mes: string;
}>(
  `SELECT left(f.company_name, 34) AS nombre,
          count(l.id)::text AS pool,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM corpus.facts x WHERE x.loan_id = l.id AND x.metric_key = 'dscr'
          ))::text AS con_dscr,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM corpus.facts x WHERE x.loan_id = l.id AND x.metric_key = 'ltv'
          ))::text AS con_ltv,
          to_char(f.filed_at, 'MM') AS mes
     FROM corpus.filings f
     JOIN corpus.loans l ON l.accession = f.accession
    WHERE extract(year FROM f.filed_at) = $1
    GROUP BY f.company_name, f.accession, f.filed_at
    ORDER BY f.filed_at`,
  [objetivo],
);

console.log(`\n${"─".repeat(78)}`);
console.log(`La cohorte ${objetivo} en detalle`);
console.log(`${"─".repeat(78)}\n`);

if (emisiones.length === 0) {
  console.log(`  \x1b[33mSin emisiones en ${objetivo}.\x1b[0m\n`);
} else {
  console.log(`  mes   emisión                              pool   DSCR    LTV`);
  console.log(`  ${"─".repeat(66)}`);
  for (const e of emisiones) {
    const pool = Number(e.pool);
    console.log(
      `  ${e.mes}    ${e.nombre.padEnd(36)} ${String(pool).padStart(5)}  ` +
        `${pct(Number(e.con_dscr) / pool).padStart(5)}  ${pct(Number(e.con_ltv) / pool).padStart(5)}`,
    );
  }

  /**
   * La cobertura mensual importa para un benchmark en vivo.
   *
   * Si la cohorte tiene doce emisiones pero todas de enero a marzo, una emisión
   * de agosto se compara contra un mercado de hace medio año — que en este
   * período, con la tasa moviéndose, no es el mismo mercado.
   */
  const meses = new Set(emisiones.map((e) => e.mes));
  console.log(
    `\n  \x1b[90m${emisiones.length} emisiones en ${meses.size} meses distintos.\x1b[0m` +
      (meses.size < 4
        ? `  \x1b[33m← concentradas en el tiempo\x1b[0m`
        : ""),
  );
}

console.log(
  `\n  \x1b[90mFalta el denominador que este corpus no tiene: cuántas emisiones hubo\x1b[0m`,
);
console.log(
  `  \x1b[90mrealmente en el año. Sin eso, "tenemos N" no dice si es mucho o poco, y\x1b[0m`,
);
console.log(
  `  \x1b[90mes lo primero a resolver antes de prometerle cobertura a nadie.\x1b[0m\n`,
);

await closePool();

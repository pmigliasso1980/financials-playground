/**
 * Los 790 préstamos con estado vacío: qué son.
 *
 *   npm run db:sin-estado
 *
 * POR QUÉ HACE FALTA PREGUNTARLO
 *
 * `db:fix-estados` recuperó 1.107 préstamos que tenían el nombre del estado escrito
 * completo. Quedan 790 con la celda VACÍA, y ahí no hay nada que mapear: no es un
 * problema de formato, es que el dato no está.
 *
 * La sospecha era carteras multi-estado —un préstamo sobre propiedades en cinco
 * estados no tiene UN estado— y hay un indicio a favor que apareció solo: entre los
 * valores raros el monitor encontró un `"Various Various"` literal. Un indicio no es
 * una prueba, y ya me equivoqué prediciendo con menos evidencia que ésta.
 *
 * LAS DOS EXPLICACIONES SE DISTINGUEN BARATO
 *
 * Si son carteras, están REPARTIDAS: toda emisión conduit tiene alguna, así que
 * deberían aparecer de a poco en casi todos los filings.
 *
 * Si es un defecto del parser, están AMONTONADAS en pocos filings, que es
 * exactamente la forma que tuvo el agujero de `property_type` —donde una emisión,
 * BBCMS 2022-C17, explicaba sola una porción enorme—.
 *
 * La concentración es el discriminador, y no depende de que yo acierte cuál es.
 *
 * LO QUE SE MIDE ADEMÁS
 *
 * `property_count > 1` es la prueba directa de multi-propiedad, la misma que usó
 * `db:type-gap`. Y si la explicación es la cartera, la ciudad y el código postal
 * tienen que faltar TAMBIÉN: una cartera en cinco estados tampoco tiene una ciudad.
 * Si la ciudad está y el estado no, la explicación es otra y es del parser.
 *
 * ESTO NO ARREGLA NADA
 *
 * Es un diagnóstico de una corrida, no un script para tener. Si la respuesta es
 * "carteras", el arreglo no es completar el estado sino que `/comps` sepa que
 * existen; si es el parser, el arreglo es el parser.
 */

import { closePool, ping, query } from "./client.js";
import { CODIGOS } from "../harvest/normalize/estados.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const codigos = [...CODIGOS];
/** Vacío de verdad, no "escrito raro": los raros ya los arregló db:fix-estados. */
const VACIO = `(l.state IS NULL OR btrim(l.state) = '')`;

console.log(`\n${"═".repeat(78)}`);
console.log("Préstamos con el estado vacío: ¿carteras o defecto del parser?");
console.log(`${"═".repeat(78)}\n`);

const { rows: tot } = await query<{ vacios: string; total: string; invalidos: string }>(
  `SELECT count(*) FILTER (WHERE ${VACIO})::text AS vacios,
          count(*)::text AS total,
          count(*) FILTER (WHERE l.state IS NOT NULL AND btrim(l.state) <> ''
                             AND NOT (btrim(l.state) = ANY($1)))::text AS invalidos
     FROM corpus.loans l`,
  [codigos],
);
const vacios = Number(tot[0]!.vacios);
if (vacios === 0) {
  console.log(`  No quedan préstamos con el estado vacío.\n`);
  await closePool();
  process.exit(0);
}
console.log(
  `  ${vacios} vacíos de ${Number(tot[0]!.total).toLocaleString("en-US")} préstamos` +
    `  ·  ${tot[0]!.invalidos} más con un valor que no es un estado\n`,
);

/**
 * EL DISCRIMINADOR.
 *
 * Se compara contra el total de emisiones del corpus, no contra un umbral elegido:
 * lo que importa es qué porción de los filings tiene al menos uno.
 */
const { rows: conc } = await query<{
  emisiones_con: string; emisiones_total: string; top5: string; mediana: string;
}>(
  `WITH por_filing AS (
     SELECT l.accession, count(*) FILTER (WHERE ${VACIO}) AS vacios
       FROM corpus.loans l GROUP BY 1
   )
   SELECT count(*) FILTER (WHERE vacios > 0)::text AS emisiones_con,
          count(*)::text                            AS emisiones_total,
          (SELECT sum(vacios) FROM (
             SELECT vacios FROM por_filing ORDER BY vacios DESC LIMIT 5) t)::text AS top5,
          (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY vacios)
             FROM por_filing WHERE vacios > 0)::text AS mediana
     FROM por_filing`,
);
const con = Number(conc[0]!.emisiones_con);
const totalEm = Number(conc[0]!.emisiones_total);
const top5 = Number(conc[0]!.top5);

console.log(`  \x1b[1mConcentración\x1b[0m`);
console.log(
  `    ${con} de ${totalEm} emisiones (${((con / totalEm) * 100).toFixed(0)}%) tienen al menos uno`,
);
console.log(
  `    las 5 peores explican ${top5} de ${vacios} (${((top5 / vacios) * 100).toFixed(0)}%)` +
    `  ·  mediana por emisión afectada: ${conc[0]!.mediana}`,
);

const repartido = con / totalEm >= 0.5 && top5 / vacios <= 0.35;
const amontonado = top5 / vacios >= 0.5;
console.log(
  repartido
    ? `    \x1b[32m→ repartido: compatible con carteras, no con un defecto de formato\x1b[0m`
    : amontonado
      ? `    \x1b[33m→ amontonado: pocas emisiones explican la mayoría — mirá cuáles abajo\x1b[0m`
      : `    \x1b[33m→ mezcla: ni repartido ni concentrado, probablemente las dos cosas\x1b[0m`,
);

/**
 * La prueba directa. Si son carteras, `property_count > 1`; y la ciudad tiene que
 * faltar también, porque una cartera en cinco estados tampoco tiene una ciudad.
 *
 * La fila que decide es la última: estado vacío CON ciudad presente no puede ser
 * una cartera. Eso es el parser perdiendo una columna.
 */
const { rows: ev } = await query<Record<string, string>>(
  `SELECT count(*)::text                                                    AS n,
          count(pc.value) FILTER (WHERE pc.value::numeric > 1)::text        AS multi,
          count(pc.value)::text                                             AS con_count,
          count(*) FILTER (WHERE l.city IS NULL OR btrim(l.city) = '')::text AS sin_ciudad,
          count(*) FILTER (WHERE l.city IS NOT NULL AND btrim(l.city) <> '')::text AS con_ciudad,
          count(*) FILTER (WHERE lower(btrim(coalesce(l.city, ''))) LIKE 'various%')::text AS ciudad_various,
          count(*) FILTER (WHERE l.property_type IS NULL)::text             AS sin_tipo
     FROM corpus.loans l
     LEFT JOIN corpus.facts pc
            ON pc.loan_id = l.id AND pc.metric_key = 'property_count'
           AND pc.value ~ '^[0-9.]+$'
    WHERE ${VACIO}`,
);
const e = ev[0]!;
const linea = (etiqueta: string, n: string, sobre = vacios) =>
  console.log(
    `    ${etiqueta.padEnd(34)} ${String(n).padStart(5)}  ` +
      `\x1b[90m${((Number(n) / sobre) * 100).toFixed(0)}%\x1b[0m`,
  );

console.log(`\n  \x1b[1mQué tienen esos préstamos\x1b[0m`);
linea("tienen property_count", e.con_count!);
linea("property_count > 1 (multi-propiedad)", e.multi!);
linea("tampoco tienen ciudad", e.sin_ciudad!);
linea("la ciudad dice 'Various'", e.ciudad_various!);
linea("tampoco tienen tipo de propiedad", e.sin_tipo!);
console.log(
  `\n    \x1b[1mtienen ciudad pero no estado: ${e.con_ciudad}\x1b[0m` +
    `  \x1b[90m← una cartera multi-estado no puede tener UNA ciudad;\x1b[0m`,
);
console.log(`    \x1b[90m   estos son el parser perdiendo la columna, no el mercado\x1b[0m`);

/**
 * EL PUNTO CIEGO DEL DISCRIMINADOR DE ARRIBA.
 *
 * "Repartido entre 214 de 233 emisiones" descarta que UNA emisión rota explique
 * todo. No descarta que un AÑO esté roto: si el formato de 2020 pierde la columna,
 * las cuarenta emisiones de 2020 lo tienen y el reparto se ve igual de sano.
 *
 * La primera corrida mostró siete de las ocho peores emisiones en 2020, y ese dato
 * mi test no lo miraba. Así que la tasa se mide por año.
 */
const { rows: anios } = await query<{ anio: string; vacios: string; de: string; emisiones: string }>(
  `SELECT to_char(f.filed_at, 'YYYY') AS anio,
          count(*) FILTER (WHERE ${VACIO})::text AS vacios,
          count(*)::text                          AS de,
          count(DISTINCT l.accession)::text       AS emisiones
     FROM corpus.loans l JOIN corpus.filings f ON f.accession = l.accession
    GROUP BY 1 ORDER BY 1`,
);
console.log(`\n  \x1b[1mTasa por año de emisión\x1b[0m`);
const tasas = anios.map((a) => Number(a.vacios) / Math.max(1, Number(a.de)));
const mediaTasa = tasas.reduce((t, v) => t + v, 0) / Math.max(1, tasas.length);
for (const [i, a] of anios.entries()) {
  const t = tasas[i]!;
  /** El doble de la media es arbitrario, pero se dice en vez de esconderse. */
  const alto = t >= mediaTasa * 2;
  const barra = "█".repeat(Math.round(t * 60));
  console.log(
    `    ${a.anio}  ${String(a.vacios).padStart(4)} de ${String(a.de).padStart(5)}` +
      `  ${(t * 100).toFixed(1).padStart(5)}%  ${alto ? "\x1b[33m" : "\x1b[90m"}${barra}\x1b[0m` +
      (alto ? `  \x1b[33m← más del doble de la media (${(mediaTasa * 100).toFixed(1)}%)\x1b[0m` : ""),
  );
}

/**
 * LA CONSULTA QUE DECIDE.
 *
 * Para cada emisión con muchos vacíos: ¿esos préstamos tienen `property_count > 1`?
 *
 * Si lo tienen, son carteras de verdad y la tasa alta es de la emisión, no del
 * parser. Si NO lo tienen, el Annex A trae el dato y nosotros lo perdimos.
 *
 * Es la misma pregunta que el agregado ya contestó al 74%, pero hecha donde el
 * agregado no puede: en la cola. Un promedio sano convive con una emisión rota.
 */
const { rows: peores } = await query<{
  empresa: string; accession: string; n: string; de: string; multi: string;
}>(
  `SELECT f.company_name AS empresa, l.accession,
          count(*) FILTER (WHERE ${VACIO})::text AS n,
          count(*)::text                          AS de,
          count(*) FILTER (WHERE ${VACIO} AND pc.value IS NOT NULL
                             AND pc.value::numeric > 1)::text AS multi
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.facts pc
            ON pc.loan_id = l.id AND pc.metric_key = 'property_count'
           AND pc.value ~ '^[0-9.]+$'
    GROUP BY 1, 2 HAVING count(*) FILTER (WHERE ${VACIO}) > 0
    ORDER BY count(*) FILTER (WHERE ${VACIO}) DESC LIMIT 10`,
);
console.log(`\n  \x1b[1mEmisiones con más vacíos — y si esos préstamos son carteras\x1b[0m`);
let sospechosas = 0;
for (const p of peores) {
  const n = Number(p.n);
  const multi = Number(p.multi);
  const share = multi / Math.max(1, n);
  /**
   * Si menos de la mitad de los vacíos de una emisión tiene property_count > 1, la
   * explicación de cartera no alcanza para esa emisión.
   */
  const sospechosa = share < 0.5;
  if (sospechosa) sospechosas++;
  console.log(
    `    ${p.empresa.slice(0, 40).padEnd(42)} ${String(n).padStart(3)}/${String(p.de).padEnd(3)}` +
      `  \x1b[${sospechosa ? "33" : "32"}m${multi} son cartera (${(share * 100).toFixed(0)}%)\x1b[0m` +
      ` \x1b[90m${p.accession}\x1b[0m`,
  );
}

console.log(
  sospechosas === 0
    ? `\n  \x1b[32mNinguna emisión de la cola se explica por el parser: todas son carteras.\x1b[0m`
    : `\n  \x1b[33m${sospechosas} emisión(es) donde la mayoría de los vacíos NO son carteras.\x1b[0m\n` +
        `  \x1b[33mAhí el Annex A trae el estado y lo estamos perdiendo.\x1b[0m`,
);

/**
 * LAS DOS POBLACIONES, QUE ES LA RESPUESTA DE VERDAD.
 *
 * La corrida anterior dio 585 de 790 con `property_count > 1` y las diez emisiones
 * de la cola en 0%. Eso no es contradictorio: son dos grupos distintos sumados.
 *
 *   con property_count  → cartera multi-propiedad. El Annex A dice cuántas
 *                         propiedades hay y no dice un estado porque no hay UNO.
 *                         El dato no falta: no existe.
 *
 *   sin property_count  → no sabemos ni cuántas propiedades tiene. Si además le
 *                         falta el tipo, no perdimos una columna: perdimos el
 *                         bloque de características de la propiedad entero.
 *
 * La confirmación es que los dos huecos coincidan en las mismas filas. Si los 205
 * sin conteo son casi los mismos que los que no tienen tipo, el agujero de
 * `property_type` —el ítem #37— y éste son EL MISMO DEFECTO mirado por dos lados, y
 * arreglarlo cuenta dos veces.
 */
const { rows: pob } = await query<Record<string, string>>(
  `WITH v AS (
     SELECT l.id, l.accession, l.property_type,
            (SELECT value FROM corpus.facts
              WHERE loan_id = l.id AND metric_key = 'property_count'
                AND value ~ '^[0-9.]+$' LIMIT 1) AS pc
       FROM corpus.loans l WHERE ${VACIO}
   )
   SELECT count(*) FILTER (WHERE pc IS NOT NULL)::text                          AS cartera,
          count(*) FILTER (WHERE pc IS NULL)::text                              AS ciega,
          count(*) FILTER (WHERE pc IS NULL AND property_type IS NULL)::text     AS ciega_sin_tipo,
          count(*) FILTER (WHERE pc IS NOT NULL AND property_type IS NULL)::text AS cartera_sin_tipo,
          count(DISTINCT accession) FILTER (WHERE pc IS NULL)::text              AS emisiones_ciegas
     FROM v`,
);
const b = pob[0]!;
const ciega = Number(b.ciega);
console.log(`\n  \x1b[1mLas dos poblaciones\x1b[0m`);
console.log(
  `    \x1b[32m${b.cartera} carteras multi-propiedad\x1b[0m` +
    `  \x1b[90m— el Annex A dice cuántas propiedades hay; no hay UN estado que poner\x1b[0m`,
);
console.log(
  `    \x1b[33m${ciega} sin conteo de propiedades\x1b[0m` +
    `  \x1b[90m— en ${b.emisiones_ciegas} emisiones; de ésos, ${b.ciega_sin_tipo} tampoco tienen tipo\x1b[0m`,
);
const solapa = Number(b.ciega_sin_tipo) / Math.max(1, ciega);
console.log(
  solapa >= 0.8
    ? `\n  \x1b[33mEl ${(solapa * 100).toFixed(0)}% de los ciegos tampoco tiene tipo: no perdimos una\x1b[0m\n` +
        `  \x1b[33mcolumna, perdimos el bloque de características entero. Este agujero y el\x1b[0m\n` +
        `  \x1b[33mde property_type (#37) son el mismo defecto por dos lados.\x1b[0m`
    : `\n  \x1b[90mSolo el ${(solapa * 100).toFixed(0)}% de los ciegos carece también de tipo: los dos\x1b[0m\n` +
        `  \x1b[90mhuecos no coinciden, así que son defectos distintos y hay que atacarlos aparte.\x1b[0m`,
);

/**
 * LO QUE DESCARTAMOS AL COSECHAR, QUE ES DONDE ESTÁ LA GEOGRAFÍA QUE FALTA.
 *
 * Dije en voz alta que las carteras "no se arreglan cosechando" porque el Annex A
 * no trae un estado para ellas. Es falso, y conviene dejarlo escrito.
 *
 * El Annex A trae DOS clases de fila: una por préstamo y una por cada propiedad que
 * lo garantiza. Un préstamo sobre cinco propiedades tiene su fila con el saldo y
 * cinco filas más con la dirección, la ciudad y el estado de cada una. El harvester
 * clasifica, se queda con las de préstamo y descarta las de propiedad — en el
 * fixture de Benchmark 2020-B16 son 50 descartadas sobre 33 préstamos.
 *
 * O sea que el estado de las 585 carteras no falta en el documento. Lo tenemos
 * delante y lo tiramos. Y no hay tabla donde ponerlo: el esquema tiene filings,
 * loans, observations, facts, performance, delinquency y unmapped_cells, ninguna de
 * propiedades.
 *
 * CÓMO SE MIDE, Y UN PROXY QUE NO MEDÍA NADA
 *
 * La primera versión lo estimaba por resta sobre `stats`: filas de datos menos
 * préstamos guardados. Dio ~0 y por un momento me lo creí.
 *
 * Estaba mal por construcción. `keepLoanRows` corre en `batch.ts` ANTES de
 * `rowsToObservations`, así que `dataRows` ya cuenta solo las filas que
 * sobrevivieron el filtro. La resta medía los subtotales que se caen después, no
 * las propiedades. Un número con dos decimales de confianza sobre la pregunta
 * equivocada, que casi cierra una línea de investigación correcta.
 *
 * Ahora el harvester lo registra de verdad en `stats.propertyRowsDropped`. Las 233
 * emisiones ya cosechadas no lo tienen, así que hasta la próxima cosecha esto
 * muestra la cota que sale de los tres fixtures —138 filas de propiedad sobre 84
 * préstamos— y dice que es una extrapolación.
 */
const { rows: desc } = await query<{ con: string; tiradas: string; de: string }>(
  `SELECT count(*) FILTER (WHERE stats->>'propertyRowsDropped' IS NOT NULL)::text AS con,
          coalesce(sum((stats->>'propertyRowsDropped')::int), 0)::text            AS tiradas,
          count(*)::text                                                          AS de
     FROM corpus.filings`,
);
const d = desc[0]!;
console.log(`\n  \x1b[1mFilas de propiedad descartadas al cosechar\x1b[0m`);
if (Number(d.con) === 0) {
  /** 138 filas de propiedad sobre 84 préstamos en los tres fixtures = 1,64 por préstamo. */
  const RATIO_FIXTURES = 138 / 84;
  const est = Math.round(Number(tot[0]!.total) * RATIO_FIXTURES);
  console.log(
    `    ninguna de las ${d.de} emisiones registra el conteo — se cosecharon antes de medirlo`,
  );
  console.log(
    `    \x1b[33m~${est.toLocaleString("en-US")} filas estimadas\x1b[0m` +
      `  \x1b[90mextrapolando 1,64 por préstamo desde los tres fixtures\x1b[0m`,
  );
  console.log(
    `    \x1b[90mes una extrapolación de 3 documentos a 233: sirve para decidir si vale\x1b[0m`,
  );
  console.log(`    \x1b[90mla pena medirlo en serio, no para citarla\x1b[0m`);
} else {
  console.log(
    `    \x1b[1m${Number(d.tiradas).toLocaleString("en-US")} filas\x1b[0m en ${d.con} de ${d.de} emisiones` +
      ` \x1b[90m(el resto se cosechó antes de medirlo)\x1b[0m`,
  );
}
console.log(
  `    \x1b[90mcada una trae dirección, ciudad y estado de UNA propiedad: ahí está la\x1b[0m`,
);
console.log(
  `    \x1b[90mgeografía de las ${b.cartera} carteras, y no hay tabla donde guardarla\x1b[0m`,
);

console.log(
  `\n  \x1b[90mUna cartera de cinco propiedades en Texas SÍ tiene un estado, y hoy no\x1b[0m`,
);
console.log(
  `  \x1b[90maparece en una consulta por Texas. Eso no es el mercado: es el esquema.\x1b[0m\n`,
);

await closePool();

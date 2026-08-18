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
             FROM por_filing WHERE vacios > 0)::text AS mediana`,
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

/** Las emisiones peores, para poder abrir el documento si están amontonadas. */
const { rows: peores } = await query<{ empresa: string; accession: string; n: string; de: string }>(
  `SELECT f.company_name AS empresa, l.accession,
          count(*) FILTER (WHERE ${VACIO})::text AS n, count(*)::text AS de
     FROM corpus.loans l JOIN corpus.filings f ON f.accession = l.accession
    GROUP BY 1, 2 HAVING count(*) FILTER (WHERE ${VACIO}) > 0
    ORDER BY 3::int DESC LIMIT 8`,
);
console.log(`\n  \x1b[1mEmisiones con más vacíos\x1b[0m`);
for (const p of peores) {
  console.log(
    `    ${p.empresa.slice(0, 44).padEnd(46)} ${String(p.n).padStart(4)} de ${String(p.de).padEnd(4)}` +
      ` \x1b[90m${p.accession}\x1b[0m`,
  );
}

console.log(
  `\n  \x1b[90mSi son carteras, el arreglo no es completar el estado sino que /comps sepa\x1b[0m`,
);
console.log(
  `  \x1b[90mque existen. Si es el parser, el arreglo es el parser.\x1b[0m\n`,
);

await closePool();

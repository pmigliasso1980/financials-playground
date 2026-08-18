/**
 * Los préstamos sin tipo de propiedad: qué son, antes de decidir qué hacer.
 *
 *   npm run db:type-gap
 *
 * POR QUÉ AHORA, Y POR QUÉ EMPIEZA MIRANDO EN VEZ DE ARREGLANDO
 *
 * El índice del producto muestra quince filas que dicen "34/35": préstamos que
 * existen en la emisión y no entran a la medición de composición porque no tienen
 * tipo. Dejó de ser deuda de backlog y pasó a ser una columna en la cara del
 * producto.
 *
 * La tentación es escribir el arreglo directo —completar el tipo desde otra
 * columna— pero cuál es "otra columna" depende de POR QUÉ falta, y hay al menos
 * cuatro motivos posibles que piden arreglos distintos:
 *
 *   1. El préstamo tiene varias propiedades de tipos distintos. El Annex A pone
 *      "Various" en la fila del préstamo y el tipo real en las filas de propiedad,
 *      que el harvester descarta. Acá NO hay un tipo que recuperar: el préstamo
 *      genuinamente no tiene uno, y la respuesta correcta puede ser una categoría
 *      "Varios" en vez de un null.
 *   2. La emisión usa un encabezado que el mapeo no reconoce. Se arregla en la
 *      taxonomía y recupera todos los préstamos de esa emisión de una.
 *   3. La celda está vacía en el documento. No hay nada que hacer.
 *   4. El valor existe pero cae en 'Sin clasificar' del CASE. Eso no es este
 *      script —esos préstamos SÍ tienen property_type— pero conviene contarlos al
 *      lado porque se confunden al leer.
 *
 * Los cuatro se ven distinto en los datos y el arreglo de uno no sirve para los
 * otros. Así que primero se mira.
 *
 * LA HIPÓTESIS QUE TENGO, PARA QUE QUEDE ESCRITA ANTES DEL RESULTADO
 *
 * Que sean multi-propiedad. Diecisiete préstamos repartidos en quince emisiones
 * —casi uno por emisión, sin concentrarse en ninguna— no parece un encabezado sin
 * mapear: eso daría todos los préstamos de una o dos emisiones juntos. Un
 * fenómeno raro y parejo entre documentos se parece más a una propiedad del
 * préstamo que a un defecto del parser.
 *
 * Si es eso, el arreglo NO es completar el dato: es dejar de contarlos como
 * ausencia. Y entonces la pregunta de producto pasa a ser si "Varios" es una
 * categoría de composición o una fila aparte.
 */

import { closePool, ping, query } from "./client.js";
import { estadoCorpus, estampa } from "./procedencia.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const num = (v: number) => v.toLocaleString("en-US");

console.log(`\n${"═".repeat(78)}`);
console.log("Préstamos sin tipo de propiedad");
console.log(`${"═".repeat(78)}`);

// ---------------------------------------------------------------------------
// 1. Cuántos son, y si se concentran en algún lado
// ---------------------------------------------------------------------------

const { rows: porAnada } = await query<{
  anada: string; prestamos: string; sin_tipo: string; emisiones: string; em_con_hueco: string;
}>(
  `SELECT extract(year FROM f.filed_at)::int::text AS anada,
          count(*)::text AS prestamos,
          count(*) FILTER (WHERE l.property_type IS NULL)::text AS sin_tipo,
          count(DISTINCT l.accession)::text AS emisiones,
          count(DISTINCT l.accession) FILTER (WHERE l.property_type IS NULL)::text AS em_con_hueco
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
    GROUP BY 1 ORDER BY 1`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("Por añada");
console.log(`${"─".repeat(78)}\n`);
console.log(`  añada   préstamos   sin tipo      %      emisiones con hueco`);
console.log(`  ${"─".repeat(62)}`);
let totalSin = 0;
let total = 0;
for (const r of porAnada) {
  const sin = Number(r.sin_tipo), n = Number(r.prestamos);
  totalSin += sin;
  total += n;
  console.log(
    `  ${r.anada}   ${num(n).padStart(9)} ${String(sin).padStart(10)} ${pct(sin / Math.max(1, n), 1).padStart(7)}` +
      `      ${r.em_con_hueco} de ${r.emisiones}` +
      (sin / Math.max(1, n) > 0.05 ? `  \x1b[33m← concentrado\x1b[0m` : ""),
  );
}
console.log(
  `\n  \x1b[1m${totalSin} de ${num(total)} préstamos\x1b[0m (${pct(totalSin / Math.max(1, total), 2)}) sin tipo en todo el corpus.`,
);

/**
 * La forma decide el diagnóstico.
 *
 * Si los huecos se apilan en pocas emisiones, es un encabezado sin mapear y se
 * arregla en la taxonomía. Si están repartidos de a uno, es una propiedad del
 * préstamo y la taxonomía no tiene nada que ver.
 */
const { rows: forma } = await query<{ por_emision: string; emisiones: string; max_en_una: string }>(
  `WITH x AS (
     SELECT accession, count(*) FILTER (WHERE property_type IS NULL) AS sin_tipo,
            count(*) AS n
       FROM corpus.loans GROUP BY accession
   )
   SELECT round(avg(sin_tipo) FILTER (WHERE sin_tipo > 0), 2)::text AS por_emision,
          count(*) FILTER (WHERE sin_tipo > 0)::text AS emisiones,
          max(sin_tipo)::text AS max_en_una
     FROM x`,
);
const f0 = forma[0]!;
console.log(
  `  \x1b[90mRepartidos en ${f0.emisiones} emisiones, ${f0.por_emision} por emisión en promedio, ` +
    `${f0.max_en_una} en la peor.\x1b[0m`,
);
console.log(
  Number(f0.max_en_una) <= 3
    ? `  \x1b[90mNinguna emisión concentra: no parece un encabezado sin mapear.\x1b[0m`
    : `  \x1b[33mAlguna emisión concentra ${f0.max_en_una}: ahí sí puede ser el mapeo.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 2. Qué SÍ se sabe de esos préstamos
// ---------------------------------------------------------------------------

/**
 * `property_count` es la prueba directa de la hipótesis multi-propiedad, y
 * `property_name` la indirecta: los Annex A escriben "Various" o listan varias.
 */
const { rows: quePasa } = await query<{
  total: string; con_count: string; multi: string; nombre_various: string;
  con_detalle: string; con_units: string; con_dscr: string;
}>(
  `WITH sin AS (SELECT id, property_name FROM corpus.loans WHERE property_type IS NULL)
   SELECT count(*)::text AS total,
          count(pc.value)::text AS con_count,
          count(*) FILTER (WHERE pc.value ~ '^[0-9.]+$' AND pc.value::numeric > 1)::text AS multi,
          count(*) FILTER (WHERE s.property_name ~* 'various|portfolio')::text AS nombre_various,
          count(pd.value)::text AS con_detalle,
          count(un.value)::text AS con_units,
          count(ds.value)::text AS con_dscr
     FROM sin s
     LEFT JOIN corpus.facts pc ON pc.loan_id = s.id AND pc.metric_key = 'property_count'
     LEFT JOIN corpus.facts pd ON pd.loan_id = s.id AND pd.metric_key = 'property_type_detailed'
     LEFT JOIN corpus.facts un ON un.loan_id = s.id AND un.metric_key = 'units'
     LEFT JOIN corpus.facts ds ON ds.loan_id = s.id AND ds.metric_key = 'dscr'`,
);
const q = quePasa[0]!;

console.log(`\n${"─".repeat(78)}`);
console.log("Qué se sabe de los préstamos sin tipo");
console.log(`${"─".repeat(78)}\n`);
const linea = (et: string, v: string, nota = "") =>
  console.log(
    `  ${et.padEnd(34)} ${String(v).padStart(5)} de ${q.total}` +
      `  ${pct(Number(v) / Math.max(1, Number(q.total)), 0).padStart(6)}   \x1b[90m${nota}\x1b[0m`,
  );
linea("tienen property_count", q.con_count);
linea("...y es mayor a 1", q.multi, "← multi-propiedad: no tienen UN tipo");
linea("se llaman Various / Portfolio", q.nombre_various, "la pista del nombre");
linea("tienen property_type_detailed", q.con_detalle, "← si lo tienen, se puede derivar");
linea("tienen units", q.con_units, "el resto del parseo funcionó");
linea("tienen dscr", q.con_dscr, "no son filas fantasma");

/**
 * La distinción que decide el arreglo: un préstamo multi-propiedad no tiene un
 * tipo que recuperar, y uno de una sola propiedad sin tipo sí lo perdió.
 */
console.log(
  `\n  \x1b[90mUn préstamo con varias propiedades no TIENE un tipo — el Annex A pone\x1b[0m`,
);
console.log(
  `  \x1b[90m"Various" y los tipos viven en las filas de propiedad, que se descartan.\x1b[0m`,
);
console.log(
  `  \x1b[90mAhí el arreglo no es completar el dato: es dejar de contarlo como ausencia.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 3. Las filas, una por una — son diecisiete
// ---------------------------------------------------------------------------

const { rows: detalle } = await query<{
  emision: string; loan_ref: string | null; nombre: string | null;
  count: string | null; detalle: string | null; sin_mapear: string | null;
}>(
  `SELECT f.company_name AS emision, l.loan_ref, l.property_name AS nombre,
          pc.value AS count, pd.value AS detalle,
          (SELECT string_agg(u.header, ' · ' ORDER BY u.header)
             FROM corpus.unmapped_cells u
            WHERE u.loan_id = l.id AND u.header ~* 'type|property') AS sin_mapear
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.facts pc ON pc.loan_id = l.id AND pc.metric_key = 'property_count'
     LEFT JOIN corpus.facts pd ON pd.loan_id = l.id AND pd.metric_key = 'property_type_detailed'
    WHERE l.property_type IS NULL
      AND extract(year FROM f.filed_at) = extract(year FROM now())
    ORDER BY f.company_name, l.row_index`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`Las filas de la cohorte actual — ${detalle.length}`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  emisión                        ref     props   nombre / subtipo`);
console.log(`  ${"─".repeat(72)}`);
for (const r of detalle) {
  console.log(
    `  ${(r.emision ?? "").slice(0, 30).padEnd(31)} ${(r.loan_ref ?? "—").slice(0, 6).padEnd(7)} ` +
      `${(r.count ?? "—").padStart(5)}   ` +
      `\x1b[90m${(r.detalle ?? r.nombre ?? "(sin nombre)").slice(0, 34)}\x1b[0m`,
  );
  if (r.sin_mapear) {
    console.log(`  \x1b[33m      columnas sin mapear con 'type': ${r.sin_mapear.slice(0, 60)}\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// 4. El otro agujero, que se confunde con este
// ---------------------------------------------------------------------------

/**
 * 'Sin clasificar' NO es lo mismo que sin tipo.
 *
 * Esos préstamos tienen property_type y el CASE no lo reconoce, así que entran a
 * la composición como una categoría propia y ensucian la distancia sin avisar. Se
 * cuenta al lado porque las dos cosas se leen igual en la página.
 */
const { rows: sinClasificar } = await query<{ tipo: string; n: string }>(
  `SELECT l.property_type AS tipo, count(*)::text AS n
     FROM corpus.loans l
    WHERE l.property_type IS NOT NULL
      AND l.property_type !~* 'multifamily|cooperative|garden|low rise|mid rise|student'
      AND l.property_type !~* 'retail|anchored|single tenant'
      AND l.property_type !~* 'office|cbd|suburban|medical'
      AND l.property_type !~* 'industrial|warehouse|flex'
      AND l.property_type !~* 'storage'
      AND l.property_type !~* 'hospitality|hotel|service|extended stay'
      AND l.property_type !~* 'mixed'
      AND l.property_type !~* 'manufactured'
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 15`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("Y el otro agujero: tienen tipo, pero el CASE no lo reconoce");
console.log(`${"─".repeat(78)}\n`);
if (sinClasificar.length === 0) {
  console.log(`  \x1b[32mNinguno. Todos los valores caen en alguna categoría.\x1b[0m`);
} else {
  const totalSC = sinClasificar.reduce((t, r) => t + Number(r.n), 0);
  for (const r of sinClasificar) {
    console.log(`  ${r.tipo.slice(0, 44).padEnd(46)} ${String(r.n).padStart(5)}`);
  }
  console.log(
    `\n  \x1b[33m${totalSC} préstamos entran a la composición como 'Sin clasificar'.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mNo son un hueco: son una categoría que existe y nadie decidió. Suma a la\x1b[0m`,
  );
  console.log(
    `  \x1b[90mdistancia como cualquier otra, así que dos emisiones con muchos de estos se\x1b[0m`,
  );
  console.log(`  \x1b[90mparecen entre sí por una razón que no es de negocio.\x1b[0m`);
}

const estado = await estadoCorpus();
await closePool();
console.log(`\n\x1b[90m  ${estampa(estado)}\x1b[0m\n`);

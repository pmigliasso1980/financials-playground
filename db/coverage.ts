/**
 * ¿Cuánto del informe del servicer llega al corpus?
 *
 *   npm run db:coverage
 *
 * LA PREGUNTA
 *
 * `db:predictors` y `db:delinquency` cuentan eventos sobre el pool completo de
 * cada emisión. El denominador es el pool del Annex A; el numerador son solo
 * los préstamos que pegaron por Pros ID contra el informe del servicer.
 *
 * Si el join pierde filas, la tasa baja sin que nada haya mejorado. Una emisión
 * con join del 20% aporta su pool entero abajo y un quinto de sus eventos
 * arriba, y sale del análisis pareciendo sana.
 *
 * Eso ya nos pasó de la forma más cara posible: el SIR por shelf correlacionaba
 * 0,74 con la cobertura del join. Medía el pipeline, no la suscripción.
 *
 * QUÉ SE COMPARA
 *
 * Filas de morosidad que el parser encontró en el 10-D (guardadas en
 * `servicer_reports.stats`) contra filas que efectivamente se persistieron. La
 * diferencia son préstamos morosos reales que el corpus no pudo ubicar.
 *
 * POR QUÉ ESTE NÚMERO Y NO LA COBERTURA DEL NOI
 *
 * La cobertura del NOI mezcla dos causas: el join y las filas que el servicer
 * publica sin período. BANK pierde el 99% de su NOI por lo segundo, que no
 * tiene nada que ver con el join. La morosidad no depende de fechas, así que
 * su pérdida aísla el join.
 *
 * EL UMBRAL SE FIJA ANTES DE VER LOS NÚMEROS
 *
 * Pérdida global bajo 5% y repartida: el join funciona y las diferencias entre
 * shelves son reales. Pérdida concentrada en un shelf: hay que excluir esas
 * emisiones del análisis y decirlo, no repararlas.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const PERDIDA_ACEPTABLE = 0.05;
const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

console.log(`\n${"═".repeat(78)}`);
console.log("Cobertura del join contra el informe del servicer");
console.log(`${"═".repeat(78)}`);

// ---------------------------------------------------------------------------
// 1. Global
// ---------------------------------------------------------------------------

/**
 * Tres números, no dos. La primera versión de este script comparaba parseadas
 * contra filas de la tabla y llamaba "perdida" a la diferencia: 349 contra 282,
 * 19%. Pero 341 de esas 349 SÍ habían pegado —el join anda al 97,7%— y las 59
 * restantes son tramos pari passu colapsando sobre el mismo préstamo, que es lo
 * que queremos que pase.
 *
 * O sea que el diagnóstico construido para detectar un artefacto del pipeline
 * era, él mismo, un artefacto del pipeline. Separar las dos pérdidas es todo el
 * punto de este script.
 */
const { rows: glob } = await query<{
  parseadas: string; pegadas: string; filas: string;
}>(
  `SELECT coalesce(sum((stats->>'delinquencyRows')::int), 0)::text   AS parseadas,
          coalesce(sum((stats->>'delinquencyMatched')::int), 0)::text AS pegadas,
          (SELECT count(*) FROM corpus.delinquency)::text             AS filas
     FROM corpus.servicer_reports`,
);

const parseadas = Number(glob[0]?.parseadas ?? 0);
const pegadas = Number(glob[0]?.pegadas ?? 0);
const filas = Number(glob[0]?.filas ?? 0);
const perdida = parseadas > 0 ? (parseadas - pegadas) / parseadas : 0;

console.log(`\n${"─".repeat(78)}`);
console.log("Filas de morosidad: parseadas → pegadas → filas distintas");
console.log(`${"─".repeat(78)}\n`);

if (pegadas === 0 && parseadas > 0) {
  console.log(
    `  \x1b[33mNo hay 'delinquencyMatched' en stats. Recosechá:  npm run db:performance\x1b[0m\n`,
  );
} else {
  console.log(`  ${String(parseadas).padStart(5)}  filas en los 10-D`);
  console.log(
    `  ${String(pegadas).padStart(5)}  encontraron su préstamo   ` +
      `${perdida <= PERDIDA_ACEPTABLE ? "\x1b[32m" : "\x1b[31m"}${parseadas - pegadas} sin pegar ` +
      `(${pct(perdida, 1)})\x1b[0m   \x1b[90mumbral ${pct(PERDIDA_ACEPTABLE)}\x1b[0m`,
  );
  console.log(
    `  ${String(filas).padStart(5)}  filas en la tabla         ` +
      `\x1b[90m${pegadas - filas} colapsadas — tramos pari passu del mismo préstamo\x1b[0m`,
  );
  console.log(
    `\n  \x1b[90mSolo la primera diferencia es cobertura perdida. La segunda es la\x1b[0m`,
  );
  console.log(
    `  \x1b[90mdeduplicación funcionando: el estado de pago es del préstamo, no del tramo.\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 2. Por shelf
// ---------------------------------------------------------------------------

/**
 * El shelf sale del nombre porque no hay columna que lo guarde.
 *
 * Es frágil —"BANK5" tiene que probarse antes que "BANK", si no todo BANK5 cae
 * en BANK— así que el orden de los CASE importa y está puesto a propósito.
 */
const SHELF = `
  CASE
    WHEN sr.company_name ILIKE 'BANK5%'     THEN 'BANK5'
    WHEN sr.company_name ILIKE 'BANK %'     THEN 'BANK'
    WHEN sr.company_name ILIKE 'BENCHMARK%' THEN 'Benchmark'
    WHEN sr.company_name ILIKE 'BBCMS%'     THEN 'BBCMS'
    WHEN sr.company_name ILIKE 'BMO%'       THEN 'BMO'
    WHEN sr.company_name ILIKE 'WELLS%'     THEN 'Wells'
    WHEN sr.company_name ILIKE 'MORGAN%' OR sr.company_name ILIKE 'MSWF%' THEN 'MS'
    WHEN sr.company_name ILIKE 'GS %'       THEN 'GS'
    ELSE 'otros'
  END`;

const { rows: porShelf } = await query<{
  shelf: string; emisiones: string; parseadas: string; pegadas: string;
  filas: string; pool: string;
}>(
  `WITH por_informe AS (
     SELECT sr.accession,
            ${SHELF} AS shelf,
            coalesce((sr.stats->>'delinquencyRows')::int, 0)    AS parseadas,
            coalesce((sr.stats->>'delinquencyMatched')::int, 0) AS pegadas,
            coalesce((sr.stats->>'poolLoans')::int, 0)          AS pool,
            (SELECT count(*) FROM corpus.delinquency d
              WHERE d.report_accession = sr.accession)          AS filas
       FROM corpus.servicer_reports sr
   )
   SELECT shelf, count(*)::text AS emisiones,
          sum(parseadas)::text AS parseadas,
          sum(pegadas)::text   AS pegadas,
          sum(filas)::text     AS filas,
          sum(pool)::text      AS pool
     FROM por_informe
    GROUP BY shelf
    ORDER BY sum(parseadas) - sum(pegadas) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("Por shelf");
console.log(`${"─".repeat(78)}\n`);
console.log(`  shelf       emis.    pool   parseadas   sin pegar   filas   tasa obs.`);
console.log(`  ${"─".repeat(72)}`);

for (const r of porShelf) {
  const p = Number(r.parseadas);
  const g = Number(r.pegadas);
  const f = Number(r.filas);
  const pool = Number(r.pool);
  const perd = p - g;
  const color = p > 0 && perd / p > PERDIDA_ACEPTABLE ? "\x1b[31m" : "\x1b[90m";
  console.log(
    `  ${r.shelf.padEnd(11)} ${String(r.emisiones).padStart(4)} ${String(pool).padStart(7)} ` +
      `${String(p).padStart(11)}   ${color}${String(perd).padStart(5)}` +
      ` ${p > 0 ? `(${pct(perd / p)})`.padStart(6) : "     —"}\x1b[0m` +
      ` ${String(f).padStart(7)}` +
      `   ${pool > 0 ? pct(f / pool, 1).padStart(7) : "      —"}`,
  );
}

console.log(
  `\n  \x1b[90mLa última columna es la tasa que el análisis LEE: eventos pegados sobre pool\x1b[0m`,
);
console.log(
  `  \x1b[90mcompleto. Si un shelf pierde filas, su tasa baja sin que nada mejore.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 3. Las emisiones que más pierden
// ---------------------------------------------------------------------------

/**
 * Solo las que pierden en el JOIN. Las que colapsan tramos no son un problema y
 * listarlas acá fue lo que me hizo leer mal la primera vez.
 */
const { rows: peores } = await query<{
  emision: string; parseadas: string; pegadas: string; pool: string;
}>(
  `SELECT left(sr.company_name, 36) AS emision,
          coalesce((sr.stats->>'delinquencyRows')::int, 0)::text    AS parseadas,
          coalesce((sr.stats->>'delinquencyMatched')::int, 0)::text AS pegadas,
          coalesce((sr.stats->>'poolLoans')::int, 0)::text          AS pool
     FROM corpus.servicer_reports sr
    WHERE coalesce((sr.stats->>'delinquencyRows')::int, 0)
          > coalesce((sr.stats->>'delinquencyMatched')::int, 0)
    ORDER BY coalesce((sr.stats->>'delinquencyRows')::int, 0)
             - coalesce((sr.stats->>'delinquencyMatched')::int, 0) DESC
    LIMIT 12`,
);

if (peores.length === 0) {
  console.log(
    `\n  \x1b[32mNinguna emisión pierde filas de morosidad en el join.\x1b[0m\n`,
  );
} else {
  console.log(`\n${"─".repeat(78)}`);
  console.log(`Emisiones que pierden filas en el join (${peores.length} peores)`);
  console.log(`${"─".repeat(78)}\n`);
  console.log(`  emisión                                parseadas   pegadas   pool`);
  console.log(`  ${"─".repeat(72)}`);
  for (const r of peores) {
    console.log(
      `  ${r.emision.padEnd(38)} ${String(r.parseadas).padStart(9)} ${String(r.pegadas).padStart(9)} ` +
        `${String(r.pool).padStart(6)}`,
    );
  }
  console.log(
    `\n  \x1b[90mCada fila acá es un préstamo moroso real que el corpus no pudo ubicar.\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 4. ¿Los shelves listan la misma población?
// ---------------------------------------------------------------------------

/**
 * El join funciona —2,3% de pérdida— y aun así BMO marca 11,1% del pool contra
 * 1,3% de BANK, con BMO más JOVEN. El censurado a derecha predice lo contrario:
 * las añadas viejas tuvieron más tiempo para romperse.
 *
 * Hay una explicación que no es de crédito. La tabla de morosidad la arma el
 * administrador y no todos listan la misma población: uno puede incluir cada
 * préstamo en watchlist aunque pague al día —Benchmark 2020-B16 tiene uno así—
 * y otro solo los de 60+ días. Si es eso, la tasa mide política de reporte.
 *
 * La firma que los separa: si un shelf lista watchlist, sus filas se concentran
 * en 0 meses de atraso. Si lista morosos de verdad, se corren a 2+.
 *
 * Esto NO prueba cuál es el correcto. Prueba si son comparables entre sí, que
 * es la pregunta previa y la que el análisis por shelf da por respondida.
 */
const { rows: pobl } = await query<{
  shelf: string; n: string; cero: string; dos_mas: string;
  transferidos: string; ejecucion: string; mediana: string | null;
}>(
  `SELECT ${SHELF} AS shelf,
          count(*)::text AS n,
          count(*) FILTER (WHERE d.months_delinquent = 0)::text  AS cero,
          count(*) FILTER (WHERE d.months_delinquent >= 2)::text AS dos_mas,
          count(*) FILTER (WHERE d.transfer_date IS NOT NULL)::text AS transferidos,
          count(*) FILTER (WHERE d.foreclosure_date IS NOT NULL
                              OR d.reo_date IS NOT NULL)::text AS ejecucion,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY d.months_delinquent)::text AS mediana
     FROM corpus.delinquency d
     JOIN corpus.servicer_reports sr ON sr.accession = d.report_accession
    GROUP BY 1
   HAVING count(*) >= 5
    ORDER BY count(*) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("¿Los shelves listan la misma población?");
console.log(`${"─".repeat(78)}\n`);
console.log(`  shelf         filas   0 meses   2+ meses   mediana   transf.   ejec.`);
console.log(`  ${"─".repeat(72)}`);

for (const r of pobl) {
  const n = Number(r.n);
  console.log(
    `  ${r.shelf.padEnd(11)} ${String(n).padStart(7)} ` +
      `${pct(Number(r.cero) / n).padStart(9)} ${pct(Number(r.dos_mas) / n).padStart(10)} ` +
      `${(r.mediana === null ? "—" : Number(r.mediana).toFixed(1)).padStart(9)} ` +
      `${pct(Number(r.transferidos) / n).padStart(9)} ${pct(Number(r.ejecucion) / n).padStart(7)}`,
  );
}

console.log(
  `\n  \x1b[90mUn shelf con casi todas sus filas en 0 meses está listando watchlist,\x1b[0m`,
);
console.log(
  `  \x1b[90mno morosos. Comparar su tasa contra la de otro shelf mide el reporte.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 5. ¿Por qué un shelf no tiene morosos?
// ---------------------------------------------------------------------------

/**
 * Cero filas de morosidad en una emisión tiene tres causas y hasta hoy las tres
 * se veían iguales desde la base:
 *
 *   sin bloque      → el localizador no lo ubicó: es formato, hay que arreglarlo
 *   bloque vacío    → el 10-D dice "No delinquent loans this period"
 *   todo descartado → filas que los filtros comieron (leyendas, notas al pie)
 *
 * La distinción no es cosmética. BANK marca 1,3% del pool contra 11,1% de BMO,
 * y esa diferencia significa cosas opuestas según de dónde venga el cero: si es
 * formato, el shelf no se puede comparar; si es el documento declarando que no
 * hay morosos, la diferencia es real.
 *
 * Verifiqué el documento de BANK 2021-BNK36 a mano y dice "No delinquent loans
 * this period". Esta tabla es la misma pregunta hecha sobre las 148 emisiones
 * en vez de sobre la que tenía abierta.
 */
const { rows: causas } = await query<{
  shelf: string; emisiones: string; sin_bloque: string;
  bloque_vacio: string; todo_descartado: string; con_filas: string;
}>(
  `WITH por_informe AS (
     SELECT ${SHELF} AS shelf,
            coalesce((sr.stats->>'delinquencyTables')::int, -1)   AS tablas,
            coalesce((sr.stats->>'delinquencyDataRows')::int, 0)  AS filas,
            coalesce((sr.stats->>'delinquencyRows')::int, 0)      AS utiles
       FROM corpus.servicer_reports sr
   )
   SELECT shelf, count(*)::text AS emisiones,
          count(*) FILTER (WHERE tablas = 0)::text                        AS sin_bloque,
          count(*) FILTER (WHERE tablas > 0 AND filas = 0)::text          AS bloque_vacio,
          count(*) FILTER (WHERE filas > 0 AND utiles = 0)::text          AS todo_descartado,
          count(*) FILTER (WHERE utiles > 0)::text                        AS con_filas
     FROM por_informe
    GROUP BY shelf
    ORDER BY count(*) FILTER (WHERE tablas = 0) DESC, shelf`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("De dónde viene el cero: formato, documento, o filtro");
console.log(`${"─".repeat(78)}\n`);
console.log(`  shelf       emis.   sin bloque   bloque vacío   todo descart.   con filas`);
console.log(`  ${"─".repeat(72)}`);

let faltaStats = true;
for (const r of causas) {
  const sb = Number(r.sin_bloque);
  if (sb >= 0) faltaStats = false;
  console.log(
    `  ${r.shelf.padEnd(11)} ${String(r.emisiones).padStart(4)} ` +
      `${(sb > 0 ? `\x1b[31m${sb}\x1b[0m` : String(sb)).padStart(sb > 0 ? 21 : 12)} ` +
      `${String(r.bloque_vacio).padStart(13)} ${String(r.todo_descartado).padStart(15)} ` +
      `${String(r.con_filas).padStart(11)}`,
  );
}

if (faltaStats) {
  console.log(
    `\n  \x1b[33mFaltan los contadores en stats. Recosechá:  npm run db:performance\x1b[0m`,
  );
} else {
  console.log(
    `\n  \x1b[90m"sin bloque" es lo único que hay que arreglar: el localizador falló y la\x1b[0m`,
  );
  console.log(
    `  \x1b[90memisión entra al denominador con cero eventos garantizados. "bloque vacío"\x1b[0m`,
  );
  console.log(
    `  \x1b[90mes el 10-D diciendo "No delinquent loans this period" — un cero verdadero.\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 6. Qué se descartó, crudo
// ---------------------------------------------------------------------------

/**
 * Las emisiones donde el filtro se comió TODAS las filas.
 *
 * Verifiqué una a mano —BANK 2021-BNK36, decía "No delinquent loans this
 * period"— y de ahí di por buenas otras once sin abrirlas. Esta tabla es esa
 * verificación hecha sobre todas a la vez.
 *
 * Si el valor crudo es prosa, el filtro trabaja bien y el cero es del emisor.
 * Si es un número, hay morosos siendo borrados y la tasa del shelf está mal.
 */
const { rows: crudo } = await query<{
  emision: string; descartadas: string; muestra: string | null;
}>(
  `SELECT left(sr.company_name, 30) AS emision,
          coalesce((sr.stats->>'delinquencyDropped')::int, 0)::text AS descartadas,
          (sr.stats->'delinquencyDroppedSamples')->>0 AS muestra
     FROM corpus.servicer_reports sr
    WHERE coalesce((sr.stats->>'delinquencyDataRows')::int, 0) > 0
      AND coalesce((sr.stats->>'delinquencyRows')::int, 0) = 0
    ORDER BY sr.company_name
    LIMIT 20`,
);

if (crudo.length > 0) {
  console.log(`\n${"─".repeat(78)}`);
  console.log("Emisiones que descartaron todo: qué decía la primera fila");
  console.log(`${"─".repeat(78)}\n`);
  for (const r of crudo) {
    const m = r.muestra ?? "(sin muestra — recosechá)";
    // Un identificador numérico acá es un moroso borrado; prosa es el filtro
    // trabajando. La diferencia se ve sola, y por eso se imprime el valor.
    const esNumero = /^\d+[a-z]?$/i.test(m.trim());
    console.log(
      `  ${r.emision.padEnd(32)} ${String(r.descartadas).padStart(3)}  ` +
        `${esNumero ? "\x1b[31m" : "\x1b[90m"}"${m}"\x1b[0m`,
    );
  }
  console.log(
    `\n  \x1b[90mProsa = el filtro trabaja bien, el cero es del emisor.\x1b[0m`,
  );
  console.log(
    `  \x1b[31mUn número = un moroso borrado y la tasa del shelf está mal.\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 7. Emisora × administrador: ¿la pregunta se puede hacer?
// ---------------------------------------------------------------------------

/**
 * ESTO CORRE ANTES DE MIRAR NINGÚN RESULTADO. NO ES UN ANÁLISIS.
 *
 * El SIR dice que BANK transfiere a special servicing 4 veces menos que BBCMS,
 * ajustado por añada y apalancamiento. Sobrevivió cinco ataques. La hipótesis
 * que queda es que no sea la emisora sino el administrador maestro, que arma
 * tanto la tabla de NOI como la de morosidad.
 *
 * Pero si cada emisora usa un administrador distinto y ningún administrador
 * aparece en dos emisoras, las dos variables son la MISMA columna con dos
 * nombres. Ningún dato de este corpus las separa, y correr el análisis igual
 * produciría un número que parece una respuesta.
 *
 * La condición de identificabilidad es celdas fuera de la diagonal: al menos un
 * administrador con dos emisoras, o al menos una emisora con dos
 * administradores. Sin eso, la respuesta correcta es "no se puede saber".
 */
const { rows: cruce } = await query<{
  shelf: string; master: string; n: string;
}>(
  `SELECT ${SHELF} AS shelf,
          coalesce(sr.master_servicer, '(sin dato)') AS master,
          count(*)::text AS n
     FROM corpus.servicer_reports sr
    GROUP BY 1, 2
    ORDER BY 1, count(*) DESC`,
);

console.log(`\n${"═".repeat(78)}`);
console.log("Emisora × administrador maestro  —  ¿la pregunta es identificable?");
console.log(`${"═".repeat(78)}\n`);

const porShelfMap = new Map<string, Array<[string, number]>>();
const porMaster = new Map<string, Set<string>>();
for (const r of cruce) {
  const lista = porShelfMap.get(r.shelf) ?? [];
  lista.push([r.master, Number(r.n)]);
  porShelfMap.set(r.shelf, lista);
  const s = porMaster.get(r.master) ?? new Set<string>();
  s.add(r.shelf);
  porMaster.set(r.master, s);
}

for (const [shelf, lista] of [...porShelfMap].sort()) {
  const total = lista.reduce((a, [, n]) => a + n, 0);
  console.log(`  \x1b[1m${shelf}\x1b[0m \x1b[90m(${total} emisiones)\x1b[0m`);
  for (const [master, n] of lista) {
    console.log(`      ${String(n).padStart(3)}  ${master.slice(0, 60)}`);
  }
}

const compartidos = [...porMaster.entries()].filter(
  ([m, s]) => s.size > 1 && m !== "(sin dato)",
);
const shelvesMixtos = [...porShelfMap.entries()].filter(
  ([, l]) => l.filter(([m]) => m !== "(sin dato)").length > 1,
);

console.log(`\n${"─".repeat(78)}\n`);
console.log(
  `  Administradores en más de una emisora: ${compartidos.length}` +
    (compartidos.length > 0
      ? `\n${compartidos.map(([m, s]) => `      ${m.slice(0, 50)} → ${[...s].join(", ")}`).join("\n")}`
      : ""),
);
console.log(
  `  Emisoras con más de un administrador:  ${shelvesMixtos.length}` +
    (shelvesMixtos.length > 0
      ? `\n${shelvesMixtos.map(([s]) => `      ${s}`).join("\n")}`
      : ""),
);

if (compartidos.length === 0 && shelvesMixtos.length === 0) {
  console.log(
    `\n  \x1b[31mNO IDENTIFICABLE.\x1b[0m Emisora y administrador son la misma columna`,
  );
  console.log(
    `  \x1b[90mcon dos nombres. Ningún dato de este corpus puede separarlas, y correr\x1b[0m`,
  );
  console.log(
    `  \x1b[90mel análisis igual daría un número que parece una respuesta.\x1b[0m\n`,
  );
} else {
  console.log(
    `\n  \x1b[32mHay celdas fuera de la diagonal.\x1b[0m La pregunta se puede hacer,`,
  );
  console.log(
    `  \x1b[90mpero solo con la potencia que den esas celdas: si el solapamiento son\x1b[0m`,
  );
  console.log(
    `  \x1b[90mdos emisiones, el contraste va a ser demasiado ruidoso para concluir.\x1b[0m\n`,
  );
}

await closePool();

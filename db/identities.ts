/**
 * Identidades aritméticas entre métricas mapeadas por separado.
 *
 *   npm run db:identities
 *
 * POR QUÉ ESTO ES LA VERIFICACIÓN MÁS FUERTE QUE TENEMOS
 *
 * Cada columna del Annex A se mapea de forma independiente: un patrón sobre el
 * encabezado, sin mirar las otras. `net_cash_flow` no sabe nada de
 * `debt_service_pi`, y ninguno sabe de `dscr_ncf`.
 *
 * Pero el emisor las calculó a partir de las mismas cifras, así que tienen que
 * cerrar entre sí:
 *
 *     DSCR (NCF)  =  NCF / servicio de deuda
 *     NCF         =  NOI − reserva de reposición − TI/LC
 *     debt yield  =  NOI / saldo
 *     LTV         =  saldo / tasación
 *
 * Si tres columnas mapeadas por separado satisfacen una identidad sobre miles de
 * préstamos, la probabilidad de que estén las tres mal de forma compensada es
 * despreciable. Y si NO cierran, hay un error de mapeo que ninguna métrica
 * mirada sola habría delatado —que es exactamente el tipo de error que nos costó
 * ocho iteraciones encontrar a mano.
 *
 * Esta verificación recién es posible desde que se mapearon los bloques del
 * Annex A que antes se descartaban enteros: sin `debt_service_pi` teníamos el
 * DSCR pero no sus partes, así que no había nada contra qué contrastarlo.
 *
 * SOBRE LA TOLERANCIA
 *
 * No se exige igualdad exacta. Los emisores redondean —el DSCR se publica con
 * dos decimales, y 1.45 puede venir de cualquier cosa entre 1.445 y 1.455— así
 * que la tolerancia por defecto es 1%. Lo que importa no es el caso individual
 * sino la proporción: si el 95% de los préstamos cierra, el mapeo está bien y el
 * 5% restante son casos raros que vale mirar. Si cierra el 60%, hay un problema
 * sistemático.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const TOLERANCE = 0.01;
const pct = (v: number | string | null, d = 1) =>
  v === null ? "—" : `${(Number(v) * 100).toFixed(d)}%`;

console.log(`\n${"═".repeat(78)}`);
console.log("Identidades aritméticas");
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  Cada métrica se mapea sola, sin mirar a las demás. Que cierren entre sí\x1b[0m`,
);
console.log(`\x1b[90m  es evidencia de que el mapeo es correcto. Tolerancia ${pct(TOLERANCE, 0)}.\x1b[0m\n`);

/** Un fact numérico de una métrica, listo para unir. */
const fact = (alias: string, key: string) =>
  `LEFT JOIN corpus.facts ${alias} ON ${alias}.loan_id = l.id ` +
  `AND ${alias}.metric_key = '${key}' AND ${alias}.value ~ '^-?[0-9.]+$'`;

interface IdentityResult {
  label: string;
  formula: string;
  n: number;
  holds: number;
  share: number;
  medianError: number | null;
  worst: Array<{ loan: string; expected: number; actual: number; error: number }>;
}

async function checkIdentity(
  label: string,
  formula: string,
  joins: string,
  expected: string,
  actual: string,
  extraWhere = "",
): Promise<IdentityResult | null> {
  const { rows } = await query<{
    n: string; holds: string; median_error: number | null;
  }>(
    `WITH pairs AS (
       SELECT ${expected} AS expected, ${actual} AS actual
         FROM corpus.loans l
         ${joins}
        WHERE ${expected} IS NOT NULL AND ${actual} IS NOT NULL
          AND ${actual} <> 0 ${extraWhere}
     )
     SELECT count(*) AS n,
            count(*) FILTER (WHERE abs(expected / actual - 1) <= ${TOLERANCE}) AS holds,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(expected / actual - 1)) AS median_error
       FROM pairs WHERE actual <> 0`,
  );

  const r = rows[0];
  if (!r || Number(r.n) < 20) return null;

  const { rows: worst } = await query<{
    loan: string; expected: number; actual: number; err: number;
  }>(
    `SELECT coalesce(l.loan_ref, l.id::text) AS loan,
            ${expected} AS expected, ${actual} AS actual,
            abs(${expected} / ${actual} - 1) AS err
       FROM corpus.loans l
       ${joins}
      WHERE ${expected} IS NOT NULL AND ${actual} IS NOT NULL
        AND ${actual} <> 0 ${extraWhere}
      ORDER BY abs(${expected} / ${actual} - 1) DESC NULLS LAST
      LIMIT 3`,
  );

  return {
    label,
    formula,
    n: Number(r.n),
    holds: Number(r.holds),
    share: Number(r.holds) / Number(r.n),
    medianError: r.median_error,
    worst: worst.map((w) => ({
      loan: w.loan, expected: Number(w.expected), actual: Number(w.actual), error: Number(w.err),
    })),
  };
}

const results: IdentityResult[] = [];

/**
 * DSCR contra sus dos partes, escaladas al préstamo completo.
 *
 * Dos cosas hay que acertar acá y ninguna está escrita en el documento.
 *
 * 1. UN PRÉSTAMO CON PERÍODO DE SOLO INTERESES TIENE DOS SERVICIOS DE DEUDA.
 *    El emisor calcula el DSCR contra el que corresponda al momento, así que
 *    usamos el de IO cuando existe y el de P&I cuando no.
 *
 * 2. EL SERVICIO DE DEUDA ES DE LA NOTA DEL TRUST; EL DSCR, DEL PRÉSTAMO ENTERO.
 *    El Annex A publica "Annual Debt Service" de la porción que compró esta
 *    emisión, pero el ratio contra el NOI de la propiedad completa. Sin escalar,
 *    la identidad falla exactamente en los préstamos repartidos.
 *
 *    Se escala por saldo porque todas las notas de un mismo préstamo comparten
 *    tasa y amortización: el servicio por dólar es idéntico en todas. Verificado
 *    a mano antes de escribirlo, sobre los tres peores desvíos:
 *
 *      loan 46:  164.630 × 288,1 = 47,4M → 97.102.547 / 47,4M = 2,05  (pub. 2,04)
 *      loan 23:  557.608 × 207,7 = 115,8M → 236.785.998 / 115,8M = 2,05 (pub. 2,04)
 *      loan 24:  381.529 × 106,6 = 40,7M → 84.349.369 / 40,7M = 2,07  (pub. 2,07)
 *
 *    Tres préstamos de tres emisores distintos, con factores distintos, dando el
 *    valor publicado al segundo decimal. No es coincidencia.
 */
/**
 * El sénior: la columna publicada si existe, la suma si no.
 *
 * Armar el sénior sumando dos métricas depende de que las DOS se hayan mapeado
 * bien. Varias emisiones publican el total en una sola columna y el
 * reconciliador las encontró comparando valores, no nombres. Cuando está, se usa
 * esa: no depende de que el pari passu se haya capturado, ni de que el Annex lo
 * publique por separado.
 */
const SENIOR =
  "coalesce(sen.value::numeric, amt.value::numeric + coalesce(npp.value::numeric, 0))";
const SENIOR_JOINS =
  `${fact("amt", "loan_amount")} ${fact("npp", "balance_pari_passu_non_trust")} ` +
  `${fact("sen", "balance_senior_total")}`;
/** Servicio de deuda de la nota del trust, llevado al préstamo completo. */
const DEBT_SERVICE_SENIOR =
  `coalesce(dsio.value::numeric, dspi.value::numeric) ` +
  `* ${SENIOR} / NULLIF(amt.value::numeric, 0)`;
const DS_JOINS = `${fact("dspi", "debt_service_pi")} ${fact("dsio", "debt_service_io")}`;

const dscrNcf = await checkIdentity(
  "DSCR (NCF) = NCF / servicio de deuda",
  "dscr_ncf · net_cash_flow · debt_service_io|pi escalado al senior",
  `${fact("d", "dscr_ncf")} ${fact("ncf", "net_cash_flow")} ${DS_JOINS} ${SENIOR_JOINS}`,
  `ncf.value::numeric / NULLIF(${DEBT_SERVICE_SENIOR}, 0)`,
  "d.value::numeric",
);
if (dscrNcf) results.push(dscrNcf);

const dscrNoi = await checkIdentity(
  "DSCR (NOI) = NOI suscrito / servicio de deuda",
  "dscr · noi_underwritten · debt_service_io|pi escalado al senior",
  `${fact("d", "dscr")} ${fact("noi", "noi_underwritten")} ${DS_JOINS} ${SENIOR_JOINS}`,
  `noi.value::numeric / NULLIF(${DEBT_SERVICE_SENIOR}, 0)`,
  "d.value::numeric",
);
if (dscrNoi) results.push(dscrNoi);

/**
 * La resta que define el NCF.
 *
 * Es la identidad que motivó mapear los bloques descartados: teníamos NOI y NCF
 * pero ninguno de los dos sustraendos, así que la diferencia entre ambos era un
 * número sin explicación.
 */
const ncf = await checkIdentity(
  "NCF = NOI − reposición − TI/LC",
  "net_cash_flow · noi_underwritten · underwritten_replacement_reserve · underwritten_tilc",
  `${fact("ncf", "net_cash_flow")} ${fact("noi", "noi_underwritten")} ` +
    `${fact("rep", "underwritten_replacement_reserve")} ${fact("tilc", "underwritten_tilc")}`,
  "noi.value::numeric - coalesce(rep.value::numeric, 0) - coalesce(tilc.value::numeric, 0)",
  "ncf.value::numeric",
);
if (ncf) results.push(ncf);

/**
 * CONTRA QUÉ SALDO CIERRA CADA RATIO
 *
 * Un Annex A publica siete saldos para el mismo préstamo, y los ratios se
 * calculan contra alguno de ellos sin decir cuál. Suponerlo es cómo llegamos al
 * problema: `loan_amount` apuntaba a "Original Balance" —la porción de este
 * trust en un préstamo repartido— y el debt yield calculado daba 3947%.
 *
 * En vez de elegir por intuición, se prueban todos los candidatos y gana el que
 * cierra. La proporción que cierra con cada uno ES la respuesta sobre qué
 * significa cada columna, y queda registrada en la salida en vez de en la
 * cabeza de alguien.
 */
const BALANCE_CANDIDATES: Array<{ label: string; sql: string; joins: string }> = [
  {
    label: "trust (cut-off)",
    sql: "amt.value::numeric",
    joins: fact("amt", "loan_amount"),
  },
  {
    label: "whole loan",
    sql: "wl.value::numeric",
    joins: fact("wl", "balance_whole_loan"),
  },
  {
    label: "trust + pari passu no-trust",
    sql: "(amt.value::numeric + coalesce(npp.value::numeric, 0))",
    joins: `${fact("amt", "loan_amount")} ${fact("npp", "balance_pari_passu_non_trust")}`,
  },
  {
    label: "whole loan + subordinada",
    sql: "(wl.value::numeric + coalesce(sub.value::numeric, 0))",
    joins: `${fact("wl", "balance_whole_loan")} ${fact("sub", "balance_subordinate")}`,
  },
];

console.log(`\n${"─".repeat(78)}`);
console.log(`Qué saldo usa cada ratio`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  denominador                     debt yield        LTV`);

let bestBalance = BALANCE_CANDIDATES[0]!;
let bestShare = -1;

for (const cand of BALANCE_CANDIDATES) {
  const dyRes = await checkIdentity(
    `Debt yield / ${cand.label}`,
    "",
    `${fact("dy", "debt_yield")} ${fact("noi", "noi_underwritten")} ${cand.joins}`,
    `noi.value::numeric / NULLIF(${cand.sql}, 0)`,
    "dy.value::numeric",
  );
  const ltvRes = await checkIdentity(
    `LTV / ${cand.label}`,
    "",
    `${fact("v", "ltv")} ${cand.joins} ${fact("val", "appraised_value")}`,
    `${cand.sql} / NULLIF(val.value::numeric, 0)`,
    "v.value::numeric",
  );

  const dyShare = dyRes?.share ?? 0;
  const ltvShare = ltvRes?.share ?? 0;
  const paint = (v: number) =>
    (v >= 0.9 ? "\x1b[32m" : v >= 0.7 ? "\x1b[33m" : "\x1b[90m") + pct(v, 0).padStart(6) + "\x1b[0m";

  console.log(
    `  ${cand.label.padEnd(30)} ${paint(dyShare)}    ${paint(ltvShare)}  ` +
      `\x1b[90m(n ${dyRes?.n ?? 0} / ${ltvRes?.n ?? 0})\x1b[0m`,
  );

  if (dyShare + ltvShare > bestShare) {
    bestShare = dyShare + ltvShare;
    bestBalance = cand;
  }
}

console.log(
  `\n  \x1b[1mMejor denominador: ${bestBalance.label}\x1b[0m`,
);
console.log(
  `  \x1b[90mSi ninguno pasa el 90%, faltan saldos por mapear o hay préstamos con\x1b[0m`,
);
console.log(`  \x1b[90muna estructura de deuda que todavía no modelamos.\x1b[0m`);

const debtYield = await checkIdentity(
  "Debt yield = NOI suscrito / saldo",
  `debt_yield · noi_underwritten · ${bestBalance.label}`,
  `${fact("dy", "debt_yield")} ${fact("noi", "noi_underwritten")} ${bestBalance.joins}`,
  `noi.value::numeric / NULLIF(${bestBalance.sql}, 0)`,
  "dy.value::numeric",
);
if (debtYield) results.push(debtYield);

const ltv = await checkIdentity(
  "LTV = saldo / tasación",
  `ltv · ${bestBalance.label} · appraised_value`,
  `${fact("v", "ltv")} ${bestBalance.joins} ${fact("val", "appraised_value")}`,
  `${bestBalance.sql} / NULLIF(val.value::numeric, 0)`,
  "v.value::numeric",
);
if (ltv) results.push(ltv);

// ---------------------------------------------------------------------------

if (results.length === 0) {
  console.error(
    `  \x1b[33mNinguna identidad tiene muestra suficiente.\x1b[0m\n` +
      `  ¿Cosechaste con el mapeo nuevo?  npm run harvest:batch -- --limit 100\n`,
  );
  await closePool();
  process.exit(0);
}

console.log(`\n${"─".repeat(78)}\nResumen\n${"─".repeat(78)}\n`);
console.log(`  identidad                                       n    cierra   error mediano`);
for (const r of results) {
  const color = r.share >= 0.9 ? "\x1b[32m" : r.share >= 0.7 ? "\x1b[33m" : "\x1b[31m";
  console.log(
    `  ${r.label.padEnd(44)} ${String(r.n).padStart(5)}  ${color}${pct(r.share, 0).padStart(6)}\x1b[0m  ` +
      `${pct(r.medianError, 2).padStart(12)}`,
  );
}

const broken = results.filter((r) => r.share < 0.7);
const partial = results.filter((r) => r.share >= 0.7 && r.share < 0.9);

console.log();
if (broken.length === 0 && partial.length === 0) {
  console.log(`  \x1b[32mTodas cierran por encima del 90%.\x1b[0m`);
  console.log(
    `  Métricas mapeadas por separado satisfacen las relaciones que el emisor usó`,
  );
  console.log(`  para calcularlas. Es la evidencia más fuerte de que el mapeo es correcto.`);
} else {
  for (const r of [...broken, ...partial]) {
    const sev = r.share < 0.7 ? "\x1b[31m" : "\x1b[33m";
    console.log(`  ${sev}${r.label}\x1b[0m cierra solo en ${pct(r.share, 0)} de ${r.n}.`);
    console.log(`  \x1b[90m  métricas: ${r.formula}\x1b[0m`);
    for (const w of r.worst) {
      console.log(
        `  \x1b[90m  loan ${w.loan}: esperado ${w.expected.toFixed(4)}, ` +
          `publicado ${w.actual.toFixed(4)} (${pct(w.error, 0)} de error)\x1b[0m`,
      );
    }
    console.log();
  }
  console.log(
    `  \x1b[90mUna identidad que no cierra es un error de mapeo o un supuesto equivocado\x1b[0m`,
  );
  console.log(
    `  \x1b[90msobre cómo el emisor calcula. Las dos cosas hay que entenderlas antes de\x1b[0m`,
  );
  console.log(`  \x1b[90mconstruir encima.\x1b[0m`);
}

// ---------------------------------------------------------------------------
// ¿Dónde se concentran las fallas?
// ---------------------------------------------------------------------------

/**
 * La pregunta que decide qué arreglar.
 *
 * Las cuatro identidades que fallan lo hacen en la misma proporción (73-75%) y
 * en los mismos préstamos, con factores de error de ~280x repetidos. Eso
 * descarta el redondeo y descarta una métrica confundida con otra: es escala, o
 * es que estamos leyendo la fila equivocada.
 *
 * Si las fallas se concentran en pocos filings, el problema es de formato —un
 * emisor que publica en miles, o una columna distinta con el mismo nombre— y se
 * arregla en el mapeo. Si están repartidas parejo entre todos los filings, el
 * problema es por préstamo y hay que buscar qué tienen en común esos préstamos.
 *
 * Son dos arreglos completamente distintos, y mirar el agregado no distingue
 * cuál.
 */
console.log(`\n${"─".repeat(78)}`);
console.log(`Dónde fallan`);
console.log(`${"─".repeat(78)}\n`);

/**
 * La sonda usa el denominador ganador, no `loan_amount` suelto.
 *
 * Antes usaba solo el saldo del trust y reportaba 865 préstamos rotos repartidos
 * entre 99 filings, con la conclusión "el problema es por préstamo". Era cierto
 * —el problema era el pari passu, que es una propiedad del préstamo— pero el
 * diagnóstico quedó obsoleto en cuanto se arregló. Una sonda que mide contra un
 * supuesto viejo sigue reportando el problema viejo.
 */
const { rows: byFiling } = await query<{
  filings: string; clean: string; broken: string; mixed: string;
}>(
  `WITH per_loan AS (
     SELECT l.accession,
            abs((noi.value::numeric / NULLIF(${SENIOR}, 0))
                / NULLIF(dy.value::numeric, 0) - 1) <= ${TOLERANCE} AS ok
       FROM corpus.loans l
       ${fact("dy", "debt_yield")} ${fact("noi", "noi_underwritten")} ${SENIOR_JOINS}
      WHERE dy.value IS NOT NULL AND noi.value IS NOT NULL AND amt.value IS NOT NULL
        AND amt.value::numeric <> 0 AND dy.value::numeric <> 0
   ),
   per_filing AS (
     SELECT accession,
            count(*) AS n,
            count(*) FILTER (WHERE ok) AS ok
       FROM per_loan GROUP BY accession
   )
   SELECT count(*) AS filings,
          count(*) FILTER (WHERE ok = n) AS clean,
          count(*) FILTER (WHERE ok = 0) AS broken,
          count(*) FILTER (WHERE ok > 0 AND ok < n) AS mixed
     FROM per_filing`,
);

const { rows: failCount } = await query<{ n: string }>(
  `SELECT count(*) AS n
     FROM corpus.loans l
     ${fact("dy", "debt_yield")} ${fact("noi", "noi_underwritten")} ${SENIOR_JOINS}
    WHERE dy.value IS NOT NULL AND noi.value IS NOT NULL AND amt.value IS NOT NULL
      AND amt.value::numeric <> 0 AND dy.value::numeric <> 0
      AND abs((noi.value::numeric / NULLIF(${SENIOR}, 0))
              / NULLIF(dy.value::numeric, 0) - 1) > ${TOLERANCE}`,
);
const profileFailing = failCount[0]?.n ?? "0";

const bf = byFiling[0];
if (bf) {
  console.log(`  Tomando "debt yield = NOI / saldo" como sonda:\n`);
  console.log(`    filings evaluados        ${String(bf.filings).padStart(4)}`);
  console.log(`    todos sus préstamos OK   ${String(bf.clean).padStart(4)}`);
  console.log(`    ninguno OK               ${String(bf.broken).padStart(4)}`);
  console.log(`    mezclados                ${String(bf.mixed).padStart(4)}`);

  const total = Number(bf.filings);
  const mixed = Number(bf.mixed);
  const failing = Number(profileFailing);

  /**
   * Nombrar las emisiones que fallan enteras, no contarlas.
   *
   * "15 emisiones con ninguno OK" es una señal concentrada —una convención que
   * no modelamos, no ruido— y el conteo no deja perseguirla. Es el mismo error
   * que este archivo señala en otros lados: un diagnóstico que informa magnitud
   * en vez de identidad obliga a escribir una consulta a mano para actuar.
   */
  /**
   * La tabla de desempeño existe.
   *
   * NINGUNA OTRA COMPROBACIÓN LA MIRA
   *
   * `corpus.performance` referencia `loans(id)` con ON DELETE CASCADE, y
   * `--refresh-stale` borra los préstamos antes de reescribirlos. Cada recosecha
   * del Annex A destruye el desempeño acumulado.
   *
   * Pasó, y estuvo un día entero sin detectarse. Todo lo demás seguía sano: las
   * cinco identidades cerraban al 97%, el corpus tenía sus 8.935 préstamos, las
   * participaciones del pool sumaban 100%. Lo único que faltaba era la mitad del
   * hallazgo —el lado del resultado real— y no había nada que lo dijera.
   *
   * Es el mismo principio que la suma del pool aplicado a otra tabla: un corpus
   * al que le falta una pieza entera es indistinguible de uno correcto si nadie
   * pregunta por esa pieza.
   */
  const { rows: perf } = await query<{ filas: string; prestamos: string }>(
    `SELECT count(*)::text AS filas, count(DISTINCT loan_id)::text AS prestamos
       FROM corpus.performance`,
  );
  const perfFilas = Number(perf[0]?.filas ?? 0);

  console.log(`\n  \x1b[1mDesempeño posterior al cierre\x1b[0m`);
  if (perfFilas === 0) {
    console.log(
      `    \x1b[31mVACÍA. El hallazgo no se puede reproducir en este estado.\x1b[0m`,
    );
    console.log(
      `    \x1b[90mUna recosecha con --refresh-stale la borra: el CASCADE viene de\x1b[0m`,
    );
    console.log(
      `    \x1b[90mloans(id). Reconstruir con \x1b[0m\x1b[1mnpm run db:performance\x1b[0m`,
    );
  } else {
    console.log(
      `    ${perfFilas.toLocaleString("en-US")} filas · ${Number(perf[0]!.prestamos).toLocaleString("en-US")} préstamos`,
    );
  }

  /**
   * Las participaciones del pool tienen que sumar 100%.
   *
   * LA VERIFICACIÓN QUE FALTABA: SI SE PIERDEN PRÉSTAMOS, NADIE SE ENTERA
   *
   * Todas las demás comprobaciones de este archivo miran préstamos que están.
   * Ninguna detecta los que faltan: si el parser descarta la mitad de las filas,
   * la otra mitad sigue cerrando sus identidades, sus valores siguen siendo
   * razonables y los chequeos de sanidad siguen pasando. El corpus no tiene
   * forma de saber que le falta algo.
   *
   * Pasó con Morgan Stanley 2021-L5. Bajó de 65 a 19 préstamos entre dos
   * cosechas y solo se notó porque el total del corpus se movió 46 y alguien
   * estaba mirando por otro motivo.
   *
   * `% of Initial Pool Balance` resuelve esto: el emisor publica la
   * participación de cada préstamo sobre el pool, y por construcción suman uno.
   * Si una emisión suma 0.30, faltan dos tercios de sus préstamos, y no hace
   * falta saber cuántos debería tener ni consultar ninguna fuente externa.
   *
   * También distingue la causa. Una suma que se pasa de 1 es lo contrario:
   * filas contadas dos veces, o filas de propiedad tomadas por préstamos —que
   * es la duda que queda abierta sobre L5—.
   */
  const { rows: pool } = await query<{
    company: string; year: string; suma: string; prestamos: string; total: string;
  }>(
    `SELECT f.company_name AS company,
            extract(year FROM f.filed_at)::int::text AS year,
            round(sum(ps.value::numeric), 3)::text AS suma,
            count(*)::text AS prestamos,
            (SELECT count(*)::text FROM corpus.loans l2
              WHERE l2.accession = f.accession) AS total
       FROM corpus.loans l
       ${fact("ps", "pool_share")}
       JOIN corpus.filings f ON f.accession = l.accession
      WHERE ps.value IS NOT NULL
      GROUP BY 1, 2, f.accession
     HAVING sum(ps.value::numeric) < 0.97 OR sum(ps.value::numeric) > 1.03
      ORDER BY abs(sum(ps.value::numeric) - 1) DESC
      LIMIT 12`,
  );

  const { rows: poolTotal } = await query<{ n: string }>(
    `SELECT count(DISTINCT l.accession)::text AS n
       FROM corpus.loans l ${fact("ps", "pool_share")}
      WHERE ps.value IS NOT NULL`,
  );

  const evaluadas = Number(poolTotal[0]?.n ?? 0);
  console.log(`\n  \x1b[1mLa suma de participaciones del pool\x1b[0m`);
  console.log(
    `  \x1b[90mDetecta préstamos perdidos, que ninguna otra comprobación ve.\x1b[0m\n`,
  );

  if (evaluadas === 0) {
    console.log(`    \x1b[33mNingún filing tiene pool_share mapeado.\x1b[0m`);
  } else if (pool.length === 0) {
    console.log(
      `    \x1b[32mLas ${evaluadas} emisiones con pool_share suman 100% ± 3%.\x1b[0m`,
    );
  } else {
    console.log(`    ${pool.length} de ${evaluadas} emisiones no suman 100%:\n`);
    /**
     * La suma sola no dice cuál de las dos causas es.
     *
     * Si la emisión tiene 31 préstamos y solo 5 traen `pool_share`, el 22.8% no
     * significa que se perdieron filas: significa que la columna no se mapeó en
     * las otras 26 y estamos sumando un quinto del pool. Son dos problemas
     * distintos con dos arreglos distintos, y sin comparar contra el total de
     * préstamos de la emisión el diagnóstico apunta al lado equivocado.
     *
     * Pasó en la primera corrida de este mismo check, tres líneas después de que
     * el archivo declarara que un fallo tiene que decir cuál de sus causas es.
     */
    for (const p of pool) {
      const s = Number(p.suma);
      const con = Number(p.prestamos);
      const tot = Number(p.total);
      const dx =
        con < tot
          ? `\x1b[33mparcial: ${con}/${tot} con la columna\x1b[0m`
          : s < 1
            ? "faltan filas del Annex A"
            : "filas contadas de más";
      console.log(
        `    ${p.year}  ${p.company.slice(0, 36).padEnd(36)} ${pct(s, 1).padStart(7)}  ${String(con).padStart(3)}/${String(tot).padEnd(3)}  \x1b[90m${dx}\x1b[0m`,
      );
    }
    console.log(
      `\n    \x1b[90mSolo las que dicen "faltan filas" son préstamos perdidos. Las\x1b[0m`,
    );
    console.log(`    \x1b[90m"parcial" son un agujero de mapeo en esa emisión.\x1b[0m`);
  }

  if (Number(bf.broken) > 0) {
    const { rows: worst } = await query<{
      company: string; year: string; loans: string;
    }>(
      `WITH per_loan AS (
         SELECT l.accession,
                abs((noi.value::numeric / NULLIF(${SENIOR}, 0))
                    / NULLIF(dy.value::numeric, 0) - 1) <= ${TOLERANCE} AS ok
           FROM corpus.loans l
           ${fact("dy", "debt_yield")} ${fact("noi", "noi_underwritten")} ${SENIOR_JOINS}
          WHERE dy.value IS NOT NULL AND noi.value IS NOT NULL AND amt.value IS NOT NULL
            AND amt.value::numeric <> 0 AND dy.value::numeric <> 0
       )
       SELECT f.company_name AS company,
              extract(year FROM f.filed_at)::int::text AS year,
              count(*)::text AS loans
         FROM per_loan p
         JOIN corpus.filings f ON f.accession = p.accession
        GROUP BY 1, 2
       HAVING count(*) FILTER (WHERE ok) = 0
        ORDER BY count(*) DESC LIMIT 15`,
    );

    if (worst.length > 0) {
      console.log(`\n  \x1b[33mEmisiones donde no cierra ninguno:\x1b[0m\n`);
      for (const w of worst) {
        console.log(
          `    ${w.year}  ${w.company.slice(0, 46).padEnd(46)} ${String(w.loans).padStart(4)} préstamos`,
        );
      }
      const years = [...new Set(worst.map((w) => w.year))].sort();
      console.log(
        `\n    \x1b[90mAñadas: ${years.join(", ")}. Si se concentran en una, es una convención\x1b[0m`,
      );
      console.log(`    \x1b[90mde formato; si están repartidas, es por préstamo.\x1b[0m`);
    }
  }
  console.log();
  /**
   * Cuando el residuo es chico, decirlo.
   *
   * Esta sección se escribió cuando fallaba una de cada cuatro filas y servía
   * para decidir dónde buscar. Con el denominador correcto quedan 27 de 3.528, y
   * el texto seguía diciendo "hay de las dos cosas" —mandando a investigar un
   * problema resuelto. Un diagnóstico que no se apaga cuando la causa se arregla
   * es ruido con formato de alerta.
   */
  if (failing > 0 && failing < 60) {
    console.log(`  \x1b[32mQuedan ${failing} préstamos fuera de tolerancia sobre miles.\x1b[0m`);
    console.log(`  Es residuo: redondeo del emisor y estructuras de deuda sueltas.`);
    console.log(`  \x1b[90mNo hay patrón que perseguir hasta que ese número vuelva a crecer.\x1b[0m`);
  } else if (mixed / total < 0.2) {
    console.log(`  \x1b[33mLas fallas se concentran por filing.\x1b[0m Un filing cierra o no cierra`);
    console.log(`  entero: es un problema de formato del emisor, no de préstamos sueltos.`);
  } else if (mixed / total > 0.6) {
    console.log(`  \x1b[33mCasi todos los filings tienen préstamos buenos y malos mezclados.\x1b[0m`);
    console.log(`  El problema es por préstamo: hay que encontrar qué comparten los que fallan.`);
  } else {
    console.log(`  \x1b[33mHay de las dos cosas\x1b[0m: filings enteros rotos y filings mezclados.`);
  }
}

/**
 * Y qué tienen en común los préstamos que fallan.
 *
 * La sospecha más económica ante un factor de ~280: son préstamos con varias
 * propiedades. Si el saldo se publica a nivel préstamo y el NOI a nivel
 * propiedad —o al revés— la relación entre ambos se rompe justamente en los
 * multipropiedad, y el factor sería el número de propiedades o algo proporcional.
 */
const { rows: profile } = await query<{
  grupo: string; n: string; props: number | null; amt: number | null; noi: number | null;
}>(
  `WITH per_loan AS (
     SELECT l.id,
            abs((noi.value::numeric / NULLIF(${SENIOR}, 0))
                / NULLIF(dy.value::numeric, 0) - 1) <= ${TOLERANCE} AS ok,
            pc.value::numeric AS props,
            amt.value::numeric AS amt,
            noi.value::numeric AS noi
       FROM corpus.loans l
       ${fact("dy", "debt_yield")} ${fact("noi", "noi_underwritten")} ${SENIOR_JOINS}
       ${fact("pc", "property_count")}
      WHERE dy.value IS NOT NULL AND noi.value IS NOT NULL AND amt.value IS NOT NULL
        AND amt.value::numeric <> 0 AND dy.value::numeric <> 0
   )
   SELECT CASE WHEN ok THEN 'cierra' ELSE 'no cierra' END AS grupo,
          count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY props) AS props,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY amt)   AS amt,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY noi)   AS noi
     FROM per_loan GROUP BY 1 ORDER BY 1`,
);

if (profile.length === 2) {
  console.log(`\n  Perfil de los dos grupos:\n`);
  console.log(`    grupo          n   # propiedades         saldo mediano       NOI mediano`);
  for (const r of profile) {
    const money = (v: number | null) =>
      v === null ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
    console.log(
      `    ${r.grupo.padEnd(10)} ${String(r.n).padStart(5)}   ${(r.props === null ? "—" : Number(r.props).toFixed(1)).padStart(13)}   ` +
        `${money(r.amt).padStart(17)}   ${money(r.noi).padStart(15)}`,
    );
  }

  const ok = profile.find((r) => r.grupo === "cierra")!;
  const bad = profile.find((r) => r.grupo === "no cierra")!;
  const ratio = Number(ok.amt) / Number(bad.amt);
  console.log();
  if (Number.isFinite(ratio) && (ratio > 50 || ratio < 0.02)) {
    console.log(
      `  \x1b[31mEl saldo mediano difiere ${ratio > 1 ? ratio.toFixed(0) : (1 / ratio).toFixed(0)}x entre grupos.\x1b[0m ` +
        `El problema está en loan_amount:`,
    );
    console.log(`  o hay dos columnas distintas con el mismo nombre, o vienen en escalas distintas.`);
  } else if (Number(bad.props) > Number(ok.props)) {
    console.log(
      `  \x1b[33mLos que fallan tienen más propiedades (${Number(bad.props).toFixed(1)} contra ${Number(ok.props).toFixed(1)}).\x1b[0m`,
    );
    console.log(`  Saldo y NOI estarían publicados a niveles distintos en los multipropiedad.`);
  } else {
    console.log(`  \x1b[90mNo hay una diferencia obvia de perfil. Hay que mirar casos a mano.\x1b[0m`);
  }
}

/**
 * Cobertura: de nada sirve que una identidad cierre sobre veinte préstamos.
 */
const { rows: coverage } = await query<{ total: string }>(
  `SELECT count(*) AS total FROM corpus.loans`,
);
const total = Number(coverage[0]?.total ?? 0);
if (total > 0) {
  console.log(`\n  \x1b[90mCobertura sobre ${total} préstamos del corpus:\x1b[0m`);
  for (const r of results) {
    console.log(
      `  \x1b[90m  ${r.label.padEnd(44)} ${pct(r.n / total, 0).padStart(5)}\x1b[0m`,
    );
  }
}

console.log(`\n${"─".repeat(78)}`);
console.log(
  `\n  \x1b[90mNinguna de estas comprobaciones necesita una fuente externa: el documento\x1b[0m`,
);
console.log(`  \x1b[90mse verifica contra sí mismo.\x1b[0m\n`);

await closePool();

/**
 * ¿Qué distingue a los préstamos de LMF que el DSCR y el LTV no capturan?
 *
 *   npm run db:mechanism
 *   npm run db:mechanism -- --vendedor SMC
 *
 * DE QUÉ TIPO DE PREGUNTA ES ESTA
 *
 * Doce ataques dejaron un residuo: LMF transfiere a special servicing 1,89
 * veces más de lo esperable, controlando tipo de propiedad, añada, tercil de
 * DSCR y tercil de LTV. El exceso vive en tres subtipos de multifamily —Garden,
 * Mid Rise, Multifamily/Retail— donde está en 30,5% contra ~8% del corpus, y
 * aparece en las cuatro añadas donde tiene muestra.
 *
 * Once de esos doce ataques preguntaban "¿es un artefacto?". El que valió
 * —mapear el vendedor— preguntaba "¿qué sería esto si fuera real?".
 *
 * Esta pregunta es de la segunda clase, un paso más adelante: dado que parece
 * real, ¿POR QUÉ? Si LMF presta al mismo DSCR y al mismo LTV pero con estructura
 * más blanda, ese es el mecanismo, y explica por qué el apalancamiento
 * observable no lo capturaba.
 *
 * LOS CANDIDATOS, TODOS YA MAPEADOS
 *
 *   io_period_original      un período solo-interés largo posterga la
 *                           amortización: el préstamo llega al vencimiento con
 *                           más saldo y menos colchón
 *   reserve_replacement_*   reservas de reposición livianas dejan al inmueble
 *                           sin fondos para capex cuando el NOI se achica
 *   reserve_tilc_*          idem para comisiones y mejoras de inquilinos
 *   noi_underwritten vs
 *   noi_most_recent         cuánto del NOI suscrito era proyección y cuánto
 *                           renta ya existente al momento de originar
 *
 * El último es el más interesante: si LMF suscribe sobre NOI proyectado muy por
 * encima del histórico, está prestando contra crecimiento de renta que todavía
 * no ocurrió. Esa es exactamente la apuesta que no se cumplió en multifamily
 * 2021-2024, y sería un mecanismo, no una correlación.
 *
 * CÓMO SE COMPARA
 *
 * Contra préstamos del MISMO subtipo y la misma añada, no contra el corpus
 * entero. Si LMF concentra en Garden y Garden tiene IO más largo en general, la
 * comparación cruda mediría el subtipo.
 *
 * LO QUE ESTO NO PUEDE HACER
 *
 * Con ~59 préstamos en los subtipos afectados, esto describe un perfil; no
 * prueba causalidad. Un mecanismo plausible y consistente es más de lo que
 * teníamos, y menos que una explicación demostrada.
 *
 * DOS ARREGLOS DE UNA AUDITORÍA POSTERIOR
 *
 * 1. El porcentaje "sin reserva de reposición" contaba el NULO junto con el cero.
 *    Si el Annex A de un vendedor no publica esa columna, ese vendedor salía con
 *    100% "sin reserva" y eso se leía como diferencia estructural cuando era falta
 *    de extracción. Es la misma forma que el bug de la ocupación: ausencia del dato
 *    confundida con ausencia de la cosa. Las otras dos filas del mismo bloque ya
 *    usaban denominador de no-nulos, así que el script se contradecía a sí mismo.
 *
 * 2. No había ninguna referencia. Imprimía medianas de un vendedor contra el resto
 *    y cerraba con "una diferencia grande sería un mecanismo", sin definir grande y
 *    sin nulo. Con ~59 préstamos el ruido de muestreo en una mediana es
 *    considerable, así que el script no podía distinguir un mecanismo del azar en
 *    NINGUNA dirección — y su resultado negativo se citaba como evidencia de que no
 *    hay mecanismo.
 *
 *    Ahora hay permutación: se mezclan las etiquetas de vendedor 4.000 veces y se
 *    mide qué diferencia produce el azar. Es el mismo procedimiento que en
 *    db:composition-signal, que es la única medición de esa sesión que no hubo que
 *    corregir.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const vFlag = process.argv.indexOf("--vendedor");
const VENDEDOR = vFlag === -1 ? "LMF" : (process.argv[vFlag + 1] ?? "LMF");

/** Fijado antes de ver nada: debajo de esto la comparación no se lee. */
const MIN_CELDA = 10;

const num = (v: number | null, d = 2) => (v === null ? "—" : v.toFixed(d));

/**
 * La base: préstamos con vendedor, subtipo y añada, más las métricas candidatas.
 *
 * Se restringe a los subtipos donde vive el exceso. Comparar sobre el corpus
 * entero mezclaría el perfil de LMF en self storage con el de multifamily, y el
 * exceso está en multifamily.
 */
const SUBTIPOS = ["Garden", "Mid Rise", "Multifamily/Retail"];

const BASE = `
  SELECT l.id,
         nullif(btrim(l.loan_seller), '') AS vendedor,
         extract(year FROM f.filed_at)::int AS anada,
         nullif(btrim(fd.value), '') AS subtipo,
         (d.transfer_date IS NOT NULL)::int AS evento,
         nullif(io.value, '')::numeric   AS io_meses,
         nullif(term.value, '')::numeric AS plazo,
         nullif(rr.value, '')::numeric   AS reserva_rep,
         nullif(uw.value, '')::numeric   AS noi_uw,
         nullif(mr.value, '')::numeric   AS noi_hist,
         nullif(amt.value, '')::numeric  AS saldo
    FROM corpus.loans l
    JOIN corpus.filings f ON f.accession = l.accession
    LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
    LEFT JOIN corpus.facts fd  ON fd.loan_id = l.id AND fd.metric_key = 'property_type_detailed'
    LEFT JOIN corpus.facts io  ON io.loan_id = l.id AND io.metric_key = 'io_period_original'
                              AND io.value ~ '^[0-9.]+$'
    LEFT JOIN corpus.facts term ON term.loan_id = l.id AND term.metric_key = 'term_original'
                               AND term.value ~ '^[0-9.]+$'
    LEFT JOIN corpus.facts rr  ON rr.loan_id = l.id AND rr.metric_key = 'reserve_replacement_monthly'
                              AND rr.value ~ '^[0-9.]+$'
    LEFT JOIN corpus.facts uw  ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten'
                              AND uw.value ~ '^[0-9.]+$'
    LEFT JOIN corpus.facts mr  ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'
                              AND mr.value ~ '^[0-9.]+$'
    LEFT JOIN corpus.facts amt ON amt.loan_id = l.id AND amt.metric_key = 'loan_amount'
                              AND amt.value ~ '^[0-9.]+$'
   WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                          WHERE deal_accession IS NOT NULL)
`;

console.log(`\n${"═".repeat(78)}`);
console.log(`¿Qué tienen los préstamos de ${VENDEDOR} que el apalancamiento no muestra?`);
console.log(`${"═".repeat(78)}`);

/**
 * Se traen las FILAS, no los agregados.
 *
 * La versión anterior calculaba medianas y porcentajes en SQL. Para permutar las
 * etiquetas hace falta cada préstamo por separado: mezclar en SQL sería reescribir
 * la query 4.000 veces.
 */
const { rows: filas } = await query<{
  vendedor: string; evento: string;
  io_meses: string | null; plazo: string | null;
  reserva_rep: string | null; noi_uw: string | null; noi_hist: string | null;
  saldo: string | null;
}>(
  `WITH base AS (${BASE})
   SELECT vendedor, evento::text,
          io_meses::text, plazo::text, reserva_rep::text,
          noi_uw::text, noi_hist::text, saldo::text
     FROM base
    WHERE subtipo = ANY($1) AND vendedor IS NOT NULL`,
  [SUBTIPOS],
);

if (filas.length === 0) {
  console.log(`\n  \x1b[33mSin préstamos en ${SUBTIPOS.join(", ")}.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

interface Prestamo {
  esVendedor: boolean;
  evento: number;
  /** null significa "no lo tenemos", y se propaga: nunca se convierte en 0. */
  ioShare: number | null;
  reservaPb: number | null;
  proyeccion: number | null;
  saldo: number | null;
}

const n = (x: string | null) => (x === null || x === "" ? null : Number(x));

const datos: Prestamo[] = filas.map((r) => {
  const io = n(r.io_meses);
  const plazo = n(r.plazo);
  const rr = n(r.reserva_rep);
  const uw = n(r.noi_uw);
  const hist = n(r.noi_hist);
  const saldo = n(r.saldo);
  return {
    esVendedor: r.vendedor === VENDEDOR,
    evento: Number(r.evento),
    ioShare: io !== null && plazo ? io / plazo : null,
    /**
     * La reserva se guarda como null cuando NO SE EXTRAJO y como 0 cuando el
     * documento dice cero. La versión anterior los juntaba, y eso convertía un
     * vendedor con formato distinto en un vendedor con estructura más blanda.
     */
    reservaPb: rr !== null && saldo ? (rr * 12) / saldo * 10000 : null,
    proyeccion: uw !== null && hist ? uw / hist : null,
    saldo,
  };
});

const delVendedor = datos.filter((d) => d.esVendedor);
const delResto = datos.filter((d) => !d.esVendedor);

console.log(
  `\n\x1b[90m  Subtipos: ${SUBTIPOS.join(" · ")} — donde vive el exceso\x1b[0m\n`,
);
console.log(`  grupo        n    ev     tasa`);
console.log(`  ${"─".repeat(44)}`);
for (const [etiqueta, grupo] of [[VENDEDOR, delVendedor], ["resto", delResto]] as const) {
  const ev = grupo.reduce((a, d) => a + d.evento, 0);
  console.log(
    `  ${etiqueta.padEnd(10)} ${String(grupo.length).padStart(4)} ${String(ev).padStart(5)}  ` +
      `${grupo.length ? ((ev / grupo.length) * 100).toFixed(1).padStart(6) : "   —"}%`,
  );
}

/** Semilla fija: un p-valor que cambia entre corridas no se puede citar. */
function rng(semilla: number) {
  let s = semilla >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const mediana = (xs: number[]) => {
  if (xs.length === 0) return null;
  const o = [...xs].sort((a, b) => a - b);
  const m = o.length >> 1;
  return o.length % 2 ? o[m]! : (o[m - 1]! + o[m]!) / 2;
};

/**
 * PERMUTACIÓN: la referencia que el script no tenía.
 *
 * Se mezclan las etiquetas de vendedor entre los mismos préstamos y se recalcula
 * la diferencia de medianas. Si la observada no supera lo que produce mezclar, no
 * hay nada que explicar — y eso vale tanto para afirmar un mecanismo como para
 * descartarlo.
 *
 * Los nulos NO participan: un préstamo sin el dato no aporta ni al observado ni al
 * permutado, así que la comparación es entre los que tienen el dato en cada grupo.
 */
const PERMUTACIONES = 4000;

function permutar(
  extraer: (d: Prestamo) => number | null,
): { obs: number | null; nulo: number | null; p: number; nA: number; nB: number } {
  const conDato = datos.filter((d) => extraer(d) !== null);
  const a = conDato.filter((d) => d.esVendedor).map((d) => extraer(d)!);
  const b = conDato.filter((d) => !d.esVendedor).map((d) => extraer(d)!);
  if (a.length < 3 || b.length < 3) {
    return { obs: mediana(a), nulo: null, p: 1, nA: a.length, nB: b.length };
  }

  const obs = Math.abs(mediana(a)! - mediana(b)!);
  const todos = [...a, ...b];
  const rand = rng(0xc0ffee);
  const difs: number[] = [];

  for (let k = 0; k < PERMUTACIONES; k++) {
    // Fisher-Yates sobre una copia: mezcla las etiquetas, no los valores.
    const mezcla = [...todos];
    for (let i = mezcla.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [mezcla[i], mezcla[j]] = [mezcla[j]!, mezcla[i]!];
    }
    const pa = mezcla.slice(0, a.length);
    const pb = mezcla.slice(a.length);
    difs.push(Math.abs(mediana(pa)! - mediana(pb)!));
  }
  difs.sort((x, y) => x - y);

  return {
    obs,
    nulo: difs[Math.floor(difs.length / 2)]!,
    p: difs.filter((x) => x >= obs).length / difs.length,
    nA: a.length,
    nB: b.length,
  };
}

console.log(`\n${"─".repeat(78)}`);
console.log("El perfil, contra lo que produce mezclar las etiquetas");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  métrica                       ${VENDEDOR.padStart(9)}     resto    |dif|    nulo   p-valor    n`,
);
console.log(`  ${"─".repeat(74)}`);

const METRICAS: Array<{
  etiqueta: string;
  extraer: (d: Prestamo) => number | null;
  fmt: (v: number) => string;
}> = [
  { etiqueta: "IO / plazo", extraer: (d) => d.ioShare, fmt: (v) => v.toFixed(2) },
  { etiqueta: "Reserva repos. (pb del saldo)", extraer: (d) => d.reservaPb, fmt: (v) => v.toFixed(0) },
  { etiqueta: "NOI suscrito / histórico", extraer: (d) => d.proyeccion, fmt: (v) => v.toFixed(2) },
  { etiqueta: "Saldo (M)", extraer: (d) => d.saldo, fmt: (v) => (v / 1e6).toFixed(1) },
];

let significativas = 0;
for (const m of METRICAS) {
  const r = permutar(m.extraer);
  const conA = datos.filter((d) => d.esVendedor && m.extraer(d) !== null).map((d) => m.extraer(d)!);
  const conB = datos.filter((d) => !d.esVendedor && m.extraer(d) !== null).map((d) => m.extraer(d)!);
  const mA = mediana(conA);
  const mB = mediana(conB);
  const sig = r.nulo !== null && r.p < 0.05;
  if (sig) significativas++;

  console.log(
    `  ${m.etiqueta.padEnd(30)} ${(mA === null ? "—" : m.fmt(mA)).padStart(9)} ` +
      `${(mB === null ? "—" : m.fmt(mB)).padStart(9)} ` +
      `${(r.obs === null ? "—" : m.fmt(r.obs)).padStart(8)} ` +
      `${(r.nulo === null ? "—" : m.fmt(r.nulo)).padStart(7)} ` +
      `${sig ? "\x1b[32m" : "\x1b[90m"}${r.nulo === null ? "sin muestra" : r.p.toFixed(4)}\x1b[0m` +
      `  \x1b[90m${r.nA}/${r.nB}\x1b[0m`,
  );
}

console.log(`\n${"─".repeat(78)}\n`);

/**
 * El contraste, contra las cuatro pruebas y no contra cero.
 *
 * Con cuatro métricas al 5% se espera 0,2 falsos positivos, así que una
 * significativa ya es más de lo esperable — pero una sola métrica de cuatro con
 * p apenas debajo de 0,05 tampoco es un mecanismo demostrado.
 */
const esperadas = METRICAS.length * 0.05;
console.log(
  `  \x1b[1m${significativas} de ${METRICAS.length} métricas se apartan más que el azar\x1b[0m` +
    ` \x1b[90m(esperadas por azar: ${esperadas.toFixed(1)})\x1b[0m`,
);
console.log(
  significativas === 0
    ? `\n  \x1b[33mNingún mecanismo en estas cuatro.\x1b[0m Y ahora eso significa algo: antes el\n` +
        `  script no tenía referencia, así que "no encontré nada" era compatible con no\n` +
        `  poder encontrar nada. Con permutación, la ausencia es informativa dentro de\n` +
        `  lo que la muestra permite.`
    : `\n  \x1b[32m${significativas} candidata(s) a mecanismo.\x1b[0m Una diferencia en solo-interés o en la\n` +
        `  proyección de NOI explica por qué el mismo DSCR y el mismo LTV rinden distinto.\n` +
        `  Una diferencia en el SALDO no es mecanismo: es un confundido nuevo y queda como\n` +
        `  el próximo control.`,
);

console.log(
  `\n  \x1b[90mLos nulos no participan: un préstamo sin el dato no aporta ni al observado ni\x1b[0m`,
);
console.log(
  `  \x1b[90mal permutado. La columna n dice cuántos tenían el dato en cada grupo, y si esos\x1b[0m`,
);
console.log(
  `  \x1b[90mdos números son muy distintos, la métrica mide cobertura además de estructura.\x1b[0m`,
);
console.log(
  `\n  \x1b[90mCon ${delVendedor.length} préstamos de ${VENDEDOR} esto describe un perfil. No prueba causalidad.\x1b[0m\n`,
);

await closePool();

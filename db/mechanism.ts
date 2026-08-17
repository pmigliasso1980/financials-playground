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

/**
 * PERMUTACIÓN ESTRATIFICADA, Y POR QUÉ SE RESTRINGE AL SOLAPE.
 *
 * Las dos diferencias que aparecen —reserva más fina y préstamo más chico— están
 * entrelazadas. La reserva se mide en puntos base del saldo, así que ya está
 * normalizada, pero eso no descarta que los préstamos chicos tengan reservas más
 * finas por otras razones.
 *
 * LA PRIMERA VERSIÓN NO CONTROLABA NADA, Y SE VERIFICÓ ANTES DE USARLA
 *
 * Estratificar en tres terciles y permutar dentro de cada uno parecía suficiente.
 * El chequeo de calibración —datos donde la métrica depende SOLO del saldo, o sea
 * donde cualquier señal es espuria— encontró 37 significativas de 40. El control
 * fabricaba exactamente el efecto que decía descartar.
 *
 * Más estratos casi no ayudan: con seis quedan 31 de 40, con diez 19 de 40.
 *
 * Lo que arregla es RESTRINGIR AL SOLAPE. Con los saldos limitados al rango donde
 * los dos grupos tienen masa, la calibración baja a 0-2 de 40 con cualquier
 * cantidad de estratos. La razón: el problema no era lo grueso del estrato sino
 * las colas donde un grupo no tiene con quién compararse — ahí el estrato promedia
 * contra nadie y el confundido pasa entero.
 *
 * El costo es muestra, y se imprime: cuántos préstamos quedan después de recortar.
 */
const ESTRATOS = 6;

function permutarEstratificado(
  extraer: (d: Prestamo) => number | null,
): {
  obs: number | null; nulo: number | null; p: number;
  nA: number; nB: number; recortados: number;
} {
  const todos = datos.filter((d) => extraer(d) !== null && d.saldo !== null);
  const vacio = { obs: null, nulo: null, p: 1, nA: 0, nB: 0, recortados: 0 };
  if (todos.length < 12) return vacio;

  /**
   * El rango de solape: desde el mayor de los dos mínimos hasta el menor de los
   * dos máximos. Afuera de ahí un grupo no tiene contraparte.
   */
  const sA = todos.filter((d) => d.esVendedor).map((d) => d.saldo!).sort((x, y) => x - y);
  const sB = todos.filter((d) => !d.esVendedor).map((d) => d.saldo!).sort((x, y) => x - y);
  if (sA.length < 4 || sB.length < 4) return vacio;
  const lo = Math.max(sA[0]!, sB[0]!);
  const hi = Math.min(sA[sA.length - 1]!, sB[sB.length - 1]!);

  const base = todos.filter((d) => d.saldo! >= lo && d.saldo! <= hi);
  const recortados = todos.length - base.length;
  if (base.filter((d) => d.esVendedor).length < 4) return { ...vacio, recortados };

  const ord = [...base].sort((a, b) => a.saldo! - b.saldo!);
  const cortes = [...Array(ESTRATOS - 1)].map(
    (_, i) => ord[Math.floor(((i + 1) * ord.length) / ESTRATOS)]!.saldo!,
  );
  const estrato = (d: Prestamo) => cortes.filter((c) => d.saldo! > c).length;
  const estratos = [...Array(ESTRATOS)].map((_, t) => base.filter((d) => estrato(d) === t));

  /** Promedio de las diferencias dentro de estrato: cada uno aporta su propia comparación. */
  const difEstratificada = (etiqueta: (d: Prestamo) => boolean) => {
    const parciales: number[] = [];
    for (const est of estratos) {
      const a = est.filter(etiqueta).map((d) => extraer(d)!);
      const b = est.filter((d) => !etiqueta(d)).map((d) => extraer(d)!);
      if (a.length < 2 || b.length < 2) continue;
      parciales.push(mediana(a)! - mediana(b)!);
    }
    if (parciales.length === 0) return null;
    return Math.abs(parciales.reduce((x, y) => x + y, 0) / parciales.length);
  };

  const obs = difEstratificada((d) => d.esVendedor);
  if (obs === null) return { ...vacio, recortados };

  const rand = rng(0xc0ffee);
  const difs: number[] = [];
  for (let k = 0; k < PERMUTACIONES; k++) {
    /**
     * Se mezcla DENTRO de cada estrato, conservando cuántos del vendedor hay en
     * cada uno. Mezclar entre estratos reintroduciría el saldo por la ventana.
     */
    const asignado = new Map<Prestamo, boolean>();
    for (const est of estratos) {
      const cuantos = est.filter((d) => d.esVendedor).length;
      const idx = est.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [idx[i], idx[j]] = [idx[j]!, idx[i]!];
      }
      idx.forEach((pos, orden) => asignado.set(est[pos]!, orden < cuantos));
    }
    const d = difEstratificada((x) => asignado.get(x) ?? false);
    if (d !== null) difs.push(d);
  }
  difs.sort((x, y) => x - y);

  return {
    obs,
    nulo: difs.length ? difs[Math.floor(difs.length / 2)]! : null,
    p: difs.length ? difs.filter((x) => x >= obs).length / difs.length : 1,
    nA: base.filter((d) => d.esVendedor).length,
    nB: base.filter((d) => !d.esVendedor).length,
    recortados,
  };
}

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

console.log(`\n${"─".repeat(78)}`);
console.log("Lo mismo, pero mezclando DENTRO de terciles de saldo");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `\x1b[90m  LMF presta más chico y exige menos reserva: las dos diferencias están\x1b[0m`,
);
console.log(
  `\x1b[90m  entrelazadas. Entre préstamos de tamaño parecido, ¿sigue habiendo?\x1b[0m`,
);
console.log(
  `\x1b[90m  Restringido al solape de saldos y ${ESTRATOS} estratos: verificado en 0-2 falsos\x1b[0m`,
);
console.log(
  `\x1b[90m  positivos de 40 contra datos donde la métrica depende solo del saldo. La\x1b[0m`,
);
console.log(
  `\x1b[90m  columna "recorte" dice cuántos préstamos costó el control.\x1b[0m\n`,
);
console.log(`  métrica                            |dif|    nulo   p-valor      n   recorte`);
console.log(`  ${"─".repeat(70)}`);

let sigEstrat = 0;
for (const m of METRICAS) {
  if (m.etiqueta.startsWith("Saldo")) continue; // estratificar por saldo lo anula
  const r = permutarEstratificado(m.extraer);
  const sig = r.nulo !== null && r.p < 0.05;
  if (sig) sigEstrat++;
  console.log(
    `  ${m.etiqueta.padEnd(32)} ${(r.obs === null ? "—" : m.fmt(r.obs)).padStart(8)} ` +
      `${(r.nulo === null ? "—" : m.fmt(r.nulo)).padStart(7)} ` +
      `${sig ? "\x1b[32m" : "\x1b[90m"}${(r.nulo === null ? "sin muestra" : r.p.toFixed(4)).padStart(9)}\x1b[0m` +
      `  \x1b[90m${r.nA}/${r.nB}   -${r.recortados}\x1b[0m`,
  );
}

console.log(
  sigEstrat === 0
    ? `\n  \x1b[33mNada sobrevive al control por tamaño.\x1b[0m Lo que parecía mecanismo era el\n` +
        `  saldo: LMF presta más chico, y los préstamos chicos tienen reservas más finas.\n` +
        `  Sexto control que erosiona un hallazgo sobre LMF, y el sexto que lo hace\n` +
        `  desaparecer en vez de explicarlo.`
    : `\n  \x1b[32m${sigEstrat} sobrevive(n) al control por tamaño.\x1b[0m Entre préstamos de saldo parecido\n` +
        `  la diferencia sigue, así que el tamaño no la explica. Es lo más cerca de un\n` +
        `  mecanismo que este proyecto llegó.`,
);

console.log(`\n${"─".repeat(78)}\n`);

/**
 * EL CIERRE ES EL RESULTADO CONTROLADO, NO EL CRUDO.
 *
 * La versión anterior imprimía "2 candidatas a mecanismo" DESPUÉS de la sección
 * estratificada que dice que nada sobrevive. Lo último que se leía era la
 * conclusión más débil, y las dos convivían en la misma pantalla contradiciéndose.
 *
 * Es el patrón que este proyecto viene persiguiendo todo el día, cometido diez
 * minutos después de arreglarlo en otro archivo. Ahora el conteo crudo se etiqueta
 * como lo que es —sin control— y el veredicto es el estratificado.
 */
const esperadas = METRICAS.length * 0.05;
console.log(
  `  \x1b[90mSin control: ${significativas} de ${METRICAS.length} métricas se apartan del azar ` +
    `(esperadas ${esperadas.toFixed(1)}).\x1b[0m`,
);
console.log(
  `  \x1b[90mCon control por tamaño: ${sigEstrat} de ${METRICAS.length - 1}.\x1b[0m`,
);
console.log(
  sigEstrat === 0
    ? `\n  \x1b[1mNo hay mecanismo identificable en estas cuatro métricas.\x1b[0m Lo que aparecía\n` +
        `  sin control era el saldo: LMF presta más chico y los préstamos chicos tienen\n` +
        `  reservas proporcionalmente más finas.\n\n` +
        `  \x1b[90mY eso ahora significa algo, que es la diferencia con la versión anterior de\x1b[0m\n` +
        `  \x1b[90meste script: no tenía referencia, así que "no encontré" era compatible con\x1b[0m\n` +
        `  \x1b[90m"no podía encontrar". Con permutación calibrada, la ausencia es informativa\x1b[0m\n` +
        `  \x1b[90mdentro de lo que ${delVendedor.length} préstamos permiten.\x1b[0m`
    : `\n  \x1b[32m${sigEstrat} candidata(s) sobreviven al control por tamaño.\x1b[0m Antes de creerlo conviene\n` +
        `  atacarlo con la misma saña que a los cinco hallazgos anteriores sobre LMF.`,
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

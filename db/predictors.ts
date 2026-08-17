/**
 * ¿Qué predice la transferencia a special servicing?
 *
 *   npm run db:predictors
 *
 * POR QUÉ ESTA PREGUNTA Y NO LA DE AÑADAS
 *
 * Preguntar "¿qué añada es peor?" parte la muestra en celdas de quince casos.
 * Ayer eso mató al hallazgo del NOI —ninguna añada era distinguible de otra— y
 * hoy dejó la explicación del pico de 2023 apoyada sobre 17 eventos.
 *
 * Preguntar "¿qué características al originar predicen el problema?" agrupa las
 * cinco añadas: 335 eventos contra 8.935 préstamos. El eje temporal deja de
 * partir la muestra y pasa a ser una variable más.
 *
 * Es lo que el análisis de potencia dijo ayer: este corpus sirve para preguntas
 * transversales. La diferencia es que ahora hay una variable de resultado que no
 * es ruidosa.
 *
 * LA HIPÓTESIS QUE VIENE DE HOY
 *
 * Las siete emisiones que concentran el multifamily problemático de 2023 tienen
 * todas el mismo perfil: DSCR entre 1,28 y 1,45 y tasa entre 6,7% y 7,4%. Si eso
 * predice transferencia en TODAS las añadas, la pista era real y deja de depender
 * de una celda de 17 casos. Si solo aparece en 2023, era ruido.
 *
 * QUÉ HACE Y QUÉ NO
 *
 * Tasas de transferencia por decil de cada variable, más un cruce DSCR × tasa.
 * No es un modelo: son tabulaciones. Un modelo con 335 eventos y covariables
 * correlacionadas entre sí daría coeficientes que no se pueden interpretar, y
 * este proyecto ya tuvo suficientes números que parecían decir algo.
 *
 * EL SESGO QUE NO SE VA
 *
 * Sigue siendo stock: los préstamos que ya se resolvieron no aparecen. Eso
 * subestima a las añadas viejas de forma pareja dentro de cada decil, así que
 * afecta los niveles pero no el ORDEN entre deciles, que es lo que se lee acá.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

/** Wilson: con tasas de 2-5% la normal da intervalos que se meten en negativo. */
function wilson(k: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = k / total;
  const d = 1 + (z * z) / total;
  const c = p + (z * z) / (2 * total);
  const m = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

console.log(`\n${"═".repeat(78)}`);
console.log("Qué predice la transferencia a special servicing");
console.log(`${"═".repeat(78)}`);

/**
 * La base: un préstamo por fila, con sus métricas de originación y si transfirió.
 *
 * Solo emisiones que tienen informe del servicer: en las demás el evento no es
 * observable y contarlas como "sin transferencia" inventaría ceros.
 *
 * EL GATE CAMBIÓ, Y POR QUÉ IMPORTA
 *
 * Antes decía eso mismo pero preguntaba por `corpus.performance`, que es la
 * tabla de NOI. O sea usaba "pudimos parsear el NOI" como proxy de "hay
 * informe". El shelf BANK publica su bloque de morosidad entero y aun así
 * quedaba afuera, porque su NOI viene sin período utilizable: unos 800
 * préstamos excluidos de una pregunta que nunca necesitó el NOI.
 *
 * Ahora pregunta por `servicer_reports.deal_accession`, que se escribe apenas
 * el informe se parsea, haya dado NOI o no. Es la diferencia entre "no hubo
 * evento" y "no lo observamos" —que sin registro son la misma fila ausente.
 */
const BASE = `
  SELECT l.id,
         extract(year FROM f.filed_at)::int AS anada,
         ltv.value::numeric   AS ltv,
         dscr.value::numeric  AS dscr,
         dy.value::numeric    AS dy,
         ir.value::numeric    AS tasa,
         l.property_type,
         (d.transfer_date IS NOT NULL)::int AS evento
    FROM corpus.loans l
    JOIN corpus.filings f ON f.accession = l.accession
    LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
    LEFT JOIN corpus.facts ltv  ON ltv.loan_id = l.id AND ltv.metric_key = 'ltv'
                               AND ltv.value ~ '^-?[0-9.]+$'
    LEFT JOIN corpus.facts dscr ON dscr.loan_id = l.id AND dscr.metric_key = 'dscr'
                               AND dscr.value ~ '^-?[0-9.]+$'
    LEFT JOIN corpus.facts dy   ON dy.loan_id = l.id AND dy.metric_key = 'debt_yield'
                               AND dy.value ~ '^-?[0-9.]+$'
    LEFT JOIN corpus.facts ir   ON ir.loan_id = l.id AND ir.metric_key = 'interest_rate'
                               AND ir.value ~ '^-?[0-9.]+$'
   WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
`;

const { rows: total } = await query<{ n: string; ev: string }>(
  `WITH base AS (${BASE}) SELECT count(*)::text AS n, sum(evento)::text AS ev FROM base`,
);
console.log(
  `\n\x1b[90m  ${Number(total[0]!.n).toLocaleString("en-US")} préstamos · ` +
    `${total[0]!.ev} transferencias · tasa base ${pct(Number(total[0]!.ev) / Number(total[0]!.n))}\x1b[0m\n`,
);

/**
 * Tasa por quintil de una variable.
 *
 * Quintiles y no deciles: con 335 eventos, diez celdas dejan ~33 cada una y los
 * intervalos se solapan todos. Cinco celdas dan ~67, que ya permite ver un
 * gradiente.
 */
async function porQuintil(col: string, etiqueta: string, formato: (v: number) => string) {
  const { rows } = await query<{
    q: string; n: string; ev: string; lo: string; hi: string;
  }>(
    `WITH base AS (${BASE}),
     conq AS (
       SELECT *, ntile(5) OVER (ORDER BY ${col}) AS q
         FROM base WHERE ${col} IS NOT NULL
     )
     SELECT q::text, count(*)::text AS n, sum(evento)::text AS ev,
            min(${col})::text AS lo, max(${col})::text AS hi
       FROM conq GROUP BY q ORDER BY q`,
  );

  if (rows.length === 0) return;

  console.log(`${"─".repeat(78)}`);
  console.log(etiqueta);
  console.log(`${"─".repeat(78)}\n`);
  console.log(`  quintil        rango           n     eventos    tasa         IC 95%`);
  console.log(`  ${"─".repeat(72)}`);

  const tasas: number[] = [];
  for (const r of rows) {
    const n = Number(r.n), ev = Number(r.ev);
    const [lo, hi] = wilson(ev, n);
    tasas.push(ev / n);
    console.log(
      `    ${r.q}      ${formato(Number(r.lo))}–${formato(Number(r.hi))}`.padEnd(32) +
        `${String(n).padStart(5)}   ${String(ev).padStart(5)}    ${pct(ev / n).padStart(6)}   ` +
        `[${pct(lo).padStart(5)} , ${pct(hi).padStart(5)}]`,
    );
  }

  /**
   * ¿Los extremos se distinguen?
   *
   * Comparar Q1 contra Q5 es la lectura honesta: si sus intervalos se pisan, la
   * variable no separa nada aunque la columna del medio dibuje una tendencia.
   */
  const p = rows[0]!, u = rows[rows.length - 1]!;
  const [lo1, hi1] = wilson(Number(p.ev), Number(p.n));
  const [lo5, hi5] = wilson(Number(u.ev), Number(u.n));
  const separan = hi1 < lo5 || hi5 < lo1;
  console.log(
    `\n  Q1 vs Q5: ${pct(tasas[0]!)} contra ${pct(tasas[tasas.length - 1]!)}  ` +
      (separan
        ? `\x1b[32m← los intervalos no se pisan\x1b[0m`
        : `\x1b[90mlos intervalos se pisan: no separa\x1b[0m`),
  );
  console.log();
}

await porQuintil("dscr", "Por DSCR al originar", (v) => v.toFixed(2));
await porQuintil("ltv", "Por LTV al originar", (v) => pct(v, 0));
await porQuintil("tasa", "Por tasa de interés al originar", (v) => pct(v, 2));
await porQuintil("dy", "Por debt yield al originar", (v) => pct(v, 0));

/**
 * El cruce que viene de la pista de hoy: cobertura fina Y tasa alta.
 *
 * Los cortes salen del perfil observado en las siete emisiones de multifamily
 * 2023 —DSCR bajo 1,50 y tasa sobre 6,5%— y se aplican a TODAS las añadas. Si el
 * cuadrante "fina y cara" tiene una tasa marcadamente mayor que los otros tres,
 * la pista de hoy describe un producto y no una añada.
 */
const DSCR_CORTE = 1.5;
const TASA_CORTE = 0.065;

const { rows: cruce } = await query<{
  cobertura: string; costo: string; n: string; ev: string;
}>(
  `WITH base AS (${BASE})
   SELECT CASE WHEN dscr < ${DSCR_CORTE} THEN 'fina' ELSE 'holgada' END AS cobertura,
          CASE WHEN tasa > ${TASA_CORTE} THEN 'cara' ELSE 'barata' END AS costo,
          count(*)::text AS n, sum(evento)::text AS ev
     FROM base WHERE dscr IS NOT NULL AND tasa IS NOT NULL
    GROUP BY 1, 2 ORDER BY 1, 2`,
);

console.log(`${"─".repeat(78)}`);
console.log(`Cobertura × costo  (DSCR ${DSCR_CORTE} · tasa ${pct(TASA_CORTE, 1)})`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  cobertura   costo        n    eventos    tasa           IC 95%`);
console.log(`  ${"─".repeat(68)}`);

let peor = { k: "", tasa: 0, n: 0 };
for (const c of cruce) {
  const n = Number(c.n), ev = Number(c.ev);
  const [lo, hi] = wilson(ev, n);
  const t = ev / n;
  if (t > peor.tasa && n >= 100) peor = { k: `${c.cobertura} y ${c.costo}`, tasa: t, n };
  console.log(
    `  ${c.cobertura.padEnd(11)} ${c.costo.padEnd(8)} ${String(n).padStart(5)}   ` +
      `${String(ev).padStart(5)}    ${pct(t).padStart(6)}    [${pct(lo).padStart(5)} , ${pct(hi).padStart(5)}]`,
  );
}
console.log(
  `\n  Peor cuadrante con n ≥ 100: \x1b[1m${peor.k}\x1b[0m  ${pct(peor.tasa)} sobre ${peor.n}\n`,
);

/**
 * ¿El cuadrante malo es un fenómeno de 2023 o de todas las añadas?
 *
 * Si la tasa del cuadrante "fina y cara" es alta solo en 2023, la pista era esa
 * añada. Si es alta en varias, es el producto.
 */
const { rows: porAnada } = await query<{
  anada: string; n: string; ev: string;
}>(
  `WITH base AS (${BASE})
   SELECT anada::text, count(*)::text AS n, sum(evento)::text AS ev
     FROM base
    WHERE dscr IS NOT NULL AND tasa IS NOT NULL
      AND dscr < ${DSCR_CORTE} AND tasa > ${TASA_CORTE}
    GROUP BY 1 ORDER BY 1`,
);

console.log(`${"─".repeat(78)}`);
console.log("El cuadrante fina y cara, añada por añada");
console.log(`${"─".repeat(78)}\n`);
console.log(`  añada      n    eventos    tasa`);
console.log(`  ${"─".repeat(44)}`);

let anadasConMuestra = 0;
let anadasAltas = 0;
for (const r of porAnada) {
  const n = Number(r.n), ev = Number(r.ev);
  if (n < 30) {
    console.log(`  ${r.anada}   ${String(n).padStart(4)}    \x1b[90mn insuficiente\x1b[0m`);
    continue;
  }
  anadasConMuestra++;
  if (ev / n > 0.04) anadasAltas++;
  console.log(
    `  ${r.anada}   ${String(n).padStart(4)}    ${String(ev).padStart(5)}    ${pct(ev / n).padStart(6)}`,
  );
}

console.log();
if (anadasConMuestra >= 3 && anadasAltas >= 2) {
  console.log(
    `  \x1b[32mEl cuadrante falla en ${anadasAltas} de ${anadasConMuestra} añadas con muestra.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mLa pista de hoy describe un producto, no la añada 2023.\x1b[0m\n`,
  );
} else if (anadasConMuestra >= 3) {
  console.log(`  \x1b[33mSolo una añada muestra tasa alta.\x1b[0m`);
  console.log(
    `  \x1b[90mLa pista era 2023, no el producto. Vuelve a depender de pocos casos.\x1b[0m\n`,
  );
} else {
  console.log(
    `  \x1b[33mMenos de tres añadas con n ≥ 30 en el cuadrante: no alcanza para decidir.\x1b[0m\n`,
  );
}

/**
 * Dentro de una misma añada: ¿la variable sigue prediciendo?
 *
 * EL CONFUNDIDOR QUE DESTAPÓ LA TABLA ANTERIOR
 *
 * Los quintiles de tasa son quintiles de añada disfrazados: Q1 va de 0% a 3,56%
 * —préstamos de 2020-2021— y Q5 de 6,91% a 12% —2023-2024—. Lo mismo pasa en
 * parte con el DSCR, que cae de 2,25 mediano en 2020-2021 a 1,62-1,72 en
 * 2023-2024.
 *
 * Y las añadas están contaminadas por el sesgo de stock: el 10-D lista lo que
 * está HOY en special servicing, así que las viejas pierden lo ya resuelto. Una
 * variable correlacionada con la añada hereda ese sesgo entero.
 *
 * El LTV es la excepción: sus medianas van de 55% a 61% en las cinco añadas, sin
 * tendencia. Por eso su gradiente era el más creíble de la tabla anterior.
 *
 * ESTA ES LA PRUEBA
 *
 * Partir por añada y mirar el gradiente adentro. Si dentro de 2024 sola el
 * quintil bajo de DSCR sigue fallando más que el alto, la variable predice de
 * verdad. Si se aplana, era añada.
 *
 * Con ~1.300 préstamos y 25-47 eventos por añada las celdas quedan finas, así
 * que se usan terciles y no quintiles, y se lee el cociente extremo, no cada
 * celda.
 */
console.log(`${"─".repeat(78)}`);
console.log("Dentro de cada añada: ¿sobrevive el gradiente?");
console.log(`${"─".repeat(78)}\n`);

for (const [col, etiqueta] of [
  ["dscr", "DSCR"],
  ["ltv", "LTV"],
] as Array<[string, string]>) {
  const { rows } = await query<{
    anada: string; t: string; n: string; ev: string;
  }>(
    `WITH base AS (${BASE}),
     cont AS (
       SELECT *, ntile(3) OVER (PARTITION BY anada ORDER BY ${col}) AS t
         FROM base WHERE ${col} IS NOT NULL
     )
     SELECT anada::text, t::text, count(*)::text AS n, sum(evento)::text AS ev
       FROM cont GROUP BY anada, t ORDER BY anada, t`,
  );

  console.log(`  \x1b[1m${etiqueta}\x1b[0m   (T1 = más riesgoso según la tabla anterior)`);
  console.log(`  añada     T1            T2            T3         cociente T1/T3`);
  console.log(`  ${"─".repeat(64)}`);

  const anadas = [...new Set(rows.map((r) => r.anada))].sort();
  let sobreviven = 0;
  let evaluadas = 0;

  for (const a of anadas) {
    const ts = rows.filter((r) => r.anada === a);
    if (ts.length < 3) continue;

    /**
     * El tercil "riesgoso" es el bajo para DSCR y el alto para LTV: la tabla
     * anterior mostró que la siniestralidad cae con DSCR y sube con LTV.
     */
    const riesgoso = col === "dscr" ? ts[0]! : ts[2]!;
    const seguro = col === "dscr" ? ts[2]! : ts[0]!;

    const tr = Number(riesgoso.ev) / Number(riesgoso.n);
    const ts3 = Number(seguro.ev) / Number(seguro.n);
    const coc = ts3 > 0 ? tr / ts3 : NaN;

    evaluadas++;
    if (!Number.isNaN(coc) && coc >= 1.5) sobreviven++;

    const celdas = ts
      .map((x) => `${pct(Number(x.ev) / Number(x.n)).padStart(5)} (${String(x.ev).padStart(2)})`)
      .join("  ");

    console.log(
      `  ${a}   ${celdas}     ` +
        (Number.isNaN(coc)
          ? "\x1b[90m  —  \x1b[0m"
          : coc >= 1.5
            ? `\x1b[32m${coc.toFixed(1)}x\x1b[0m`
            : `\x1b[90m${coc.toFixed(1)}x\x1b[0m`),
    );
  }

  console.log(
    `\n  Gradiente ≥1,5x en ${sobreviven} de ${evaluadas} añadas` +
      (sobreviven >= evaluadas - 1
        ? `  \x1b[32m← sobrevive dentro de añada\x1b[0m`
        : sobreviven >= 3
          ? `  \x1b[33m← sobrevive en la mayoría\x1b[0m`
          : `  \x1b[31m← era añada disfrazada\x1b[0m`),
  );
  console.log();
}

console.log(
  `  \x1b[90mUn gradiente que sobrevive dentro de cada añada no puede ser el sesgo de\x1b[0m`,
);
console.log(
  `  \x1b[90mstock: adentro de una añada todos los préstamos tienen la misma edad y la\x1b[0m`,
);
console.log(`  \x1b[90mmisma exposición a que su caso ya se haya resuelto.\x1b[0m\n`);

/**
 * DSCR contra LTV: ¿cuál manda cuando se controla por el otro?
 *
 * POR QUÉ IMPORTA
 *
 * Las dos muestran gradientes de 6-8x y las dos sobreviven dentro de añada. Pero
 * están correlacionadas —un préstamo muy apalancado tiende a tener cobertura
 * ajustada— así que puede ser que una sea la que importa y la otra su reflejo.
 *
 * La tabla cruzada lo separa. Si al fijar el tercil de DSCR la siniestralidad
 * sigue subiendo con el LTV, las dos aportan. Si se aplana, LTV era el reflejo.
 * Y viceversa.
 *
 * NO ES UNA REGRESIÓN A PROPÓSITO
 *
 * Con 147 eventos en nueve celdas quedan ~16 por celda. Una regresión escupiría
 * dos coeficientes con intervalos enormes y la ilusión de haber controlado. La
 * tabla muestra las celdas y su n, que es lo que permite juzgar si el patrón se
 * sostiene o son tres casos.
 *
 * MECANISMO ESPERADO
 *
 * DSCR mide flujo —¿puede pagar la cuota?— y la transferencia a special servicing
 * es un evento de pago. LTV mide stock y aprieta al vencimiento. Como casi
 * ninguno de estos préstamos venció todavía, DSCR debería dominar.
 */
console.log(`${"─".repeat(78)}`);
console.log("DSCR × LTV: ¿cuál manda?");
console.log(`${"─".repeat(78)}\n`);

const { rows: cruz } = await query<{
  td: string; tl: string; n: string; ev: string;
}>(
  `WITH base AS (${BASE}),
   conts AS (
     SELECT *,
            ntile(3) OVER (ORDER BY dscr) AS td,
            ntile(3) OVER (ORDER BY ltv)  AS tl
       FROM base WHERE dscr IS NOT NULL AND ltv IS NOT NULL
   )
   SELECT td::text, tl::text, count(*)::text AS n, sum(evento)::text AS ev
     FROM conts GROUP BY td, tl ORDER BY td, tl`,
);

const celda = (td: number, tl: number) => {
  const r = cruz.find((x) => Number(x.td) === td && Number(x.tl) === tl);
  if (!r) return { n: 0, ev: 0, t: 0 };
  const n = Number(r.n), ev = Number(r.ev);
  return { n, ev, t: n > 0 ? ev / n : 0 };
};

const ETQ_D = ["DSCR bajo ", "DSCR medio", "DSCR alto "];
const ETQ_L = ["LTV bajo", "LTV medio", "LTV alto"];

console.log(`                 ${ETQ_L.map((e) => e.padEnd(16)).join("")}`);
console.log(`  ${"─".repeat(64)}`);
for (let d = 1; d <= 3; d++) {
  const fila = [1, 2, 3]
    .map((l) => {
      const c = celda(d, l);
      return `${pct(c.t).padStart(5)} (${String(c.ev).padStart(2)}/${String(c.n).padStart(3)})`.padEnd(16);
    })
    .join("");
  console.log(`  ${ETQ_D[d - 1]}    ${fila}`);
}

/**
 * Los dos efectos marginales, medidos donde el otro está fijo.
 *
 * El efecto de LTV se mide dentro del tercil de DSCR más riesgoso —donde hay
 * eventos suficientes para verlo— y el de DSCR dentro del tercil de LTV más
 * riesgoso, por la misma razón.
 */
const ltvDentroDscrBajo = celda(1, 3).t / (celda(1, 1).t || Infinity);
const dscrDentroLtvAlto = celda(1, 3).t / (celda(3, 3).t || Infinity);

console.log(`\n  Con DSCR bajo fijo, pasar de LTV bajo a alto multiplica por ` +
  `\x1b[1m${Number.isFinite(ltvDentroDscrBajo) ? ltvDentroDscrBajo.toFixed(1) : "∞"}x\x1b[0m`);
console.log(`  Con LTV alto fijo, pasar de DSCR alto a bajo multiplica por ` +
  `\x1b[1m${Number.isFinite(dscrDentroLtvAlto) ? dscrDentroLtvAlto.toFixed(1) : "∞"}x\x1b[0m`);

const ganaDscr = dscrDentroLtvAlto > ltvDentroDscrBajo * 1.5;
const ganaLtv = ltvDentroDscrBajo > dscrDentroLtvAlto * 1.5;

console.log();
if (ganaDscr) {
  console.log(`  \x1b[32mDSCR domina.\x1b[0m`);
  console.log(
    `  \x1b[90mControlando por apalancamiento, la cobertura sigue separando; al revés\x1b[0m`,
  );
  console.log(`  \x1b[90mno tanto. El LTV era en buena parte su reflejo.\x1b[0m\n`);
} else if (ganaLtv) {
  console.log(`  \x1b[32mLTV domina.\x1b[0m`);
  console.log(
    `  \x1b[90mContrario al mecanismo esperado: si el evento es de pago, la cobertura\x1b[0m`,
  );
  console.log(`  \x1b[90mdebería mandar. Que no lo haga es lo interesante.\x1b[0m\n`);
} else {
  console.log(`  \x1b[33mLas dos aportan, en magnitudes parecidas.\x1b[0m`);
  console.log(
    `  \x1b[90mNinguna es reflejo de la otra: miden riesgos distintos y se suman.\x1b[0m\n`,
  );
}

console.log(
  `  \x1b[90mCon ~16 eventos por celda esto es una lectura de forma, no una medición.\x1b[0m`,
);
console.log(
  `  \x1b[90mLa esquina peor y la mejor son creíbles; las del medio, menos.\x1b[0m\n`,
);

/**
 * ¿Hay emisoras que suscriben mejor?
 *
 * LA PREGUNTA
 *
 * Las emisiones CMBS salen por "shelves" —BBCMS, Benchmark, BANK, BMO— que
 * corresponden a bancos distintos. Si una shelf tiene menos transferencias que
 * otra con préstamos del mismo perfil, eso dice algo sobre quién suscribe mejor.
 *
 * Si en cambio todas se parecen una vez ajustado el perfil, dice otra cosa
 * igual de interesante: que la shelf es una etiqueta de distribución y no un
 * estándar de suscripción. Los préstamos conduit los originan los mismos pocos
 * bancos y se venden a la emisión que toque.
 *
 * CÓMO SE CONTROLA LA COMPOSICIÓN
 *
 * Estandarización indirecta. Para cada shelf se calcula cuántas transferencias
 * ESPERARÍA tener si sus préstamos fallaran a la tasa global de su celda
 * DSCR × LTV. El cociente observado/esperado (SIR) es 1,0 si la shelf se
 * comporta como el promedio dado lo que prestó.
 *
 * Es el mismo instrumento que la estandarización por tipo de activo de
 * `db:delinquency`, pero acá el ajuste es por las dos variables que hoy
 * demostraron predecir.
 *
 * LO QUE ESTA PRUEBA NO PUEDE
 *
 * La shelf no es el originador. Un deal de BBCMS puede tener préstamos
 * originados por cuatro bancos distintos, y el Annex A publica el vendedor por
 * préstamo en una columna que todavía no mapeamos. Esto mide la emisión, que es
 * una aproximación gruesa.
 */
console.log(`${"─".repeat(78)}`);
console.log("¿Hay emisoras que suscriben mejor?");
console.log(`${"─".repeat(78)}\n`);

const { rows: shelves } = await query<{
  shelf: string; n: string; ev: string; esperado: string;
}>(
  `WITH base AS (${BASE}),
   conceldas AS (
     SELECT *,
            ntile(3) OVER (ORDER BY dscr) AS td,
            ntile(3) OVER (ORDER BY ltv)  AS tl
       FROM base WHERE dscr IS NOT NULL AND ltv IS NOT NULL
   ),
   /**
    * La celda incluye la AÑADA, no solo el perfil.
    *
    * Sin eso el SIR mide edad, no calidad, y por dos caminos opuestos: una shelf
    * joven no tuvo tiempo de que sus préstamos entren a special servicing, y una
    * vieja ya vio resolverse los suyos —el 10-D lista stock, no acumulado—.
    * BANK5 (100% 2023-2024) daba 0,16 y BANK (87% 2020-2022) daba 0,34; las dos
    * puntas eran el mismo artefacto.
    *
    * Se cae el LTV del ajuste para no quedarse sin muestra: 5 añadas × 3
    * terciles de DSCR son 15 celdas con ~10 eventos. Con LTV serían 45 celdas
    * con 3 eventos, y el "ajuste" sería ruido.
    */
   tasa_celda AS (
     SELECT anada, td, avg(evento::numeric) AS tasa FROM conceldas GROUP BY anada, td
   ),
   conshelf AS (
     SELECT c.*,
            upper(split_part(
              (SELECT f2.company_name FROM corpus.loans l2
                 JOIN corpus.filings f2 ON f2.accession = l2.accession
                WHERE l2.id = c.id), ' ', 1)) AS shelf
       FROM conceldas c
   )
   SELECT s.shelf,
          count(*)::text AS n,
          sum(s.evento)::text AS ev,
          round(sum(t.tasa), 2)::text AS esperado
     FROM conshelf s
     JOIN tasa_celda t ON t.anada = s.anada AND t.td = s.td
    GROUP BY s.shelf
   HAVING count(*) >= 200
    ORDER BY count(*) DESC`,
);

console.log(`  emisora        n     obs   esperado    SIR        IC 95% del SIR`);
console.log(`  ${"─".repeat(68)}`);

/**
 * Intervalo del SIR por el método de Byar, que se porta bien con pocos eventos.
 * Si el intervalo contiene 1,0 la shelf no se distingue del promedio.
 */
function byar(obs: number, esp: number): [number, number] {
  if (esp <= 0) return [0, 0];
  const lo = obs === 0 ? 0 : (obs * (1 - 1 / (9 * obs) - 1.96 / (3 * Math.sqrt(obs))) ** 3) / esp;
  const hi = ((obs + 1) * (1 - 1 / (9 * (obs + 1)) + 1.96 / (3 * Math.sqrt(obs + 1))) ** 3) / esp;
  return [Math.max(0, lo), hi];
}

let distintas = 0;
for (const r of shelves) {
  const obs = Number(r.ev), esp = Number(r.esperado);
  const sir = esp > 0 ? obs / esp : 0;
  const [lo, hi] = byar(obs, esp);
  const distinta = lo > 1 || hi < 1;
  if (distinta) distintas++;
  console.log(
    `  ${r.shelf.padEnd(12)} ${String(r.n).padStart(5)}   ${String(obs).padStart(3)}    ` +
      `${esp.toFixed(1).padStart(6)}   ${sir.toFixed(2).padStart(5)}   ` +
      `[${lo.toFixed(2)} , ${hi.toFixed(2)}]` +
      (distinta ? `  \x1b[33m← se aparta\x1b[0m` : ""),
  );
}

console.log(
  `\n  ${distintas} de ${shelves.length} emisoras se apartan del promedio ajustado por perfil y añada.`,
);

/**
 * La mezcla de añadas de cada shelf: el dato crudo que delata el confundidor.
 *
 * Un SIR no distingue "suscribe mejor" de "es más nueva". Los pesos por añada
 * sí. BANK5 emite a 5 años desde 2023; si su columna está toda a la derecha, su
 * SIR bajo era edad y no calidad.
 */
const { rows: mezcla } = await query<{ shelf: string; anada: string; n: string }>(
  `WITH base AS (${BASE})
   SELECT upper(split_part(f.company_name, ' ', 1)) AS shelf,
          extract(year FROM f.filed_at)::int::text AS anada,
          count(*)::text AS n
     FROM base b
     JOIN corpus.loans l ON l.id = b.id
     JOIN corpus.filings f ON f.accession = l.accession
    GROUP BY 1, 2 ORDER BY 1, 2`,
);

const porShelf = new Map<string, Map<string, number>>();
for (const m of mezcla) {
  const inner = porShelf.get(m.shelf) ?? new Map<string, number>();
  inner.set(m.anada, Number(m.n));
  porShelf.set(m.shelf, inner);
}

/**
 * Cobertura del join por emisora: la hipótesis que el SIR no puede distinguir.
 *
 * El numerador cuenta solo préstamos que pegaron contra su informe del servicer.
 * El denominador es el pool entero. Si una shelf pega al 20% y otra al 80%, la
 * primera va a mostrar menos eventos aunque tenga los mismos problemas.
 *
 * Ya sabíamos que el join es desparejo —Benchmark 2020-B16 pegaba 3 de 33— pero
 * nunca lo miramos por emisora. Si BANK y BANK5 pegan mal y BBCMS pega bien, los
 * tres SIR que "se apartan" son cobertura y no suscripción.
 *
 * Es el mismo error de siempre en una forma nueva: un cociente cuyo numerador y
 * denominador vienen de fuentes con cobertura distinta.
 */
const { rows: cobertura } = await query<{ shelf: string; pool: string; pegan: string }>(
  `SELECT upper(split_part(f.company_name, ' ', 1)) AS shelf,
          count(*)::text AS pool,
          count(*) FILTER (
            WHERE EXISTS (SELECT 1 FROM corpus.performance p WHERE p.loan_id = l.id)
               OR EXISTS (SELECT 1 FROM corpus.delinquency d WHERE d.loan_id = l.id)
          )::text AS pegan
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
    WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
    GROUP BY 1`,
);

const cob = new Map(
  cobertura.map((c) => [c.shelf, Number(c.pegan) / Math.max(1, Number(c.pool))]),
);

console.log(`\n  Cobertura del join — ¿el SIR mide suscripción o cuántos pegan?\n`);
console.log(`  emisora        SIR    % de préstamos que pegan contra el 10-D`);
console.log(`  ${"─".repeat(60)}`);
for (const r of shelves) {
  const sir = Number(r.esperado) > 0 ? Number(r.ev) / Number(r.esperado) : 0;
  const c = cob.get(r.shelf) ?? 0;
  const barra = "█".repeat(Math.round(c * 20));
  console.log(
    `  ${r.shelf.padEnd(12)} ${sir.toFixed(2).padStart(5)}    ${pct(c, 0).padStart(4)}  ${barra}`,
  );
}

const conSir = shelves.map((r) => ({
  sir: Number(r.esperado) > 0 ? Number(r.ev) / Number(r.esperado) : 0,
  cob: cob.get(r.shelf) ?? 0,
}));
const n2 = conSir.length;
const mx = conSir.reduce((a, b) => a + b.sir, 0) / n2;
const my = conSir.reduce((a, b) => a + b.cob, 0) / n2;
const cov = conSir.reduce((a, b) => a + (b.sir - mx) * (b.cob - my), 0);
const sx = Math.sqrt(conSir.reduce((a, b) => a + (b.sir - mx) ** 2, 0));
const sy = Math.sqrt(conSir.reduce((a, b) => a + (b.cob - my) ** 2, 0));
const corr = sx > 0 && sy > 0 ? cov / (sx * sy) : 0;

console.log(`\n  Correlación entre SIR y cobertura del join: \x1b[1m${corr.toFixed(2)}\x1b[0m`);
if (Math.abs(corr) > 0.6) {
  console.log(
    `  \x1b[31mEl SIR sigue a la cobertura. No mide suscripción: mide cuántos pegan.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mArreglar el join de las emisoras con cobertura baja es condición previa\x1b[0m`,
  );
  console.log(`  \x1b[90mpara poder preguntar quién suscribe mejor.\x1b[0m\n`);
} else {
  console.log(
    `  \x1b[32mNo hay relación fuerte: la cobertura no explica las diferencias.\x1b[0m\n`,
  );
}

const cols = ["2020", "2021", "2022", "2023", "2024", "2025", "2026"];
console.log(`\n  Mezcla de añadas — ¿el SIR mide calidad o edad?\n`);
console.log(`  emisora      ${cols.map((a) => a.slice(2).padStart(5)).join("")}`);
console.log(`  ${"─".repeat(52)}`);
for (const r of shelves) {
  const inner = porShelf.get(r.shelf) ?? new Map<string, number>();
  const tot = [...inner.values()].reduce((a, b) => a + b, 0) || 1;
  console.log(
    `  ${r.shelf.padEnd(12)} ` +
      cols.map((a) => `${Math.round(((inner.get(a) ?? 0) / tot) * 100)}%`.padStart(5)).join(""),
  );
}
console.log();
if (distintas === 0) {
  console.log(
    `\n  \x1b[32mNinguna se distingue una vez ajustado por DSCR y LTV.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mLa emisión no es un estándar de suscripción: es una etiqueta de\x1b[0m`,
  );
  console.log(
    `  \x1b[90mdistribución. Lo que separa préstamos buenos de malos son los números\x1b[0m`,
  );
  console.log(`  \x1b[90mdel préstamo, no de quién lleva el nombre.\x1b[0m\n`);
} else {
  console.log(
    `\n  \x1b[33mHay emisoras que se apartan.\x1b[0m Antes de leerlo como calidad de`,
  );
  console.log(
    `  \x1b[90msuscripción hay que descartar que sea concentración por añada: una shelf\x1b[0m`,
  );
  console.log(`  \x1b[90mcon más deals de 2023 hereda su exposición.\x1b[0m\n`);
}

await closePool();

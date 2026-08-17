/**
 * Morosidad y special servicing por añada.
 *
 *   npm run db:delinquency
 *
 * EL ORDEN IMPORTA Y ESTÁ FORZADO POR EL CÓDIGO
 *
 * Primero la identidad, después las tasas. Si la identidad no cierra, el script
 * NO reporta tasas: imprime los desvíos y termina.
 *
 * Eso no es prolijidad. Con el NOI construimos el análisis primero y la
 * verificación meses después, y el resultado vivió un año sin que nadie pudiera
 * romperlo. Acá la verificación está antes por construcción, no por disciplina.
 *
 * LA IDENTIDAD
 *
 * `months_delinquent` y `paid_through` son el mismo hecho por dos caminos: los
 * meses de atraso tienen que ser ≈ (fin del período − paid through) / 30,44. Que
 * dos columnas mapeadas por separado coincidan sobre cientos de filas es la
 * misma clase de evidencia que las identidades del Annex A.
 *
 * DOS EVENTOS DISTINTOS
 *
 * Benchmark 2020-B16 tiene un préstamo transferido a special servicing que paga
 * al día. La transferencia es la señal temprana; el atraso, el síntoma tardío.
 * Se reportan por separado porque miden cosas distintas.
 *
 * EL DENOMINADOR ES UNA COTA
 *
 * El numerador solo cuenta préstamos que pegaron contra el informe del servicer.
 * El denominador es el pool completo de esas emisiones, incluidos los que no
 * pegaron. Donde el join es parcial —Benchmark 2020-B16 pega 3 de 33— la tasa
 * queda subestimada. Por eso se reporta también restringido a emisiones con join
 * mayoritario: si las dos versiones dicen lo mismo, el sesgo no manda.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Umbrales fijados antes de ver los números. */
const IDENTIDAD_MINIMA = 0.9;
const TOLERANCIA_MESES = 1;
const JOIN_MAYORITARIO = 0.5;

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

console.log(`\n${"═".repeat(78)}`);
console.log("Morosidad y special servicing");
console.log(`${"═".repeat(78)}`);

// ---------------------------------------------------------------------------
// 1. La identidad, antes que nada
// ---------------------------------------------------------------------------

const { rows: ident } = await query<{
  n: string; cierra: string;
}>(
  `SELECT count(*)::text AS n,
          count(*) FILTER (
            WHERE abs(
              greatest(0, floor((period - paid_through) / 30.44))
              - months_delinquent
            ) <= ${TOLERANCIA_MESES}
          )::text AS cierra
     FROM corpus.delinquency
    WHERE period IS NOT NULL AND paid_through IS NOT NULL
      AND months_delinquent IS NOT NULL`,
);

const n = Number(ident[0]?.n ?? 0);
const cierra = Number(ident[0]?.cierra ?? 0);

console.log(`\n${"─".repeat(78)}`);
console.log("Identidad: meses de atraso ≈ (período − paid through) / 30,44");
console.log(`${"─".repeat(78)}\n`);

if (n === 0) {
  console.log(
    `  \x1b[33mNo hay filas con las dos columnas. Corré db:performance.\x1b[0m\n`,
  );
  await closePool();
  process.exit(0);
}

const share = cierra / n;
console.log(
  `  ${cierra} de ${n} cierran dentro de ±${TOLERANCIA_MESES} mes  →  ` +
    `${share >= IDENTIDAD_MINIMA ? "\x1b[32m" : "\x1b[31m"}${pct(share, 0)}\x1b[0m` +
    `   (umbral ${pct(IDENTIDAD_MINIMA, 0)})`,
);

const { rows: desvios } = await query<{
  publica: string; paid: string; periodo: string; esperado: string;
}>(
  `SELECT months_delinquent::text AS publica,
          paid_through::text AS paid,
          period::text AS periodo,
          greatest(0, floor((period - paid_through) / 30.44))::text AS esperado
     FROM corpus.delinquency
    WHERE period IS NOT NULL AND paid_through IS NOT NULL
      AND months_delinquent IS NOT NULL
      AND abs(greatest(0, floor((period - paid_through) / 30.44)) - months_delinquent)
          > ${TOLERANCIA_MESES}
    ORDER BY abs(greatest(0, floor((period - paid_through) / 30.44)) - months_delinquent) DESC
    LIMIT 5`,
);

for (const d of desvios) {
  console.log(
    `    \x1b[90mpublica ${d.publica.padStart(3)} meses · paid through ${d.paid} · ` +
      `período ${d.periodo} → ${d.esperado}\x1b[0m`,
  );
}

if (share < IDENTIDAD_MINIMA) {
  console.log(
    `\n  \x1b[31mLA IDENTIDAD NO CIERRA. No se reportan tasas.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mUna de las dos columnas no significa lo que creemos. Calcular tasas\x1b[0m`,
  );
  console.log(
    `  \x1b[90mencima sería construir sobre un dato que no entendemos — que es\x1b[0m`,
  );
  console.log(`  \x1b[90mexactamente lo que pasó con el NOI.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Tasas por añada, con intervalo
// ---------------------------------------------------------------------------

/**
 * Intervalo de Wilson, no la aproximación normal.
 *
 * Con tasas bajas y n moderado, la normal da intervalos que se meten en
 * negativo y subestiman la incertidumbre. Wilson se porta bien en los extremos,
 * que es justo donde van a caer las añadas jóvenes.
 */
function wilson(k: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = k / total;
  const d = 1 + (z * z) / total;
  const centro = p + (z * z) / (2 * total);
  const margen = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (centro - margen) / d), Math.min(1, (centro + margen) / d)];
}

interface Anada {
  anada: string; pool: string; morosos: string; special: string; ejecucion: string;
}

async function tasas(soloJoinMayoritario: boolean): Promise<Anada[]> {
  const filtro = soloJoinMayoritario
    ? `AND f.accession IN (
         SELECT l2.accession FROM corpus.loans l2
          GROUP BY l2.accession
         HAVING count(*) FILTER (
                  WHERE EXISTS (SELECT 1 FROM corpus.performance p2 WHERE p2.loan_id = l2.id)
                     OR EXISTS (SELECT 1 FROM corpus.delinquency d2 WHERE d2.loan_id = l2.id)
                )::numeric / count(*) >= ${JOIN_MAYORITARIO}
       )`
    : "";

  const { rows } = await query<Anada>(
    `SELECT extract(year FROM f.filed_at)::int::text AS anada,
            count(*)::text AS pool,
            count(*) FILTER (WHERE d.months_delinquent > 0)::text AS morosos,
            count(*) FILTER (WHERE d.transfer_date IS NOT NULL)::text AS special,
            count(*) FILTER (WHERE d.foreclosure_date IS NOT NULL
                                OR d.reo_date IS NOT NULL)::text AS ejecucion
       FROM corpus.loans l
       JOIN corpus.filings f ON f.accession = l.accession
       LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
      WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
        ${filtro}
      GROUP BY 1 ORDER BY 1`,
  );
  return rows;
}

for (const [titulo, solo] of [
  ["Todas las emisiones con informe del servicer", false],
  [`Solo emisiones con join ≥ ${pct(JOIN_MAYORITARIO, 0)}`, true],
] as Array<[string, boolean]>) {
  const rows = await tasas(solo);
  console.log(`\n${"─".repeat(78)}`);
  console.log(titulo);
  console.log(`${"─".repeat(78)}\n`);
  console.log(`  añada   pool   special servicing        IC 95%         moroso  ejec.`);
  console.log(`  ${"─".repeat(70)}`);

  for (const r of rows) {
    const pool = Number(r.pool);
    const sp = Number(r.special);
    const [lo, hi] = wilson(sp, pool);
    console.log(
      `  ${r.anada}  ${String(pool).padStart(5)}   ${pct(sp / pool).padStart(6)} (${String(sp).padStart(3)})   ` +
        `[${pct(lo).padStart(5)} , ${pct(hi).padStart(5)}]    ` +
        `${pct(Number(r.morosos) / pool).padStart(6)}  ${pct(Number(r.ejecucion) / pool).padStart(5)}`,
    );
  }
}

/**
 * ¿Alguna añada es distinguible de otra?
 *
 * Es la pregunta que mató al hallazgo del NOI, hecha antes de afirmar nada.
 */
const rows = await tasas(false);
const conIC = rows.map((r) => {
  const pool = Number(r.pool);
  const [lo, hi] = wilson(Number(r.special), pool);
  return { anada: r.anada, lo, hi, pool };
});

const distinguibles: string[] = [];
for (let i = 0; i < conIC.length; i++) {
  for (let j = i + 1; j < conIC.length; j++) {
    const a = conIC[i]!;
    const b = conIC[j]!;
    if (a.hi < b.lo || b.hi < a.lo) distinguibles.push(`${a.anada} vs ${b.anada}`);
  }
}

const pares = (conIC.length * (conIC.length - 1)) / 2;
console.log(`\n${"─".repeat(78)}`);
console.log("Veredicto");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  Pares de añadas con intervalos que NO se pisan: ${distinguibles.length} de ${pares}`,
);
if (distinguibles.length > 0) {
  console.log(`  \x1b[32m${distinguibles.join(" · ")}\x1b[0m\n`);
  console.log(
    `  \x1b[90mEsta variable sí distingue añadas, a diferencia del crecimiento del NOI\x1b[0m`,
  );
  console.log(`  \x1b[90m—donde 0 de 10 pares eran distinguibles—.\x1b[0m\n`);
} else {
  console.log(`  \x1b[33mNinguno.\x1b[0m\n`);
  console.log(
    `  \x1b[90mLa morosidad tampoco separa añadas con esta muestra. El problema no\x1b[0m`,
  );
  console.log(`  \x1b[90mera la variable elegida.\x1b[0m\n`);
}

/**
 * ¿La añada o dos emisiones?
 *
 * Una tasa por añada promedia emisiones, y el corpus tiene pocas por año. Si el
 * exceso de una añada vive en una o dos, no es un fenómeno de mercado sino de
 * esos deals —distinto originador, distinta concentración, distinto activo—.
 *
 * El criterio se fija antes de mirar: si la emisión más afectada aporta más de
 * la mitad de los eventos de su añada, la tasa anual no describe a la añada.
 */
const CONCENTRACION_MAX = 0.5;

const { rows: porEmision } = await query<{
  anada: string; company: string; pool: string; eventos: string;
}>(
  `SELECT extract(year FROM f.filed_at)::int::text AS anada,
          f.company_name AS company,
          count(*)::text AS pool,
          count(*) FILTER (WHERE d.transfer_date IS NOT NULL)::text AS eventos
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
    WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
    GROUP BY 1, 2, f.accession
   HAVING count(*) FILTER (WHERE d.transfer_date IS NOT NULL) > 0
    ORDER BY 1, count(*) FILTER (WHERE d.transfer_date IS NOT NULL) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("¿La añada, o unas pocas emisiones?");
console.log(`${"─".repeat(78)}\n`);

const porAnada = new Map<string, typeof porEmision>();
for (const r of porEmision) {
  const list = porAnada.get(r.anada) ?? [];
  list.push(r);
  porAnada.set(r.anada, list);
}

for (const [anada, lista] of [...porAnada].sort()) {
  const total = lista.reduce((a, r) => a + Number(r.eventos), 0);
  const top = lista[0]!;
  const shareTop = Number(top.eventos) / total;
  const alerta = shareTop > CONCENTRACION_MAX;

  console.log(
    `  \x1b[1m${anada}\x1b[0m  ${total} eventos en ${lista.length} emisiones` +
      (alerta ? `  \x1b[31m← concentrado\x1b[0m` : ""),
  );
  for (const r of lista.slice(0, 3)) {
    const p = Number(r.eventos) / total;
    console.log(
      `      ${String(r.eventos).padStart(3)} de ${String(r.pool).padStart(3)} ` +
        `(${pct(Number(r.eventos) / Number(r.pool)).padStart(5)} del deal · ` +
        `${pct(p, 0).padStart(4)} de la añada)  \x1b[90m${r.company.slice(0, 38)}\x1b[0m`,
    );
  }
  if (lista.length > 3) console.log(`      \x1b[90m… y ${lista.length - 3} emisiones más\x1b[0m`);
  console.log();
}

/**
 * ¿Cuándo fallan, no cuántos fallan.
 *
 * EL CONFUNDIDOR QUE QUEDA
 *
 * El 10-D lista los préstamos que están HOY en special servicing, no los que
 * alguna vez estuvieron. Un préstamo de 2020 que entró en 2021 y se resolvió no
 * aparece; uno de 2024 todavía no tuvo tiempo de entrar. Eso produce un pico en
 * las añadas de edad intermedia sin que tengan nada de malo, y es la explicación
 * más económica del 6,1% de 2023.
 *
 * `transfer_date` permite distinguirlo sin bajar informes históricos: para cada
 * evento sabemos cuántos meses pasaron entre el cierre de la emisión y la
 * transferencia.
 *
 *   Si 2023 falla a la MISMA antigüedad que las demás → es stock, no calidad.
 *     Todas las añadas transfieren a los ~30 meses; 2023 está en esa ventana
 *     ahora y las otras ya pasaron.
 *
 *   Si 2023 falla ANTES —a los 18 meses donde otras tardan 40— eso no lo explica
 *     el stock. Un préstamo que se rompe en año y medio se suscribió mal.
 *
 * La segunda columna es la tasa por año de exposición, que normaliza
 * parcialmente por edad: eventos dividido años desde el cierre. Es cruda —supone
 * riesgo constante en el tiempo, que es falso— pero mueve el número en la
 * dirección correcta y muestra si el pico sobrevive al ajuste.
 */
const { rows: timing } = await query<{
  anada: string; n: string; p25: number | null; mediana: number | null;
  p75: number | null; edad: number | null; pool: string;
}>(
  `WITH ev AS (
     SELECT extract(year FROM f.filed_at)::int AS anada,
            (d.transfer_date - f.filed_at) / 30.44 AS meses_al_evento,
            (CURRENT_DATE - f.filed_at) / 365.25 AS edad_anos
       FROM corpus.delinquency d
       JOIN corpus.loans l ON l.id = d.loan_id
       JOIN corpus.filings f ON f.accession = l.accession
      WHERE d.transfer_date IS NOT NULL
        AND d.transfer_date >= f.filed_at
   ),
   po AS (
     SELECT extract(year FROM f.filed_at)::int AS anada, count(*) AS pool
       FROM corpus.loans l JOIN corpus.filings f ON f.accession = l.accession
      WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
      GROUP BY 1
   )
   SELECT ev.anada::text AS anada,
          count(*)::text AS n,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY meses_al_evento) AS p25,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY meses_al_evento) AS mediana,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY meses_al_evento) AS p75,
          max(ev.edad_anos) AS edad,
          max(po.pool)::text AS pool
     FROM ev JOIN po ON po.anada = ev.anada
    GROUP BY ev.anada ORDER BY ev.anada`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("¿Cuándo fallan? Meses entre el cierre y la transferencia");
console.log(`${"─".repeat(78)}\n`);
console.log(`  añada    n    p25   mediana   p75    edad    eventos por 1.000 préstamos-año`);
console.log(`  ${"─".repeat(74)}`);

for (const t of timing) {
  const pool = Number(t.pool);
  const edad = Number(t.edad);
  const tasa = pool > 0 && edad > 0 ? (Number(t.n) / (pool * edad)) * 1000 : 0;
  console.log(
    `  ${t.anada}  ${String(t.n).padStart(3)}   ` +
      `${(t.p25 ?? 0).toFixed(0).padStart(3)}    ${(t.mediana ?? 0).toFixed(0).padStart(3)}    ` +
      `${(t.p75 ?? 0).toFixed(0).padStart(3)}   ${edad.toFixed(1)}a          ${tasa.toFixed(1).padStart(5)}`,
  );
}

const medianas = timing
  .filter((t) => t.mediana !== null)
  .map((t) => ({ anada: t.anada, m: Number(t.mediana) }));
if (medianas.length >= 2) {
  const lento = medianas.reduce((a, b) => (a.m > b.m ? a : b));
  const rapido = medianas.reduce((a, b) => (a.m < b.m ? a : b));
  console.log(
    `\n  Más rápido en fallar: \x1b[1m${rapido.anada}\x1b[0m a los ${rapido.m.toFixed(0)} meses · ` +
      `más lento: ${lento.anada} a los ${lento.m.toFixed(0)}`,
  );
  console.log(
    `\n  \x1b[90mSi la añada con más eventos es también la más rápida en producirlos, el\x1b[0m`,
  );
  console.log(
    `  \x1b[90mstock no lo explica. Si falla a la misma antigüedad que las demás, sí.\x1b[0m\n`,
  );
}

/**
 * Incidencia a edad fija: eventos dentro de los primeros 24 meses.
 *
 * POR QUÉ EL TEST ANTERIOR NO SIRVE
 *
 * La mediana de meses hasta la transferencia cae monótona con la añada —50, 43,
 * 31, 19, 14— y eso no dice nada sobre las añadas: dice que a una emisión de
 * 2024 la venimos mirando 31 meses, así que su mediana no puede pasar de 31.
 * Es censura por la derecha, y el modo de falla del test es indistinguible de la
 * hipótesis que quería descartar.
 *
 * QUÉ ARREGLA ESTA VERSIÓN
 *
 * Fijar la ventana. Contar solo eventos ocurridos dentro de los primeros 24
 * meses desde el cierre pone a todas las añadas en la misma escala: 24 meses
 * están completamente observados para cualquier emisión con más de dos años.
 *
 * QUÉ NO ARREGLA
 *
 * El 10-D lista lo que está HOY en special servicing. Un préstamo de 2020 que
 * transfirió en el mes 18 y se resolvió en 2023 no aparece, así que su ventana
 * de 24 meses está vaciada por resolución. **La incidencia de las añadas viejas
 * queda subestimada y el sesgo crece con la edad.**
 *
 * Por eso la comparación honesta es 2023 contra 2024: las dos jóvenes, las dos
 * con 24 meses observados, las dos con poco tiempo para que se resuelva nada.
 * Las demás se muestran como referencia con la advertencia puesta.
 */
const VENTANA_MESES = 24;

const { rows: fija } = await query<{
  anada: string; pool: string; eventos: string; edad: number;
}>(
  `SELECT extract(year FROM f.filed_at)::int::text AS anada,
          count(*)::text AS pool,
          count(*) FILTER (
            WHERE d.transfer_date IS NOT NULL
              AND d.transfer_date >= f.filed_at
              AND (d.transfer_date - f.filed_at) <= ${VENTANA_MESES} * 30.44
          )::text AS eventos,
          max((CURRENT_DATE - f.filed_at) / 365.25) AS edad
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
    WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
    GROUP BY 1 ORDER BY 1`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`Incidencia a edad fija: transferencias en los primeros ${VENTANA_MESES} meses`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  añada   pool   eventos   incidencia         IC 95%        edad`);
console.log(`  ${"─".repeat(66)}`);

const fijos = fija
  .filter((r) => Number(r.edad) * 12 >= VENTANA_MESES)
  .map((r) => {
    const pool = Number(r.pool);
    const k = Number(r.eventos);
    const [lo, hi] = wilson(k, pool);
    return { anada: r.anada, pool, k, lo, hi, edad: Number(r.edad) };
  });

for (const r of fijos) {
  const viejo = r.edad > 4;
  console.log(
    `  ${r.anada}  ${String(r.pool).padStart(5)}   ${String(r.k).padStart(5)}     ` +
      `${pct(r.k / r.pool).padStart(6)}    [${pct(r.lo).padStart(5)} , ${pct(r.hi).padStart(5)}]   ` +
      `${r.edad.toFixed(1)}a` +
      (viejo ? `  \x1b[90m← vaciada por resolución\x1b[0m` : ""),
  );
}

const a23 = fijos.find((r) => r.anada === "2023");
const a24 = fijos.find((r) => r.anada === "2024");

console.log(`\n  \x1b[1mLa comparación limpia: 2023 contra 2024\x1b[0m`);
if (a23 && a24) {
  const solapan = !(a23.lo > a24.hi || a24.lo > a23.hi);
  console.log(
    `    2023  ${pct(a23.k / a23.pool)} [${pct(a23.lo)} , ${pct(a23.hi)}]` +
      `    2024  ${pct(a24.k / a24.pool)} [${pct(a24.lo)} , ${pct(a24.hi)}]`,
  );
  if (solapan) {
    console.log(`\n    \x1b[33mLos intervalos se pisan.\x1b[0m`);
    console.log(
      `    \x1b[90mA la misma edad, 2023 y 2024 no son distinguibles. El 6,1% de 2023\x1b[0m`,
    );
    console.log(
      `    \x1b[90mera la ventana de observación, no la añada. El pico se explica por\x1b[0m`,
    );
    console.log(`    \x1b[90mstock y censura.\x1b[0m\n`);
  } else {
    console.log(`\n    \x1b[32mLos intervalos NO se pisan.\x1b[0m`);
    console.log(
      `    \x1b[90mA la misma edad y con el mismo sesgo de resolución, una añada tiene\x1b[0m`,
    );
    console.log(
      `    \x1b[90mmás transferencias tempranas que la otra. Eso el stock no lo explica.\x1b[0m\n`,
    );
  }
} else {
  console.log(`    \x1b[33mFaltan datos de una de las dos añadas.\x1b[0m\n`);
}

/**
 * ¿Ya venían distintos al originar?
 *
 * LA ÚLTIMA ALTERNATIVA BARATA
 *
 * 2023 transfiere a special servicing 2,4 veces más que 2024 a la misma edad.
 * Eso sobrevivió a la identidad, al sesgo del join, a la concentración por
 * emisión y al confundidor de edad. Queda una explicación que no es sobre
 * suscripción sino sobre composición: que los préstamos de 2023 ya fueran peores
 * en el papel.
 *
 * 2023 fue el año de menor emisión CMBS de la década y el peor momento de la
 * oficina. Si esos deals traen más oficina, más apalancamiento o menos cobertura
 * al originar, el mercado ya lo sabía y no hay noticia.
 *
 * Se compara sobre el lado del Annex A, que es el dato más fuerte del corpus
 * —identidades al 97%— y que es independiente del informe del servicer.
 *
 * CÓMO SE LEE
 *
 *   perfil parecido + desempeño distinto  → es sobre suscripción
 *   perfil peor en 2023                   → es composición, no hay noticia
 */
const { rows: perfil } = await query<{
  anada: string; n: string; ltv: number | null; dscr: number | null;
  dy: number | null; office: number | null; retail: number | null;
  hotel: number | null; multi: number | null;
}>(
  `SELECT extract(year FROM f.filed_at)::int::text AS anada,
          count(*)::text AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ltv.value::numeric)  AS ltv,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY dscr.value::numeric) AS dscr,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY dy.value::numeric)   AS dy,
          avg((l.property_type ILIKE '%office%')::int)      AS office,
          avg((l.property_type ILIKE '%retail%')::int)      AS retail,
          avg((l.property_type ILIKE '%hospitality%'
               OR l.property_type ILIKE '%hotel%')::int)    AS hotel,
          avg((l.property_type ILIKE '%multifamily%')::int) AS multi
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.facts ltv  ON ltv.loan_id = l.id AND ltv.metric_key = 'ltv'
                                AND ltv.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts dscr ON dscr.loan_id = l.id AND dscr.metric_key = 'dscr'
                                AND dscr.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts dy   ON dy.loan_id = l.id AND dy.metric_key = 'debt_yield'
                                AND dy.value ~ '^-?[0-9.]+$'
    WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
    GROUP BY 1 ORDER BY 1`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("¿Ya venían distintos al originar? Perfil del Annex A");
console.log(`${"─".repeat(78)}\n`);
console.log(`  añada     n     LTV    DSCR   debt yield    oficina  retail  hotel  multi`);
console.log(`  ${"─".repeat(74)}`);

for (const r of perfil) {
  console.log(
    `  ${r.anada}  ${String(r.n).padStart(5)}   ${pct(Number(r.ltv ?? 0), 0).padStart(4)}   ` +
      `${(Number(r.dscr ?? 0)).toFixed(2).padStart(5)}   ${pct(Number(r.dy ?? 0)).padStart(6)}      ` +
      `${pct(Number(r.office ?? 0), 0).padStart(5)}   ${pct(Number(r.retail ?? 0), 0).padStart(5)}  ` +
      `${pct(Number(r.hotel ?? 0), 0).padStart(5)}  ${pct(Number(r.multi ?? 0), 0).padStart(5)}`,
  );
}

const p23 = perfil.find((r) => r.anada === "2023");
const p24 = perfil.find((r) => r.anada === "2024");

if (p23 && p24) {
  /**
   * El criterio se fija antes: 2023 "viene peor" si su LTV mediano supera al de
   * 2024 en más de 3 puntos, su DSCR es menor en más de 0,15, o su exposición a
   * oficina es mayor en más de 8 puntos. Son las tres palancas que un suscriptor
   * miraría primero.
   */
  const peorLtv = Number(p23.ltv ?? 0) - Number(p24.ltv ?? 0) > 0.03;
  const peorDscr = Number(p24.dscr ?? 0) - Number(p23.dscr ?? 0) > 0.15;
  const masOffice = Number(p23.office ?? 0) - Number(p24.office ?? 0) > 0.08;

  console.log(`\n  \x1b[1m2023 contra 2024 al originar\x1b[0m`);
  console.log(
    `    LTV      ${pct(Number(p23.ltv ?? 0), 1)} vs ${pct(Number(p24.ltv ?? 0), 1)}` +
      `   ${peorLtv ? "\x1b[33m← 2023 más apalancado\x1b[0m" : "\x1b[90msin diferencia relevante\x1b[0m"}`,
  );
  console.log(
    `    DSCR     ${Number(p23.dscr ?? 0).toFixed(2)} vs ${Number(p24.dscr ?? 0).toFixed(2)}` +
      `     ${peorDscr ? "\x1b[33m← 2023 con menos cobertura\x1b[0m" : "\x1b[90msin diferencia relevante\x1b[0m"}`,
  );
  console.log(
    `    oficina  ${pct(Number(p23.office ?? 0), 1)} vs ${pct(Number(p24.office ?? 0), 1)}` +
      `   ${masOffice ? "\x1b[33m← 2023 más expuesto\x1b[0m" : "\x1b[90msin diferencia relevante\x1b[0m"}`,
  );

  if (!peorLtv && !peorDscr && !masOffice) {
    console.log(`\n    \x1b[32mNo se explica por composición.\x1b[0m`);
    console.log(
      `    \x1b[90mLos préstamos de 2023 y 2024 se ven iguales en el papel y se rompen\x1b[0m`,
    );
    console.log(
      `    \x1b[90mdistinto. Eso es sobre suscripción, o sobre algo que el Annex A no\x1b[0m`,
    );
    console.log(`    \x1b[90mpublica.\x1b[0m\n`);
  } else {
    console.log(`\n    \x1b[33m2023 ya venía peor en el papel.\x1b[0m`);
    console.log(
      `    \x1b[90mLa diferencia de desempeño puede ser composición del pool y no\x1b[0m`,
    );
    console.log(`    \x1b[90mcalidad de la suscripción.\x1b[0m\n`);
  }
}

/**
 * La misma comparación, dentro de cada tipo de activo.
 *
 * POR QUÉ EL BLOQUE ANTERIOR NO ALCANZÓ
 *
 * Los tres umbrales que fijé —LTV, DSCR, oficina— pasaron por separado y el
 * script concluyó "no se explica por composición". Mirando la tabla se ve otra
 * cosa: 2023 tiene 17,5% oficina y 15% hotel contra 11,2% y 10% de 2024, y la
 * mitad de multifamily. Ninguna diferencia individual llegó al corte, pero
 * juntas describen un pool más riesgoso por el lado del activo.
 *
 * **Un umbral univariado deja pasar una diferencia que está repartida entre
 * varias variables.** Los valores crudos lo mostraron; el veredicto automático
 * no.
 *
 * ESTA ES LA PRUEBA DIRECTA
 *
 * Comparar 2023 contra 2024 DENTRO de cada tipo. Si la oficina de 2023 falla
 * como la de 2024 y la brecha agregada viene de que 2023 tiene más oficina,
 * es composición. Si la oficina de 2023 falla más que la de 2024, no lo es.
 *
 * Es la misma lógica de la banda de tamaño que mató al hallazgo del NOI.
 *
 * La última fila estandariza: la tasa que tendría 2023 si tuviera la mezcla de
 * activos de 2024. Si al reponderar la brecha se disuelve, era composición.
 */
const TIPOS: Array<[string, string]> = [
  ["oficina", "%office%"],
  ["retail", "%retail%"],
  ["hotel", "%hospitality%"],
  ["multifamily", "%multifamily%"],
  ["industrial", "%industrial%"],
];

console.log(`\n${"─".repeat(78)}`);
console.log(`Dentro de cada tipo de activo: 2023 contra 2024 a ${VENTANA_MESES} meses`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  tipo            2023: n    tasa        2024: n    tasa      cociente`);
console.log(`  ${"─".repeat(72)}`);

const porTipo: Array<{ tipo: string; n23: number; k23: number; n24: number; k24: number }> = [];

for (const [nombre, patron] of TIPOS) {
  const { rows } = await query<{ anada: string; pool: string; ev: string }>(
    `SELECT extract(year FROM f.filed_at)::int::text AS anada,
            count(*)::text AS pool,
            count(*) FILTER (
              WHERE d.transfer_date IS NOT NULL
                AND d.transfer_date >= f.filed_at
                AND (d.transfer_date - f.filed_at) <= ${VENTANA_MESES} * 30.44
            )::text AS ev
       FROM corpus.loans l
       JOIN corpus.filings f ON f.accession = l.accession
       LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
      WHERE l.property_type ILIKE $1
        AND extract(year FROM f.filed_at) IN (2023, 2024)
        AND f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
      GROUP BY 1 ORDER BY 1`,
    [patron],
  );

  const r23 = rows.find((r) => r.anada === "2023");
  const r24 = rows.find((r) => r.anada === "2024");
  const n23 = Number(r23?.pool ?? 0), k23 = Number(r23?.ev ?? 0);
  const n24 = Number(r24?.pool ?? 0), k24 = Number(r24?.ev ?? 0);
  if (n23 < 20 || n24 < 20) {
    console.log(`  ${nombre.padEnd(14)} \x1b[90mn insuficiente (${n23} / ${n24})\x1b[0m`);
    continue;
  }
  porTipo.push({ tipo: nombre, n23, k23, n24, k24 });

  const t23 = k23 / n23, t24 = k24 / n24;
  const coc = t24 > 0 ? t23 / t24 : NaN;
  console.log(
    `  ${nombre.padEnd(14)} ${String(n23).padStart(4)}  ${pct(t23).padStart(6)}` +
      `      ${String(n24).padStart(4)}  ${pct(t24).padStart(6)}` +
      `     ${Number.isNaN(coc) ? "  —  " : `${coc.toFixed(1)}x`}`,
  );
}

/**
 * Estandarización directa: la tasa de 2023 con la mezcla de 2024.
 *
 * Se aplican las tasas por tipo de 2023 a los pesos de 2024. Si el resultado se
 * acerca a la tasa cruda de 2024, la brecha era composición.
 */
if (porTipo.length >= 3) {
  const pool24 = porTipo.reduce((a, t) => a + t.n24, 0);
  const estandarizada = porTipo.reduce(
    (a, t) => a + (t.k23 / t.n23) * (t.n24 / pool24),
    0,
  );
  const cruda24 = porTipo.reduce((a, t) => a + t.k24, 0) / pool24;
  const cruda23 =
    porTipo.reduce((a, t) => a + t.k23, 0) / porTipo.reduce((a, t) => a + t.n23, 0);

  console.log(`\n  \x1b[1mEstandarizando 2023 a la mezcla de activos de 2024\x1b[0m`);
  console.log(`    2023 cruda          ${pct(cruda23)}`);
  console.log(`    2023 estandarizada  ${pct(estandarizada)}`);
  console.log(`    2024 cruda          ${pct(cruda24)}`);

  const brechaCruda = cruda23 - cruda24;
  const brechaEstand = estandarizada - cruda24;
  const explicado = brechaCruda !== 0 ? 1 - brechaEstand / brechaCruda : 0;

  console.log(
    `\n    La composición explica ${pct(Math.max(0, Math.min(1, explicado)), 0)} de la brecha.`,
  );
  if (brechaEstand > 0.01) {
    console.log(
      `    \x1b[32mQueda una brecha de ${pct(brechaEstand)} después de igualar la mezcla.\x1b[0m\n`,
    );
  } else {
    console.log(
      `    \x1b[33mIgualando la mezcla, la brecha desaparece: era composición.\x1b[0m\n`,
    );
  }
}

/**
 * La celda que sostiene todo: multifamily 2023.
 *
 * POR QUÉ MIRAR ACÁ
 *
 * La estandarización concluyó que la composición explica 0% de la brecha. Ese
 * veredicto depende casi enteramente de una celda: multifamily 2023, con 17
 * eventos sobre 95 préstamos —17,9%—. Como multifamily pesa 30% en la mezcla de
 * 2024, esa tasa se propaga a toda la estandarización.
 *
 * Y 17,9% de special servicing en multifamily a 24 meses no es una tasa de
 * mercado: multifamily es la clase más resistente del CMBS. Un número así
 * describe un producto concreto —préstamos puente a tasa flotante, sponsors
 * apalancados— o un error, pero no "el multifamily de 2023".
 *
 * Si los 17 están en una o dos emisiones, el resultado no es sobre la añada ni
 * sobre el tipo de activo, y toda la cadena de conclusiones se cae.
 */
const { rows: mf } = await query<{
  company: string; pool: string; eventos: string; ltv: number | null;
  dscr: number | null; tasa: number | null;
}>(
  `SELECT f.company_name AS company,
          count(*)::text AS pool,
          count(*) FILTER (
            WHERE d.transfer_date IS NOT NULL
              AND d.transfer_date >= f.filed_at
              AND (d.transfer_date - f.filed_at) <= ${VENTANA_MESES} * 30.44
          )::text AS eventos,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ltv.value::numeric)  AS ltv,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY dscr.value::numeric) AS dscr,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ir.value::numeric)   AS tasa
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
     LEFT JOIN corpus.facts ltv  ON ltv.loan_id = l.id AND ltv.metric_key = 'ltv'
                                AND ltv.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts dscr ON dscr.loan_id = l.id AND dscr.metric_key = 'dscr'
                                AND dscr.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts ir   ON ir.loan_id = l.id AND ir.metric_key = 'interest_rate'
                                AND ir.value ~ '^-?[0-9.]+$'
    WHERE l.property_type ILIKE '%multifamily%'
      AND extract(year FROM f.filed_at) = 2023
      AND f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
    GROUP BY f.company_name, f.accession
    ORDER BY count(*) FILTER (
      WHERE d.transfer_date IS NOT NULL
        AND d.transfer_date >= f.filed_at
        AND (d.transfer_date - f.filed_at) <= ${VENTANA_MESES} * 30.44
    ) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("La celda que sostiene el resultado: multifamily 2023");
console.log(`${"─".repeat(78)}\n`);
console.log(`  eventos / pool    LTV    DSCR   tasa     emisión`);
console.log(`  ${"─".repeat(72)}`);

const totalEv = mf.reduce((a, r) => a + Number(r.eventos), 0);
let acumulado = 0;

for (const r of mf.filter((x) => Number(x.eventos) > 0)) {
  acumulado += Number(r.eventos);
  console.log(
    `  ${String(r.eventos).padStart(3)} / ${String(r.pool).padEnd(4)}      ` +
      `${pct(Number(r.ltv ?? 0), 0).padStart(4)}   ${Number(r.dscr ?? 0).toFixed(2)}   ` +
      `${pct(Number(r.tasa ?? 0), 2).padStart(6)}   \x1b[90m${r.company.slice(0, 34)}\x1b[0m`,
  );
}

const conEventos = mf.filter((x) => Number(x.eventos) > 0).length;
const top2 = mf.slice(0, 2).reduce((a, r) => a + Number(r.eventos), 0);
const shareTop2 = totalEv > 0 ? top2 / totalEv : 0;

console.log(
  `\n  ${totalEv} eventos en ${conEventos} emisiones · las dos peores aportan ${pct(shareTop2, 0)}`,
);

if (shareTop2 > 0.5) {
  console.log(`\n  \x1b[31mLA CELDA ESTÁ DOMINADA POR DOS EMISIONES.\x1b[0m`);
  console.log(
    `  \x1b[90m"El multifamily de 2023" no existe como fenómeno: son esos deals. Y como\x1b[0m`,
  );
  console.log(
    `  \x1b[90mesta celda manda en la estandarización, el "0% explicado por composición"\x1b[0m`,
  );
  console.log(`  \x1b[90mtampoco se sostiene.\x1b[0m\n`);
} else {
  console.log(`\n  \x1b[32mRepartido entre ${conEventos} emisiones.\x1b[0m`);
  console.log(
    `  \x1b[90mNo es un deal puntual. Mirar LTV, DSCR y tasa: si esas emisiones traen\x1b[0m`,
  );
  console.log(
    `  \x1b[90mtasas notoriamente más altas, el producto es distinto aunque el tipo de\x1b[0m`,
  );
  console.log(`  \x1b[90mactivo se llame igual.\x1b[0m\n`);
}

console.log(
  `  \x1b[90mOJO: la exposición al riesgo crece con la edad. Una añada 2020 tuvo seis\x1b[0m`,
);
console.log(
  `  \x1b[90maños para acumular eventos y una 2024 tuvo dos. Una diferencia entre\x1b[0m`,
);
console.log(
  `  \x1b[90mañadas puede ser calidad de suscripción o simplemente tiempo, y estas\x1b[0m`,
);
console.log(`  \x1b[90mtasas no lo separan.\x1b[0m\n`);

await closePool();

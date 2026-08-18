/**
 * Suscripción contra resultado.
 *
 *   npm run db:outcomes
 *
 * LA PREGUNTA QUE ESTE SCRIPT PUEDE RESPONDER Y EL ANTERIOR NO
 *
 * Todo el análisis del Annex A medía optimismo: cuánto se despegó el suscriptor
 * del histórico. Nunca pudo decir si tenía razón. Con el NOI real del primer
 * ejercicio completo sí, y eso habilita la pregunta que importa:
 *
 *   ¿el optimismo en la originación predice el resultado?
 *
 * Hay motivo para dudar. Benchmark 2024-V7, préstamo 8: suscrito 3,4% POR DEBAJO
 * del histórico —conservador según cualquier métrica de originación— y el NOI
 * real cayó 62%. Fue el peor del pool. Si ese caso es representativo, buena
 * parte de lo que medimos con el Annex A no tiene contenido predictivo, y
 * conviene saberlo antes de construir un producto encima.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const pct = (v: number | string | null, d = 1) =>
  v === null ? "—" : `${(Number(v) * 100).toFixed(d)}%`;
const num = (v: number | string | null, d = 2) => (v === null ? "—" : Number(v).toFixed(d));

console.log(`\n${"═".repeat(78)}`);
console.log("Suscripción contra resultado");
console.log(`${"═".repeat(78)}`);

// ---------------------------------------------------------------------------
// Muestra
// ---------------------------------------------------------------------------

const { rows: sample } = await query<{
  trusts: string; loans: string; with_uw: string; with_all: string; period: string;
}>(
  `SELECT count(DISTINCT accession) AS trusts,
          count(*) AS loans,
          count(*) FILTER (WHERE noi_underwritten IS NOT NULL) AS with_uw,
          count(*) FILTER (WHERE noi_underwritten IS NOT NULL AND noi_trailing IS NOT NULL) AS with_all,
          min(noi_start)::text || ' a ' || max(noi_end)::text AS period
     FROM corpus.underwriting_outcomes`,
);

const s = sample[0];
if (!s || Number(s.with_uw) === 0) {
  console.error(`\n✗ Sin datos de desempeño. Corré primero:  npm run db:performance\n`);
  await closePool();
  process.exit(1);
}

console.log(`\n  ${s.trusts} trusts · ${s.loans} préstamos con NOI real · ${s.with_all} con las tres cifras`);
console.log(`  \x1b[90mperíodos de NOI: ${s.period}\x1b[0m`);

/**
 * Filtro de solapamiento — sin esto medimos dos veces la misma historia.
 *
 * El servicer reporta el último ejercicio que tenga disponible, y para algunos
 * préstamos ese ejercicio empieza ANTES de la originación. Un préstamo cerrado
 * en junio de 2024 con NOI reportado de octubre 2023 a septiembre 2024 no tiene
 * "resultado": ese período es casi el mismo histórico que el suscriptor miró
 * para suscribir. La brecha contra él no mide error de proyección, mide ruido.
 *
 * En la primera corrida el rango arrancaba en 2023-10-01 sobre un corpus
 * originado en 2024. Todo lo que siga usa solo períodos posteriores al cierre.
 */
const { rows: overlapRows } = await query<{ total: string; overlapping: string }>(
  `SELECT count(*) AS total,
          count(*) FILTER (WHERE days_after_origination < 0) AS overlapping
     FROM corpus.underwriting_outcomes WHERE gap_vs_actual IS NOT NULL`,
);
const ov = overlapRows[0]!;
if (Number(ov.overlapping) > 0) {
  console.log(
    `\n  \x1b[33m${ov.overlapping} de ${ov.total} préstamos tienen un período de NOI que empieza\x1b[0m`,
  );
  console.log(`  \x1b[33mANTES del cierre: solapan con el histórico y quedan excluidos.\x1b[0m`);
}

/** Cláusula común: solo desempeño genuinamente posterior a la originación. */
const POST = `gap_vs_actual IS NOT NULL AND days_after_origination >= 0`;

// ---------------------------------------------------------------------------
// A) La medición de Griffin, ahora sí comparable
// ---------------------------------------------------------------------------

const GRIFFIN_SHARE = 0.29;

const { rows: griffin } = await query<{
  n: string; median: number | null; share: number | null; p25: number | null; p75: number | null;
}>(
  `SELECT count(*) AS n,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY gap_vs_actual) AS median,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY gap_vs_actual) AS p25,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY gap_vs_actual) AS p75,
          1.0 * count(*) FILTER (WHERE gap_vs_actual >= 0.05) / count(*) AS share
     FROM corpus.underwriting_outcomes
    WHERE ${POST}`,
);

const g = griffin[0]!;
console.log(`\n\x1b[1mA. NOI suscrito contra NOI real\x1b[0m`);
console.log(`\x1b[90m   Ahora sí es la misma cantidad que mide Griffin: promesa contra resultado.\x1b[0m\n`);
console.log(`   n                      ${String(g.n).padStart(6)}`);
console.log(`   mediana                ${pct(g.median).padStart(6)}`);
console.log(`   rango intercuartil     ${pct(g.p25)} a ${pct(g.p75)}`);
console.log(`   con brecha ≥5%         ${pct(g.share, 0).padStart(6)}`);
console.log(`   \x1b[90mGriffin 2013-2019      ${(GRIFFIN_SHARE * 100).toFixed(0)}%   (n = 39.522)\x1b[0m`);

const delta = Number(g.share) - GRIFFIN_SHARE;
console.log();
if (Number(g.n) < 300) {
  console.log(`   \x1b[33mCon n = ${g.n} contra 39.522, cualquier diferencia es provisoria.\x1b[0m`);
} else if (Math.abs(delta) < 0.06) {
  console.log(`   \x1b[32mEn línea con lo publicado\x1b[0m: el fenómeno sigue con intensidad parecida`);
  console.log(`   cinco años después, medido de forma independiente.`);
} else if (delta > 0) {
  console.log(`   \x1b[33mSube ${(delta * 100).toFixed(0)} puntos sobre el período de Griffin.\x1b[0m`);
} else {
  console.log(`   \x1b[32mBaja ${Math.abs(delta * 100).toFixed(0)} puntos: la práctica se moderó.\x1b[0m`);
}

// ---------------------------------------------------------------------------
// A2) Por añada de originación
// ---------------------------------------------------------------------------

/**
 * El agregado mezcla dos mercados distintos y esconde la señal.
 *
 * Con la añada 2024 sola, la mediana daba 5,6% y el 52% de los préstamos
 * superaba el umbral. Al sumar 2020-2023 la mediana cayó a 1,0% y el share a
 * 41%. Ese movimiento no significa que la práctica sea más suave de lo que
 * pensábamos: significa que hay añadas con signos opuestos promediándose.
 *
 * La razón es evidente una vez planteada. Un préstamo originado en 2020 se
 * suscribió durante la incertidumbre de COVID, con supuestos deprimidos, y su
 * primer año completo cayó en la recuperación. Uno originado en 2024 se
 * suscribió proyectando crecimiento sobre un mercado que después quedó plano.
 * Promediarlos da un número que no describe a ninguno de los dos.
 *
 * Es el mismo error de composición que ya nos mordió con multifamily en
 * `db:challenge`, donde la participación de un tipo movía los agregados sin que
 * cambiara ningún estándar de suscripción.
 */
console.log(`\n\n\x1b[1mA2. Por añada de originación\x1b[0m`);
console.log(`\x1b[90m   El agregado promedia mercados distintos: 2020 se suscribió en plena\x1b[0m`);
console.log(`\x1b[90m   incertidumbre y cobró en la recuperación; 2024 proyectó crecimiento\x1b[0m`);
console.log(`\x1b[90m   sobre un mercado que quedó plano.\x1b[0m\n`);

const { rows: vintages } = await query<{
  vintage: string; n: string; median: number | null; share: number | null;
  projected: number | null; growth: number | null; dy_miss: number | null;
}>(
  `SELECT extract(year FROM originated_at)::int::text AS vintage,
          count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_actual) AS median,
          1.0 * count(*) FILTER (WHERE gap_vs_actual >= 0.05) / count(*) AS share,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_trailing) AS projected,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY growth_delivered) AS growth,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY (noi_actual - noi_underwritten) / NULLIF(loan_amount_senior, 0)) AS dy_miss
     FROM corpus.underwriting_outcomes
    WHERE ${POST} AND originated_at IS NOT NULL
    GROUP BY 1 HAVING count(*) >= 30
    ORDER BY 1`,
);

if (vintages.length >= 3) {
  console.log(`   añada      n   mediana   ≥5%   proyectó   entregó   error DY`);
  for (const v of vintages) {
    const hot = Number(v.share) >= GRIFFIN_SHARE;
    const cell = hot
      ? `\x1b[33m${pct(v.share, 0).padStart(5)}\x1b[0m`
      : `\x1b[32m${pct(v.share, 0).padStart(5)}\x1b[0m`;
    console.log(
      `   ${v.vintage}  ${String(v.n).padStart(5)}   ${pct(v.median).padStart(7)} ${cell}  ` +
        `${pct(v.projected).padStart(9)} ${pct(v.growth).padStart(9)}   ${pct(v.dy_miss).padStart(8)}`,
    );
  }

  /**
   * Mínimo contra máximo, no primero contra último.
   *
   * La primera versión comparaba los extremos de la serie y anunció "estable
   * entre añadas" sobre un patrón en forma de U: 2020 daba 51% y 2024 daba 52%,
   * con 2021 en 33% en el medio. Restar las puntas de una curva no lineal da
   * cero y esconde justamente la variación que se quería medir.
   *
   * El piso de muestra saca a 2020, que aporta 39 préstamos contra los ~500 de
   * las añadas centrales.
   */
  const VINTAGE_MIN_N = 100;
  const solid = vintages.filter((v) => Number(v.n) >= VINTAGE_MIN_N);
  const pool = solid.length >= 3 ? solid : vintages;
  const lo = pool.reduce((a, b) => (Number(b.share) < Number(a.share) ? b : a));
  const hi = pool.reduce((a, b) => (Number(b.share) > Number(a.share) ? b : a));
  const spread = Number(hi.share) - Number(lo.share);
  if (solid.length !== vintages.length) {
    const thin = vintages.filter((v) => Number(v.n) < VINTAGE_MIN_N).map((v) => v.vintage);
    console.log(
      `\n   \x1b[90mFuera de la comparación por muestra chica: ${thin.join(", ")}.\x1b[0m`,
    );
  }

  console.log(
    `\n   \x1b[90mGriffin midió 29% sobre 2013-2019. Su ventana termina donde arranca la\x1b[0m`,
  );
  console.log(`   \x1b[90mnuestra, así que estas filas son la continuación de su serie.\x1b[0m`);

  console.log();
  if (Math.abs(spread) > 0.12) {
    console.log(
      `   \x1b[33mLa añada importa más que el nivel:\x1b[0m ${pct(lo.share, 0)} en ${lo.vintage} ` +
        `contra ${pct(hi.share, 0)} en ${hi.vintage}.`,
    );
    console.log(`   Cualquier cifra agregada promedia esos extremos y no describe a ninguno.`);

    /**
     * La pregunta que decide qué significa la serie.
     *
     * Si el crecimiento PROYECTADO se mantuvo parecido entre añadas y el
     * ENTREGADO se derrumbó, el suscriptor no cambió: cambió el mercado. Si el
     * proyectado subió, sí hubo un cambio de práctica.
     *
     * No son lo mismo y el titular es distinto: "la suscripción se volvió más
     * agresiva" contra "las propiedades dejaron de crecer y la suscripción no se
     * ajustó".
     */
    const dProjected = Number(hi.projected) - Number(lo.projected);
    const dGrowth = Number(hi.growth) - Number(lo.growth);
    console.log();
    console.log(`   Entre ${lo.vintage} y ${hi.vintage}:`);
    console.log(
      `     crecimiento proyectado   ${pct(lo.projected)} → ${pct(hi.projected)}   ` +
        `(${dProjected >= 0 ? "+" : ""}${(dProjected * 100).toFixed(1)} pp)`,
    );
    console.log(
      `     crecimiento entregado    ${pct(lo.growth)} → ${pct(hi.growth)}   ` +
        `(${dGrowth >= 0 ? "+" : ""}${(dGrowth * 100).toFixed(1)} pp)`,
    );
    console.log();
    if (Math.abs(dGrowth) > Math.abs(dProjected) * 2) {
      console.log(
        `   \x1b[1mLo que se movió es el mercado, no la suscripción.\x1b[0m El suscriptor proyectó`,
      );
      console.log(
        `   casi lo mismo en las dos añadas; las propiedades entregaron ${Math.abs(dGrowth * 100).toFixed(0)} puntos menos.`,
      );
      console.log(
        `   \x1b[90mLa brecha crece porque la realidad cayó, no porque la promesa subiera.\x1b[0m`,
      );
    } else if (dProjected > 0.03) {
      console.log(
        `   \x1b[33mLa suscripción sí se volvió más agresiva\x1b[0m: se proyectó ${(dProjected * 100).toFixed(1)} pp más`,
      );
      console.log(`   de crecimiento en ${hi.vintage} que en ${lo.vintage}.`);
    } else {
      console.log(`   \x1b[90mProyección y resultado se movieron a la par. Sin lectura clara.\x1b[0m`);
    }
  } else {
    console.log(`   \x1b[90mEstable entre añadas: el agregado sí representa al conjunto.\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// B) ¿Sirve de algo lo que medimos con el Annex A?
// ---------------------------------------------------------------------------

console.log(`\n\n\x1b[1mB. ¿El optimismo en la originación predice el resultado?\x1b[0m`);
console.log(`\x1b[90m   Si medir contra el histórico tuviera contenido predictivo, los préstamos\x1b[0m`);
console.log(`\x1b[90m   suscritos con más optimismo deberían fallar más.\x1b[0m\n`);

const { rows: buckets } = await query<{
  bucket: string; n: string; gap_actual: number | null; growth: number | null; fail: number | null;
}>(
  `WITH b AS (
     SELECT CASE
              WHEN gap_vs_trailing <  0    THEN '1. conservador (<0%)'
              WHEN gap_vs_trailing < 0.05  THEN '2. neutral (0-5%)'
              WHEN gap_vs_trailing < 0.15  THEN '3. optimista (5-15%)'
              ELSE                              '4. muy optimista (>15%)'
            END AS bucket,
            gap_vs_actual, growth_delivered
       FROM corpus.underwriting_outcomes
      WHERE ${POST} AND gap_vs_trailing IS NOT NULL AND growth_delivered IS NOT NULL
   )
   SELECT bucket, count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_actual) AS gap_actual,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY growth_delivered) AS growth,
          1.0 * count(*) FILTER (WHERE growth_delivered < -0.10) / count(*) AS fail
     FROM b GROUP BY 1 ORDER BY 1`,
);

if (buckets.length >= 3) {
  console.log(`   tramo al originar          n   brecha vs real   creció   cayó >10%`);
  for (const b of buckets) {
    console.log(
      `   ${b.bucket.padEnd(24)} ${String(b.n).padStart(4)}   ${pct(b.gap_actual).padStart(12)}   ` +
        `${pct(b.growth).padStart(6)}   ${pct(b.fail, 0).padStart(8)}`,
    );
  }

  const first = buckets[0]!;
  const last = buckets[buckets.length - 1]!;
  const spread = Number(last.fail) - Number(first.fail);

  console.log();
  if (spread > 0.15) {
    console.log(`   \x1b[32mEl optimismo parecería predecir\x1b[0m: los muy optimistas caen ${(spread * 100).toFixed(0)} puntos más.`);
  } else if (Math.abs(spread) <= 0.15) {
    console.log(`   \x1b[33mNo hay gradiente claro (${(spread * 100).toFixed(0)} puntos entre extremos).\x1b[0m`);
  } else {
    console.log(`   \x1b[31mLa relación va al revés\x1b[0m: los conservadores caen mucho más.`);
  }
  console.log(
    `   \x1b[90mNo saques conclusiones de esta tabla todavía: las dos columnas comparten\x1b[0m`,
  );
  console.log(`   \x1b[90mdenominador. El bloque B2 controla eso.\x1b[0m`);
}

/**
 * El caso individual que motivó esta sección, en forma de conteo.
 *
 * Cuántos préstamos suscritos por debajo del histórico —los "prudentes"—
 * terminaron entre los peores resultados del corpus.
 */
const { rows: paradox } = await query<{ conservative: string; collapsed: string }>(
  `SELECT count(*) FILTER (WHERE gap_vs_trailing < 0) AS conservative,
          count(*) FILTER (WHERE gap_vs_trailing < 0 AND growth_delivered < -0.25) AS collapsed
     FROM corpus.underwriting_outcomes
    WHERE ${POST} AND gap_vs_trailing IS NOT NULL AND growth_delivered IS NOT NULL`,
);
const p = paradox[0];
if (p && Number(p.conservative) > 0) {
  const share = Number(p.collapsed) / Number(p.conservative);
  console.log(
    `\n   \x1b[90mDe ${p.conservative} préstamos suscritos POR DEBAJO del histórico, ` +
      `${p.collapsed} (${pct(share, 0)})\x1b[0m`,
  );
  console.log(`   \x1b[90mperdieron más del 25% de su NOI. La prudencia no los protegió.\x1b[0m`);
}

// ---------------------------------------------------------------------------
// B2) ¿El gradiente de B es real o aritmética?
// ---------------------------------------------------------------------------

/**
 * El bloque B compara dos cocientes que COMPARTEN DENOMINADOR.
 *
 *   gap_vs_trailing   = suscrito / histórico - 1
 *   growth_delivered  = real     / histórico - 1
 *
 * El histórico está abajo en los dos. Si para un préstamo cualquiera ese
 * histórico viene circunstancialmente alto —un año bueno, un ingreso no
 * recurrente, un inquilino que después se fue— entonces el primer cociente baja
 * (parece conservador) y el segundo también (parece que la propiedad cayó). Y al
 * revés si viene bajo. Eso produce un gradiente perfecto entre los dos, en
 * dirección negativa, SIN que exista ninguna relación real.
 *
 * Se llama sesgo de razón por denominador común, y es la explicación más
 * económica de un resultado tan prolijo como el de B —cuatro tramos monótonos
 * de -10,7% a +18,6%— que además contradice la intuición.
 *
 * El control usa un denominador que no viene del NOI: el saldo del préstamo.
 *
 *   debt yield real = NOI real / saldo senior
 *
 * El saldo lo fija el prestamista, no se deriva de ningún NOI, y no participa de
 * gap_vs_trailing. Si los préstamos suscritos con optimismo realmente terminan
 * peor, su debt yield real tiene que ser más bajo. Si el debt yield real sale
 * parejo entre tramos, el gradiente de B era del divisor y no del mundo.
 *
 * CUÁL SALDO: el senior, no la porción del trust.
 *
 * La primera versión usaba `loan_amount`, que es lo que compró esta emisión,
 * contra un NOI que es de la propiedad entera. En los préstamos repartidos entre
 * varios trusts eso infla el debt yield por el factor de reparto —hasta 288x en
 * un caso—. Las identidades aritméticas después determinaron que el emisor
 * calcula contra trust + pari passu no-trust, con 99% de coincidencia, así que
 * ese es el denominador correcto para cualquier ratio contra un NOI de la
 * propiedad.
 */
console.log(`\n\n\x1b[1mB2. Control: ¿el gradiente de B es aritmética?\x1b[0m`);
console.log(`\x1b[90m   B compara dos cocientes que comparten el histórico como denominador.\x1b[0m`);
console.log(`\x1b[90m   Eso solo ya produce un gradiente negativo sin relación real detrás.\x1b[0m`);
console.log(`\x1b[90m   Control con debt yield real (NOI real / saldo): el saldo no sale del NOI.\x1b[0m\n`);

const { rows: dyBuckets } = await query<{
  bucket: string; n: string; dy_uw: number | null; dy_actual: number | null; drop: number | null;
}>(
  `WITH b AS (
     SELECT CASE
              WHEN gap_vs_trailing <  0    THEN '1. conservador (<0%)'
              WHEN gap_vs_trailing < 0.05  THEN '2. neutral (0-5%)'
              WHEN gap_vs_trailing < 0.15  THEN '3. optimista (5-15%)'
              ELSE                              '4. muy optimista (>15%)'
            END AS bucket,
            noi_underwritten / NULLIF(loan_amount_senior, 0) AS dy_uw,
            noi_actual       / NULLIF(loan_amount_senior, 0) AS dy_actual
       FROM corpus.underwriting_outcomes
      WHERE ${POST} AND gap_vs_trailing IS NOT NULL
        AND loan_amount_senior IS NOT NULL AND loan_amount_senior > 0
   )
   SELECT bucket, count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY dy_uw)     AS dy_uw,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY dy_actual) AS dy_actual,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY dy_actual - dy_uw) AS drop
     FROM b WHERE dy_uw IS NOT NULL AND dy_actual IS NOT NULL
    GROUP BY 1 ORDER BY 1`,
);

if (dyBuckets.length >= 3) {
  console.log(`   tramo al originar          n   DY suscrito   DY real   diferencia`);
  for (const b of dyBuckets) {
    console.log(
      `   ${b.bucket.padEnd(24)} ${String(b.n).padStart(4)}   ${pct(b.dy_uw).padStart(9)}   ` +
        `${pct(b.dy_actual).padStart(7)}   ${pct(b.drop).padStart(10)}`,
    );
  }

  const dys = dyBuckets.map((b) => Number(b.dy_actual));
  const spread = Math.max(...dys) - Math.min(...dys);
  const drops = dyBuckets.map((b) => Number(b.drop));
  const dropSpread = Math.max(...drops) - Math.min(...drops);

  console.log();
  if (spread < 0.015 && dropSpread < 0.015) {
    console.log(
      `   \x1b[31mEl debt yield real es parejo entre tramos (${pct(spread)} de rango).\x1b[0m`,
    );
    console.log(`   El gradiente de B era sesgo de denominador común, no una relación.`);
    console.log(`   \x1b[1mB queda descartado.\x1b[0m Medir optimismo contra el histórico no dice`);
    console.log(`   nada sobre el resultado, ni a favor ni en contra.`);
  } else if (Number(dyBuckets[dyBuckets.length - 1]!.dy_actual) < Number(dyBuckets[0]!.dy_actual) - 0.01) {
    console.log(`   \x1b[32mLos optimistas terminan con debt yield real más bajo.\x1b[0m`);
    console.log(`   Sobrevive al control: la relación existe y va en la dirección esperada.`);
  } else {
    console.log(`   \x1b[33mHay dispersión (${pct(spread)}) pero sin orden claro.\x1b[0m`);
    console.log(`   Ni se confirma ni se descarta con esta muestra.`);
  }
}

// ---------------------------------------------------------------------------
// C) Por tipo de propiedad
// ---------------------------------------------------------------------------

console.log(`\n\n\x1b[1mC. Por tipo de propiedad\x1b[0m`);
console.log(`\x1b[90m   La escala que encontramos con el Annex A ordenaba por visibilidad de\x1b[0m`);
console.log(`\x1b[90m   renta contractual. ¿Se sostiene contra el resultado real?\x1b[0m\n`);

const { rows: byType } = await query<{
  ptype: string; n: string; vs_trailing: number | null; vs_actual: number | null;
  growth: number | null; dy_miss: number | null;
}>(
  `SELECT coalesce(nullif(property_type, ''), 'sin tipo') AS ptype,
          count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_trailing) AS vs_trailing,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_actual)   AS vs_actual,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY growth_delivered) AS growth,
          -- Métrica limpia: cuánto se apartó el debt yield real del suscrito.
          -- No comparte denominador con nada de lo anterior.
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY (noi_actual - noi_underwritten) / NULLIF(loan_amount_senior, 0)) AS dy_miss
     FROM corpus.underwriting_outcomes
    WHERE ${POST}
    GROUP BY 1 HAVING count(*) >= 8
    ORDER BY percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_actual) DESC`,
);

if (byType.length >= 3) {
  console.log(`   tipo                    n   vs histórico   vs real   creció   error DY`);
  for (const r of byType) {
    const bad = Number(r.dy_miss) < -0.01;
    const cell = bad ? `\x1b[33m${pct(r.dy_miss).padStart(8)}\x1b[0m` : pct(r.dy_miss).padStart(8);
    console.log(
      `   ${r.ptype.slice(0, 20).padEnd(20)} ${String(r.n).padStart(4)}   ` +
        `${pct(r.vs_trailing).padStart(10)}   ${pct(r.vs_actual).padStart(7)}   ` +
        `${pct(r.growth).padStart(6)}   ${cell}`,
    );
  }

  /**
   * "Error DY" es la columna con la que se puede comparar entre tipos.
   *
   * Es (NOI real − NOI suscrito) / saldo: cuántos puntos de debt yield le
   * faltaron a la propiedad para llegar a lo prometido. El saldo como
   * denominador no viene del NOI, así que no arrastra el sesgo que mató al
   * bloque B, y está en unidades comparables entre tipos —a diferencia de un
   * porcentaje sobre bases distintas.
   */
  console.log(
    `\n   \x1b[90mLa columna comparable es "error DY": (real − suscrito) / saldo, en puntos\x1b[0m`,
  );
  console.log(`   \x1b[90mde debt yield. Es la única que no comparte denominador con las otras.\x1b[0m`);

  /**
   * "sin tipo" no es un tipo de propiedad, es un agujero de mapeo.
   *
   * La primera corrida lo eligió como el peor del cuadro y produjo una frase sin
   * sentido: "sin tipo se suscribió con 6.3% sobre su histórico". Son nueve
   * préstamos a los que no les pudimos leer la categoría; meterlos en una
   * comparación entre tipos es comparar una categoría con la ausencia de una.
   *
   * Además hace falta un piso de muestra: con n de un dígito la mediana la
   * mueve un préstamo.
   */
  const NARRATIVE_MIN_N = 20;
  const real = byType.filter(
    (r) => r.ptype !== "sin tipo" && Number(r.n) >= NARRATIVE_MIN_N,
  );

  const untyped = byType.find((r) => r.ptype === "sin tipo");
  if (untyped) {
    console.log(
      `\n   \x1b[90m"sin tipo" son ${untyped.n} préstamos sin categoría mapeada, no un tipo.\x1b[0m`,
    );
    console.log(`   \x1b[90mQuedan fuera de la comparación; son deuda técnica del mapeo.\x1b[0m`);
  }

  if (real.length < 3) {
    console.log(`\n   \x1b[33mMuestra insuficiente por tipo para comparar.\x1b[0m`);
  } else {
  /**
   * "Más certero" es el más cercano a cero, no el más alto.
   *
   * Con la añada 2024 sola todos los errores eran negativos —las propiedades
   * quedaban por debajo de lo suscrito— y tomar el máximo daba, por casualidad,
   * el más cercano a cero. Al sumar 2020-2023 aparecieron errores POSITIVOS:
   * propiedades que superaron lo suscrito. Ahí el máximo dejó de significar
   * "certero" y pasó a significar "el que más se pasó para arriba", y el script
   * imprimió que Manufactured Housing con +1,5% era el más preciso cuando Self
   * Storage estaba en -0,0%.
   *
   * Una heurística que funciona solo mientras todos los signos coinciden es una
   * coincidencia, no una heurística.
   */
  const worst = real.reduce((a, b) => (Number(b.dy_miss) < Number(a.dy_miss) ? b : a));
  const over = real.reduce((a, b) => (Number(b.dy_miss) > Number(a.dy_miss) ? b : a));
  const best = real.reduce((a, b) =>
    Math.abs(Number(b.dy_miss)) < Math.abs(Number(a.dy_miss)) ? b : a,
  );

  /**
   * El contraste que invierte el hallazgo del Annex A.
   *
   * Con el Annex A solo, "riesgo" era optimismo: cuánto se despegaba el
   * suscriptor del histórico. Contra el resultado puede pasar que el tipo más
   * optimista sea el más certero y el más prudente el que más falla —porque en
   * activos volátiles anclar al histórico no es prudencia, es no tener nada
   * mejor a mano.
   */
  if (Number(worst.vs_trailing) < Number(best.vs_trailing)) {
    console.log(
      `\n   \x1b[33mSe invierte el orden del Annex A.\x1b[0m ${worst.ptype} se suscribió con ` +
        `${pct(worst.vs_trailing)} sobre`,
    );
    console.log(
      `   su histórico —el extremo prudente— y es el que más error tiene (${pct(worst.dy_miss)} de DY).`,
    );
    console.log(
      `   ${best.ptype} es el más certero: ${pct(best.dy_miss)} de desvío sobre el saldo.`,
    );
    if (Number(over.dy_miss) > 0.005 && over.ptype !== best.ptype) {
      console.log(
        `   \x1b[90mY ${over.ptype} quedó ${pct(over.dy_miss)} POR ENCIMA de lo suscrito: se suscribió\x1b[0m`,
      );
      console.log(`   \x1b[90mde menos, no de más.\x1b[0m`);
    }
    console.log(
      `\n   \x1b[90mEn originación el riesgo parece optimismo. Contra el resultado, el riesgo\x1b[0m`,
    );
    console.log(
      `   \x1b[90mes volatilidad. No son lo mismo, y el Annex A solo ve el primero.\x1b[0m`,
    );
  } else {
    console.log(
      `\n   \x1b[90mEl orden se mantiene: ${worst.ptype} es el que más error tiene (${pct(worst.dy_miss)}).\x1b[0m`,
    );
  }
  }
}

// ---------------------------------------------------------------------------
// D) ¿La muestra está sesgada?
// ---------------------------------------------------------------------------

console.log(`\n\n\x1b[1mD. Control de sesgo de muestra\x1b[0m`);
console.log(`\x1b[90m   Solo entran los préstamos cuyo servicer reportó un año completo. Si los\x1b[0m`);
console.log(`\x1b[90m   que reportan fueran sistemáticamente distintos, todo lo anterior se cae.\x1b[0m\n`);

const { rows: bias } = await query<{
  reported: string; n: string; uw_gap: number | null; dscr: number | null; ltv: number | null;
}>(
  `SELECT CASE WHEN p.loan_id IS NULL THEN 'sin reportar' ELSE 'con NOI real' END AS reported,
          count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1) AS uw_gap,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY d.value::numeric) AS dscr,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY v.value::numeric) AS ltv
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.performance p ON p.loan_id = l.id
     LEFT JOIN corpus.facts uw ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten' AND uw.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts mr ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'  AND mr.value ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts d  ON d.loan_id  = l.id AND d.metric_key  = 'dscr'             AND d.value  ~ '^-?[0-9.]+$'
     LEFT JOIN corpus.facts v  ON v.loan_id  = l.id AND v.metric_key  = 'ltv'              AND v.value  ~ '^-?[0-9.]+$'
    WHERE f.accession IN (SELECT DISTINCT accession FROM corpus.underwriting_outcomes)
    GROUP BY 1`,
);

if (bias.length === 2) {
  console.log(`   grupo             n   brecha vs hist   DSCR    LTV`);
  for (const b of bias) {
    console.log(
      `   ${b.reported.padEnd(14)} ${String(b.n).padStart(4)}   ${pct(b.uw_gap).padStart(12)}   ` +
        `${num(b.dscr).padStart(4)}  ${pct(b.ltv).padStart(6)}`,
    );
  }

  const a = bias.find((x) => x.reported === "con NOI real")!;
  const b = bias.find((x) => x.reported === "sin reportar")!;
  const gapDiff = Math.abs(Number(a.uw_gap) - Number(b.uw_gap));
  const dscrDiff = Math.abs(Number(a.dscr) - Number(b.dscr));

  console.log();
  if (gapDiff < 0.04 && dscrDiff < 0.15) {
    console.log(`   \x1b[32mLos dos grupos se parecen al originar.\x1b[0m Que un servicer reporte o no`);
    console.log(`   no depende de cómo se suscribió el préstamo: la muestra sirve.`);
  } else {
    console.log(`   \x1b[33mLos grupos difieren al originar\x1b[0m (brecha ${pct(gapDiff)}, DSCR ${num(dscrDiff)}).`);
    console.log(`   Los que reportan no son una muestra neutral: hay que decirlo en cualquier`);
    console.log(`   conclusión que salga de acá.`);
  }
}

console.log(`\n${"─".repeat(78)}`);
console.log(
  `\n  \x1b[90mPrimera vez que el corpus puede decir si una suscripción estuvo\x1b[0m`,
);
console.log(`  \x1b[90mequivocada, y no solo si fue optimista.\x1b[0m\n`);

await closePool();

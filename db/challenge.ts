/**
 * Intentos de falsear los hallazgos.
 *
 *   npm run db:challenge
 *
 * POR QUÉ EXISTE
 *
 * Dos resultados salieron del corpus:
 *
 *   A) Office se suscribe ~13% por encima de su NOI real, en 4 de cada 5 préstamos.
 *   B) Multifamily rompió en 2026 su banda de dos años en DSCR, LTV y debt yield.
 *
 * Antes de mostrárselos a alguien conviene atacarlos uno mismo. Este script lo
 * hace, y los dos cayeron.
 *
 * A aguantó cuatro pruebas —lease-up, tamaño de préstamo, emisor, selección de
 * deals— y murió en la quinta. Comparado contra industrial, que comparte
 * estructura de contrato, office solo queda arriba en 58% de los deals. Lo que
 * la brecha mide no es agresividad sino cuánta renta futura hay bajo contrato:
 * hospitality -0.5%, self storage 1.2%, retail 3.5%, industrial 10.8%,
 * office 13.1%.
 *
 * B murió antes: el "quiebre de 2026" era en parte 221 préstamos cooperativos
 * mezclados dentro de Multifamily, y el DSCR resultó plano (R² 0.06). Lo que
 * quedó en su lugar es una deriva gradual de apalancamiento desde 2024.
 *
 * Los dos reemplazos son más chicos que los titulares originales y están mejor
 * sostenidos. El script se mantiene para que cualquier hallazgo futuro pase por
 * el mismo filtro antes de que alguien construya encima.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const pct = (v: number | null, decimals = 1) =>
  v === null ? "—" : `${(v * 100).toFixed(decimals)}%`;
const num = (v: number | null, decimals = 2) => (v === null ? "—" : v.toFixed(decimals));

console.log(`\n${"═".repeat(78)}`);
console.log("Falsificación de hallazgos");
console.log(`${"═".repeat(78)}`);

// ===========================================================================
// A) Office: ¿es lease-up?
// ===========================================================================

console.log(`\n\x1b[1mA. Office se suscribe 13% por encima del NOI real\x1b[0m`);
console.log(`\x1b[90m   Hipótesis alternativa: son edificios en lease-up.\x1b[0m`);
console.log(
  `\x1b[90m   Si fuera cierto, los préstamos con más brecha tendrían ocupación baja.\x1b[0m\n`,
);

const { rows: leaseUp } = await query<{
  bucket: string; n: string; occ: number | null; gap: number | null;
}>(
  `WITH pairs AS (
     SELECT
       l.id,
       uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap,
       occ.value::numeric AS occupancy
     FROM corpus.loans l
     JOIN corpus.facts uw  ON uw.loan_id  = l.id AND uw.metric_key  = 'noi_underwritten'
     JOIN corpus.facts mr  ON mr.loan_id  = l.id AND mr.metric_key  = 'noi_most_recent'
     LEFT JOIN corpus.facts occ ON occ.loan_id = l.id AND occ.metric_key = 'occupancy'
     WHERE l.property_type = 'Office'
       AND uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$'
       AND mr.value::numeric > 0
       AND occ.value ~ '^-?[0-9.]+$'
   )
   SELECT
     CASE
       WHEN gap <  0.00 THEN '1. brecha negativa'
       WHEN gap <  0.10 THEN '2. brecha 0-10%'
       WHEN gap <  0.25 THEN '3. brecha 10-25%'
       ELSE                  '4. brecha >25%'
     END AS bucket,
     count(*) AS n,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY occupancy) AS occ,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY gap) AS gap
   FROM pairs
   GROUP BY 1 ORDER BY 1`,
);

if (leaseUp.length > 0) {
  console.log(`   ${"tramo".padEnd(20)} ${"n".padStart(5)}  ${"brecha".padStart(9)}  ${"ocupación".padStart(10)}`);
  for (const r of leaseUp) {
    console.log(
      `   ${r.bucket.padEnd(20)} ${String(r.n).padStart(5)}  ${pct(r.gap).padStart(9)}  ${pct(r.occ).padStart(10)}`,
    );
  }

  const low = leaseUp.find((r) => r.bucket.startsWith("1"));
  const high = leaseUp.find((r) => r.bucket.startsWith("4"));
  if (low?.occ != null && high?.occ != null) {
    const delta = low.occ - high.occ;
    console.log();
    if (delta > 0.08) {
      console.log(
        `   \x1b[33mLa hipótesis se sostiene:\x1b[0m los de mayor brecha tienen ${pct(delta)} menos`,
      );
      console.log(`   de ocupación. Es consistente con lease-up, no con agresividad.`);
    } else if (delta > 0.03) {
      console.log(
        `   \x1b[33mParcialmente:\x1b[0m ${pct(delta)} menos de ocupación en los de mayor brecha.`,
      );
      console.log(`   Explica parte del fenómeno, probablemente no todo.`);
    } else {
      console.log(
        `   \x1b[32mLa hipótesis NO se sostiene:\x1b[0m la ocupación es similar (${pct(Math.abs(delta))} de`,
      );
      console.log(
        `   diferencia). Los préstamos con más brecha no están más vacíos, así que`,
      );
      console.log(`   la proyección no se explica por lease-up.`);
    }
  }
}

// --- ¿es un puñado de préstamos grandes? ------------------------------------

const { rows: byWeight } = await query<{
  unweighted: number | null; weighted: number | null; n: string;
}>(
  `WITH pairs AS (
     SELECT
       uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap,
       bal.value::numeric AS balance
     FROM corpus.loans l
     JOIN corpus.facts uw  ON uw.loan_id  = l.id AND uw.metric_key = 'noi_underwritten'
     JOIN corpus.facts mr  ON mr.loan_id  = l.id AND mr.metric_key = 'noi_most_recent'
     JOIN corpus.facts bal ON bal.loan_id = l.id AND bal.metric_key = 'loan_amount'
     WHERE l.property_type = 'Office'
       AND uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$' AND bal.value ~ '^-?[0-9.]+$'
       AND mr.value::numeric > 0 AND bal.value::numeric > 0
   )
   SELECT
     count(*) AS n,
     avg(gap) AS unweighted,
     sum(gap * balance) / NULLIF(sum(balance), 0) AS weighted
   FROM pairs`,
);

const w = byWeight[0];
if (w?.unweighted != null && w?.weighted != null) {
  console.log(`\n   Ponderación por tamaño de préstamo:`);
  console.log(`     promedio simple      ${pct(w.unweighted)}`);
  console.log(`     ponderado por saldo  ${pct(w.weighted)}`);
  const gap = Math.abs(w.weighted - w.unweighted);
  console.log(
    gap > 0.05
      ? `   \x1b[33m   La diferencia sugiere que unos pocos préstamos grandes mueven el promedio.\x1b[0m`
      : `   \x1b[32m   Similares: el fenómeno no depende de unos pocos préstamos grandes.\x1b[0m`,
  );
}

// --- ¿es un solo emisor? ------------------------------------------------------

const { rows: byIssuer } = await query<{ issuer: string; n: string; gap: number | null }>(
  `WITH pairs AS (
     SELECT
       split_part(fi.company_name, ' ', 1) AS issuer,
       uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap
     FROM corpus.loans l
     JOIN corpus.filings fi ON fi.accession = l.accession
     JOIN corpus.facts uw ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten'
     JOIN corpus.facts mr ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'
     WHERE l.property_type = 'Office'
       AND uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$' AND mr.value::numeric > 0
   )
   SELECT issuer, count(*) AS n,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY gap) AS gap
   FROM pairs GROUP BY 1 HAVING count(*) >= 20 ORDER BY count(*) DESC`,
);

if (byIssuer.length > 1) {
  console.log(`\n   Por emisor:`);
  for (const r of byIssuer) {
    console.log(`     ${r.issuer.padEnd(16)} ${String(r.n).padStart(4)}  ${pct(r.gap).padStart(8)}`);
  }
  const positives = byIssuer.filter((r) => (r.gap ?? 0) > 0.05).length;
  console.log(
    positives === byIssuer.length
      ? `   \x1b[32m   Todos los emisores muestran el mismo patrón: no es de uno solo.\x1b[0m`
      : `   \x1b[33m   ${positives} de ${byIssuer.length} emisores. Revisar si depende de quién origina.\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// A2) ¿Office está solo, o hay otros tipos igual de altos?
// ---------------------------------------------------------------------------

/**
 * Hasta acá comparamos office contra "el resto", que es un promedio de tipos muy
 * distintos. Si hotel o retail también corren alto, el hallazgo no es sobre
 * office sino sobre tipos con renta volátil, y el titular cambia.
 */
const { rows: byType } = await query<{
  ptype: string; n: string; median: number | null; share: number | null;
}>(
  `WITH pairs AS (
     SELECT coalesce(nullif(l.property_type, ''), 'sin tipo') AS ptype,
            uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap
     FROM corpus.loans l
     JOIN corpus.facts uw ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten'
     JOIN corpus.facts mr ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'
     WHERE uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$' AND mr.value::numeric > 0
   )
   SELECT ptype, count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median,
          1.0 * count(*) FILTER (WHERE gap >= 0.05) / NULLIF(count(*), 0) AS share
     FROM pairs GROUP BY 1 HAVING count(*) >= 40
     ORDER BY percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) DESC`,
);

if (byType.length > 2) {
  console.log(`\n   \x1b[1mBrecha por tipo de propiedad\x1b[0m \x1b[90m(¿office está solo?)\x1b[0m\n`);
  console.log(`     tipo                   n    mediana     ≥5%`);
  for (const r of byType) {
    const hot = (r.median ?? 0) >= 0.08;
    const label = hot ? `\x1b[33m${r.ptype.padEnd(18)}\x1b[0m` : r.ptype.padEnd(18);
    console.log(
      `     ${label} ${String(r.n).padStart(5)}   ${pct(r.median).padStart(7)}  ${pct(r.share, 0).padStart(6)}`,
    );
  }
  const top = byType[0];
  const second = byType[1];
  if (top && second) {
    console.log(
      top.ptype.toLowerCase().includes("office")
        ? `\n   \x1b[32mOffice encabeza\x1b[0m, ${(((top.median ?? 0) - (second.median ?? 0)) * 100).toFixed(1)} pp por encima de ${second.ptype}.`
        : `\n   \x1b[33mOffice NO encabeza: ${top.ptype} está más alto (${pct(top.median)}).\x1b[0m\n` +
          `   El hallazgo no es sobre office; hay que reformularlo.`,
    );
  }
}

// ---------------------------------------------------------------------------
// A3) Control dentro del mismo deal
// ---------------------------------------------------------------------------

/**
 * La explicación alternativa más difícil de descartar es la selección: los
 * office que llegan a CMBS en 2024-2026 podrían ser una muestra rara —activos
 * con una historia que contar, refinanciaciones con reposicionamiento— y no un
 * reflejo de cómo se suscribe office en general.
 *
 * El control es comparar office contra el resto DENTRO del mismo deal. Mismo
 * emisor, misma fecha, mismo comité de crédito, mismo apetito de riesgo. Si la
 * brecha sobrevive pareada, la selección a nivel deal queda descartada.
 */
/** Compara office contra un grupo de control, pareado por deal. */
async function pairedVs(
  label: string,
  controlSql: string,
  minControl: number,
): Promise<{ deals: number; rate: number; diff: number | null } | null> {
  const { rows } = await query<{ deals: string; higher: string; median_diff: number | null }>(
    `WITH pairs AS (
       SELECT l.accession, l.property_type AS ptype,
              uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap
       FROM corpus.loans l
       JOIN corpus.facts uw ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten'
       JOIN corpus.facts mr ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'
       WHERE uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$' AND mr.value::numeric > 0
     ),
     per_deal AS (
       SELECT accession,
              count(*) FILTER (WHERE ptype = 'Office') AS n_office,
              count(*) FILTER (WHERE ${controlSql}) AS n_control,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY CASE WHEN ptype = 'Office' THEN gap END) AS g_office,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY CASE WHEN ${controlSql} THEN gap END) AS g_control
         FROM pairs GROUP BY accession
     )
     SELECT count(*) AS deals,
            count(*) FILTER (WHERE g_office > g_control) AS higher,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY g_office - g_control) AS median_diff
       FROM per_deal
      WHERE n_office >= 2 AND n_control >= ${minControl}`,
  );
  const r = rows[0];
  if (!r || Number(r.deals) < 8) {
    console.log(
      `     ${label.padEnd(28)} \x1b[90mmuestra insuficiente (${r ? r.deals : 0} deals)\x1b[0m`,
    );
    return null;
  }
  const deals = Number(r.deals);
  const rate = Number(r.higher) / deals;
  console.log(
    `     ${label.padEnd(28)} ${String(deals).padStart(4)} deals   ` +
      `${pct(rate, 0).padStart(5)} a favor   ${pct(r.median_diff).padStart(7)}`,
  );
  return { deals, rate, diff: r.median_diff };
}

console.log(
  `\n   \x1b[1mControl pareado dentro del mismo deal\x1b[0m \x1b[90m(descarta selección por emisor y vintage)\x1b[0m\n`,
);
console.log(`     grupo de control            deals    office arriba   dif. mediana`);

const vsAll = await pairedVs("todo el resto del pool", "ptype <> 'Office'", 5);

/**
 * El control decisivo es industrial, no "el resto".
 *
 * La tabla por tipo mostró un orden que se explica solo: hospitality -0.5%,
 * self storage 1.2%, retail 3.5%, industrial 10.8%, office 13.1%. Eso no parece
 * agresividad sino visibilidad de renta contractual —un hotel no tiene contratos
 * que proyectar, una oficina sí, y suscribir por encima del trailing con
 * escalones firmados es legítimo.
 *
 * Si esa es la explicación, office e industrial deberían parecerse, porque
 * comparten estructura de contrato. Y de hecho están a 2.3 pp. Comparar office
 * contra "el resto" infla la brecha metiendo hoteles y self storage en el
 * denominador.
 *
 * Este par es el que decide: contra industrial, dentro del mismo deal, ¿office
 * sigue arriba?
 */
const vsIndustrial = await pairedVs(
  "solo industrial",
  "ptype = 'Industrial'",
  2,
);

console.log();
if (vsAll && vsAll.rate >= 0.7) {
  console.log(
    `   \x1b[32mContra todo el pool office queda arriba en ${pct(vsAll.rate, 0)} de los deals.\x1b[0m`,
  );
  console.log(`   Mismo emisor, misma fecha, mismo comité: no es selección de deals.`);
}

if (vsIndustrial) {
  console.log();
  if (vsIndustrial.rate >= 0.65) {
    console.log(
      `   \x1b[32mY contra industrial —misma estructura de contrato— sigue arriba\x1b[0m`,
    );
    console.log(
      `   \x1b[32men ${pct(vsIndustrial.rate, 0)} de los deals.\x1b[0m La visibilidad de renta contractual no`,
    );
    console.log(`   alcanza a explicarlo: office se despega de su propio comparable.`);
  } else {
    console.log(
      `   \x1b[33mContra industrial la ventaja se diluye (${pct(vsIndustrial.rate, 0)}).\x1b[0m Office e industrial`,
    );
    console.log(
      `   \x1b[33mcomparten estructura de contrato, así que lo que mide la brecha es\x1b[0m`,
    );
    console.log(
      `   \x1b[33mvisibilidad de renta futura, no agresividad propia de office.\x1b[0m`,
    );
    console.log(
      `   \x1b[90mEl titular correcto sería "los tipos con contratos largos se suscriben\x1b[0m`,
    );
    console.log(`   \x1b[90mmuy por encima del trailing", con office en el extremo.\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// Contraste con la literatura
// ---------------------------------------------------------------------------

/**
 * Contraste con Griffin (2023), Journal of Finance — y por qué NO es comparable.
 *
 * "Is COVID Revealing a Virus in CMBS 2.0?" mide el NOI suscrito contra el NOI
 * *real reportado por el servicer en el primer año posterior al cierre*. Es una
 * comparación hacia adelante: promesa contra resultado.
 *
 * Nosotros medimos el NOI suscrito contra `noi_most_recent`, que es el NOI
 * histórico del último período cerrado *antes* del cierre, tal como lo publica
 * el Annex A. Es una comparación hacia atrás: promesa contra historia.
 *
 * Son cantidades distintas y no se pueden poner en la misma tabla:
 *
 *   - Nuestra brecha tiene un componente legítimo grande. Suscribir por encima
 *     del trailing es la práctica normal cuando hay escalones de renta
 *     contractuales, contratos firmados sin ocupar, o gastos no recurrentes que
 *     se normalizan. Un 46% acá no es un 46% de préstamos mal suscritos.
 *
 *   - Y tiene un sesgo conocido en contra. Griffin también encontró que los
 *     originadores inflan los financieros pasados que publican. Si el
 *     denominador viene inflado, nuestra brecha sale más chica que la real.
 *
 * Para replicar a Griffin haría falta el NOI post-originación, que no está en el
 * Annex A: sale de los reportes del servicer (10-D en EDGAR, o Trepp). Es otra
 * fuente y otro pipeline.
 *
 * Lo que este bloque sí puede hacer es reportar nuestro número con su nombre
 * correcto, y dejar registrado por qué no es el de Griffin.
 */
const GAP_THRESHOLD = 0.05;

const { rows: gapRows } = await query<{
  segment: string;
  n: string;
  share: number | null;
  median: number | null;
}>(
  `WITH pairs AS (
     SELECT coalesce(nullif(pt.value, ''), 'sin tipo') AS ptype,
            uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap
     FROM corpus.loans l
     JOIN corpus.facts uw ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten'
     JOIN corpus.facts mr ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'
     LEFT JOIN corpus.facts pt ON pt.loan_id = l.id AND pt.metric_key = 'property_type'
     WHERE uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$'
       AND mr.value::numeric > 0
   ),
   labelled AS (
     SELECT CASE WHEN ptype ILIKE '%office%' THEN 'office' ELSE 'resto' END AS segment, gap
     FROM pairs
     UNION ALL
     SELECT 'TOTAL', gap FROM pairs
   )
   SELECT segment,
          count(*) AS n,
          1.0 * count(*) FILTER (WHERE gap >= ${GAP_THRESHOLD}) / NULLIF(count(*), 0) AS share,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median
   FROM labelled
   GROUP BY segment
   ORDER BY CASE segment WHEN 'TOTAL' THEN 0 WHEN 'office' THEN 1 ELSE 2 END`,
);

const total = gapRows.find((r) => r.segment === "TOTAL");
if (total && Number(total.n) > 100) {
  console.log(`\n\n\x1b[1mContraste con la literatura — y por qué no aplica\x1b[0m`);
  console.log(
    `\x1b[90m   Griffin (2023), Journal of Finance — "Is COVID Revealing a Virus in CMBS 2.0?"\x1b[0m`,
  );
  console.log(
    `\x1b[90m   Comparó el NOI suscrito contra el NOI reportado por el servicer en el\x1b[0m`,
  );
  console.log(
    `\x1b[90m   primer año POSTERIOR al cierre. 29% de 39.522 préstamos con brecha ≥5%.\x1b[0m`,
  );
  console.log(
    `\n   \x1b[31mNosotros medimos otra cosa\x1b[0m: suscrito contra el histórico ANTERIOR al`,
  );
  console.log(`   cierre, que es lo único que publica el Annex A.`);
  console.log(
    `\n   \x1b[90m   Griffin:  promesa vs. resultado   → cuánto se equivocó el suscriptor\x1b[0m`,
  );
  console.log(
    `   \x1b[90m   Nosotros: promesa vs. historia    → cuánto se despegó del trailing\x1b[0m`,
  );
  console.log(
    `\n   Los números no se comparan. Suscribir por encima del trailing es normal`,
  );
  console.log(`   con escalones de renta o gastos no recurrentes normalizados.\n`);

  console.log(`   Brecha suscrito / trailing en este corpus:\n`);
  console.log(`     segmento        n     ≥5%    mediana`);
  for (const r of gapRows) {
    console.log(
      `     ${r.segment.padEnd(10)}${String(r.n).padStart(6)}  ${pct(r.share, 0).padStart(6)}  ${pct(r.median, 1).padStart(9)}`,
    );
  }

  /**
   * Este corte office/resto quedó superado por A2 y A3.
   *
   * "Resto" promedia hoteles con oficinas, y la separación de 10 puntos sale
   * mayormente de meter hospitality y self storage en el denominador. Contra
   * industrial —el comparable real— la ventaja de office cae a 58% de los deals.
   * Se deja la fila para no perder continuidad con corridas anteriores, pero la
   * lectura correcta es la escala por tipo de A2.
   */
  console.log(
    `\n   \x1b[90mEsta partición quedó superada: "resto" mezcla hoteles con oficinas.\x1b[0m`,
  );
  console.log(`   \x1b[90mLa lectura buena es la escala por tipo de arriba.\x1b[0m`);
  console.log(
    `\n   \x1b[90mPara replicar a Griffin haría falta el NOI post-originación: reportes\x1b[0m`,
  );
  console.log(
    `   \x1b[90mdel servicer (10-D en EDGAR o Trepp). Otra fuente, otro pipeline.\x1b[0m`,
  );
}

// ===========================================================================
// B) Multifamily: ¿son las tasas?
// ===========================================================================

/**
 * Las cooperativas de vivienda vienen etiquetadas como "Multifamily" pero son
 * otro negocio: la cooperativa es dueña del edificio y toma deuda mínima contra
 * un valor alto. LTV de 10-20% con DSCR de 4x a 12x es normal ahí, y absurdo en
 * multifamily convencional.
 *
 * Mientras estén mezcladas, cualquier mediana de multifamily es una mezcla de
 * dos poblaciones distintas. Se identifican por las columnas Coop-* del Annex A,
 * que ya cosechamos.
 */
const COOP_METRICS = ["coop_units", "coop_sponsor_units", "coop_rental_value", "coop_ltv_as_rental"];
const IS_COOP = `EXISTS (
  SELECT 1 FROM corpus.facts c
   WHERE c.loan_id = l.id
     AND c.metric_key IN (${COOP_METRICS.map((m) => `'${m}'`).join(", ")})
     AND c.value ~ '^[0-9.]+$' AND c.value::numeric > 0
)`;

console.log(`\n\n\x1b[1mB. Multifamily rompió su banda en 2026\x1b[0m`);

// --- censo de cooperativas ----------------------------------------------------

const { rows: coopCensus } = await query<{
  issuer: string; total: string; coops: string; ltv_coop: number | null; ltv_conv: number | null;
}>(
  `SELECT split_part(fi.company_name, ' ', 1) AS issuer,
          count(DISTINCT l.id) AS total,
          count(DISTINCT l.id) FILTER (WHERE ${IS_COOP}) AS coops,
          percentile_cont(0.50) WITHIN GROUP (
            ORDER BY CASE WHEN ${IS_COOP} THEN v.value::numeric END) AS ltv_coop,
          percentile_cont(0.50) WITHIN GROUP (
            ORDER BY CASE WHEN NOT ${IS_COOP} THEN v.value::numeric END) AS ltv_conv
     FROM corpus.filings fi
     JOIN corpus.loans l ON l.accession = fi.accession
     LEFT JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = 'ltv' AND v.value ~ '^-?[0-9.]+$'
    WHERE l.property_type = 'Multifamily'
    GROUP BY 1 HAVING count(DISTINCT l.id) FILTER (WHERE ${IS_COOP}) > 0
    ORDER BY count(DISTINCT l.id) FILTER (WHERE ${IS_COOP}) DESC`,
);

const coopTotal = coopCensus.reduce((a, r) => a + Number(r.coops), 0);
if (coopTotal > 0) {
  console.log(
    `\n   \x1b[1mCooperativas detectadas\x1b[0m \x1b[90m(columnas Coop-* del Annex A pobladas)\x1b[0m\n`,
  );
  console.log(`     emisor            coop / total    LTV coop   LTV resto`);
  for (const r of coopCensus) {
    console.log(
      `     ${r.issuer.padEnd(16)} ${String(r.coops).padStart(4)} / ${String(r.total).padEnd(5)}  ` +
        `${pct(r.ltv_coop).padStart(9)}   ${pct(r.ltv_conv).padStart(9)}`,
    );
  }
  console.log(
    `\n   \x1b[32m${coopTotal} préstamos cooperativos confirmados por dato, no por inferencia.\x1b[0m`,
  );
  console.log(
    `   \x1b[90mEl LTV bajo era correcto. El error era mezclarlos. De acá en adelante\x1b[0m`,
  );
  console.log(`   \x1b[90mmultifamily excluye cooperativas.\x1b[0m`);
} else {
  console.log(
    `\n   \x1b[33mNingún préstamo de multifamily tiene columnas Coop-* pobladas.\x1b[0m`,
  );
  console.log(
    `   \x1b[33mLa explicación cooperativa queda sin respaldo en el dato: el LTV bajo\x1b[0m`,
  );
  console.log(`   \x1b[33mde algún emisor sigue sin explicar.\x1b[0m`);
}

console.log(`\n\x1b[90m   Hipótesis alternativa: el DSCR cae porque subieron las tasas.\x1b[0m`);
console.log(
  `\x1b[90m   Si fuera cierto, la tasa mediana debería subir junto con la caída del DSCR.\x1b[0m\n`,
);

const { rows: rates } = await query<{
  period: string; n: string; dscr: number | null; ltv: number | null;
  dy: number | null; rate: number | null;
}>(
  `SELECT
     to_char(date_trunc('quarter', fi.filed_at), 'YYYY-"Q"Q') AS period,
     count(DISTINCT l.id) AS n,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY d.value::numeric) AS dscr,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY v.value::numeric) AS ltv,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY y.value::numeric) AS dy,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY r.value::numeric) AS rate
   FROM corpus.filings fi
   JOIN corpus.loans l ON l.accession = fi.accession
   LEFT JOIN corpus.facts d ON d.loan_id = l.id AND d.metric_key = 'dscr'          AND d.value ~ '^-?[0-9.]+$'
   LEFT JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = 'ltv'           AND v.value ~ '^-?[0-9.]+$'
   LEFT JOIN corpus.facts y ON y.loan_id = l.id AND y.metric_key = 'debt_yield'    AND y.value ~ '^-?[0-9.]+$'
   LEFT JOIN corpus.facts r ON r.loan_id = l.id AND r.metric_key = 'interest_rate' AND r.value ~ '^-?[0-9.]+$'
   WHERE fi.filed_at IS NOT NULL AND l.property_type = 'Multifamily' AND NOT ${IS_COOP}
   GROUP BY 1 HAVING count(DISTINCT l.id) >= 20 ORDER BY 1`,
);

if (rates.length > 2) {
  console.log(
    `   ${"período".padEnd(10)} ${"n".padStart(5)}  ${"DSCR".padStart(7)} ${"LTV".padStart(7)} ${"debt yield".padStart(11)} ${"tasa".padStart(8)}`,
  );
  for (const r of rates) {
    console.log(
      `   ${r.period.padEnd(10)} ${String(r.n).padStart(5)}  ${num(r.dscr).padStart(7)} ` +
        `${pct(r.ltv).padStart(7)} ${pct(r.dy).padStart(11)} ${pct(r.rate, 2).padStart(8)}`,
    );
  }

  /**
   * Tendencia sobre toda la serie, no "los últimos dos contra el resto".
   *
   * La comparación de dos bloques tenía dos defectos que se hicieron visibles al
   * excluir las cooperativas. El umbral de muestra estaba calibrado sobre una
   * población que incluía 221 préstamos cooperativos; al sacarlos, dejó afuera
   * seis de once trimestres y "los últimos dos" pasaron a ser 2025-Q3 y 2026-Q2,
   * salteándose los del medio. La etiqueta decía una cosa y el cálculo hacía
   * otra.
   *
   * El defecto de fondo es anterior: partir la serie en dos bloques obliga a
   * elegir dónde cortar, y el corte se elige mirando el resultado. Una pendiente
   * sobre todos los trimestres no tiene ese grado de libertad.
   *
   * Reportamos también el R²: una pendiente sin ajuste es ruido con dirección.
   */
  const MIN_QUARTER = 40;
  const usable = rates.filter((r) => Number(r.n) >= MIN_QUARTER);
  const excluded = rates.filter((r) => Number(r.n) < MIN_QUARTER);

  if (excluded.length > 0) {
    console.log(
      `   \x1b[90mExcluidos por muestra chica: ${excluded.map((r) => `${r.period} (n=${r.n})`).join(", ")}\x1b[0m`,
    );
  }

  /** Pendiente OLS por trimestre y bondad de ajuste. */
  function trend(ys: Array<number | null>): { perYear: number; r2: number; n: number } | null {
    const pts = ys
      .map((y, i) => ({ x: i, y }))
      .filter((p): p is { x: number; y: number } => typeof p.y === "number");
    if (pts.length < 4) return null;

    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p.x, 0) / n;
    const my = pts.reduce((a, p) => a + p.y, 0) / n;
    const sxy = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
    const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
    if (sxx === 0) return null;

    const slope = sxy / sxx;
    const syy = pts.reduce((a, p) => a + (p.y - my) ** 2, 0);
    const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
    return { perYear: slope * 4, r2, n };
  }

  const tDscr = trend(usable.map((r) => r.dscr));
  const tLtv = trend(usable.map((r) => r.ltv));
  const tDy = trend(usable.map((r) => r.dy));
  const tRate = trend(usable.map((r) => r.rate));

  if (tLtv && tDy && tRate && tDscr) {
    console.log(
      `\n   Deriva anual sobre los ${usable.length} trimestres usables \x1b[90m(pendiente OLS)\x1b[0m\n`,
    );
    const line = (label: string, t: { perYear: number; r2: number }, unit: "pp" | "x") =>
      `     ${label.padEnd(12)} ${(t.perYear >= 0 ? "+" : "") + (unit === "pp" ? (t.perYear * 100).toFixed(2) + " pp" : t.perYear.toFixed(3) + "x")}`.padEnd(
        34,
      ) + `\x1b[90mR² ${t.r2.toFixed(2)}\x1b[0m`;

    console.log(line("LTV", tLtv, "pp"));
    console.log(line("debt yield", tDy, "pp"));
    console.log(line("DSCR", tDscr, "x"));
    console.log(line("tasa", tRate, "pp"));

    const FIT = 0.3;
    const leverageUp = tLtv.perYear > 0.005 && tLtv.r2 > FIT;
    const dyDown = tDy.perYear < -0.002 && tDy.r2 > FIT;

    console.log();
    if (leverageUp && dyDown) {
      console.log(
        `   \x1b[33mApalancamiento en aumento sostenido.\x1b[0m LTV sube ${(tLtv.perYear * 100).toFixed(1)} pp/año y el`,
      );
      console.log(
        `   debt yield cae ${Math.abs(tDy.perYear * 100).toFixed(1)} pp/año. El debt yield es el control decisivo:`,
      );
      console.log(`   no depende ni de tasas ni de tasaciones, así que la caída es más`);
      console.log(`   deuda por dólar de NOI, no un artefacto de valuación.`);
      console.log(
        `\n   \x1b[1mPero no es lo que decía la hipótesis.\x1b[0m No hay quiebre en 2026: hay`,
      );
      console.log(
        `   una deriva gradual desde 2024. "Rompió su banda" queda descartado;`,
      );
      console.log(`   lo que sobrevive es un aflojamiento lento y continuo.`);
    } else if (leverageUp) {
      console.log(
        `   \x1b[33mEl LTV sube ${(tLtv.perYear * 100).toFixed(1)} pp/año, pero el debt yield no acompaña.\x1b[0m`,
      );
      console.log(`   Sin ese control, la suba puede ser de tasaciones y no de deuda.`);
    } else {
      console.log(`   \x1b[32mNinguna serie muestra deriva con ajuste suficiente.\x1b[0m`);
      console.log(`   La hipótesis del aflojamiento no se sostiene sobre estos datos.`);
    }

    if (Math.abs(tRate.perYear) > 0.002 && tRate.r2 > FIT) {
      console.log(
        `\n   \x1b[90mControl de tasas: ${tRate.perYear > 0 ? "suben" : "bajan"} ${Math.abs(tRate.perYear * 100).toFixed(2)} pp/año (R² ${tRate.r2.toFixed(2)}).\x1b[0m`,
      );
      console.log(
        tRate.perYear < 0
          ? `   \x1b[90mCon tasas en baja el DSCR debería subir. Que siga plano es consistente\x1b[0m\n` +
            `   \x1b[90mcon más deuda, no con costo de deuda.\x1b[0m`
          : `   \x1b[90mParte del movimiento del DSCR es mecánico por costo de deuda.\x1b[0m`,
      );
    }
  }
}

// --- ¿un solo emisor? ---------------------------------------------------------

const { rows: mfIssuers } = await query<{ issuer: string; n: string; ltv: number | null }>(
  `SELECT split_part(fi.company_name, ' ', 1) AS issuer,
          count(DISTINCT l.id) AS n,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY v.value::numeric) AS ltv
     FROM corpus.filings fi
     JOIN corpus.loans l ON l.accession = fi.accession
     JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = 'ltv' AND v.value ~ '^-?[0-9.]+$'
    WHERE l.property_type = 'Multifamily' AND fi.filed_at >= '2026-01-01' AND NOT ${IS_COOP}
    GROUP BY 1 HAVING count(DISTINCT l.id) >= 15 ORDER BY count(DISTINCT l.id) DESC`,
);

if (mfIssuers.length > 1) {
  console.log(`\n   LTV de multifamily en 2026, por emisor \x1b[90m(sin cooperativas)\x1b[0m:`);

  /**
   * Un LTV muy bajo NO es necesariamente un error.
   *
   * Acá me equivoqué: marqué en rojo el 11,0% de la familia BANK asumiendo que
   * un préstamo de CMBS no cotiza así. La aritmética decía otra cosa —préstamo
   * de $8,5M contra tasación de $38,6M, con cap rate normal de 5,9%— y el
   * corpus tenía la respuesta en columnas que yo había descartado por
   * aburridas: "Coop - Coop Units", "Coop - LTV as Rental".
   *
   * Son préstamos a cooperativas de vivienda, típicamente de Nueva York. La
   * cooperativa es dueña del edificio y toma deuda mínima contra un valor alto:
   * LTV de 10-20% con DSCR de 4x a 12x es lo normal en ese nicho.
   *
   * Vienen clasificados como "Multifamily", así que arrastran las medianas de
   * esa categoría. La marca ahora señala eso —hay que segmentarlos— en vez de
   * afirmar que el dato está roto.
   */
  const unusual: string[] = [];
  for (const r of mfIssuers) {
    const v = r.ltv;
    const low = v !== null && v < 0.30;
    if (low) unusual.push(r.issuer);
    const cell = low ? `\x1b[33m${pct(v).padStart(8)}\x1b[0m ⚠` : pct(v).padStart(8);
    console.log(`     ${r.issuer.padEnd(16)} ${String(r.n).padStart(4)}  ${cell}`);
  }

  if (unusual.length > 0) {
    console.log(
      `\n   \x1b[33m   ${unusual.join(", ")}: LTV bajo 30% con las cooperativas YA excluidas.\x1b[0m`,
    );
    console.log(
      `   \x1b[90m   Queda otro nicho de deuda baja sin identificar. Los candidatos son\x1b[0m`,
    );
    console.log(
      `   \x1b[90m   vivienda subsidiada con deuda pública subordinada, ground leases, y\x1b[0m`,
    );
    console.log(
      `   \x1b[90m   préstamos suplementarios sobre deuda de agencia ya existente.\x1b[0m`,
    );
    console.log(
      `   \x1b[90m   Inspeccioná el detalle antes de asumir que el pipeline está roto:\x1b[0m`,
    );
    console.log(
      `   \x1b[90m   la vez pasada lo era, y el dato estaba bien.\x1b[0m`,
    );
  } else {
    console.log(
      `   \x1b[90m   Si un emisor domina y el resto está mucho más abajo, el hallazgo es suyo,\x1b[0m`,
    );
    console.log(`   \x1b[90m   no del mercado.\x1b[0m`);
  }
}

// ===========================================================================
// Estado de los hallazgos
// ===========================================================================

console.log(`\n\n${"═".repeat(78)}`);
console.log("Estado de los hallazgos");
console.log(`${"═".repeat(78)}\n`);

console.log(`\x1b[31m✗ DESCARTADO\x1b[0m  "Office se suscribe agresivamente"`);
console.log(
  `\x1b[90m             Sobrevivió a lease-up, a ponderación por tamaño, a emisor y a\x1b[0m`,
);
console.log(
  `\x1b[90m             selección de deals. Cayó contra su propio comparable: pareado\x1b[0m`,
);
console.log(
  `\x1b[90m             dentro del deal, office supera a industrial en 58% de los casos.\x1b[0m\n`,
);

console.log(`\x1b[32m✓ SOBREVIVE\x1b[0m  La brecha escala con la visibilidad de renta contractual`);
console.log(
  `\x1b[90m             Hospitality -0.5% → self storage 1.2% → retail 3.5% →\x1b[0m`,
);
console.log(
  `\x1b[90m             industrial 10.8% → office 13.1%. Ordena por cuánta renta futura\x1b[0m`,
);
console.log(
  `\x1b[90m             hay bajo contrato, no por agresividad. Es más chico que el\x1b[0m`,
);
console.log(`\x1b[90m             titular original y está mejor sostenido.\x1b[0m\n`);

console.log(`\x1b[31m✗ DESCARTADO\x1b[0m  "Multifamily rompió su banda en 2026"`);
console.log(
  `\x1b[90m             No hay quiebre. El DSCR es plano (R² 0.06) y el supuesto salto\x1b[0m`,
);
console.log(
  `\x1b[90m             de 2026 era en parte 221 cooperativas mezcladas en la categoría.\x1b[0m\n`,
);

console.log(`\x1b[32m✓ SOBREVIVE\x1b[0m  Deriva de apalancamiento en multifamily convencional`);
console.log(
  `\x1b[90m             LTV +2.3 pp/año y debt yield -0.6 pp/año, R² ~0.65, sostenido\x1b[0m`,
);
console.log(
  `\x1b[90m             desde 2024. Con tasas en baja el DSCR debería subir y está plano:\x1b[0m`,
);
console.log(`\x1b[90m             la capacidad extra se tomó como deuda, no como colchón.\x1b[0m\n`);

console.log(`\x1b[32m✓ CONTROL\x1b[0m    Hospitality en -0.5% valida el instrumento`);
console.log(
  `\x1b[90m             Donde no hay contratos que proyectar la brecha desaparece. Si el\x1b[0m`,
);
console.log(
  `\x1b[90m             pipeline inflara sistemáticamente, aparecería también ahí.\x1b[0m\n`,
);

console.log(`${"─".repeat(78)}`);
console.log(
  `\n  \x1b[90mDos hallazgos entraron, dos salieron reemplazados por versiones más chicas\x1b[0m`,
);
console.log(`  \x1b[90my mejor sostenidas. Eso es el proceso funcionando, no fallando.\x1b[0m\n`);

await closePool();

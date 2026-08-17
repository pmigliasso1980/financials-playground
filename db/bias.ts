/**
 * ¿La muestra con desempeño representa al pool de su añada?
 *
 *   npm run db:bias
 *
 * POR QUÉ ESTO PUEDE INVALIDAR EL HALLAZGO
 *
 * El resultado del proyecto dice que el crecimiento de NOI entregado cayó de
 * 11,5% en la añada 2021 a 1,0% en 2024. Ese número sale de los préstamos que
 * tienen informe del servicer, que son ~2.200 de 8.935.
 *
 * Comparar 2021 contra 2024 supone que las dos submuestras se parecen a sus
 * pools. Si no se parecen —si en una añada el 10-D solo pega contra préstamos
 * chicos y en otra contra todos— la serie compara poblaciones distintas y el
 * derrumbe podría ser un artefacto de qué préstamos logramos unir.
 *
 * No es una preocupación abstracta. El join contra el servicer es peor
 * justamente en 2020-2021, que son las añadas que peor parsean y de donde sale
 * el extremo alto de la serie. Es decir: **el número más importante del hallazgo
 * descansa sobre los datos más débiles.**
 *
 * QUÉ MIRA
 *
 * Para cada añada, el perfil de los préstamos CON desempeño contra el de los que
 * NO lo tienen, sobre el mismo pool. Si el sesgo existe pero es igual en todas
 * las añadas, la comparación entre añadas sigue siendo válida —todas están
 * corridas para el mismo lado—. Lo que rompe la serie es que el sesgo CAMBIE.
 *
 * LOS UMBRALES ESTÁN FIJADOS ANTES DE VER LOS NÚMEROS
 *
 * Elegirlos mirando el resultado sería elegir la conclusión.
 *
 *   una añada está sesgada     si la mediana de saldo de la muestra se aparta
 *                              más de 25% de la del resto del pool
 *   la serie no es comparable  si la dirección o magnitud del sesgo difiere
 *                              entre añadas: max(ratio) / min(ratio) > 1,5
 *   se ignoran las añadas      con menos de 50 préstamos con desempeño, porque
 *                              una mediana sobre 12 casos no dice nada
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const SESGO_ANADA = 0.25;
const DISPERSION_MAX = 1.5;
const MIN_N = 50;

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const money = (v: number | null) =>
  v === null ? "—" : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.round(v).toLocaleString("en-US");

console.log(`\n${"═".repeat(78)}`);
console.log("Sesgo de la muestra con desempeño");
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  El hallazgo compara añadas. Eso solo vale si la submuestra con 10-D se\x1b[0m`,
);
console.log(
  `\x1b[90m  parece a su pool, o si se desvía IGUAL en todas. Umbrales fijados antes\x1b[0m`,
);
console.log(`\x1b[90m  de correr: sesgo ${pct(SESGO_ANADA)} · dispersión ${DISPERSION_MAX}x · n mínimo ${MIN_N}.\x1b[0m\n`);

interface Fila {
  anada: string;
  n_total: string;
  n_con: string;
  saldo_con: number | null;
  saldo_sin: number | null;
  noi_con: number | null;
  noi_sin: number | null;
  ltv_con: number | null;
  ltv_sin: number | null;
  office_con: number | null;
  office_sin: number | null;
}

/**
 * `con` es el préstamo que tiene al menos un registro de desempeño POSTERIOR al
 * cierre. El filtro de días importa: un período que empieza antes de la fecha de
 * emisión solapa con el histórico que el suscriptor ya tenía a la vista, así que
 * no mide un resultado y tampoco cuenta como cobertura.
 */
const { rows } = await query<Fila>(
  `WITH base AS (
     SELECT l.id,
            extract(year FROM f.filed_at)::int AS anada,
            coalesce(sen.value::numeric,
                     amt.value::numeric + coalesce(npp.value::numeric, 0)) AS saldo,
            noi.value::numeric AS noi,
            ltv.value::numeric AS ltv,
            (l.property_type ILIKE '%office%')::int AS es_office,
            EXISTS (
              SELECT 1 FROM corpus.performance p
               WHERE p.loan_id = l.id
                 AND (p.noi_start - f.filed_at) >= 0
            ) AS con_desempeno
       FROM corpus.loans l
       JOIN corpus.filings f ON f.accession = l.accession
       LEFT JOIN corpus.facts amt ON amt.loan_id = l.id AND amt.metric_key = 'loan_amount'
                                  AND amt.value ~ '^-?[0-9.]+$'
       LEFT JOIN corpus.facts npp ON npp.loan_id = l.id
                                  AND npp.metric_key = 'balance_pari_passu_non_trust'
                                  AND npp.value ~ '^-?[0-9.]+$'
       LEFT JOIN corpus.facts sen ON sen.loan_id = l.id
                                  AND sen.metric_key = 'balance_senior_total'
                                  AND sen.value ~ '^-?[0-9.]+$'
       LEFT JOIN corpus.facts noi ON noi.loan_id = l.id AND noi.metric_key = 'noi_underwritten'
                                  AND noi.value ~ '^-?[0-9.]+$'
       LEFT JOIN corpus.facts ltv ON ltv.loan_id = l.id AND ltv.metric_key = 'ltv'
                                  AND ltv.value ~ '^-?[0-9.]+$'
   )
   SELECT anada::text AS anada,
          count(*)::text AS n_total,
          count(*) FILTER (WHERE con_desempeno)::text AS n_con,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY saldo)
            FILTER (WHERE con_desempeno)      AS saldo_con,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY saldo)
            FILTER (WHERE NOT con_desempeno)  AS saldo_sin,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY noi)
            FILTER (WHERE con_desempeno)      AS noi_con,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY noi)
            FILTER (WHERE NOT con_desempeno)  AS noi_sin,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ltv)
            FILTER (WHERE con_desempeno)      AS ltv_con,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ltv)
            FILTER (WHERE NOT con_desempeno)  AS ltv_sin,
          avg(es_office) FILTER (WHERE con_desempeno)     AS office_con,
          avg(es_office) FILTER (WHERE NOT con_desempeno) AS office_sin
     FROM base
    GROUP BY anada
    ORDER BY anada`,
);

/**
 * Antes de medir el sesgo, comprobar que haya muestra.
 *
 * "0% de cobertura" tiene dos causas con dos arreglos distintos: la tabla de
 * desempeño está vacía, o está poblada pero ningún período es posterior al
 * cierre. Sin distinguirlas, el diagnóstico manda a mirar el lado equivocado.
 *
 * La primera es un riesgo real de este esquema: `corpus.performance` referencia
 * `loans(id)` con ON DELETE CASCADE, y `--refresh-stale` borra los préstamos
 * antes de reescribirlos. **Cada recosecha del Annex A destruye el desempeño
 * acumulado**, y nada avisa —las identidades siguen cerrando, el corpus sigue
 * teniendo 8.935 préstamos, y solo falta la tabla que ninguna comprobación
 * mira—.
 */
const { rows: salud } = await query<{
  filas: string; prestamos: string; posteriores: string;
}>(
  `SELECT count(*)::text AS filas,
          count(DISTINCT p.loan_id)::text AS prestamos,
          count(*) FILTER (WHERE (p.noi_start - f.filed_at) >= 0)::text AS posteriores
     FROM corpus.performance p
     JOIN corpus.loans l   ON l.id = p.loan_id
     JOIN corpus.filings f ON f.accession = l.accession`,
);

const sal = salud[0];
const filas = Number(sal?.filas ?? 0);
const posteriores = Number(sal?.posteriores ?? 0);

if (filas === 0) {
  console.log(`${"─".repeat(78)}`);
  console.log(`\n  \x1b[31mLA TABLA DE DESEMPEÑO ESTÁ VACÍA.\x1b[0m\n`);
  console.log(
    `  \x1b[90mNo es un problema de esta comprobación: no hay contra qué medir sesgo.\x1b[0m`,
  );
  console.log(
    `  \x1b[90m\`corpus.performance\` referencia \`loans(id)\` con ON DELETE CASCADE, y\x1b[0m`,
  );
  console.log(
    `  \x1b[90m\`--refresh-stale\` borra los préstamos antes de reescribirlos. Cada\x1b[0m`,
  );
  console.log(
    `  \x1b[90mrecosecha del Annex A se lleva puesto el desempeño acumulado.\x1b[0m\n`,
  );
  console.log(`  Reconstruir con:  \x1b[1mnpm run db:performance\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

if (posteriores === 0) {
  console.log(`${"─".repeat(78)}`);
  console.log(
    `\n  \x1b[33m${filas} filas de desempeño, pero ninguna posterior al cierre.\x1b[0m\n`,
  );
  console.log(
    `  \x1b[90mLa tabla está poblada; lo que falla es el filtro de fecha. Un período\x1b[0m`,
  );
  console.log(
    `  \x1b[90mque empieza antes de la emisión solapa con el histórico que el\x1b[0m`,
  );
  console.log(
    `  \x1b[90msuscriptor ya tenía a la vista, así que no mide un resultado.\x1b[0m\n`,
  );
  await closePool();
  process.exit(0);
}

console.log(
  `\x1b[90m  ${filas.toLocaleString("en-US")} filas de desempeño · ${posteriores.toLocaleString("en-US")} posteriores al cierre.\x1b[0m\n`,
);

console.log(`${"─".repeat(78)}`);
console.log("Cobertura y perfil, añada por añada");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  añada   pool  con 10-D  cob.   saldo mediano        NOI mediano       LTV`,
);
console.log(
  `                                  con / sin  ratio    con / sin        con/sin`,
);
console.log(`  ${"─".repeat(74)}`);

const ratios: Array<{ anada: string; ratio: number; n: number }> = [];

for (const r of rows) {
  const nTotal = Number(r.n_total);
  const nCon = Number(r.n_con);
  const cob = nTotal > 0 ? nCon / nTotal : 0;
  const ratio =
    r.saldo_con !== null && r.saldo_sin !== null && Number(r.saldo_sin) !== 0
      ? Number(r.saldo_con) / Number(r.saldo_sin)
      : NaN;

  const chico = nCon < MIN_N;
  const sesgada = !Number.isNaN(ratio) && Math.abs(ratio - 1) > SESGO_ANADA;
  const marca = chico ? "\x1b[90m" : sesgada ? "\x1b[33m" : "";
  const fin = marca ? "\x1b[0m" : "";

  console.log(
    `  ${marca}${r.anada}   ${String(nTotal).padStart(4)}    ${String(nCon).padStart(5)}  ` +
      `${pct(cob).padStart(4)}   ${money(r.saldo_con).padStart(6)} / ${money(r.saldo_sin).padEnd(6)} ` +
      `${Number.isNaN(ratio) ? " — " : `${ratio.toFixed(2)}x`}   ` +
      `${money(r.noi_con).padStart(6)} / ${money(r.noi_sin).padEnd(6)}  ` +
      `${r.ltv_con === null ? "—" : pct(Number(r.ltv_con))}/${r.ltv_sin === null ? "—" : pct(Number(r.ltv_sin))}` +
      `${chico ? "  (n bajo)" : sesgada ? "  ← sesgada" : ""}${fin}`,
  );

  if (!chico && !Number.isNaN(ratio)) ratios.push({ anada: r.anada, ratio, n: nCon });
}

console.log(`\n${"─".repeat(78)}`);
console.log("Veredicto");
console.log(`${"─".repeat(78)}\n`);

if (ratios.length < 2) {
  console.log(
    `  \x1b[33mMenos de dos añadas con n ≥ ${MIN_N}. No se puede evaluar comparabilidad.\x1b[0m\n`,
  );
} else {
  const max = ratios.reduce((a, b) => (a.ratio > b.ratio ? a : b));
  const min = ratios.reduce((a, b) => (a.ratio < b.ratio ? a : b));
  const dispersion = max.ratio / min.ratio;
  const sesgadas = ratios.filter((r) => Math.abs(r.ratio - 1) > SESGO_ANADA);

  console.log(
    `  Añadas con muestra suficiente: ${ratios.length}  ·  sesgadas: ${sesgadas.length}`,
  );
  console.log(
    `  Ratio de saldo mediano (con/sin): de ${min.ratio.toFixed(2)}x en ${min.anada} ` +
      `a ${max.ratio.toFixed(2)}x en ${max.anada}`,
  );
  console.log(`  Dispersión: ${dispersion.toFixed(2)}x  (umbral ${DISPERSION_MAX}x)\n`);

  if (dispersion > DISPERSION_MAX) {
    console.log(
      `  \x1b[31mLA SERIE ENTRE AÑADAS NO ES COMPARABLE TAL COMO ESTÁ.\x1b[0m`,
    );
    console.log(
      `  \x1b[90mEl sesgo de selección cambia de una añada a otra, así que parte de la\x1b[0m`,
    );
    console.log(
      `  \x1b[90mcaída de 11,5% a 1,0% puede ser qué préstamos logramos unir, no qué\x1b[0m`,
    );
    console.log(
      `  \x1b[90mpasó con el NOI. Hay que ponderar por tamaño o comparar dentro de\x1b[0m`,
    );
    console.log(`  \x1b[90mestratos antes de sostener el número.\x1b[0m\n`);
  } else if (sesgadas.length > 0) {
    console.log(`  \x1b[33mHay sesgo, pero es parejo entre añadas.\x1b[0m`);
    console.log(
      `  \x1b[90mLa muestra no representa al pool —los niveles absolutos están corridos—\x1b[0m`,
    );
    console.log(
      `  \x1b[90mpero todas las añadas lo están en la misma dirección y magnitud, así\x1b[0m`,
    );
    console.log(
      `  \x1b[90mque la COMPARACIÓN entre ellas se sostiene. El hallazgo es sobre la\x1b[0m`,
    );
    console.log(`  \x1b[90mtendencia, no sobre el nivel.\x1b[0m\n`);
  } else {
    console.log(`  \x1b[32mNo se detecta sesgo de selección por tamaño.\x1b[0m`);
    console.log(
      `  \x1b[90mLa muestra con desempeño se parece a su pool en todas las añadas con\x1b[0m`,
    );
    console.log(`  \x1b[90mn suficiente. La comparación entre añadas se sostiene.\x1b[0m\n`);
  }
}

/**
 * El hallazgo dentro de una banda de tamaño fija.
 *
 * POR QUÉ ESTO DECIDE
 *
 * El bloque anterior dice que la muestra con 10-D está sesgada por tamaño y que
 * el sesgo cambia de dirección entre añadas: 1,90x en 2020, 0,62x en 2023. Si el
 * tamaño se correlaciona con el crecimiento de NOI entregado, la serie 11,5% →
 * 1,0% mezcla dos efectos y no se puede atribuir al mercado.
 *
 * La forma de separarlos es restringir a un estrato donde las cinco añadas
 * tengan muestra: comparar préstamos de tamaño parecido contra préstamos de
 * tamaño parecido. El tamaño deja de variar, así que lo que quede de tendencia
 * no puede ser suyo.
 *
 * LA BANDA SE ELIGE ANTES DE VER EL RESULTADO
 *
 * 10M-30M, porque las medianas de las cinco submuestras —20,0M · 14,1M · 14,3M ·
 * 24,0M · 21,0M— caen todas adentro. Es el rango donde las cinco añadas tienen
 * masa, y se fija por esa razón y no por lo que produzca.
 *
 * CRITERIO DE SUPERVIVENCIA, TAMBIÉN FIJADO ANTES
 *
 * Sin estratificar, el entregado cae de 11,5% a 1,0%: 10,5 puntos. El hallazgo
 * sobrevive si dentro de la banda la caída conserva al menos la mitad —5 puntos—
 * y sigue siendo descendente. Si queda por debajo de eso, buena parte de la
 * caída era composición de la muestra y hay que reescribir la conclusión.
 */
const BANDA_MIN = 10_000_000;
const BANDA_MAX = 30_000_000;
const CAIDA_MINIMA = 0.05;

const { rows: estrato } = await query<{
  anada: string; n: string; entregado: number | null; proyectado: number | null;
}>(
  `SELECT extract(year FROM originated_at)::int::text AS anada,
          count(*)::text AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY growth_delivered) AS entregado,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_trailing)  AS proyectado
     FROM corpus.underwriting_outcomes
    WHERE days_after_origination >= 0
      AND is_full_year
      AND growth_delivered IS NOT NULL
      AND loan_amount_senior BETWEEN ${BANDA_MIN} AND ${BANDA_MAX}
    GROUP BY 1
   HAVING count(*) >= 20
    ORDER BY 1`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`El hallazgo dentro de la banda ${BANDA_MIN / 1e6}M-${BANDA_MAX / 1e6}M`);
console.log(`${"─".repeat(78)}\n`);
console.log(
  `\x1b[90m  Mismo tamaño contra mismo tamaño. Lo que quede de tendencia no puede\x1b[0m`,
);
console.log(`\x1b[90m  ser efecto del sesgo, porque el tamaño ya no varía.\x1b[0m\n`);

if (estrato.length < 2) {
  console.log(
    `  \x1b[33mMenos de dos añadas con n ≥ 20 en la banda. No alcanza para comparar.\x1b[0m\n`,
  );
} else {
  console.log(`  añada    n    NOI entregado    proyectado sobre histórico`);
  console.log(`  ${"─".repeat(56)}`);
  for (const e of estrato) {
    console.log(
      `  ${e.anada}   ${String(e.n).padStart(3)}      ` +
        `${e.entregado === null ? "—" : pct(Number(e.entregado), 1).padStart(6)}` +
        `             ${e.proyectado === null ? "—" : pct(Number(e.proyectado), 1).padStart(6)}`,
    );
  }

  const primero = estrato[0]!;
  const ultimo = estrato[estrato.length - 1]!;
  const caida = Number(primero.entregado) - Number(ultimo.entregado);

  console.log(
    `\n  Caída dentro de la banda: ${pct(caida, 1)} ` +
      `(de ${primero.anada} a ${ultimo.anada})`,
  );
  console.log(`  Umbral de supervivencia fijado antes: ${pct(CAIDA_MINIMA, 0)}\n`);

  if (caida >= CAIDA_MINIMA) {
    console.log(`  \x1b[32mEL HALLAZGO SOBREVIVE A LA ESTRATIFICACIÓN.\x1b[0m`);
    console.log(
      `  \x1b[90mComparando préstamos de tamaño equivalente, el entregado sigue cayendo.\x1b[0m`,
    );
    console.log(
      `  \x1b[90mLa magnitud puede diferir de la serie sin estratificar —parte de\x1b[0m`,
    );
    console.log(
      `  \x1b[90maquella era composición— pero la dirección y el orden no son artefacto.\x1b[0m\n`,
    );
  } else {
    console.log(`  \x1b[31mEL HALLAZGO NO SOBREVIVE.\x1b[0m`);
    console.log(
      `  \x1b[90mA tamaño constante la caída se desvanece: la serie 11,5% → 1,0% estaba\x1b[0m`,
    );
    console.log(
      `  \x1b[90mmidiendo qué préstamos logramos unir, no qué pasó con el NOI. La\x1b[0m`,
    );
    console.log(`  \x1b[90mconclusión hay que reescribirla.\x1b[0m\n`);
  }
}

console.log(
  `  \x1b[90mEsto mide sesgo por TAMAÑO. Un sesgo por tipo de activo o por emisor\x1b[0m`,
);
console.log(
  `  \x1b[90mrequiere su propia comprobación; la columna de office es solo un\x1b[0m`,
);
console.log(`  \x1b[90mindicio, no una prueba.\x1b[0m\n`);

await closePool();

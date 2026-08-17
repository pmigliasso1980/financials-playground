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

const { rows: perfil } = await query<{
  grupo: string; n: string; ev: string;
  io_mediana: string | null; io_share: string | null;
  rr_mediana: string | null; rr_share: string | null;
  proy_mediana: string | null; proy_share: string | null;
  saldo_mediana: string | null;
}>(
  `WITH base AS (${BASE}),
   mf AS (SELECT * FROM base WHERE subtipo = ANY($1) AND vendedor IS NOT NULL)
   SELECT CASE WHEN vendedor = $2 THEN $2 ELSE 'resto' END AS grupo,
          count(*)::text AS n,
          sum(evento)::text AS ev,

          -- IO como porción del plazo: 60 meses sobre 120 es la mitad del
          -- préstamo sin amortizar. El absoluto no es comparable entre plazos.
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY io_meses / nullif(plazo, 0)
          )::text AS io_mediana,
          (count(*) FILTER (WHERE io_meses / nullif(plazo, 0) >= 0.99)::numeric
            / nullif(count(*) FILTER (WHERE io_meses IS NOT NULL AND plazo IS NOT NULL), 0))::text
            AS io_share,

          -- Reserva de reposición mensual por dólar de saldo.
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY reserva_rep * 12 / nullif(saldo, 0) * 10000
          )::text AS rr_mediana,
          (count(*) FILTER (WHERE reserva_rep = 0 OR reserva_rep IS NULL)::numeric
            / nullif(count(*), 0))::text AS rr_share,

          -- Cuánto del NOI suscrito excede al histórico: la proyección.
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY noi_uw / nullif(noi_hist, 0)
          )::text AS proy_mediana,
          (count(*) FILTER (WHERE noi_uw / nullif(noi_hist, 0) > 1.15)::numeric
            / nullif(count(*) FILTER (WHERE noi_uw IS NOT NULL AND noi_hist IS NOT NULL), 0))::text
            AS proy_share,

          percentile_cont(0.5) WITHIN GROUP (ORDER BY saldo)::text AS saldo_mediana
     FROM mf
    GROUP BY 1
    ORDER BY 1`,
  [SUBTIPOS, VENDEDOR],
);

if (perfil.length < 2) {
  console.log(
    `\n  \x1b[33mNo hay dos grupos para comparar en ${SUBTIPOS.join(", ")}.\x1b[0m\n`,
  );
  await closePool();
  process.exit(0);
}

console.log(
  `\n\x1b[90m  Subtipos: ${SUBTIPOS.join(" · ")} — donde vive el exceso\x1b[0m\n`,
);

const f = (x: string | null, mult = 1, d = 2) =>
  x === null || x === "" ? "—" : num(Number(x) * mult, d);

console.log(`  grupo        n    ev     tasa`);
console.log(`  ${"─".repeat(44)}`);
for (const r of perfil) {
  const n = Number(r.n), ev = Number(r.ev);
  console.log(
    `  ${r.grupo.padEnd(10)} ${String(n).padStart(4)} ${String(ev).padStart(5)}  ` +
      `${((ev / n) * 100).toFixed(1).padStart(6)}%`,
  );
}

console.log(`\n${"─".repeat(78)}`);
console.log("El perfil que el DSCR y el LTV no ven");
console.log(`${"─".repeat(78)}\n`);
console.log(`  métrica                          ${perfil.map((r) => r.grupo.padStart(12)).join("")}`);
console.log(`  ${"─".repeat(60)}`);

const filas: Array<[string, (r: (typeof perfil)[number]) => string]> = [
  ["IO / plazo (mediana)", (r) => f(r.io_mediana, 1, 2)],
  ["% solo-interés todo el plazo", (r) => f(r.io_share, 100, 0) + "%"],
  ["Reserva repos. anual (pb del saldo)", (r) => f(r.rr_mediana, 1, 0)],
  ["% sin reserva de reposición", (r) => f(r.rr_share, 100, 0) + "%"],
  ["NOI suscrito / histórico (mediana)", (r) => f(r.proy_mediana, 1, 2)],
  ["% con proyección > 15%", (r) => f(r.proy_share, 100, 0) + "%"],
  ["Saldo mediano (M)", (r) => f(r.saldo_mediana, 1 / 1e6, 1)],
];

for (const [etiqueta, get] of filas) {
  console.log(
    `  ${etiqueta.padEnd(34)} ${perfil.map((r) => get(r).padStart(12)).join("")}`,
  );
}

const chico = perfil.find((r) => Number(r.n) < MIN_CELDA);
if (chico) {
  console.log(
    `\n  \x1b[31mEl grupo "${chico.grupo}" tiene ${chico.n} préstamos: no alcanza.\x1b[0m`,
  );
}

console.log(
  `\n  \x1b[90mUna diferencia grande en solo-interés o en la proyección de NOI sería un\x1b[0m`,
);
console.log(
  `  \x1b[90mMECANISMO: explica por qué el mismo DSCR y el mismo LTV rinden distinto.\x1b[0m`,
);
console.log(
  `  \x1b[90mUna diferencia en el saldo mediano sería un confundido nuevo, no un\x1b[0m`,
);
console.log(
  `  \x1b[90mmecanismo — y quedaría como el próximo control pendiente.\x1b[0m`,
);
console.log(
  `\n  \x1b[90mCon ~59 préstamos esto describe un perfil. No prueba causalidad.\x1b[0m\n`,
);

await closePool();

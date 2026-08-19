/**
 * Does the sample with performance represent its vintage's pool?
 *
 *   npm run db:bias
 *
 * WHY THIS CAN INVALIDATE THE FINDING
 *
 * The project's result says delivered NOI growth fell from 11.5% in the 2021
 * vintage to 1.0% in 2024. That number comes from the loans that have a servicer
 * report, which are ~2,200 of 8,935.
 *
 * Comparing 2021 against 2024 assumes the two subsamples resemble their pools. If
 * they do not —if in one vintage the 10-D only joins against small loans and in
 * another against all of them— the series compares different populations and the
 * collapse could be an artefact of which loans we managed to join.
 *
 * This is not an abstract worry. The join against the servicer is worst precisely
 * in 2020-2021, which are the vintages that parse worst and where the high end of
 * the series comes from. That is: **the finding's most important number rests on
 * the weakest data.**
 *
 * WHAT IT LOOKS AT
 *
 * For each vintage, the profile of the loans WITH performance against those
 * WITHOUT, over the same pool. If the bias exists but is the same across every
 * vintage, the comparison between vintages is still valid — they are all shifted
 * the same way. What breaks the series is the bias CHANGING.
 *
 * THE THRESHOLDS ARE FIXED BEFORE SEEING THE NUMBERS
 *
 * Choosing them by looking at the result would be choosing the conclusion.
 *
 *   a vintage is biased        if the sample's median balance departs more than
 *                              25% from the rest of the pool's
 *   the series is not          if the direction or magnitude of the bias differs
 *   comparable                 between vintages: max(ratio) / min(ratio) > 1.5
 *   vintages are ignored       with fewer than 50 loans with performance, because
 *                              a median over 12 cases says nothing
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const VINTAGE_BIAS = 0.25;
const MAX_DISPERSION = 1.5;
const MIN_N = 50;

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const money = (v: number | null) =>
  v === null ? "—" : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.round(v).toLocaleString("en-US");

console.log(`\n${"═".repeat(78)}`);
console.log("Selection bias of the sample with performance");
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  The finding compares vintages. That only holds if the subsample with a 10-D\x1b[0m`,
);
console.log(
  `\x1b[90m  resembles its pool, or deviates the SAME way in all of them. Thresholds fixed\x1b[0m`,
);
console.log(`\x1b[90m  before running: bias ${pct(VINTAGE_BIAS)} · dispersion ${MAX_DISPERSION}x · minimum n ${MIN_N}.\x1b[0m\n`);

interface Fila {
  vintage: string;
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
 * `with` is a loan that has at least one performance record AFTER closing. The day
 * filter matters: a period starting before the issuance date overlaps with the
 * historical figures the underwriter already had in front of them, so it does not
 * measure an outcome and does not count as coverage either.
 */
const { rows } = await query<Fila>(
  `WITH base AS (
     SELECT l.id,
            extract(year FROM f.filed_at)::int AS vintage,
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
   SELECT vintage::text AS vintage,
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
    GROUP BY vintage
    ORDER BY vintage`,
);

/**
 * Before measuring the bias, check there is a sample at all.
 *
 * "0% coverage" has two causes with two different fixes: the performance table is
 * empty, or it is populated but no period is after closing. Without
 * distinguishing them, the diagnosis sends you to look at the wrong side.
 *
 * The first is a real risk of this schema: `corpus.performance` references
 * `loans(id)` with ON DELETE CASCADE, and `--refresh-stale` deletes the loans
 * before rewriting them. **Every Annex A re-harvest destroys the accumulated
 * performance**, and nothing warns you — the identities still close, the corpus
 * still has 8,935 loans, and the only thing missing is the table no check
 * mira—.
 */
const { rows: healthRows } = await query<{
  rows: string; loans: string; after_closing: string;
}>(
  `SELECT count(*)::text AS rows,
          count(DISTINCT p.loan_id)::text AS loans,
          count(*) FILTER (WHERE (p.noi_start - f.filed_at) >= 0)::text AS after_closing
     FROM corpus.performance p
     JOIN corpus.loans l   ON l.id = p.loan_id
     JOIN corpus.filings f ON f.accession = l.accession`,
);

const perfHealth = healthRows[0];
const perfRows = Number(perfHealth?.rows ?? 0);
const afterClosing = Number(perfHealth?.after_closing ?? 0);

if (perfRows === 0) {
  console.log(`${"─".repeat(78)}`);
  console.log(`\n  \x1b[31mTHE PERFORMANCE TABLE IS EMPTY.\x1b[0m\n`);
  console.log(
    `  \x1b[90mThis is not a problem with this check: there is nothing to measure bias against.\x1b[0m`,
  );
  console.log(
    `  \x1b[90m\`corpus.performance\` referencia \`loans(id)\` con ON DELETE CASCADE, y\x1b[0m`,
  );
  console.log(
    `  \x1b[90m\`--refresh-stale\` deletes the loans before rewriting them. Every\x1b[0m`,
  );
  console.log(
    `  \x1b[90mAnnex A re-harvest takes the accumulated performance with it.\x1b[0m\n`,
  );
  console.log(`  Reconstruir con:  \x1b[1mnpm run db:performance\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

if (afterClosing === 0) {
  console.log(`${"─".repeat(78)}`);
  console.log(
    `\n  \x1b[33m${perfRows} performance rows, but none after closing.\x1b[0m\n`,
  );
  console.log(
    `  \x1b[90mThe table is populated; what fails is the date filter. A period that\x1b[0m`,
  );
  console.log(
    `  \x1b[90mstarts before the issuance overlaps with the historical figures the\x1b[0m`,
  );
  console.log(
    `  \x1b[90munderwriter already had in front of them, so it does not measure an outcome.\x1b[0m\n`,
  );
  await closePool();
  process.exit(0);
}

console.log(
  `\x1b[90m  ${perfRows.toLocaleString("en-US")} performance rows · ${afterClosing.toLocaleString("en-US")} after closing.\x1b[0m\n`,
);

console.log(`${"─".repeat(78)}`);
console.log("Coverage and profile, vintage by vintage");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  vintage  pool  with 10-D  cov.   median balance       median NOI        LTV`,
);
console.log(
  `                                  with / without ratio  with / without  with/without`,
);
console.log(`  ${"─".repeat(74)}`);

const ratios: Array<{ vintage: string; ratio: number; n: number }> = [];

for (const r of rows) {
  const nTotal = Number(r.n_total);
  const nCon = Number(r.n_con);
  const cob = nTotal > 0 ? nCon / nTotal : 0;
  const ratio =
    r.saldo_con !== null && r.saldo_sin !== null && Number(r.saldo_sin) !== 0
      ? Number(r.saldo_con) / Number(r.saldo_sin)
      : NaN;

  const chico = nCon < MIN_N;
  const biased = !Number.isNaN(ratio) && Math.abs(ratio - 1) > VINTAGE_BIAS;
  const marca = chico ? "\x1b[90m" : biased ? "\x1b[33m" : "";
  const fin = marca ? "\x1b[0m" : "";

  console.log(
    `  ${marca}${r.vintage}   ${String(nTotal).padStart(4)}    ${String(nCon).padStart(5)}  ` +
      `${pct(cob).padStart(4)}   ${money(r.saldo_con).padStart(6)} / ${money(r.saldo_sin).padEnd(6)} ` +
      `${Number.isNaN(ratio) ? " — " : `${ratio.toFixed(2)}x`}   ` +
      `${money(r.noi_con).padStart(6)} / ${money(r.noi_sin).padEnd(6)}  ` +
      `${r.ltv_con === null ? "—" : pct(Number(r.ltv_con))}/${r.ltv_sin === null ? "—" : pct(Number(r.ltv_sin))}` +
      `${chico ? "  (n bajo)" : biased ? "  ← biased" : ""}${fin}`,
  );

  if (!chico && !Number.isNaN(ratio)) ratios.push({ vintage: r.vintage, ratio, n: nCon });
}

console.log(`\n${"─".repeat(78)}`);
console.log("Veredicto");
console.log(`${"─".repeat(78)}\n`);

if (ratios.length < 2) {
  console.log(
    `  \x1b[33mFewer than two vintages with n ≥ ${MIN_N}. Comparability cannot be assessed.\x1b[0m\n`,
  );
} else {
  const max = ratios.reduce((a, b) => (a.ratio > b.ratio ? a : b));
  const min = ratios.reduce((a, b) => (a.ratio < b.ratio ? a : b));
  const dispersion = max.ratio / min.ratio;
  const biased = ratios.filter((r) => Math.abs(r.ratio - 1) > VINTAGE_BIAS);

  console.log(
    `  Vintages with enough sample: ${ratios.length}  ·  biased: ${biased.length}`,
  );
  console.log(
    `  Median balance ratio (with/without): from ${min.ratio.toFixed(2)}x in ${min.vintage} ` +
      `to ${max.ratio.toFixed(2)}x in ${max.vintage}`,
  );
  console.log(`  Dispersion: ${dispersion.toFixed(2)}x  (threshold ${MAX_DISPERSION}x)\n`);

  if (dispersion > MAX_DISPERSION) {
    console.log(
      `  \x1b[31mTHE SERIES BETWEEN VINTAGES IS NOT COMPARABLE AS IT STANDS.\x1b[0m`,
    );
    console.log(
      `  \x1b[90mThe selection bias changes from one vintage to another, so part of the\x1b[0m`,
    );
    console.log(
      `  \x1b[90mfall from 11.5% to 1.0% may be which loans we managed to join, not what\x1b[0m`,
    );
    console.log(
      `  \x1b[90mhappened to the NOI. It has to be weighted by size or compared within\x1b[0m`,
    );
    console.log(`  \x1b[90mstrata before the number can be defended.\x1b[0m\n`);
  } else if (biased.length > 0) {
    console.log(`  \x1b[33mThere is bias, but it is even across vintages.\x1b[0m`);
    console.log(
      `  \x1b[90mThe sample does not represent the pool —the absolute levels are shifted—\x1b[0m`,
    );
    console.log(
      `  \x1b[90mbut every vintage is shifted in the same direction and magnitude, so\x1b[0m`,
    );
    console.log(
      `  \x1b[90mthe COMPARISON between them holds. The finding is about the trend, not\x1b[0m`,
    );
    console.log(`  \x1b[90mabout the level.\x1b[0m\n`);
  } else {
    console.log(`  \x1b[32mNo size-based selection bias detected.\x1b[0m`);
    console.log(
      `  \x1b[90mThe sample with performance resembles its pool in every vintage with\x1b[0m`,
    );
    console.log(`  \x1b[90menough n. The comparison between vintages holds.\x1b[0m\n`);
  }
}

/**
 * The finding within a fixed size band.
 *
 * WHY THIS DECIDES
 *
 * The previous block says the sample with a 10-D is biased by size and that the
 * bias changes direction between vintages: 1.90x in 2020, 0.62x in 2023. If size
 * correlates with delivered NOI growth, the series 11.5% → 1.0% mixes two effects
 * and cannot be attributed to the market.
 *
 * The way to separate them is to restrict to a stratum where all five vintages
 * have a sample: compare loans of similar size against loans of similar size. Size
 * stops varying, so whatever trend remains cannot be its.
 *
 * THE BAND IS CHOSEN BEFORE SEEING THE RESULT
 *
 * 10M-30M, because the medians of the five subsamples —20.0M · 14.1M · 14.3M ·
 * 24.0M · 21.0M— all fall inside it. It is the range where all five vintages have
 * mass, and it is fixed for that reason and not for what it produces.
 *
 * SURVIVAL CRITERION, ALSO FIXED BEFOREHAND
 *
 * Unstratified, delivered growth falls from 11.5% to 1.0%: 10.5 points. The
 * finding survives if within the band the fall retains at least half —5 points—
 * and is still downward. If it comes in below that, much of the fall was sample
 * composition and the conclusion has to be rewritten.
 */
const BAND_MIN = 10_000_000;
const BAND_MAX = 30_000_000;
const CAIDA_MINIMA = 0.05;

const { rows: estrato } = await query<{
  vintage: string; n: string; entregado: number | null; proyectado: number | null;
}>(
  `SELECT extract(year FROM originated_at)::int::text AS vintage,
          count(*)::text AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY growth_delivered) AS entregado,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_vs_trailing)  AS proyectado
     FROM corpus.underwriting_outcomes
    WHERE days_after_origination >= 0
      AND is_full_year
      AND growth_delivered IS NOT NULL
      AND loan_amount_senior BETWEEN ${BAND_MIN} AND ${BAND_MAX}
    GROUP BY 1
   HAVING count(*) >= 20
    ORDER BY 1`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`The finding within the ${BAND_MIN / 1e6}M-${BAND_MAX / 1e6}M band`);
console.log(`${"─".repeat(78)}\n`);
console.log(
  `\x1b[90m  Same size against same size. Whatever trend remains cannot be an effect\x1b[0m`,
);
console.log(`\x1b[90m  of the bias, because size no longer varies.\x1b[0m\n`);

if (estrato.length < 2) {
  console.log(
    `  \x1b[33mFewer than two vintages with n ≥ 20 in the band. Not enough to compare.\x1b[0m\n`,
  );
} else {
  console.log(`  vintage   n    delivered NOI    projected over historical`);
  console.log(`  ${"─".repeat(56)}`);
  for (const e of estrato) {
    console.log(
      `  ${e.vintage}   ${String(e.n).padStart(3)}      ` +
        `${e.entregado === null ? "—" : pct(Number(e.entregado), 1).padStart(6)}` +
        `             ${e.proyectado === null ? "—" : pct(Number(e.proyectado), 1).padStart(6)}`,
    );
  }

  const primero = estrato[0]!;
  const ultimo = estrato[estrato.length - 1]!;
  const fall = Number(primero.entregado) - Number(ultimo.entregado);

  console.log(
    `\n  Fall within the band: ${pct(fall, 1)} ` +
      `(de ${primero.vintage} a ${ultimo.vintage})`,
  );
  console.log(`  Umbral de supervivencia fijado antes: ${pct(CAIDA_MINIMA, 0)}\n`);

  if (fall >= CAIDA_MINIMA) {
    console.log(`  \x1b[32mTHE FINDING SURVIVES STRATIFICATION.\x1b[0m`);
    console.log(
      `  \x1b[90mComparing loans of equivalent size, delivered growth still falls.\x1b[0m`,
    );
    console.log(
      `  \x1b[90mThe magnitude may differ from the unstratified series —part of that\x1b[0m`,
    );
    console.log(
      `  \x1b[90mwas composition— but the direction and the ordering are not an artefact.\x1b[0m\n`,
    );
  } else {
    console.log(`  \x1b[31mEL HALLAZGO NO SOBREVIVE.\x1b[0m`);
    console.log(
      `  \x1b[90mAt constant size the fall vanishes: the series 11.5% → 1.0% was\x1b[0m`,
    );
    console.log(
      `  \x1b[90mmeasuring which loans we managed to join, not what happened to the NOI.\x1b[0m`,
    );
    console.log(`  \x1b[90mThe conclusion has to be rewritten.\x1b[0m\n`);
  }
}

console.log(
  `  \x1b[90mThis measures bias by SIZE. A bias by asset type or by issuer needs its\x1b[0m`,
);
console.log(
  `  \x1b[90mown check; the office column is only an indication, not proof.\x1b[0m\n`,
);

await closePool();

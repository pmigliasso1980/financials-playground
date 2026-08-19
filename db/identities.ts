/**
 * Arithmetic identities between metrics mapped independently.
 *
 *   npm run db:identities
 *
 * WHY THIS IS THE STRONGEST VERIFICATION WE HAVE
 *
 * Each Annex A column is mapped independently: one pattern over the
 * encabezado, sin mirar las otras. `net_cash_flow` no sabe nada de
 * `debt_service_pi`, y ninguno sabe de `dscr_ncf`.
 *
 * But the issuer computed them from the same figures, so they have to close
 * against each other:
 *
 *     DSCR (NCF)  =  NCF / debt service
 *     NCF         =  NOI − replacement reserve − TI/LC
 *     debt yield  =  NOI / balance
 *     LTV         =  balance / appraised value
 *
 * If three independently mapped columns satisfy an identity over thousands of
 * loans, the probability that all three are wrong in a mutually cancelling way is
 * negligible. And if they do NOT close, there is a mapping error no metric looked
 * at alone would have revealed — which is exactly the kind of error that took us
 * eight iterations to find by hand.
 *
 * This verification only became possible once the Annex A blocks that used to be
 * discarded whole were mapped: without `debt_service_pi` we had the DSCR but not
 * its parts, so there was nothing to check it against.
 *
 * SOBRE LA TOLERANCIA
 *
 * No se exige igualdad exacta. Los emisores redondean —el DSCR se publica con
 * two decimals, and 1.45 can come from anything between 1.445 and 1.455— so the
 * default tolerance is 1%. What matters is not the individual case but the
 * proportion: if 95% of loans close, the mapping is right and the remaining 5%
 * are odd cases worth looking at. If 60% close, there is a systematic problem.
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
console.log("Arithmetic identities");
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  Each metric is mapped on its own, without looking at the others. That they\x1b[0m`,
);
console.log(`\x1b[90m  es evidencia de que el mapeo es correcto. Tolerancia ${pct(TOLERANCE, 0)}.\x1b[0m\n`);

/** A numeric fact for one metric, ready to join. */
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
 * DSCR against its two parts, scaled to the whole loan.
 *
 * Two things have to be right here and neither is written in the document.
 *
 * 1. A LOAN WITH AN INTEREST-ONLY PERIOD HAS TWO DEBT SERVICE FIGURES.
 *    The issuer computes the DSCR against whichever applies at the time, so we
 *    use the IO one when it exists and the P&I one when it does not.
 *
 * 2. DEBT SERVICE IS FOR THE TRUST'S NOTE; THE DSCR IS FOR THE WHOLE LOAN.
 *    The Annex A publishes "Annual Debt Service" for the portion this issuance
 *    bought, but the ratio against the whole property's NOI. Without scaling, the
 *    identity fails precisely on the split loans.
 *
 *    It scales by balance because every note of the same loan shares the rate and
 *    amortisation: service per dollar is identical across all of them. Verified by
 *    hand before writing it, over the three worst deviations:
 *
 *      loan 46:  164.630 × 288,1 = 47,4M → 97.102.547 / 47,4M = 2,05  (pub. 2,04)
 *      loan 23:  557.608 × 207,7 = 115,8M → 236.785.998 / 115,8M = 2,05 (pub. 2,04)
 *      loan 24:  381.529 × 106,6 = 40,7M → 84.349.369 / 40,7M = 2,07  (pub. 2,07)
 *
 *    Three loans from three different issuers, with different factors, giving the
 *    valor publicado al segundo decimal. No es coincidencia.
 */
/**
 * The senior balance: the published column if it exists, the sum if not.
 *
 * Building the senior balance by summing two metrics depends on BOTH having been
 * mapped correctly. Several issuances publish the total in a single column and the
 * reconciler found them by comparing values, not names. When it is there, it is
 * esa: no depende de que el pari passu se haya capturado, ni de que el Annex lo
 * publique por separado.
 */
const SENIOR =
  "coalesce(sen.value::numeric, amt.value::numeric + coalesce(npp.value::numeric, 0))";
const SENIOR_JOINS =
  `${fact("amt", "loan_amount")} ${fact("npp", "balance_pari_passu_non_trust")} ` +
  `${fact("sen", "balance_senior_total")}`;
/** Debt service on the trust's note, scaled to the whole loan. */
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
 * It is the identity that motivated mapping the discarded blocks: we had NOI and
 * NCF but neither of the two subtrahends, so the difference between them was a
 * number with no explanation.
 */
const ncf = await checkIdentity(
  "NCF = NOI − replacement − TI/LC",
  "net_cash_flow · noi_underwritten · underwritten_replacement_reserve · underwritten_tilc",
  `${fact("ncf", "net_cash_flow")} ${fact("noi", "noi_underwritten")} ` +
    `${fact("rep", "underwritten_replacement_reserve")} ${fact("tilc", "underwritten_tilc")}`,
  "noi.value::numeric - coalesce(rep.value::numeric, 0) - coalesce(tilc.value::numeric, 0)",
  "ncf.value::numeric",
);
if (ncf) results.push(ncf);

/**
 * WHICH BALANCE EACH RATIO CLOSES AGAINST
 *
 * An Annex A publishes seven balances for the same loan, and the ratios are
 * computed against one of them without saying which. Assuming is how we got into
 * the problem: `loan_amount` pointed at "Original Balance" —this trust's portion
 * of a split loan— and the computed debt yield came out at 3947%.
 *
 * Rather than choosing by intuition, every candidate is tried and the one that
 * closes wins. The proportion closing against each one IS the answer as to which
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
console.log(`Which balance each ratio uses`);
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
  `  \x1b[90mIf none passes 90%, there are balances left to map or there are loans with\x1b[0m`,
);
console.log(`  \x1b[90ma debt structure we do not model yet.\x1b[0m`);

const debtYield = await checkIdentity(
  "Debt yield = NOI suscrito / saldo",
  `debt_yield · noi_underwritten · ${bestBalance.label}`,
  `${fact("dy", "debt_yield")} ${fact("noi", "noi_underwritten")} ${bestBalance.joins}`,
  `noi.value::numeric / NULLIF(${bestBalance.sql}, 0)`,
  "dy.value::numeric",
);
if (debtYield) results.push(debtYield);

const ltv = await checkIdentity(
  "LTV = balance / appraised value",
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
      `  Did you harvest with the new mapping?  npm run harvest:batch -- --limit 100\n`,
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
    `  Independently mapped metrics satisfy the relationships the issuer used`,
  );
  console.log(`  to compute them. It is the strongest evidence that the mapping is correct.`);
} else {
  for (const r of [...broken, ...partial]) {
    const sev = r.share < 0.7 ? "\x1b[31m" : "\x1b[33m";
    console.log(`  ${sev}${r.label}\x1b[0m cierra solo en ${pct(r.share, 0)} de ${r.n}.`);
    console.log(`  \x1b[90m  metrics: ${r.formula}\x1b[0m`);
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
    `  \x1b[90mabout how the issuer computes. Both have to be understood before\x1b[0m`,
  );
  console.log(`  \x1b[90mconstruir encima.\x1b[0m`);
}

// ---------------------------------------------------------------------------
// Where do the failures concentrate?
// ---------------------------------------------------------------------------

/**
 * The question that decides what to fix.
 *
 * The four failing identities fail in the same proportion (73-75%) and on the same
 * loans, with repeated error factors of ~280x. That rules out rounding and rules
 * out one metric being confused with another: it is scale, or
 * es que estamos leyendo la fila equivocada.
 *
 * Si las fallas se concentran en pocos filings, el problema es de formato —un
 * emisor que publica en miles, o una columna distinta con el mismo nombre— y se
 * fixed in the mapping. If they are spread evenly across all filings, the problem
 * is per loan and we have to find what those loans have in common.
 *
 * They are two completely different fixes, and looking at the aggregate does not
 * tell them apart.
 */
console.log(`\n${"─".repeat(78)}`);
console.log(`Where they fail`);
console.log(`${"─".repeat(78)}\n`);

/**
 * La sonda usa el denominador ganador, no `loan_amount` suelto.
 *
 * It used to use only the trust balance and reported 865 broken loans spread over
 * 99 filings, with the conclusion "the problem is per loan". That was true —the
 * problem was the pari passu, which is a property of the loan— but the diagnosis
 * went stale the moment it was fixed. A probe that measures against a
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
  console.log(`    all its loans OK        ${String(bf.clean).padStart(4)}`);
  console.log(`    ninguno OK               ${String(bf.broken).padStart(4)}`);
  console.log(`    mezclados                ${String(bf.mixed).padStart(4)}`);

  const total = Number(bf.filings);
  const mixed = Number(bf.mixed);
  const failing = Number(profileFailing);

  /**
   * Nombrar las emisiones que fallan enteras, no contarlas.
   *
   * "15 issuances with none OK" is a concentrated signal —a convention we do not
   * model, not noise— and the count does not let you chase it. It is the same error
   * this file points out elsewhere: a diagnostic that reports magnitude
   * en vez de identidad obliga a escribir una consulta a mano para actuar.
   */
  /**
   * The performance table exists.
   *
   * NO OTHER CHECK LOOKS AT IT
   *
   * `corpus.performance` references `loans(id)` with ON DELETE CASCADE, and
   * `--refresh-stale` deletes the loans before rewriting them. Every Annex A
   * re-harvest destroys the accumulated performance.
   *
   * It happened, and went undetected for a whole day. Everything else looked
   * healthy: the five identities closed at 97%, the corpus had its 8,935 loans,
   * the pool shares summed to 100%. The only thing missing was half the finding
   * —the actual-outcome side— and nothing said so.
   *
   * Es el mismo principio que la suma del pool aplicado a otra tabla: un corpus
   * al que le falta una pieza entera es indistinguible de uno correcto si nadie
   * pregunta por esa pieza.
   */
  const { rows: perf } = await query<{ filas: string; prestamos: string }>(
    `SELECT count(*)::text AS filas, count(DISTINCT loan_id)::text AS prestamos
       FROM corpus.performance`,
  );
  const perfRows = Number(perf[0]?.filas ?? 0);

  console.log(`\n  \x1b[1mPost-closing performance\x1b[0m`);
  if (perfRows === 0) {
    console.log(
      `    \x1b[31mEMPTY. The finding cannot be reproduced in this state.\x1b[0m`,
    );
    console.log(
      `    \x1b[90mUna recosecha con --refresh-stale la borra: el CASCADE viene de\x1b[0m`,
    );
    console.log(
      `    \x1b[90mloans(id). Reconstruir con \x1b[0m\x1b[1mnpm run db:performance\x1b[0m`,
    );
  } else {
    console.log(
      `    ${perfRows.toLocaleString("en-US")} rows · ${Number(perf[0]!.prestamos).toLocaleString("en-US")} loans`,
    );
  }

  /**
   * Las participaciones del pool tienen que sumar 100%.
   *
   * THE CHECK THAT WAS MISSING: IF LOANS ARE LOST, NOBODY FINDS OUT
   *
   * Every other check in this file looks at loans that are present.
   * Ninguna detecta los que faltan: si el parser descarta la mitad de las filas,
   * la otra mitad sigue cerrando sus identidades, sus valores siguen siendo
   * razonables y los chequeos de sanidad siguen pasando. El corpus no tiene
   * forma de saber que le falta algo.
   *
   * It happened with Morgan Stanley 2021-L5. It dropped from 65 to 19 loans
   * between two harvests and was only noticed because the corpus total moved by 46
   * estaba mirando por otro motivo.
   *
   * `% of Initial Pool Balance` resuelve esto: el emisor publica la
   * each loan's share of the pool, and by construction they sum to one. If an
   * issuance sums to 0.30, two thirds of its loans are missing, and there is no
   * need to know how many it should have or to consult any external source.
   *
   * It also distinguishes the cause. A sum going over 1 is the opposite: rows
   * counted twice, or property rows taken for loans — which
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
    `  \x1b[90mIt detects lost loans, which no other check sees.\x1b[0m\n`,
  );

  if (evaluadas === 0) {
    console.log(`    \x1b[33mNo filing has pool_share mapped.\x1b[0m`);
  } else if (pool.length === 0) {
    console.log(
      `    \x1b[32mLas ${evaluadas} emisiones con pool_share suman 100% ± 3%.\x1b[0m`,
    );
  } else {
    console.log(`    ${pool.length} de ${evaluadas} emisiones no suman 100%:\n`);
    /**
     * The sum alone does not say which of the two causes it is.
     *
     * If the issuance has 31 loans and only 5 carry `pool_share`, the 22.8% does
     * not mean rows were lost: it means the column was not mapped in the other 26
     * and we are summing a fifth of the pool. Two different problems with two
     * different fixes, and without comparing against the issuance's total loan
     * count the diagnosis points the wrong way.
     *
     * It happened on the first run of this very check, three lines after the file
     * declared that a failure has to say which of its causes it is.
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
            : "rows counted twice";
      console.log(
        `    ${p.year}  ${p.company.slice(0, 36).padEnd(36)} ${pct(s, 1).padStart(7)}  ${String(con).padStart(3)}/${String(tot).padEnd(3)}  \x1b[90m${dx}\x1b[0m`,
      );
    }
    console.log(
      `\n    \x1b[90mOnly those saying "rows missing" are lost loans. The\x1b[0m`,
    );
    console.log(`    \x1b[90m"partial" ones are a mapping gap in that issuance.\x1b[0m`);
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
          `    ${w.year}  ${w.company.slice(0, 46).padEnd(46)} ${String(w.loans).padStart(4)} loans`,
        );
      }
      const years = [...new Set(worst.map((w) => w.year))].sort();
      console.log(
        `\n    \x1b[90mVintages: ${years.join(", ")}. If they concentrate in one, it is a format\x1b[0m`,
      );
      console.log(`    \x1b[90mconvention; if they are spread out, it is per loan.\x1b[0m`);
    }
  }
  console.log();
  /**
   * Cuando el residuo es chico, decirlo.
   *
   * This section was written when one row in four failed and it served to decide
   * where to look. With the correct denominator 27 of 3,528 remain, and the text
   * still said "there is some of both" —sending someone to investigate a solved
   * problem. A diagnostic that does not switch off when its cause is fixed
   * es ruido con formato de alerta.
   */
  if (failing > 0 && failing < 60) {
    console.log(`  \x1b[32m${failing} loans remain outside tolerance out of thousands.\x1b[0m`);
    console.log(`  It is residue: issuer rounding and one-off debt structures.`);
    console.log(`  \x1b[90mThere is no pattern to chase until that number grows again.\x1b[0m`);
  } else if (mixed / total < 0.2) {
    console.log(`  \x1b[33mThe failures concentrate by filing.\x1b[0m A filing either closes or does not`);
    console.log(`  close as a whole: it is an issuer format problem, not individual loans.`);
  } else if (mixed / total > 0.6) {
    console.log(`  \x1b[33mAlmost every filing has good and bad loans mixed together.\x1b[0m`);
    console.log(`  The problem is per loan: we have to find what the failing ones share.`);
  } else {
    console.log(`  \x1b[33mHay de las dos cosas\x1b[0m: filings enteros rotos y filings mezclados.`);
  }
}

/**
 * And what the failing loans have in common.
 *
 * The most economical suspicion given a factor of ~280: they are loans with
 * several properties. If the balance is published at loan level and the NOI at
 * property level —or the other way round— the relationship between them breaks
 * precisely on the multi-property ones, and the factor would be the number of
 * properties or something proportional to it.
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
        `The problem is in loan_amount:`,
    );
    console.log(`  o hay dos columnas distintas con el mismo nombre, o vienen en escalas distintas.`);
  } else if (Number(bad.props) > Number(ok.props)) {
    console.log(
      `  \x1b[33mThe failing ones have more properties (${Number(bad.props).toFixed(1)} against ${Number(ok.props).toFixed(1)}).\x1b[0m`,
    );
    console.log(`  Balance and NOI would be published at different levels on the multi-property ones.`);
  } else {
    console.log(`  \x1b[90mNo hay una diferencia obvia de perfil. Hay que mirar casos a mano.\x1b[0m`);
  }
}

/**
 * Coverage: an identity closing over twenty loans is worth nothing.
 */
const { rows: coverage } = await query<{ total: string }>(
  `SELECT count(*) AS total FROM corpus.loans`,
);
const total = Number(coverage[0]?.total ?? 0);
if (total > 0) {
  console.log(`\n  \x1b[90mCoverage over ${total} loans of the corpus:\x1b[0m`);
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
console.log(`  \x1b[90mis verified against itself.\x1b[0m\n`);

await closePool();

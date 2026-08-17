/**
 * Abre un préstamo y muestra de qué columna salió cada número.
 *
 *   npm run db:explain                 los peores casos de las identidades
 *   npm run db:explain -- 1234         un préstamo puntual por id interno
 *
 * PARA QUÉ SIRVE
 *
 * Cuando una identidad no cierra hay dos posibilidades y desde el agregado no se
 * distinguen: o mapeamos la columna equivocada, o el emisor calcula sobre una
 * base distinta a la que suponemos. Las dos se resuelven igual —mirando el
 * encabezado original de cada valor— y por eso las observations guardan
 * `source_header` desde el principio.
 *
 * Este script es el uso concreto de esa decisión: reconstruye el renglón del
 * Annex A tal como estaba, con el nombre de columna que el emisor le puso al
 * lado del valor que nosotros guardamos.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const arg = process.argv[2];

/** Métricas que participan de las identidades que no cierran. */
const RELEVANT = [
  "loan_amount", "appraised_value", "noi_underwritten", "net_cash_flow",
  "debt_yield", "debt_yield_whole_loan", "debt_yield_total_debt",
  "ltv", "ltv_whole_loan", "ltv_total_debt", "ltv_maturity",
  "dscr", "dscr_ncf", "dscr_whole_loan", "dscr_total_debt",
  "debt_service_pi", "debt_service_io", "units", "square_feet", "property_count",
];

const money = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : String(n);
};

/**
 * Elige los préstamos donde la identidad del debt yield falla más fuerte.
 * Se usa esa porque involucra las tres métricas sospechosas a la vez.
 */
async function worstOffenders(limit = 3): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT l.id::text
       FROM corpus.loans l
       JOIN corpus.facts dy  ON dy.loan_id  = l.id AND dy.metric_key  = 'debt_yield'       AND dy.value  ~ '^-?[0-9.]+$'
       JOIN corpus.facts noi ON noi.loan_id = l.id AND noi.metric_key = 'noi_underwritten' AND noi.value ~ '^-?[0-9.]+$'
       JOIN corpus.facts amt ON amt.loan_id = l.id AND amt.metric_key = 'loan_amount'      AND amt.value ~ '^-?[0-9.]+$'
      WHERE amt.value::numeric <> 0 AND dy.value::numeric <> 0
      ORDER BY abs((noi.value::numeric / amt.value::numeric) / dy.value::numeric - 1) DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => r.id);
}

const ids = arg ? [arg] : await worstOffenders();

if (ids.length === 0) {
  console.error("\n✗ Sin préstamos para inspeccionar.\n");
  await closePool();
  process.exit(1);
}

console.log(`\n${"═".repeat(78)}`);
console.log(arg ? `Préstamo ${arg}` : "Peores desvíos de la identidad del debt yield");
console.log(`${"═".repeat(78)}`);

for (const id of ids) {
  const { rows: meta } = await query<{
    loan_ref: string | null; property_name: string | null; property_type: string | null;
    company_name: string; accession: string;
  }>(
    `SELECT l.loan_ref, l.property_name, l.property_type, f.company_name, f.accession
       FROM corpus.loans l JOIN corpus.filings f ON f.accession = l.accession
      WHERE l.id = $1`,
    [id],
  );

  const m = meta[0];
  if (!m) {
    console.log(`\n  \x1b[31mNo existe el préstamo ${id}.\x1b[0m`);
    continue;
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log(`  ${m.company_name}`);
  console.log(
    `  loan ${m.loan_ref ?? "?"} · ${m.property_name ?? "(sin nombre)"} · ${m.property_type ?? "sin tipo"}`,
  );
  console.log(`  \x1b[90mid interno ${id} · ${m.accession}\x1b[0m\n`);

  /**
   * Las observations, no los facts.
   *
   * Un fact es el valor ya promovido: si dos columnas mapearon a la misma
   * métrica, quedó una sola. Acá queremos ver todas las candidatas con su
   * encabezado, porque el error puede ser justamente cuál ganó la promoción.
   */
  const { rows: obs } = await query<{
    metric_key: string; value: string; source_header: string; confidence: string | null;
  }>(
    `SELECT metric_key, value, source_header, confidence::text
       FROM corpus.observations
      WHERE loan_id = $1 AND metric_key = ANY($2)
      ORDER BY metric_key, confidence DESC NULLS LAST`,
    [id, RELEVANT],
  );

  if (obs.length === 0) {
    console.log(`    \x1b[90msin observations de las métricas relevantes\x1b[0m`);
    continue;
  }

  let last = "";
  for (const o of obs) {
    const dup = o.metric_key === last;
    last = o.metric_key;
    const key = dup ? "".padEnd(26) : o.metric_key.padEnd(26);
    const marker = dup ? "\x1b[33m  ↳ también\x1b[0m " : "";
    console.log(
      `    ${key} ${money(o.value).padStart(16)}   ${marker}\x1b[90m← "${o.source_header}"\x1b[0m`,
    );
  }

  // --- la aritmética, explícita -------------------------------------------

  const get = (k: string) => {
    const hit = obs.find((o) => o.metric_key === k);
    return hit ? Number(hit.value) : null;
  };
  const noi = get("noi_underwritten");
  const amt = get("loan_amount");
  const dy = get("debt_yield");
  const val = get("appraised_value");
  const ltvPub = get("ltv");

  console.log();
  if (noi !== null && amt !== null && dy !== null && amt !== 0) {
    const computed = noi / amt;
    console.log(
      `    debt yield calculado  ${(computed * 100).toFixed(1)}%   \x1b[90m(NOI ${money(String(noi))} / saldo ${money(String(amt))})\x1b[0m`,
    );
    console.log(`    debt yield publicado  ${(dy * 100).toFixed(1)}%`);
    if (dy !== 0) {
      const implied = noi / dy;
      console.log(
        `    \x1b[33msaldo implícito       ${money(String(implied))}\x1b[0m  ` +
          `\x1b[90m← el que haría cerrar la cuenta\x1b[0m`,
      );
      const factor = implied / amt;
      console.log(
        `    \x1b[90mfactor contra el saldo que guardamos: ${factor.toFixed(1)}x\x1b[0m`,
      );
    }
  }
  if (val !== null && ltvPub !== null && ltvPub !== 0) {
    const implied = val * ltvPub;
    console.log(
      `\n    saldo implícito por LTV  ${money(String(implied))}   ` +
        `\x1b[90m(tasación ${money(String(val))} × LTV ${(ltvPub * 100).toFixed(1)}%)\x1b[0m`,
    );
    if (amt !== null && amt !== 0) {
      console.log(`    \x1b[90mfactor contra el saldo que guardamos: ${(implied / amt).toFixed(1)}x\x1b[0m`);
    }
  }
}

/**
 * Los encabezados con "balance" que NO estamos mapeando.
 *
 * Si el saldo implícito no coincide con el que guardamos, lo más probable es que
 * el emisor publique varios saldos —del trust, del préstamo completo, original,
 * a la fecha de corte— y estemos leyendo uno distinto al que usa para sus
 * ratios. Esta lista dice cuáles hay disponibles.
 */
const { rows: balances } = await query<{ source_header: string; n: string }>(
  `SELECT source_header, count(*) AS n
     FROM corpus.observations
    WHERE source_header ILIKE '%balance%' OR source_header ILIKE '%loan amount%'
       OR source_header ILIKE '%cut-off%' OR source_header ILIKE '%cut off%'
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 12`,
);

if (balances.length > 0) {
  console.log(`\n${"─".repeat(78)}`);
  console.log(`Encabezados de saldo que aparecen en el corpus\n`);
  for (const b of balances) {
    console.log(`  ${String(b.n).padStart(6)}  ${b.source_header}`);
  }
}

const { rows: unmapped } = await query<{ header: string; filings: string }>(
  `SELECT header, count(DISTINCT accession) AS filings
     FROM corpus.filings f, jsonb_array_elements_text(f.columns_unmapped) AS header
    WHERE header ILIKE '%balance%' OR header ILIKE '%cut-off%' OR header ILIKE '%cut off%'
    GROUP BY 1 ORDER BY count(DISTINCT accession) DESC LIMIT 10`,
);

if (unmapped.length > 0) {
  console.log(`\n  \x1b[33mY los que NO mapeamos:\x1b[0m\n`);
  for (const u of unmapped) {
    console.log(`  ${String(u.filings).padStart(4)} filings  ${u.header}`);
  }
}

// ---------------------------------------------------------------------------
// Filings sin Loan ID
// ---------------------------------------------------------------------------

/**
 * Por qué ~30 emisiones no pegan contra el informe del servicer.
 *
 * El lote reportó "el corpus no tiene Loan ID (0 de 106 filas con loan_ref)" en
 * casi todas las añadas 2020-2021. Cero de todas, no algunas: la columna existe
 * en el documento pero se llama de una forma que nuestro patrón no reconoce.
 *
 * En vez de adivinar el nombre, lo pedimos: `columns_unmapped` guarda los
 * encabezados que el mapeo no supo interpretar, filing por filing. La columna de
 * identificador está ahí, con su nombre real.
 *
 * Es la misma decisión que ya pagó dos veces —guardar el header original de cada
 * observación, guardar los que no mapean— y la razón por la que un error de
 * mapeo se diagnostica con una consulta en vez de con una descarga.
 */
const { rows: noId } = await query<{ filings: string; loans: string }>(
  `SELECT count(DISTINCT f.accession) AS filings, count(l.id) AS loans
     FROM corpus.filings f
     JOIN corpus.loans l ON l.accession = f.accession
    WHERE f.accession NOT IN (
      SELECT DISTINCT accession FROM corpus.loans WHERE loan_ref ~ '^[0-9]'
    )`,
);

const ni = noId[0];
if (ni && Number(ni.filings) > 0) {
  console.log(`\n${"─".repeat(78)}`);
  console.log(`Filings sin Loan ID`);
  console.log(`${"─".repeat(78)}\n`);
  console.log(
    `  ${ni.filings} emisiones y ${ni.loans} préstamos no tienen identificador usable.`,
  );
  console.log(
    `  \x1b[90mNo pueden unirse contra el informe del servicer: el desempeño se pierde.\x1b[0m\n`,
  );

  const { rows: candidates } = await query<{ header: string; filings: string }>(
    `SELECT header, count(DISTINCT f.accession) AS filings
       FROM corpus.filings f, jsonb_array_elements_text(f.columns_unmapped) AS header
      WHERE f.accession NOT IN (
              SELECT DISTINCT accession FROM corpus.loans
               WHERE loan_ref ~ '^[0-9]'
            )
        AND (header ~* 'loan' OR header ~* '\\bid\\b' OR header ~* 'number'
             OR header ~* '\\bno\\.?\\b' OR header ~* 'control' OR header ~* 'seq')
      GROUP BY 1 ORDER BY count(DISTINCT f.accession) DESC, 1 LIMIT 15`,
  );

  if (candidates.length > 0) {
    console.log(`  Encabezados sin mapear que podrían ser el identificador:\n`);
    for (const c of candidates) {
      console.log(`  ${String(c.filings).padStart(4)} filings  ${c.header}`);
    }
    console.log(
      `\n  \x1b[90mEl que aparezca en todas es el candidato: agregarle un patrón a la\x1b[0m`,
    );
    console.log(`  \x1b[90mmétrica loan_id recupera esos ${ni.loans} préstamos de una.\x1b[0m`);
  } else {
    console.log(
      `  \x1b[33mNingún encabezado sin mapear parece un identificador.\x1b[0m`,
    );
    console.log(
      `  \x1b[90mPuede que esos Annex A directamente no publiquen uno, y haya que unir\x1b[0m`,
    );
    console.log(`  \x1b[90mpor otra clave —nombre de propiedad, saldo— o por orden de fila.\x1b[0m`);
  }
}

/**
 * De qué columna sacan su ratio las emisiones que fallan enteras.
 *
 * POR QUÉ ESTA SECCIÓN EXISTE APARTE
 *
 * El resto de este archivo ordena por magnitud del desvío, y ahí siempre ganan
 * los mega-préstamos: un Tysons Corner con factor 288x tapa a quince emisiones
 * de 2020 que fallan por mucho menos pero fallan *todas sus filas*.
 *
 * Son dos poblaciones distintas y se arreglan distinto. Un préstamo suelto que
 * falla es un saldo que no capturamos; una emisión donde no cierra ni una fila
 * es que la columna del ratio no significa lo que creemos.
 *
 * QUÉ BUSCAR EN LA SALIDA
 *
 * MSC 2021-L5 publica "Total Mortgage Debt UW NOI Debt Yield" —el denominador
 * incluye la deuda subordinada— y nosotros lo guardamos como si fuera el debt
 * yield sénior. Ese ratio no puede cerrar contra ningún saldo sénior: no está
 * mal el saldo, está mal a qué métrica mapeamos la columna.
 *
 * Si los encabezados de estas emisiones son los normales, la hipótesis cae y el
 * problema vuelve a ser de saldos.
 */
const SENIOR_X = "(amt.value::numeric + coalesce(npp.value::numeric, 0))";
const factJoin = (alias: string, key: string) =>
  `LEFT JOIN corpus.facts ${alias} ON ${alias}.loan_id = l.id ` +
  `AND ${alias}.metric_key = '${key}' AND ${alias}.value ~ '^-?[0-9.]+$'`;

const { rows: brokenHeaders } = await query<{
  company: string; metric_key: string; source_header: string; n: string;
}>(
  `WITH per_loan AS (
     SELECT l.accession,
            abs((noi.value::numeric / NULLIF(${SENIOR_X}, 0))
                / NULLIF(dy.value::numeric, 0) - 1) <= 0.01 AS ok
       FROM corpus.loans l
       ${factJoin("dy", "debt_yield")} ${factJoin("noi", "noi_underwritten")}
       ${factJoin("amt", "loan_amount")} ${factJoin("npp", "balance_pari_passu_non_trust")}
      WHERE dy.value IS NOT NULL AND noi.value IS NOT NULL AND amt.value IS NOT NULL
        AND amt.value::numeric <> 0 AND dy.value::numeric <> 0
   ),
   bad AS (
     SELECT accession FROM per_loan GROUP BY 1 HAVING count(*) FILTER (WHERE ok) = 0
   )
   SELECT f.company_name AS company, o.metric_key, o.source_header,
          count(*)::text AS n
     FROM corpus.observations o
     JOIN corpus.loans l ON l.id = o.loan_id
     JOIN corpus.filings f ON f.accession = l.accession
    WHERE l.accession IN (SELECT accession FROM bad)
      -- balance_pari_passu_non_trust va en esta lista porque es la otra mitad
      -- del denominador: SENIOR = loan_amount + pari passu no-trust. Sin él la
      -- sección explica una identidad mostrando solo tres de sus cuatro
      -- entradas, que fue exactamente el agujero cuando CF 2020-CF4 apareció
      -- rota: los tres encabezados visibles eran normales y el cambio estaba en
      -- el que no se mostraba.
      AND o.metric_key IN ('debt_yield', 'loan_amount', 'ltv', 'noi_underwritten',
                           'balance_pari_passu_non_trust')
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, count(*) DESC`,
);

if (brokenHeaders.length > 0) {
  console.log(`\n${"─".repeat(78)}`);
  console.log("Emisiones donde no cierra ninguna fila: de dónde sale cada número");
  console.log(`${"─".repeat(78)}\n`);

  let lastCompany = "";
  for (const r of brokenHeaders) {
    if (r.company !== lastCompany) {
      console.log(`\n  \x1b[1m${r.company}\x1b[0m`);
      lastCompany = r.company;
    }
    console.log(
      `    ${r.metric_key.padEnd(18)} ${String(r.n).padStart(4)}  \x1b[90m← "${r.source_header}"\x1b[0m`,
    );
  }

  const suspicious = brokenHeaders.filter((r) =>
    /total\s*(mortgage\s*)?debt|whole\s*loan|subordinate|combined/i.test(r.source_header),
  );
  console.log(
    `\n  \x1b[33m${suspicious.length} de ${brokenHeaders.length} encabezados nombran un saldo\x1b[0m`,
  );
  console.log(`  \x1b[33mdistinto del sénior (total debt, whole loan, subordinada).\x1b[0m`);
  console.log(
    `\n  \x1b[90mSi son muchos, el problema es a qué métrica mapeamos la columna, no\x1b[0m`,
  );
  console.log(`  \x1b[90mqué saldo usamos de denominador.\x1b[0m`);
}

/**
 * Qué columna sin mapear arreglaría más préstamos.
 *
 * LA VERSIÓN BARATA DEL RECONCILIADOR
 *
 * Cuando un debt yield no cierra, la aritmética ya nos dice cuánto tendría que
 * valer el saldo. Lo que falta es saber de qué columna sacarlo, y hasta ahora
 * eso lo hacía un humano leyendo la lista de encabezados sin mapear y adivinando
 * cuál podría ser.
 *
 * La versión completa compararía el saldo implícito contra el valor de cada
 * celda sin mapear de esa misma fila y contestaría sola. Requiere guardar las
 * celdas que hoy descartamos.
 *
 * Esta versión no requiere nada nuevo: `columns_unmapped` ya guarda los
 * encabezados por emisión, así que se puede cruzar contra los préstamos que
 * fallan y ordenar por cuántos arreglaría cada uno. No prueba que la columna sea
 * la correcta —eso lo prueba recosechar y volver a correr las identidades— pero
 * convierte "leé 87 encabezados y adiviná" en una lista de tres candidatos
 * ordenada por rendimiento.
 */
const { rows: candidates2 } = await query<{
  header: string; loans: string; filings: string; ejemplos: string;
}>(
  `WITH per_loan AS (
     SELECT l.accession, l.id,
            abs((noi.value::numeric / NULLIF(${SENIOR_X}, 0))
                / NULLIF(dy.value::numeric, 0) - 1) <= 0.01 AS ok
       FROM corpus.loans l
       ${factJoin("dy", "debt_yield")} ${factJoin("noi", "noi_underwritten")}
       ${factJoin("amt", "loan_amount")} ${factJoin("npp", "balance_pari_passu_non_trust")}
      WHERE dy.value IS NOT NULL AND noi.value IS NOT NULL AND amt.value IS NOT NULL
        AND amt.value::numeric <> 0 AND dy.value::numeric <> 0
   ),
   fallan AS (
     SELECT accession, count(*) AS n FROM per_loan WHERE ok IS NOT TRUE GROUP BY 1
   )
   SELECT header,
          sum(fa.n)::text AS loans,
          count(*)::text  AS filings,
          string_agg(DISTINCT left(f.company_name, 22), ' · ' ORDER BY left(f.company_name, 22)) AS ejemplos
     FROM fallan fa
     JOIN corpus.filings f ON f.accession = fa.accession,
          jsonb_array_elements_text(f.columns_unmapped) AS header
    WHERE (header ILIKE '%balance%' OR header ILIKE '%pari passu%'
           OR header ILIKE '%senior note%' OR header ILIKE '%companion%')
      -- Un filtro por nombre deja entrar banderas y flujos: "Pari Passu (Y/N)"
      -- encabezó el ranking con 166 préstamos y no arregla ningún saldo, porque
      -- es un booleano. Buscamos montos.
      AND header NOT ILIKE '%(y/n)%' AND header NOT ILIKE '%control%'
      AND header NOT ILIKE '%debt service%' AND header NOT ILIKE '%per unit%'
      AND header NOT ILIKE '%per sf%' AND header NOT ILIKE '%\%%'
    GROUP BY 1
    ORDER BY sum(fa.n) DESC
    LIMIT 8`,
);

if (candidates2.length > 0) {
  console.log(`\n${"─".repeat(78)}`);
  console.log("Columnas sin mapear, ordenadas por préstamos que arreglarían");
  console.log(`${"─".repeat(78)}\n`);
  for (const c of candidates2) {
    console.log(`  ${String(c.loans).padStart(4)} préstamos · ${String(c.filings).padStart(2)} emisiones  \x1b[1m${c.header}\x1b[0m`);
    console.log(`       \x1b[90m${c.ejemplos.slice(0, 66)}\x1b[0m`);
  }
  console.log(
    `\n  \x1b[90mEl número es cuántos préstamos que hoy fallan están en emisiones donde\x1b[0m`,
  );
  console.log(
    `  \x1b[90mesa columna existe. Es una cota superior, no una promesa: la prueba es\x1b[0m`,
  );
  console.log(`  \x1b[90mmapearla, recosechar y ver si las identidades suben.\x1b[0m`);
}

console.log(`\n${"─".repeat(78)}`);
console.log(
  `\n  \x1b[90mSi el saldo implícito coincide con una columna que no estamos mapeando,\x1b[0m`,
);
console.log(`  \x1b[90mel arreglo es cambiar a qué columna apunta loan_amount.\x1b[0m\n`);

await closePool();

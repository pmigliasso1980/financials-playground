/**
 * Opens one loan and shows which column each number came from.
 *
 *   npm run db:explain                 the worst identity failures
 *   npm run db:explain -- 1234         one specific loan by internal id
 *
 * WHAT IT IS FOR
 *
 * When an identity does not close there are two possibilities and the aggregate
 * cannot tell them apart: either we mapped the wrong column, or the issuer
 * computes on a different base from the one we assume. Both are resolved the same
 * way —by looking at each value's original header— which is why observations have
 * stored `source_header` from the beginning.
 *
 * This script is the concrete use of that decision: it reconstructs the Annex A
 * row as it was, with the column name the issuer gave it beside the value we
 * stored.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const arg = process.argv[2];

/** Metrics involved in the identities that do not close. */
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
 * Picks the loans where the debt yield identity fails hardest.
 * That one is used because it involves all three suspect metrics at once.
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
  console.error("\n✗ No loans to inspect.\n");
  await closePool();
  process.exit(1);
}

console.log(`\n${"═".repeat(78)}`);
console.log(arg ? `Loan ${arg}` : "Worst deviations from the debt yield identity");
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
    console.log(`\n  \x1b[31mLoan ${id} does not exist.\x1b[0m`);
    continue;
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log(`  ${m.company_name}`);
  console.log(
    `  loan ${m.loan_ref ?? "?"} · ${m.property_name ?? "(no name)"} · ${m.property_type ?? "no type"}`,
  );
  console.log(`  \x1b[90minternal id ${id} · ${m.accession}\x1b[0m\n`);

  /**
   * The observations, not the facts.
   *
   * A fact is the already-promoted value: if two columns mapped to the same
   * metric, only one survived. Here we want to see every candidate with its
   * header, because the error may be precisely which one won the promotion.
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
    console.log(`    \x1b[90mno observations for the relevant metrics\x1b[0m`);
    continue;
  }

  let last = "";
  for (const o of obs) {
    const dup = o.metric_key === last;
    last = o.metric_key;
    const key = dup ? "".padEnd(26) : o.metric_key.padEnd(26);
    const marker = dup ? "\x1b[33m  ↳ also\x1b[0m " : "";
    console.log(
      `    ${key} ${money(o.value).padStart(16)}   ${marker}\x1b[90m← "${o.source_header}"\x1b[0m`,
    );
  }

  // --- the arithmetic, spelled out ----------------------------------------

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
      `    debt yield computed   ${(computed * 100).toFixed(1)}%   \x1b[90m(NOI ${money(String(noi))} / balance ${money(String(amt))})\x1b[0m`,
    );
    console.log(`    debt yield published  ${(dy * 100).toFixed(1)}%`);
    if (dy !== 0) {
      const implied = noi / dy;
      console.log(
        `    \x1b[33mimplied balance       ${money(String(implied))}\x1b[0m  ` +
          `\x1b[90m← the one that would make it close\x1b[0m`,
      );
      const factor = implied / amt;
      console.log(
        `    \x1b[90mfactor against the balance we stored: ${factor.toFixed(1)}x\x1b[0m`,
      );
    }
  }
  if (val !== null && ltvPub !== null && ltvPub !== 0) {
    const implied = val * ltvPub;
    console.log(
      `\n    balance implied by LTV   ${money(String(implied))}   ` +
        `\x1b[90m(appraised ${money(String(val))} × LTV ${(ltvPub * 100).toFixed(1)}%)\x1b[0m`,
    );
    if (amt !== null && amt !== 0) {
      console.log(`    \x1b[90mfactor against the balance we stored: ${(implied / amt).toFixed(1)}x\x1b[0m`);
    }
  }
}

/**
 * The headers containing "balance" that we are NOT mapping.
 *
 * If the implied balance does not match the one we stored, the most likely
 * explanation is that the issuer publishes several balances —trust, whole loan,
 * original, as of the cut-off date— and we are reading a different one from the
 * one used for its ratios. This list says which are available.
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
  console.log(`Balance headers that appear in the corpus\n`);
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
  console.log(`\n  \x1b[33mAnd the ones we do NOT map:\x1b[0m\n`);
  for (const u of unmapped) {
    console.log(`  ${String(u.filings).padStart(4)} filings  ${u.header}`);
  }
}

// ---------------------------------------------------------------------------
// Filings with no Loan ID
// ---------------------------------------------------------------------------

/**
 * Why ~30 issuances do not join against the servicer report.
 *
 * The batch reported "the corpus has no Loan ID (0 of 106 rows with loan_ref)"
 * for almost every 2020-2021 vintage. Zero of all of them, not some: the column
 * exists in the document but is named in a way our pattern does not recognise.
 *
 * Rather than guessing the name, we ask for it: `columns_unmapped` stores the
 * headers the mapping could not interpret, filing by filing. The identifier
 * column is there, under its real name.
 *
 * It is the same decision that has already paid off twice —storing each
 * observation's original header, storing the ones that do not map— and the reason
 * a mapping error is diagnosed with a query instead of a download.
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
  console.log(`Filings with no Loan ID`);
  console.log(`${"─".repeat(78)}\n`);
  console.log(
    `  ${ni.filings} issuances and ${ni.loans} loans have no usable identifier.`,
  );
  console.log(
    `  \x1b[90mThey cannot be joined against the servicer report: the performance is lost.\x1b[0m\n`,
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
    console.log(`  Unmapped headers that could be the identifier:\n`);
    for (const c of candidates) {
      console.log(`  ${String(c.filings).padStart(4)} filings  ${c.header}`);
    }
    console.log(
      `\n  \x1b[90mThe one appearing in all of them is the candidate: adding a pattern to\x1b[0m`,
    );
    console.log(`  \x1b[90mthe loan_id metric recovers those ${ni.loans} loans at once.\x1b[0m`);
  } else {
    console.log(
      `  \x1b[33mNo unmapped header looks like an identifier.\x1b[0m`,
    );
    console.log(
      `  \x1b[90mThose Annex A documents may simply not publish one, and the join would\x1b[0m`,
    );
    console.log(`  \x1b[90mhave to use another key —property name, balance— or row order.\x1b[0m`);
  }
}

/**
 * Which column the issuances that fail entirely take their ratio from.
 *
 * WHY THIS SECTION EXISTS SEPARATELY
 *
 * The rest of this file sorts by the size of the deviation, and there the
 * mega-loans always win: a Tysons Corner with a 288x factor buries fifteen 2020
 * issuances that fail by far less but fail *every one of their rows*.
 *
 * They are two different populations and they are fixed differently. A single
 * loan that fails is a balance we did not capture; an issuance where not one row
 * closes means the ratio column does not mean what we think.
 *
 * WHAT TO LOOK FOR IN THE OUTPUT
 *
 * MSC 2021-L5 publishes "Total Mortgage Debt UW NOI Debt Yield" —the denominator
 * includes the subordinate debt— and we stored it as if it were the senior debt
 * yield. That ratio cannot close against any senior balance: the balance is not
 * wrong, what is wrong is which metric we mapped the column to.
 *
 * If the headers of these issuances are the normal ones, the hypothesis falls and
 * the problem is about balances again.
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
      -- balance_pari_passu_non_trust is in this list because it is the other
      -- half of the denominator: SENIOR = loan_amount + non-trust pari passu.
      -- Without it the section explains an identity while showing only three of
      -- its four inputs, which was exactly the gap when CF 2020-CF4 turned up
      -- broken: the three visible headers were normal and the change was in the
      -- one not being shown.
      AND o.metric_key IN ('debt_yield', 'loan_amount', 'ltv', 'noi_underwritten',
                           'balance_pari_passu_non_trust')
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, count(*) DESC`,
);

if (brokenHeaders.length > 0) {
  console.log(`\n${"─".repeat(78)}`);
  console.log("Issuances where not one row closes: where each number comes from");
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
    `\n  \x1b[33m${suspicious.length} of ${brokenHeaders.length} headers name a balance\x1b[0m`,
  );
  console.log(`  \x1b[33mother than the senior one (total debt, whole loan, subordinate).\x1b[0m`);
  console.log(
    `\n  \x1b[90mIf there are many, the problem is which metric we mapped the column to,\x1b[0m`,
  );
  console.log(`  \x1b[90mnot which balance we use as denominator.\x1b[0m`);
}

/**
 * Which unmapped column would fix the most loans.
 *
 * THE CHEAP VERSION OF THE RECONCILER
 *
 * When a debt yield does not close, the arithmetic already tells us what the
 * balance would have to be. What is missing is knowing which column to take it
 * from, and until now that was a human reading the list of unmapped headers and
 * guessing which one it might be.
 *
 * The full version would compare the implied balance against the value of every
 * unmapped cell in that same row and answer on its own. It requires storing the
 * cells we discard today.
 *
 * This version requires nothing new: `columns_unmapped` already stores the
 * headers per issuance, so it can be crossed against the failing loans and sorted
 * by how many each would fix. It does not prove the column is the right one
 * —that is proved by re-harvesting and re-running the identities— but it turns
 * "read 87 headers and guess" into a list of three candidates ordered by yield.
 */
const { rows: candidates2 } = await query<{
  header: string; loans: string; filings: string; examples: string;
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
   failing AS (
     SELECT accession, count(*) AS n FROM per_loan WHERE ok IS NOT TRUE GROUP BY 1
   )
   SELECT header,
          sum(fa.n)::text AS loans,
          count(*)::text  AS filings,
          string_agg(DISTINCT left(f.company_name, 22), ' · ' ORDER BY left(f.company_name, 22)) AS examples
     FROM failing fa
     JOIN corpus.filings f ON f.accession = fa.accession,
          jsonb_array_elements_text(f.columns_unmapped) AS header
    WHERE (header ILIKE '%balance%' OR header ILIKE '%pari passu%'
           OR header ILIKE '%senior note%' OR header ILIKE '%companion%')
      -- A name filter lets flags and flows in: "Pari Passu (Y/N)" topped the
      -- ranking with 166 loans and fixes no balance at all, because it is a
      -- boolean. We are looking for amounts.
      AND header NOT ILIKE '%(y/n)%' AND header NOT ILIKE '%control%'
      AND header NOT ILIKE '%debt service%' AND header NOT ILIKE '%per unit%'
      AND header NOT ILIKE '%per sf%' AND header NOT ILIKE '%\%%'
    GROUP BY 1
    ORDER BY sum(fa.n) DESC
    LIMIT 8`,
);

if (candidates2.length > 0) {
  console.log(`\n${"─".repeat(78)}`);
  console.log("Unmapped columns, ordered by the loans they would fix");
  console.log(`${"─".repeat(78)}\n`);
  for (const c of candidates2) {
    console.log(`  ${String(c.loans).padStart(4)} loans · ${String(c.filings).padStart(2)} issuances  \x1b[1m${c.header}\x1b[0m`);
    console.log(`       \x1b[90m${c.examples.slice(0, 66)}\x1b[0m`);
  }
  console.log(
    `\n  \x1b[90mThe number is how many currently failing loans are in issuances where\x1b[0m`,
  );
  console.log(
    `  \x1b[90mthat column exists. It is an upper bound, not a promise: the proof is\x1b[0m`,
  );
  console.log(`  \x1b[90mmapping it, re-harvesting and seeing whether the identities rise.\x1b[0m`);
}

console.log(`\n${"─".repeat(78)}`);
console.log(
  `\n  \x1b[90mIf the implied balance matches a column we are not mapping,\x1b[0m`,
);
console.log(`  \x1b[90mthe fix is to change which column loan_amount points at.\x1b[0m\n`);

await closePool();

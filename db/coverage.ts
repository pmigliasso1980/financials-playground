/**
 * How much of the servicer report reaches the corpus?
 *
 *   npm run db:coverage
 *
 * THE QUESTION
 *
 * `db:predictors` and `db:delinquency` count events over each issuance's full
 * pool. The denominator is the Annex A pool; the numerator is only the loans
 * that joined by Pros ID against the servicer report.
 *
 * If the join loses rows, the rate falls without anything having improved. An
 * issuance with a 20% join contributes its whole pool below and a fifth of its
 * events above, and leaves the analysis looking healthy.
 *
 * That already happened to us in the most expensive way possible: the SIR by
 * shelf correlated 0.74 with join coverage. It was measuring the pipeline, not
 * the underwriting.
 *
 * WHAT IS COMPARED
 *
 * Delinquency rows the parser found in the 10-D (stored in
 * `servicer_reports.stats`) against rows that were actually persisted. The
 * difference is real delinquent loans the corpus could not place.
 *
 * WHY THIS NUMBER AND NOT NOI COVERAGE
 *
 * NOI coverage mixes two causes: the join, and the rows the servicer publishes
 * with no period. BANK loses 99% of its NOI to the second, which has nothing to
 * do with the join. Delinquency does not depend on dates, so its loss isolates
 * the join.
 *
 * THE THRESHOLD IS FIXED BEFORE LOOKING AT THE NUMBERS
 *
 * Global loss under 5% and spread out: the join works and the differences
 * between shelves are real. Loss concentrated in one shelf: those issuances have
 * to be excluded from the analysis and said so, not patched.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const ACCEPTABLE_LOSS = 0.05;
const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

console.log(`\n${"═".repeat(78)}`);
console.log("Join coverage against the servicer report");
console.log(`${"═".repeat(78)}`);

// ---------------------------------------------------------------------------
// 1. Global
// ---------------------------------------------------------------------------

/**
 * Three numbers, not two. The first version of this script compared parsed rows
 * against table rows and called the difference "lost": 349 against 282, 19%. But
 * 341 of those 349 HAD joined —the join runs at 97.7%— and the remaining 59 are
 * pari passu tranches collapsing onto the same loan, which is what we want to
 * happen.
 *
 * So the diagnostic built to detect a pipeline artefact was itself a pipeline
 * artefact. Separating the two losses is the whole point of this script.
 */
const { rows: glob } = await query<{
  parsed: string; joined: string; rows: string;
}>(
  `SELECT coalesce(sum((stats->>'delinquencyRows')::int), 0)::text   AS parsed,
          coalesce(sum((stats->>'delinquencyMatched')::int), 0)::text AS joined,
          (SELECT count(*) FROM corpus.delinquency)::text             AS rows
     FROM corpus.servicer_reports`,
);

const parsed = Number(glob[0]?.parsed ?? 0);
const joined = Number(glob[0]?.joined ?? 0);
const rows = Number(glob[0]?.rows ?? 0);
const loss = parsed > 0 ? (parsed - joined) / parsed : 0;

console.log(`\n${"─".repeat(78)}`);
console.log("Delinquency rows: parsed → joined → distinct rows");
console.log(`${"─".repeat(78)}\n`);

if (joined === 0 && parsed > 0) {
  console.log(
    `  \x1b[33mNo 'delinquencyMatched' in stats. Re-harvest:  npm run db:performance\x1b[0m\n`,
  );
} else {
  console.log(`  ${String(parsed).padStart(5)}  rows in the 10-D filings`);
  console.log(
    `  ${String(joined).padStart(5)}  found their loan          ` +
      `${loss <= ACCEPTABLE_LOSS ? "\x1b[32m" : "\x1b[31m"}${parsed - joined} did not join ` +
      `(${pct(loss, 1)})\x1b[0m   \x1b[90mthreshold ${pct(ACCEPTABLE_LOSS)}\x1b[0m`,
  );
  console.log(
    `  ${String(rows).padStart(5)}  rows in the table         ` +
      `\x1b[90m${joined - rows} collapsed — pari passu tranches of the same loan\x1b[0m`,
  );
  console.log(
    `\n  \x1b[90mOnly the first difference is lost coverage. The second is deduplication\x1b[0m`,
  );
  console.log(
    `  \x1b[90mworking: payment status belongs to the loan, not to the tranche.\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 2. Por shelf
// ---------------------------------------------------------------------------

/**
 * The shelf comes from the name because no column stores it.
 *
 * It is fragile —"BANK5" has to be tested before "BANK", otherwise every BANK5
 * falls into BANK— so the order of the CASE branches matters and is deliberate.
 */
const SHELF = `
  CASE
    WHEN sr.company_name ILIKE 'BANK5%'     THEN 'BANK5'
    WHEN sr.company_name ILIKE 'BANK %'     THEN 'BANK'
    WHEN sr.company_name ILIKE 'BENCHMARK%' THEN 'Benchmark'
    WHEN sr.company_name ILIKE 'BBCMS%'     THEN 'BBCMS'
    WHEN sr.company_name ILIKE 'BMO%'       THEN 'BMO'
    WHEN sr.company_name ILIKE 'WELLS%'     THEN 'Wells'
    WHEN sr.company_name ILIKE 'MORGAN%' OR sr.company_name ILIKE 'MSWF%' THEN 'MS'
    WHEN sr.company_name ILIKE 'GS %'       THEN 'GS'
    ELSE 'other'
  END`;

const { rows: byShelf } = await query<{
  shelf: string; issuances: string; parsed: string; joined: string;
  rows: string; pool: string;
}>(
  `WITH per_report AS (
     SELECT sr.accession,
            ${SHELF} AS shelf,
            coalesce((sr.stats->>'delinquencyRows')::int, 0)    AS parsed,
            coalesce((sr.stats->>'delinquencyMatched')::int, 0) AS joined,
            coalesce((sr.stats->>'poolLoans')::int, 0)          AS pool,
            (SELECT count(*) FROM corpus.delinquency d
              WHERE d.report_accession = sr.accession)          AS rows
       FROM corpus.servicer_reports sr
   )
   SELECT shelf, count(*)::text AS issuances,
          sum(parsed)::text AS parsed,
          sum(joined)::text   AS joined,
          sum(rows)::text     AS rows,
          sum(pool)::text      AS pool
     FROM per_report
    GROUP BY shelf
    ORDER BY sum(parsed) - sum(joined) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("By shelf");
console.log(`${"─".repeat(78)}\n`);
console.log(`  shelf       iss.     pool      parsed   unjoined    rows   obs. rate`);
console.log(`  ${"─".repeat(72)}`);

for (const r of byShelf) {
  const p = Number(r.parsed);
  const g = Number(r.joined);
  const f = Number(r.rows);
  const pool = Number(r.pool);
  const lost = p - g;
  const color = p > 0 && lost / p > ACCEPTABLE_LOSS ? "\x1b[31m" : "\x1b[90m";
  console.log(
    `  ${r.shelf.padEnd(11)} ${String(r.issuances).padStart(4)} ${String(pool).padStart(7)} ` +
      `${String(p).padStart(11)}   ${color}${String(lost).padStart(5)}` +
      ` ${p > 0 ? `(${pct(lost / p)})`.padStart(6) : "     —"}\x1b[0m` +
      ` ${String(f).padStart(7)}` +
      `   ${pool > 0 ? pct(f / pool, 1).padStart(7) : "      —"}`,
  );
}

console.log(
  `\n  \x1b[90mThe last column is the rate the analysis READS: joined events over the full\x1b[0m`,
);
console.log(
  `  \x1b[90mpool. If a shelf loses rows, its rate falls without anything improving.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 3. The issuances that lose the most
// ---------------------------------------------------------------------------

/**
 * Only those losing rows in the JOIN. Those collapsing tranches are not a problem
 * and listing them here is what made me misread it the first time.
 */
const { rows: worst } = await query<{
  issuance: string; parsed: string; joined: string; pool: string;
}>(
  `SELECT left(sr.company_name, 36) AS issuance,
          coalesce((sr.stats->>'delinquencyRows')::int, 0)::text    AS parsed,
          coalesce((sr.stats->>'delinquencyMatched')::int, 0)::text AS joined,
          coalesce((sr.stats->>'poolLoans')::int, 0)::text          AS pool
     FROM corpus.servicer_reports sr
    WHERE coalesce((sr.stats->>'delinquencyRows')::int, 0)
          > coalesce((sr.stats->>'delinquencyMatched')::int, 0)
    ORDER BY coalesce((sr.stats->>'delinquencyRows')::int, 0)
             - coalesce((sr.stats->>'delinquencyMatched')::int, 0) DESC
    LIMIT 12`,
);

if (worst.length === 0) {
  console.log(
    `\n  \x1b[32mNo issuance loses delinquency rows in the join.\x1b[0m\n`,
  );
} else {
  console.log(`\n${"─".repeat(78)}`);
  console.log(`Issuances losing rows in the join (${worst.length} worst)`);
  console.log(`${"─".repeat(78)}\n`);
  console.log(`  issuance                                  parsed    joined   pool`);
  console.log(`  ${"─".repeat(72)}`);
  for (const r of worst) {
    console.log(
      `  ${r.issuance.padEnd(38)} ${String(r.parsed).padStart(9)} ${String(r.joined).padStart(9)} ` +
        `${String(r.pool).padStart(6)}`,
    );
  }
  console.log(
    `\n  \x1b[90mEvery row here is a real delinquent loan the corpus could not place.\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 4. Do the shelves list the same population?
// ---------------------------------------------------------------------------

/**
 * The join works —2.3% loss— and BMO still flags 11.1% of its pool against BANK's
 * 1.3%, with BMO being YOUNGER. Right-censoring predicts the opposite: older
 * vintages had more time to break.
 *
 * There is an explanation that is not about credit. The delinquency table is
 * assembled by the servicer and not all of them list the same population: one may
 * include every loan on watchlist even if it is paying on time —Benchmark
 * 2020-B16 has one like that— and another only those 60+ days late. If that is
 * it, the rate measures reporting policy.
 *
 * The signature that separates them: if a shelf lists watchlist loans, its rows
 * cluster at 0 months delinquent. If it lists genuine delinquencies, they shift
 * to 2+.
 *
 * This does NOT prove which one is correct. It proves whether they are comparable
 * with each other, which is the prior question and the one the by-shelf analysis
 * takes as already answered.
 */
const { rows: population } = await query<{
  shelf: string; n: string; zero: string; two_plus: string;
  transferred: string; foreclosure: string; median: string | null;
}>(
  `SELECT ${SHELF} AS shelf,
          count(*)::text AS n,
          count(*) FILTER (WHERE d.months_delinquent = 0)::text  AS zero,
          count(*) FILTER (WHERE d.months_delinquent >= 2)::text AS two_plus,
          count(*) FILTER (WHERE d.transfer_date IS NOT NULL)::text AS transferred,
          count(*) FILTER (WHERE d.foreclosure_date IS NOT NULL
                              OR d.reo_date IS NOT NULL)::text AS foreclosure,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY d.months_delinquent)::text AS median
     FROM corpus.delinquency d
     JOIN corpus.servicer_reports sr ON sr.accession = d.report_accession
    GROUP BY 1
   HAVING count(*) >= 5
    ORDER BY count(*) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("Do the shelves list the same population?");
console.log(`${"─".repeat(78)}\n`);
console.log(`  shelf          rows   0 months   2+ months   median   transf.   foreclo.`);
console.log(`  ${"─".repeat(72)}`);

for (const r of population) {
  const n = Number(r.n);
  console.log(
    `  ${r.shelf.padEnd(11)} ${String(n).padStart(7)} ` +
      `${pct(Number(r.zero) / n).padStart(9)} ${pct(Number(r.two_plus) / n).padStart(10)} ` +
      `${(r.median === null ? "—" : Number(r.median).toFixed(1)).padStart(9)} ` +
      `${pct(Number(r.transferred) / n).padStart(9)} ${pct(Number(r.foreclosure) / n).padStart(7)}`,
  );
}

console.log(
  `\n  \x1b[90mA shelf with nearly all its rows at 0 months is listing a watchlist,\x1b[0m`,
);
console.log(
  `  \x1b[90mnot delinquencies. Comparing its rate against another shelf's measures reporting.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 5. Why does a shelf have no delinquencies?
// ---------------------------------------------------------------------------

/**
 * Zero delinquency rows in an issuance has three causes, and until today all
 * three looked identical from the database:
 *
 *   no block        → the locator did not find it: that is format, and it needs fixing
 *   empty block     → the 10-D says "No delinquent loans this period"
 *   all discarded   → rows the filters ate (legends, footnotes)
 *
 * The distinction is not cosmetic. BANK flags 1.3% of its pool against BMO's
 * 11.1%, and that difference means opposite things depending on where the zero
 * comes from: if it is format, the shelf cannot be compared; if it is the
 * document declaring there are no delinquencies, the difference is real.
 *
 * I checked the BANK 2021-BNK36 document by hand and it says "No delinquent loans
 * this period". This table is that same question asked across all 148 issuances
 * instead of the one I happened to have open.
 */
const { rows: causes } = await query<{
  shelf: string; issuances: string; no_block: string;
  empty_block: string; all_discarded: string; with_rows: string;
}>(
  `WITH per_report AS (
     SELECT ${SHELF} AS shelf,
            coalesce((sr.stats->>'delinquencyTables')::int, -1)   AS tables,
            coalesce((sr.stats->>'delinquencyDataRows')::int, 0)  AS rows,
            coalesce((sr.stats->>'delinquencyRows')::int, 0)      AS useful
       FROM corpus.servicer_reports sr
   )
   SELECT shelf, count(*)::text AS issuances,
          count(*) FILTER (WHERE tables = 0)::text                        AS no_block,
          count(*) FILTER (WHERE tables > 0 AND rows = 0)::text          AS empty_block,
          count(*) FILTER (WHERE rows > 0 AND useful = 0)::text          AS all_discarded,
          count(*) FILTER (WHERE useful > 0)::text                        AS with_rows
     FROM per_report
    GROUP BY shelf
    ORDER BY count(*) FILTER (WHERE tables = 0) DESC, shelf`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("Where the zero comes from: format, document, or filter");
console.log(`${"─".repeat(78)}\n`);
console.log(`  shelf        iss.    no block   empty block   all discarded   with rows`);
console.log(`  ${"─".repeat(72)}`);

let statsMissing = true;
for (const r of causes) {
  const sb = Number(r.no_block);
  if (sb >= 0) statsMissing = false;
  console.log(
    `  ${r.shelf.padEnd(11)} ${String(r.issuances).padStart(4)} ` +
      `${(sb > 0 ? `\x1b[31m${sb}\x1b[0m` : String(sb)).padStart(sb > 0 ? 21 : 12)} ` +
      `${String(r.empty_block).padStart(13)} ${String(r.all_discarded).padStart(15)} ` +
      `${String(r.with_rows).padStart(11)}`,
  );
}

if (statsMissing) {
  console.log(
    `\n  \x1b[33mThe counters are missing from stats. Re-harvest:  npm run db:performance\x1b[0m`,
  );
} else {
  console.log(
    `\n  \x1b[90m"no block" is the only one that needs fixing: the locator failed and the\x1b[0m`,
  );
  console.log(
    `  \x1b[90missuance enters the denominator with zero events guaranteed. "empty block"\x1b[0m`,
  );
  console.log(
    `  \x1b[90mis the 10-D saying "No delinquent loans this period" — a true zero.\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 6. What was discarded, raw
// ---------------------------------------------------------------------------

/**
 * The issuances where the filter ate ALL the rows.
 *
 * I checked one by hand —BANK 2021-BNK36, which said "No delinquent loans this
 * period"— and from that took eleven others as good without opening them. This
 * table is that verification done across all of them at once.
 *
 * If the raw value is prose, the filter is working and the zero is the issuer's.
 * If it is a number, delinquencies are being deleted and the shelf's rate is
 * wrong.
 */
const { rows: raw } = await query<{
  issuance: string; discarded: string; sample: string | null;
}>(
  `SELECT left(sr.company_name, 30) AS issuance,
          coalesce((sr.stats->>'delinquencyDropped')::int, 0)::text AS discarded,
          (sr.stats->'delinquencyDroppedSamples')->>0 AS sample
     FROM corpus.servicer_reports sr
    WHERE coalesce((sr.stats->>'delinquencyDataRows')::int, 0) > 0
      AND coalesce((sr.stats->>'delinquencyRows')::int, 0) = 0
    ORDER BY sr.company_name
    LIMIT 20`,
);

if (raw.length > 0) {
  console.log(`\n${"─".repeat(78)}`);
  console.log("Issuances that discarded everything: what the first row said");
  console.log(`${"─".repeat(78)}\n`);
  for (const r of raw) {
    const m = r.sample ?? "(no sample — re-harvest)";
    // A numeric identifier here is a deleted delinquency; prose is the filter
    // working. The difference is self-evident, which is why the value is printed.
    const isNumber = /^\d+[a-z]?$/i.test(m.trim());
    console.log(
      `  ${r.issuance.padEnd(32)} ${String(r.discarded).padStart(3)}  ` +
        `${isNumber ? "\x1b[31m" : "\x1b[90m"}"${m}"\x1b[0m`,
    );
  }
  console.log(
    `\n  \x1b[90mProse = the filter is working, the zero is the issuer's.\x1b[0m`,
  );
  console.log(
    `  \x1b[31mA number = a deleted delinquency and the shelf's rate is wrong.\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 7. Issuer × servicer: can the question even be asked?
// ---------------------------------------------------------------------------

/**
 * THIS RUNS BEFORE LOOKING AT ANY RESULT. IT IS NOT AN ANALYSIS.
 *
 * The SIR says BANK transfers to special servicing 4 times less often than BBCMS,
 * adjusted for vintage and leverage. It survived five attacks. The hypothesis
 * that remains is that it is not the issuer but the master servicer, which
 * assembles both the NOI table and the delinquency table.
 *
 * But if each issuer uses a different servicer and no servicer appears under two
 * issuers, the two variables are the SAME column under two names. No datum in
 * this corpus separates them, and running the analysis anyway would produce a
 * number that looks like an answer.
 *
 * The identifiability condition is off-diagonal cells: at least one servicer with
 * two issuers, or at least one issuer with two servicers. Without that, the
 * correct answer is "it cannot be known".
 */
const { rows: crossTab } = await query<{
  shelf: string; master: string; n: string;
}>(
  `SELECT ${SHELF} AS shelf,
          coalesce(sr.master_servicer, '(no data)') AS master,
          count(*)::text AS n
     FROM corpus.servicer_reports sr
    GROUP BY 1, 2
    ORDER BY 1, count(*) DESC`,
);

console.log(`\n${"═".repeat(78)}`);
console.log("Issuer × master servicer  —  is the question identifiable?");
console.log(`${"═".repeat(78)}\n`);

const byShelfMap = new Map<string, Array<[string, number]>>();
const byMaster = new Map<string, Set<string>>();
for (const r of crossTab) {
  const list = byShelfMap.get(r.shelf) ?? [];
  list.push([r.master, Number(r.n)]);
  byShelfMap.set(r.shelf, list);
  const s = byMaster.get(r.master) ?? new Set<string>();
  s.add(r.shelf);
  byMaster.set(r.master, s);
}

for (const [shelf, list] of [...byShelfMap].sort()) {
  const total = list.reduce((a, [, n]) => a + n, 0);
  console.log(`  \x1b[1m${shelf}\x1b[0m \x1b[90m(${total} issuances)\x1b[0m`);
  for (const [master, n] of list) {
    console.log(`      ${String(n).padStart(3)}  ${master.slice(0, 60)}`);
  }
}

const shared = [...byMaster.entries()].filter(
  ([m, s]) => s.size > 1 && m !== "(no data)",
);
const mixedShelves = [...byShelfMap.entries()].filter(
  ([, l]) => l.filter(([m]) => m !== "(no data)").length > 1,
);

console.log(`\n${"─".repeat(78)}\n`);
console.log(
  `  Servicers under more than one issuer: ${shared.length}` +
    (shared.length > 0
      ? `\n${shared.map(([m, s]) => `      ${m.slice(0, 50)} → ${[...s].join(", ")}`).join("\n")}`
      : ""),
);
console.log(
  `  Issuers with more than one servicer:  ${mixedShelves.length}` +
    (mixedShelves.length > 0
      ? `\n${mixedShelves.map(([s]) => `      ${s}`).join("\n")}`
      : ""),
);

if (shared.length === 0 && mixedShelves.length === 0) {
  console.log(
    `\n  \x1b[31mNOT IDENTIFIABLE.\x1b[0m Issuer and servicer are the same column`,
  );
  console.log(
    `  \x1b[90munder two names. No datum in this corpus can separate them, and running\x1b[0m`,
  );
  console.log(
    `  \x1b[90mthe analysis anyway would give a number that looks like an answer.\x1b[0m\n`,
  );
} else {
  console.log(
    `\n  \x1b[32mThere are off-diagonal cells.\x1b[0m The question can be asked,`,
  );
  console.log(
    `  \x1b[90mbut only with whatever power those cells give: if the overlap is two\x1b[0m`,
  );
  console.log(
    `  \x1b[90missuances, the contrast will be too noisy to conclude anything.\x1b[0m\n`,
  );
}

await closePool();

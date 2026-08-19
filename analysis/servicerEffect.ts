/**
 * Is the gap between issuers the issuer's or the master servicer's?
 *
 *   npm run db:servicer-effect
 *
 * LA PREGUNTA
 *
 * Adjusted for vintage and DSCR tercile, BANK transfers to special servicing 4
 * times less often than BBCMS (SIR 0.39 against 1.60, non-overlapping intervals).
 * It survived five attempts to kill it: the join —which matches at 97.7%—, the
 * listed population, the block format, the filters, and the raw value verified
 * across twenty issuances.
 *
 * One alternative explanation remains. The master servicer builds the delinquency
 * table, and decides when a loan is transferred to the special servicer. If one
 * servicer transfers on looser criteria, its issuances flag more events without
 * the credit being any worse.
 *
 * WHY THE QUESTION CAN BE ASKED
 *
 * Because the design is crossed, and that was verified BEFORE looking at any
 * result (`db:coverage`, last section): Trimont appears under all eight issuers,
 * Midland under six, KeyBank under four. If each issuer used its own servicer, the
 * two variables would be the same column under two names and no analysis would be
 * possible.
 *
 * THE CONTRAST THAT DECIDES
 *
 * BANK and Wells are both almost entirely Trimont —16 of 24 and 10 of 11— and today
 * they flag 1.3% against 4.4%. If the servicer explained the gap, those two should
 * resemble each other. That they do not is evidence against the hypothesis before
 * computing anything, and this script measures it rather than reasoning about it.
 *
 * HOW TO READ IT
 *
 * The dispersion BETWEEN issuers within one servicer against the dispersion
 * BETWEEN servicers within one issuer. Whichever is larger is the variable that
 * drives it. It is a comparison of ranges, not a model: with 151 events spread
 * across cells, a model would give coefficients that cannot be interpreted.
 *
 * WHAT THIS SCRIPT DOES NOT CONTROL
 *
 * The vintage. Each cell reports its mix so you can see whether a contrast is
 * built on different vintages. It is not standardised because stratifying cells of
 * 300 loans by vintage leaves them at 60, and there is nothing left to read. It is
 * a declared limitation, not a solved one.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Fixed before seeing the numbers: below this the cell cannot be read. */
const MIN_POOL = 150;

/**
 * `--special` runs the same test against the SPECIAL servicer.
 *
 * The master decides when to transfer; the special servicer is who receives the
 * loan and is appointed by the B-piece buyer, who has an appetite of their own.
 * They are two different actors and there is no reason for the result to be the
 * same.
 *
 * It is the same question with a different column, so it shares all the code: if
 * the test were different for each, the comparison between them would say
 * nada.
 */
const SPECIAL = process.argv.includes("--special");
const COLUMN = SPECIAL ? "special_servicer" : "master_servicer";
const ROLE = SPECIAL ? "administrador especial" : "administrador maestro";

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

function wilson(k: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = k / total;
  const d = 1 + (z * z) / total;
  const c = p + (z * z) / (2 * total);
  const m = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

const SHELF = `
  CASE
    WHEN f.company_name ILIKE 'BANK5%'     THEN 'BANK5'
    WHEN f.company_name ILIKE 'BANK %'     THEN 'BANK'
    WHEN f.company_name ILIKE 'BENCHMARK%' THEN 'Benchmark'
    WHEN f.company_name ILIKE 'BBCMS%'     THEN 'BBCMS'
    WHEN f.company_name ILIKE 'BMO%'       THEN 'BMO'
    WHEN f.company_name ILIKE 'WELLS%'     THEN 'Wells'
    WHEN f.company_name ILIKE 'MORGAN%' OR f.company_name ILIKE 'MSWF%' THEN 'MS'
    WHEN f.company_name ILIKE 'GS %'       THEN 'GS'
    ELSE 'otros'
  END`;

/**
 * One loan per row, with its issuer, its servicer and whether it transferred.
 *
 * Only issuances with a registered servicer report: in the others the event is not
 * observable. The gate is `servicer_reports`, not `performance` — that was
 * corrected because using the NOI table as a proxy for "there is a report" left out
 * eight issuances whose report parsed fine but yielded no NOI.
 */
const BASE = `
  SELECT l.id,
         ${SHELF} AS shelf,
         sr.${COLUMN} AS master,
         extract(year FROM f.filed_at)::int AS vintage,
         (d.transfer_date IS NOT NULL)::int AS event
    FROM corpus.loans l
    JOIN corpus.filings f ON f.accession = l.accession
    JOIN corpus.servicer_reports sr ON sr.deal_accession = f.accession
    LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
   WHERE sr.${COLUMN} IS NOT NULL
`;

console.log(`\n${"═".repeat(78)}`);
console.log(`Issuer or ${ROLE}?`);
console.log(`${"═".repeat(78)}`);

const { rows: tot } = await query<{ n: string; ev: string }>(
  `WITH base AS (${BASE}) SELECT count(*)::text AS n, sum(event)::text AS ev FROM base`,
);
const nTot = Number(tot[0]!.n);
const evTot = Number(tot[0]!.ev);
console.log(
  `\n\x1b[90m  ${nTot.toLocaleString("en-US")} loans with an identified servicer · ` +
    `${evTot} transfers · base rate ${pct(evTot / nTot)}\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 1. Marginal by servicer
// ---------------------------------------------------------------------------

const { rows: porMaster } = await query<{
  master: string; issuers: string; n: string; ev: string;
}>(
  `WITH base AS (${BASE})
   SELECT master, count(DISTINCT shelf)::text AS issuers,
          count(*)::text AS n, sum(event)::text AS ev
     FROM base GROUP BY master ORDER BY count(*) DESC`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`By ${ROLE} (marginal)`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  servicer                  iss.        n    events      rate       95% CI`);
console.log(`  ${"─".repeat(72)}`);
for (const r of porMaster) {
  const n = Number(r.n), ev = Number(r.ev);
  const [lo, hi] = wilson(ev, n);
  console.log(
    `  ${r.master.slice(0, 24).padEnd(25)} ${String(r.issuers).padStart(4)} ` +
      `${String(n).padStart(7)} ${String(ev).padStart(8)}   ${pct(ev / n).padStart(6)}  ` +
      `[${pct(lo).padStart(5)} , ${pct(hi).padStart(5)}]`,
  );
}

// ---------------------------------------------------------------------------
// 2. The cells: issuer × servicer
// ---------------------------------------------------------------------------

const { rows: celdas } = await query<{
  shelf: string; master: string; n: string; ev: string; vintages: string;
}>(
  `WITH base AS (${BASE})
   SELECT shelf, master, count(*)::text AS n, sum(event)::text AS ev,
          string_agg(DISTINCT vintage::text, ',' ORDER BY vintage::text) AS vintages
     FROM base GROUP BY shelf, master
    HAVING count(*) >= ${MIN_POOL}
    ORDER BY master, shelf`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`Celdas issuer × ${ROLE} (pool ≥ ${MIN_POOL})`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  servicer               issuer         n   ev     rate         95% CI    vintages`);
console.log(`  ${"─".repeat(76)}`);

const porMasterCeldas = new Map<string, Array<{ shelf: string; tasa: number; n: number }>>();
const porShelfCeldas = new Map<string, Array<{ master: string; tasa: number; n: number }>>();

let masterPrev = "";
for (const c of celdas) {
  const n = Number(c.n), ev = Number(c.ev);
  const tasa = ev / n;
  const [lo, hi] = wilson(ev, n);

  (porMasterCeldas.get(c.master) ?? porMasterCeldas.set(c.master, []).get(c.master)!).push({
    shelf: c.shelf, tasa, n,
  });
  (porShelfCeldas.get(c.shelf) ?? porShelfCeldas.set(c.shelf, []).get(c.shelf)!).push({
    master: c.master, tasa, n,
  });

  const label = c.master === masterPrev ? "" : c.master.slice(0, 21);
  masterPrev = c.master;
  console.log(
    `  ${label.padEnd(22)} ${c.shelf.padEnd(10)} ${String(n).padStart(5)} ${String(ev).padStart(4)}  ` +
      `${pct(tasa).padStart(6)}  [${pct(lo).padStart(5)} , ${pct(hi).padStart(5)}]  ` +
      `\x1b[90m${c.vintages}\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 3. The test: which disperses more?
// ---------------------------------------------------------------------------

/**
 * Holding the servicer fixed, how much do the issuers vary? And the other way
 * round.
 *
 * If the gap were the servicer's, fixing it should flatten the issuers. If it is
 * the issuer's, fixing the servicer changes nothing and what flattens is the other
 * direction.
 */
/**
 * The dispersion is measured in PERCENTAGE POINTS, not as a ratio.
 *
 * The first version did `max / max(1e-9, min)` and BANK with LNR —0 events over
 * 261 loans— came out as 29,333,333x. A ratio of rates is undefined when the
 * denominator is zero, and that guard turned a "cannot be computed" into an
 * enormous number that also dragged the median.
 *
 * Percentage points are always defined, compare across cells without ambiguity,
 * and for base rates of 1-7% are what you want to read anyway: the difference
 * between 0.6% and 6.3% is 5.7 points, and that is interpretable where "ten times"
 * does not say how much.
 *
 * The ratio is still shown when it exists, because it is how we had been talking
 * about this, but it no longer decides anything.
 */
const spread = (xs: number[]) => (xs.length < 2 ? null : Math.max(...xs) - Math.min(...xs));
const cociente = (xs: number[]) => {
  if (xs.length < 2) return null;
  const min = Math.min(...xs);
  return min > 0 ? Math.max(...xs) / min : null;
};

console.log(`\n${"─".repeat(78)}`);
console.log("Holding one variable fixed, how much does the other disperse?");
console.log(`${"─".repeat(78)}\n`);

console.log(`  With the ${SPECIAL ? "special" : "master"} SERVICER fixed, dispersion between issuers:\n`);
const spreadsMaster: number[] = [];
for (const [master, xs] of porMasterCeldas) {
  const tasas = xs.map((x) => x.tasa);
  const sp = spread(tasas);
  if (sp === null) continue;
  spreadsMaster.push(sp);
  const c = cociente(tasas);
  const detalle = xs
    .sort((a, b) => a.tasa - b.tasa)
    .map((x) => `${x.shelf} ${pct(x.tasa)}`)
    .join("  ·  ");
  console.log(
    `    ${master.slice(0, 22).padEnd(23)} ${(sp * 100).toFixed(1).padStart(4)} pp` +
      `${(c === null ? "   (—)" : ` (${c.toFixed(1)}x)`).padEnd(9)}  \x1b[90m${detalle}\x1b[0m`,
  );
}

console.log(`\n  With the ISSUER fixed, dispersion between servicers:\n`);
const spreadsShelf: number[] = [];
for (const [shelf, xs] of porShelfCeldas) {
  const tasas = xs.map((x) => x.tasa);
  const sp = spread(tasas);
  if (sp === null) continue;
  spreadsShelf.push(sp);
  const c = cociente(tasas);
  const detalle = xs
    .sort((a, b) => a.tasa - b.tasa)
    .map((x) => `${x.master.slice(0, 14)} ${pct(x.tasa)}`)
    .join("  ·  ");
  console.log(
    `    ${shelf.padEnd(23)} ${(sp * 100).toFixed(1).padStart(4)} pp` +
      `${(c === null ? "   (—)" : ` (${c.toFixed(1)}x)`).padEnd(9)}  \x1b[90m${detalle}\x1b[0m`,
  );
}

const median = (xs: number[]) =>
  xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const medMaster = median(spreadsMaster);
const medShelf = median(spreadsShelf);

console.log(`\n${"─".repeat(78)}\n`);
if (medMaster === null || medShelf === null) {
  console.log(
    `  \x1b[33mThere are not enough cells with pool ≥ ${MIN_POOL} in both directions.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mLowering the threshold would surface contrasts built on twenty loans.\x1b[0m\n`,
  );
} else {
  console.log(
    `  Median with the servicer fixed: \x1b[1m${(medMaster * 100).toFixed(1)} pp\x1b[0m between issuers`,
  );
  console.log(
    `  Median with the issuer fixed:   \x1b[1m${(medShelf * 100).toFixed(1)} pp\x1b[0m between servicers`,
  );

  if (medMaster > medShelf * 1.5) {
    console.log(
      `\n  \x1b[32mThe issuer disperses more.\x1b[0m Fixing the servicer does NOT flatten the`,
    );
    console.log(
      `  \x1b[90missuers: the gap is not explained by who services it.\x1b[0m`,
    );
  } else if (medShelf > medMaster * 1.5) {
    console.log(
      `\n  \x1b[31mThe servicer disperses more.\x1b[0m The gap between issuers is largely`,
    );
    console.log(
      `  \x1b[90man effect of who builds the report, not of who underwrites.\x1b[0m`,
    );
  } else {
    console.log(
      `\n  \x1b[33mBoth disperse similarly.\x1b[0m They cannot be separated with these cells:`,
    );
    console.log(
      `  \x1b[90mthe data is compatible with both stories and with a mixture of the two.\x1b[0m`,
    );
  }
  console.log(
    `\n  \x1b[90mEach cell's vintages are in the table above. A contrast between cells of\x1b[0m`,
  );
  console.log(
    `  \x1b[90mdifferent vintages inherits the censoring, and that is not corrected.\x1b[0m\n`,
  );
}

await closePool();

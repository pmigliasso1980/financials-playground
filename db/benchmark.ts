/**
 * How does this issuance depart from its cohort?
 *
 *   npm run db:benchmark                    # the most recent one
 *   npm run db:benchmark -- BNK52
 *   npm run db:benchmark -- --list
 *
 * WHAT THIS IS AND WHAT IT IS NOT
 *
 * It is the first piece shaped like a service rather than a diagnostic: an
 * issuance goes in, where it falls relative to the others of its year comes out.
 * It has an input, an output, and an imaginable user — someone looking at a deal
 * who wants to know whether the terms are market.
 *
 * The eleven previous scripts were instruments for whoever is building. This one
 * answers a question somebody else might ask.
 *
 * WHY AGAINST THE COHORT AND NOT AGAINST HISTORY
 *
 * `db:stability` showed that 6 of 7 metrics shift more than 20% between vintages,
 * and that conditioning on term does not fix it: it is macro. A pooled reference
 * would measure the cycle, not the issuance.
 *
 * It is also the comparison someone actually wants: nobody asks whether their 2026
 * deal departs from 2013.
 *
 * THE UNIT OF COMPARISON IS THE ISSUANCE, NOT THE LOAN
 *
 * It compares the pool's MEDIAN against the distribution of the other issuances'
 * medians for that year. Comparing loan against loan would mix within-pool
 * variation with between-pool variation, and the question is about the pool.
 *
 * With 27 pairs, a percentile has a resolution of ~4 points. The ordinal position
 * —"3rd of 28"— is reported because that is what the number actually supports.
 *
 * WHAT IT EXCLUDES AND WHY
 *
 * Issuances of a single property type are not diversified conduits: they are a
 * different product. Comparing them against the conduit cohort produces guaranteed
 * differences that mean nothing. They are excluded from the reference group and it
 * says which.
 */

import { closePool, ping, query } from "./client.js";
import {
  computeBenchmark, loadCandidates, TYPE_CONCENTRATION, COHORT_METRICS,
  MIN_PER_METRIC, MIN_PAIRS, pct,
} from "./cohortBenchmark.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/**
 * THE CONSTANTS, THE METRICS AND THE COMPUTATION LIVE IN cohortBenchmark.ts
 *
 * They used to be here, and when `db:page` appeared there were two possible paths:
 * duplicate them or share them. Duplicating is how occupancy ended up with two
 * definitions contradicting each other on the same screen —one required ten loans,
 * the other one— so the computation moved to a module and this script became
 * what it is: a view.
 */
const args = process.argv.slice(2);
const LIST_ONLY = args.includes("--list");

/**
 * `--audit`: in how many issuances of the cohort does each metric resolve?
 *
 * WHY IT EXISTS
 *
 * The first run returned "Occupancy — no data in this issuance". In a diagnostic
 * that is a footnote; in a product it is what destroys trust, because the user
 * does not know whether the datum does not exist or whether we failed to find it.
 *
 * And before deciding which of the two it is, the denominator is needed: if
 * occupancy resolves in 5 of 28 issuances it should not be in the tool;
 * if it resolves in 26, it is two issuances with a mapping problem.
 *
 * It is the same rule we have been using —measure coverage before building on top
 * of it— applied to the benchmark instead of to the corpus.
 */
const AUDIT = args.includes("--audit");
const SEARCH = args.find((a) => !a.startsWith("--")) ?? null;


const candidates = await loadCandidates();

if (LIST_ONLY) {
  console.log(`\n${"═".repeat(78)}`);
  console.log("Available issuances (most recent first)");
  console.log(`${"═".repeat(78)}\n`);
  for (const c of candidates.slice(0, 30)) {
    const share = c.dominantShare;
    console.log(
      `  ${c.filed.slice(0, 10)}  ${c.name.slice(0, 42).padEnd(44)} ${String(c.pool).padStart(4)}` +
        (share > TYPE_CONCENTRATION
          ? `  \x1b[33mmono-tipo (${pct(share)} ${c.dominantType})\x1b[0m`
          : ""),
    );
  }
  console.log();
  await closePool();
  process.exit(0);
}

if (AUDIT) {
  const auditVintage = String(new Date().getFullYear());
  const cohort = candidates.filter((c) => c.vintage === auditVintage);
  const accs = cohort.map((c) => c.accession);

  console.log(`\n${"═".repeat(78)}`);
  console.log(`Benchmark audit — ${auditVintage} cohort`);
  console.log(`${"═".repeat(78)}\n`);
  console.log(`  ${cohort.length} issuances. In how many does each metric resolve?\n`);
  console.log(`  metric           resolves   issuances with no data`);
  console.log(`  ${"─".repeat(70)}`);

  for (const m of COHORT_METRICS) {
    const { rows } = await query<{ accession: string; n: string }>(
      `SELECT l.accession, count(*)::text AS n
         FROM corpus.facts fa
         JOIN corpus.loans l ON l.id = fa.loan_id
        WHERE fa.metric_key = $1
          AND fa.value ~ '^-?[0-9.]+$'
          AND fa.value::numeric BETWEEN ${m.min} AND ${m.max}
          AND l.accession = ANY($2)
        GROUP BY l.accession
       HAVING count(*) >= ${MIN_PER_METRIC}`,
      [m.key, accs],
    );
    const con = new Set(rows.map((r) => r.accession));
    const missing = cohort.filter((c) => !con.has(c.accession));
    const counts = new Map(rows.map((r) => [r.accession, Number(r.n)]));
    const share = cohort.length ? con.size / cohort.length : 0;
    console.log(
      `  ${m.label.padEnd(14)} ${`${con.size}/${cohort.length}`.padStart(8)}   ` +
        `${share >= 0.9 ? "\x1b[32m" : share >= 0.5 ? "\x1b[33m" : "\x1b[31m"}${pct(share).padStart(5)}\x1b[0m` +
        (missing.length > 0 ? `   \x1b[90m${missing.length} with no data\x1b[0m` : ""),
    );

    /**
     * The missing ones are named ALWAYS, not only when there are few.
     *
     * The first version listed them with `sin.length <= 5` and above that printed
     * "7 issuances". It is the same error we keep chasing in the
     * data, committed in the report: a summary that hides exactly what is needed
     * to decide. Seven names do not fill a screen, and without them there is no
     * way to know whether the absence is random or structural.
     */
    if (missing.length > 0 && con.size < cohort.length) {
      /**
       * How many loans it REALLY has, without the threshold.
       *
       * The first version said "no data" and that was a lie: the threshold of 10
       * is what decided, not the absence of the datum. BANK5 came out with no
       * occupancy in one table and 5/5 in the shelf one, because one required ten
       * loans and the other one. Two definitions of "has the datum" coexisting on
       * the same screen, contradicting each other.
       *
       * Now the raw count is printed against the pool. "3 of 35" is a claim about
       * the world; "no data" was one about my threshold.
       */
      const { rows: rawCounts } = await query<{ accession: string; n: string }>(
        `SELECT l.accession, count(*)::text AS n
           FROM corpus.facts fa
           JOIN corpus.loans l ON l.id = fa.loan_id
          WHERE fa.metric_key = $1
            AND fa.value ~ '^-?[0-9.]+$'
            AND fa.value::numeric BETWEEN ${m.min} AND ${m.max}
            AND l.accession = ANY($2)
          GROUP BY l.accession`,
        [m.key, missing.map((x) => x.accession)],
      );
      const rawCount = new Map(rawCounts.map((r) => [r.accession, Number(r.n)]));
      for (const x of missing) {
        const n = rawCount.get(x.accession) ?? 0;
        console.log(
          `    \x1b[90m· ${x.name.slice(0, 42).padEnd(44)} ${String(n).padStart(3)} de ${x.pool}` +
            (n > 0 ? ` \x1b[33m← the datum exists, the threshold of ${MIN_PER_METRIC} cuts it\x1b[0m` : ` \x1b[90mzero\x1b[0m`),
        );
      }
    }
  }

  /**
   * Is the absence random or does it cluster by issuer?
   *
   * 75% coverage does not mean the same thing depending on how it is distributed.
   * If the 7 without occupancy are scattered, the cohort's distribution is built
   * on a subsample resembling the whole. If they are all from the same shelf, the
   * reference systematically excludes one originator and comparing against it is
   * biased — with nothing in the output indicating it.
   *
   * It is the same question that already cost us dearly with `property_type`: there the
   * cobertura global era 93,7% y tres shelves enteros estaban abajo del umbral.
   */
  const { rows: porShelf } = await query<{ shelf: string; total: string; with_occ: string }>(
    `WITH e AS (
       SELECT f.accession,
              split_part(f.company_name, ' ', 1) AS shelf,
              EXISTS (
                SELECT 1 FROM corpus.facts fa
                  JOIN corpus.loans l ON l.id = fa.loan_id
                 WHERE l.accession = f.accession
                   AND fa.metric_key = 'occupancy'
                   AND fa.value ~ '^-?[0-9.]+$'
              ) AS tiene
         FROM corpus.filings f
        WHERE f.accession = ANY($1)
     )
     SELECT shelf, count(*)::text AS total,
            count(*) FILTER (WHERE tiene)::text AS with_occ
       FROM e GROUP BY shelf HAVING count(*) >= 2 ORDER BY 1`,
    [accs],
  );

  console.log(`\n  Occupancy by shelf — does the absence cluster?\n`);
  for (const r of porShelf) {
    const tot = Number(r.total);
    const con = Number(r.with_occ);
    console.log(
      `    ${r.shelf.slice(0, 18).padEnd(20)} ${`${con}/${tot}`.padStart(6)}` +
        (con === 0 ? `  \x1b[31m← the whole shelf\x1b[0m` : con < tot ? `  \x1b[33mpartial\x1b[0m` : ""),
    );
  }
  console.log(
    `\n  \x1b[90mThis table asks whether ANY loan has the datum, so it almost always\x1b[0m`,
  );
  console.log(
    `  \x1b[90msays yes: BANK5 comes out 5/5 while having 6 of 35. The correct unit\x1b[0m`,
  );
  console.log(`  \x1b[90mis the loan, and that is the table below.\x1b[0m`);

  /**
   * THE MEASUREMENT THAT SHOULD HAVE BEEN MADE FROM THE START: loans, not issuances.
   *
   * The two tables above count issuances passing a threshold. But an issuance's
   * median is computed over LOANS, and a cohort where each deal has the datum in
   * 11 of 35 would give 28/28 in the first table and would be a reference built on
   * a third of the population.
   *
   * `CLAUDE.md` says "the unit of analysis is chosen before the method" and here I
   * chose it afterwards, looking at what was easy to count.
   *
   * THE CUT BY TYPE IS THE DECIDING TEST
   *
   * Two explanations remain for the sparseness, and they predict different things:
   *
   *   (a) the datum is reported where it means something — a hotel's occupancy is
   *       measured with RevPAR, a self storage's rotates monthly. Then
   *       multifamily/office/retail should be high and hospitality at zero.
   *
   *   (b) the parser loses it — then coverage is even and low across ALL types,
   *       because the column does not care what is inside.
   *
   * Benchmark 2026-B42 with 1 of 62 already pushes hard towards (b): that issuance
   * is 42% multifamily, i.e. ~26 loans where occupancy is the asset's central
   * metric. But one case does not decide, and this cut does.
   */
  const { rows: porTipo } = await query<{
    type: string; total: string; with_occ: string;
  }>(
    `SELECT coalesce(l.property_type, '(sin tipo)') AS type,
            count(*)::text AS total,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM corpus.facts fa
               WHERE fa.loan_id = l.id AND fa.metric_key = 'occupancy'
                 AND fa.value ~ '^-?[0-9.]+$'
            ))::text AS with_occ
       FROM corpus.loans l
      WHERE l.accession = ANY($1)
      GROUP BY 1 HAVING count(*) >= 10
      ORDER BY count(*) DESC`,
    [accs],
  );

  const totPrest = porTipo.reduce((a, r) => a + Number(r.total), 0);
  const totOcc = porTipo.reduce((a, r) => a + Number(r.with_occ), 0);

  console.log(`\n${"─".repeat(78)}`);
  console.log(`\n  Occupancy at LOAN level, by property type\n`);
  console.log(`    type                      loans   with occupancy`);
  console.log(`    ${"─".repeat(52)}`);
  for (const r of porTipo) {
    const tot = Number(r.total);
    const con = Number(r.with_occ);
    const sh = con / tot;
    console.log(
      `    ${r.type.slice(0, 20).padEnd(22)} ${String(tot).padStart(9)}   ` +
        `${(sh >= 0.8 ? "\x1b[32m" : sh >= 0.3 ? "\x1b[33m" : "\x1b[31m")}${String(con).padStart(5)} ${pct(sh).padStart(6)}\x1b[0m`,
    );
  }
  console.log(
    `\n    \x1b[1mTotal${String(totPrest).padStart(24)}   ${totOcc} ${pct(totOcc / Math.max(1, totPrest))}\x1b[0m`,
  );

  /**
   * The verdict is computed, not eyeballed.
   *
   * If the dispersion between types is small, coverage does not depend on what is
   * inside the asset and the "reported where it means something" explanation does
   * sostiene.
   */
  const shares = porTipo.map((r) => Number(r.with_occ) / Number(r.total));
  const spread = Math.max(...shares) - Math.min(...shares);
  console.log(
    `\n    \x1b[90mDispersion between types: ${pct(spread)} (from ${pct(Math.min(...shares))} to ${pct(Math.max(...shares))}).\x1b[0m`,
  );
  console.log(
    `\n    \x1b[90mThis cut does NOT decide anything on its own: property type and issuance\x1b[0m`,
  );
  console.log(
    `    \x1b[90mare correlated. A broken issuance that is 42% multifamily sinks the\x1b[0m`,
  );
  console.log(
    `    \x1b[90mmultifamily row without multifamily having anything to do with it. See below.\x1b[0m`,
  );

  /**
   * THE REAL TEST: within each issuance, not across them.
   *
   * The previous version of this block issued a verdict ("it varies by type,
   * therefore the datum is reported where it means something") from the dispersion
   * between types AGGREGATED over the 28 issuances. It was confounded.
   *
   * The arithmetic of its own output showed it: the 7 issuances with no data sum
   * 234 loans and contribute 15, so the other 21 have 673 of 675 — 99.7%. Coverage
   * is not a gradient by type: it is binary by ISSUANCE. The "by type" variation I
   * measured was the composition of the 7 broken ones.
   *
   * It is the same error that killed the BANK versus BBCMS hypothesis: aggregating
   * across the unit that carries the real variation and reading the result as an
   * effect of the variable one wanted to look at.
   *
   * The correct test separates the two populations first. Within the issuances that
   * DO carry the datum, if coverage is even across types then format is the only
   * thing deciding and type plays no part.
   */
  const { rows: dentro } = await query<{ type: string; total: string; with_occ: string }>(
    `WITH sanas AS (
       SELECT l.accession
         FROM corpus.loans l
        WHERE l.accession = ANY($1)
        GROUP BY l.accession
       HAVING count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM corpus.facts fa
                 WHERE fa.loan_id = l.id AND fa.metric_key = 'occupancy'
                   AND fa.value ~ '^-?[0-9.]+$'
              ))::numeric / count(*) > 0.5
     )
     SELECT coalesce(l.property_type, '(sin tipo)') AS type,
            count(*)::text AS total,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM corpus.facts fa
               WHERE fa.loan_id = l.id AND fa.metric_key = 'occupancy'
                 AND fa.value ~ '^-?[0-9.]+$'
            ))::text AS with_occ
       FROM corpus.loans l
       JOIN sanas s ON s.accession = l.accession
      GROUP BY 1 HAVING count(*) >= 10
      ORDER BY count(*) DESC`,
    [accs],
  );

  console.log(`\n  Only within the issuances that DO carry occupancy\n`);
  console.log(`    type                      loans   with occupancy`);
  console.log(`    ${"─".repeat(52)}`);
  for (const r of dentro) {
    const tot = Number(r.total);
    const con = Number(r.with_occ);
    const sh = con / tot;
    console.log(
      `    ${r.type.slice(0, 20).padEnd(22)} ${String(tot).padStart(9)}   ` +
        `${(sh >= 0.8 ? "\x1b[32m" : sh >= 0.3 ? "\x1b[33m" : "\x1b[31m")}${String(con).padStart(5)} ${pct(sh).padStart(6)}\x1b[0m`,
    );
  }

  /**
   * The null bucket does NOT enter the verdict.
   *
   * Third version of this conclusion, and the first three were wrong for the same
   * reason: the number below was computed over a set that included something that
   * did not belong. Here it was `(no type)`, which is not a property type but the
   * absence of one — asking whether it behaves like a type makes no sense, and its
   * 65% inflated the dispersion to 35 points when across the eight real types it is
   * exactly zero.
   *
   * The loans with no type are the `property_type` gap that is already
   * noted separately. They are shown, not computed.
   */
  const sd = dentro
    .filter((r) => !r.type.startsWith("("))
    .map((r) => Number(r.with_occ) / Number(r.total));
  const spreadWithin = sd.length ? Math.max(...sd) - Math.min(...sd) : 0;
  console.log(
    `\n    \x1b[90mDispersion across the ${sd.length} real types: ${pct(spreadWithin)}` +
      ` (against ${pct(spread)} aggregating across issuances).\x1b[0m\n` +
      `    \x1b[90m'(no type)' is left out of the calculation: it is the absence of a type, not a type.\x1b[0m`,
  );
  console.log(
    spreadWithin < 0.2
      ? `    \x1b[31mType plays no part: where the issuance carries the datum, it carries it for all.\x1b[0m\n` +
          `    \x1b[90mIt is not format: the headers of a conduit Annex A are byte for byte\x1b[0m\n` +
          `    \x1b[90midentical across issuers. It is the order of the blocks after the join,\x1b[0m\n` +
          `    \x1b[90mwhich breaks ties between equally scored columns — fixed in taxonomy\x1b[0m\n` +
          `    \x1b[90m2026.08.10 by giving /leased occ/ the first pattern. If it goes missing\x1b[0m\n` +
          `    \x1b[90magain in some issuance, it is a pending re-harvest or a new tie.\x1b[0m`
      : `    \x1b[33mType still plays a part even within healthy issuances: there are two\x1b[0m\n` +
          `    \x1b[33moverlapping causes and they need separating before using the metric.\x1b[0m`,
  );

  /**
   * The concentration shares, which decided exclusions without anyone looking at
   * the value. An 82% and a 98% are both excluded at threshold 0.8, but the first
   * is a decision of mine and the second a property of the deal.
   */
  /**
   * Are there issuances loaded twice?
   *
   * Two "Wells Fargo Commercial Mortgage Trust 2026-5" appeared in the missing
   * list — which may be the 42-character truncation of two different deals, or the
   * same one harvested twice.
   *
   * It is not cosmetic: the cohort is the denominator of every ordinal position. A
   * duplicated issuance counts as two pairs, pulls the median towards itself
   * and shifts every "13th of 25" with nothing indicating it.
   */
  const { rows: dups } = await query<{ name: string; n: string; accs: string; pools: string }>(
    `SELECT f.company_name AS name, count(*)::text AS n,
            string_agg(f.accession, ' · ') AS accs,
            string_agg(p.pool::text, ' · ') AS pools
       FROM corpus.filings f
       JOIN (SELECT accession, count(*) AS pool FROM corpus.loans GROUP BY accession) p
         ON p.accession = f.accession
      WHERE f.accession = ANY($1)
      GROUP BY f.company_name HAVING count(*) > 1`,
    [accs],
  );
  /**
   * The property_type categories that are stored.
   *
   * Until taxonomy 2026.08.11, "General Property Type" and "Detailed Property
   * Type" tied and whichever came first after the join won. If the detailed one
   * won in some issuance, fine categories ("Anchored Retail", "Limited Service")
   * have to show up here mixed with the coarse ones.
   *
   * It is the check that the fix achieved something: a short list of coarse
   * categories means every issuance now uses the same taxonomy. A long list with
   * variants means it is still mixed.
   */
  const { rows: cats } = await query<{ type: string; n: string; issuances: string }>(
    `SELECT coalesce(property_type, '(sin tipo)') AS type,
            count(*)::text AS n,
            count(DISTINCT accession)::text AS issuances
       FROM corpus.loans WHERE accession = ANY($1)
      GROUP BY 1 ORDER BY count(*) DESC`,
    [accs],
  );
  console.log(`\n  property_type categories in the cohort — ${cats.length} distinct\n`);
  for (const c of cats) {
    console.log(
      `    ${c.type.slice(0, 34).padEnd(36)} ${String(c.n).padStart(4)} loans` +
        ` \x1b[90men ${c.issuances} emisiones\x1b[0m` +
        /**
         * Two flags, for two different failure modes.
         *
         * The first version only had the "confined to one issuance" case, written
         * assuming the risk was different issuers using different taxonomies. The
         * real problem turned out to be another: a category called "2", in three
         * issuances, which passed unflagged because it is not confined.
         *
         * A purely numeric property type is not a category: it is a data cell that
         * leaked into the column. That can be asserted without knowing which
         * document it came from.
         */
        (/^[\d.,\s]+$/.test(c.type)
          ? `  \x1b[31m← not a category: numeric value\x1b[0m`
          : Number(c.issuances) === 1 && Number(c.n) >= 3
            ? `  \x1b[33m← only in one: a different taxonomy?\x1b[0m`
            : ""),
    );
  }

  /**
   * The loans with a numeric type, with their neighbouring fields.
   *
   * THE HYPOTHESIS THIS TESTS
   *
   * `harvest:ties` found headers with data rows glued inside them ("# of
   * Properties 3 1", "Loan ID Number 37 37.01 37.02 38"). If the header ended up
   * badly delimited, that issuance's columns are shifted, and a property_type of
   * "2" would be the neighbouring column's value —precisely `# of Properties`—
   * read in the wrong place.
   *
   * If it is a shift, the neighbouring fields will also be out of
   * place: a property name where the type goes, a type where the count goes. If
   * instead the rest looks healthy, "2" is an isolated dirty cell and there is no
   * corrimiento — dos causas con arreglos completamente distintos.
   */
  const { rows: suspects } = await query<{
    name: string; loan_id: string; type: string;
    prop_name: string | null; prop_count: string | null; unit: string | null;
  }>(
    `SELECT f.company_name AS name,
            coalesce(l.loan_ref, 'fila ' || l.row_index) AS loan_id,
            l.property_type AS type,
            l.property_name AS prop_name,
            max(fa.value) FILTER (WHERE fa.metric_key = 'property_count') AS prop_count,
            max(fa.value) FILTER (WHERE fa.metric_key = 'unit_of_measure') AS unit
       FROM corpus.loans l
       JOIN corpus.filings f ON f.accession = l.accession
       LEFT JOIN corpus.facts fa ON fa.loan_id = l.id
      WHERE l.accession = ANY($1) AND l.property_type ~ '^[0-9.,[:space:]]+$'
      GROUP BY f.company_name, l.loan_ref, l.row_index, l.property_type, l.property_name
      ORDER BY 1, 2`,
    [accs],
  );

  if (suspects.length > 0) {
    console.log(`\n  Loans with a numeric type — are the columns shifted?\n`);
    for (const x of suspects) {
      console.log(`    \x1b[1m${x.name.slice(0, 40)}\x1b[0m  loan ${x.loan_id}`);
      console.log(
        `      tipo=\x1b[31m${JSON.stringify(x.type)}\x1b[0m` +
          `  # props=${JSON.stringify(x.prop_count)}` +
          `  unidad=${JSON.stringify(x.unit)}`,
      );
      console.log(`      nombre=${JSON.stringify((x.prop_name ?? "").slice(0, 44))}`);
    }
    /**
     * The previous version of these lines offered two causes —a dirty cell or a
     * column shift— as if they were exhaustive. The evidence it prints just above
     * rules out both: no name, null count and null unit is neither a dirty cell
     * nor a shift, it is a row that is not a loan.
     *
     * I left it printed several runs after knowing it was false. Now it says what
     * the evidence supports and names the task where it gets fixed.
     */
    console.log(
      `\n    \x1b[90mNo name, no count and no unit: these are not loans with the wrong type,\x1b[0m`,
    );
    console.log(
      `    \x1b[90mthey are rows that are not loans. row_index 0 is the first row after\x1b[0m`,
    );
    console.log(
      `    \x1b[90mthe header, which in a conduit Annex A usually numbers the columns —\x1b[0m`,
    );
    console.log(
      `    \x1b[90mand there a "2" in the type position is the column number. Task #49.\x1b[0m`,
    );
  }

  /**
   * PHANTOM LOANS: rows loaded as loans that are not loans.
   *
   * The 5 with a numeric property_type turned out to have no name, no property
   * count and no unit of measure, and 3 of the 5 are at row_index 0 — the first
   * row after the header, which in an Annex A usually numbers the columns. A "2"
   * in the property type position is exactly what that row leaves behind.
   *
   * It was not a column shift nor a dirty cell, which were the two causes I had
   * put forward as if they were exhaustive. It was a third.
   *
   * WHY IT MATTERS MORE THAN THE 5 CASES
   *
   * The pool is the denominator of everything this tool does: the ordinal
   * position, the composition percentages, and the note saying how much each loan
   * is worth. A phantom row breaks nothing visibly — it shifts the percentages by
   * a point and nobody would notice.
   *
   * They are counted by number of facts because that is the operational
   * definition: a real loan in a conduit Annex A has dozens of observations. A row
   * with two or three is not a loan with little data, it is something else.
   */
  const { rows: phantoms } = await query<{
    name: string; pool: string; thin: string; empty: string; min_facts: string;
  }>(
    `WITH conteo AS (
       SELECT l.accession, l.id, count(fa.id) AS facts
         FROM corpus.loans l
         LEFT JOIN corpus.facts fa ON fa.loan_id = l.id
        WHERE l.accession = ANY($1)
        GROUP BY l.accession, l.id
     )
     SELECT f.company_name AS name,
            count(*)::text AS pool,
            count(*) FILTER (WHERE c.facts <= 5)::text AS thin,
            count(*) FILTER (WHERE c.facts = 0)::text AS empty,
            min(c.facts)::text AS min_facts
       FROM conteo c JOIN corpus.filings f ON f.accession = c.accession
      GROUP BY f.company_name
     HAVING count(*) FILTER (WHERE c.facts <= 5) > 0
      ORDER BY count(*) FILTER (WHERE c.facts <= 5) DESC`,
    [accs],
  );

  const totalThin = phantoms.reduce((a, r) => a + Number(r.thin), 0);
  console.log(
    `\n  Rows with 5 facts or fewer — are they loans?  \x1b[1m${totalThin} across ${phantoms.length} issuances\x1b[0m\n`,
  );
  for (const r of phantoms) {
    console.log(
      `    ${r.name.slice(0, 40).padEnd(42)} ${String(r.thin).padStart(3)} de ${String(r.pool).padStart(3)}` +
        `  \x1b[90mminimum ${r.min_facts} facts\x1b[0m` +
        (Number(r.empty) > 0 ? `  \x1b[31m${r.empty} with no fact at all\x1b[0m` : ""),
    );
  }
  if (totalThin > 0) {
    console.log(
      `\n    \x1b[90mA real loan in a conduit Annex A has dozens of observations.\x1b[0m`,
    );
    console.log(
      `    \x1b[90mIf these rows are not loans, the pool is inflated and with it the\x1b[0m`,
    );
    console.log(
      `    \x1b[90mdenominator of every ordinal position and every composition\x1b[0m`,
    );
    console.log(`    \x1b[90mpercentage this tool prints.\x1b[0m`);
  }

  /**
   * IS THERE A GAP BETWEEN THE TWO POPULATIONS?
   *
   * The pipeline already discards rows with fewer than 3 observations
   * (`minObservationsPerRow ?? 3` in rowsToObservations). The 7 phantom rows have
   * exactly 3: they pass by one fact of margin.
   *
   * That 3 did not come from measuring anything. If real loans in a conduit Annex
   * A have dozens of observations and phantom rows have a handful, between the two
   * populations there is an empty zone, and the threshold has to sit there —
   * chosen by where the gap is, not by looking reasonable.
   *
   * If instead the distribution is continuous from 3 to 80, there are not two
   * populations: there is a gradient of completeness, any threshold cuts real
   * loans, and discarding by count is the wrong criterion.
   *
   * This histogram decides between those two things, and it is what should have
   * been looked at before fixing any number.
   */
  /**
   * OVER THE WHOLE CORPUS, NOT OVER THE COHORT.
   *
   * The first version computed it over the 28 issuances of 2026, but the threshold
   * this histogram justifies is applied when harvesting all 233. Choosing a
   * corpus-wide cut by looking at 12% is the same unit error that has already come
   * up twice today: measuring where it is convenient and applying where it matters.
   */
  const { rows: histo } = await query<{ tramo: string; n: string }>(
    `WITH conteo AS (
       SELECT l.id, count(fa.id) AS facts
         FROM corpus.loans l
         LEFT JOIN corpus.facts fa ON fa.loan_id = l.id
        GROUP BY l.id
     )
     SELECT CASE
              WHEN facts <= 10 THEN lpad(facts::text, 2, ' ')
              WHEN facts < 20 THEN '11-19'
              WHEN facts < 40 THEN '20-39'
              WHEN facts < 60 THEN '40-59'
              ELSE '60+'
            END AS tramo,
            count(*)::text AS n
       FROM conteo GROUP BY 1 ORDER BY 1`,
  );

  const totalCorpus = histo.reduce((a, h) => a + Number(h.n), 0);
  console.log(
    `\n  Observations per row across the WHOLE corpus (${totalCorpus} loans) — two populations?\n`,
  );
  const maxN = Math.max(...histo.map((h) => Number(h.n)));
  for (const h of histo) {
    const n = Number(h.n);
    const barra = "█".repeat(Math.max(1, Math.round((n / maxN) * 44)));
    const chico = /^\s*\d+$/.test(h.tramo) && Number(h.tramo) <= 10;
    console.log(
      `    ${h.tramo.padStart(5)}  ${chico ? "\x1b[31m" : "\x1b[90m"}${barra}\x1b[0m ${n}`,
    );
  }

  /**
   * THE GAP HAS TO BE CONTIGUOUS AND SIT BETWEEN THE TWO POPULATIONS.
   *
   * The previous version lumped all the empty buckets together and reported the
   * minimum and maximum as if they were a range. Over the full corpus the empties
   * are {1, 2, 8} and that printed "there is a gap between 1 and 8, move the
   * threshold to 8" — false: between 3 and 7 there are 51 rows that cut would have
   * removed.
   *
   * Two different defects on the same line. The buckets below the lowest populated
   * one are not a gap, they are the floor of the distribution. And a single empty
   * bucket between populated neighbours does not separate populations: it is
   * counting noise.
   *
   * It is the fifth verdict this session computed over a set that is not
   * the one the sentence describes. The table was right all five times.
   */
  const presentes = new Set(
    histo.map((h) => h.tramo.trim()).filter((t) => /^\d+$/.test(t)).map(Number),
  );
  const floor = Math.min(...presentes);
  const techo = Math.max(...presentes);

  /** The longest contiguous run of empty buckets, only between floor and ceiling. */
  let mejor: number[] = [];
  let actual: number[] = [];
  for (let k = floor; k <= techo; k++) {
    if (presentes.has(k)) {
      if (actual.length > mejor.length) mejor = actual;
      actual = [];
    } else actual.push(k);
  }
  if (actual.length > mejor.length) mejor = actual;

  const emptyBuckets = [...Array(10).keys()].map((k) => k + 1).filter((k) => !presentes.has(k));
  console.log(
    `\n    \x1b[90mNo rows at: ${emptyBuckets.length ? emptyBuckets.join(", ") : "any count from 1 to 10"}.` +
      ` Thinnest population: ${floor} observations.\x1b[0m`,
  );
  /**
   * THIS HISTOGRAM NO LONGER DECIDES A THRESHOLD, AND SHOULD NOT LOOK LIKE IT DOES.
   *
   * It was written to choose a cut by number of observations. The measurement over
   * the 233 issuances closed that door: the distribution is continuous from 3, any
   * cut removes real loans, and the filter ended up being structural —a row with no
   * letters in any cell is not a loan.
   *
   * After applying it a contiguous gap appears in the low tail, and the previous
   * version of this line said "the threshold can go inside it". That is circular:
   * the gap exists BECAUSE the filter removed those rows. It recommended as a
   * finding what was a consequence of the fix, and in the direction we had already
   * descartado.
   *
   * Now it only describes the shape. The low tail that remains is partial
   * coverage —task #40— and not phantom rows.
   */
  const lowTail = histo
    .filter((h) => /^\s*\d+$/.test(h.tramo) && Number(h.tramo) <= 10)
    .reduce((a, h) => a + Number(h.n), 0);
  console.log(
    `    \x1b[90m${lowTail} rows with 10 observations or fewer out of ${totalCorpus}.\x1b[0m`,
  );
  console.log(
    `    \x1b[90mNothing is discarded by count: the distribution is continuous from ${floor} and\x1b[0m`,
  );
  console.log(
    `    \x1b[90many cut would remove real loans. The filter is structural\x1b[0m`,
  );
  console.log(
    `    \x1b[90m—a row with no letters in any cell is not a loan— so what remains\x1b[0m`,
  );
  console.log(
    `    \x1b[90mhere is partial coverage, not phantom rows. Task #40.\x1b[0m`,
  );

  console.log(`\n  Duplicated issuances? — the cohort is the denominator of everything\n`);
  if (dups.length === 0) {
    console.log(`    \x1b[32mNinguna: ${cohort.length} nombres distintos en ${cohort.length} emisiones.\x1b[0m`);
  } else {
    for (const d of dups) {
      console.log(`    \x1b[33m${d.name.slice(0, 46)}\x1b[0m  ×${d.n}  pools ${d.pools}`);
      console.log(`      \x1b[90m${d.accs}\x1b[0m`);
    }
    console.log(
      `\n    \x1b[90mPools distintos = deals distintos con nombre igual. Pools iguales =\x1b[0m`,
    );
    console.log(`    \x1b[90mcheck whether it is the same issuance harvested twice.\x1b[0m`);
  }

  console.log(`\n  Concentration by type — the exclusion threshold is ${pct(TYPE_CONCENTRATION)}:\n`);
  for (const c of [...cohort].sort(
    (a, b) => b.dominantShare - a.dominantShare,
  ).slice(0, 8)) {
    const sh = c.dominantShare;
    console.log(
      `    ${c.name.slice(0, 40).padEnd(42)} ${pct(sh).padStart(5)} ${(c.dominantType ?? "").slice(0, 16)}` +
        (sh > TYPE_CONCENTRATION
          ? sh < TYPE_CONCENTRATION + 0.08
            ? `  \x1b[33m← at the threshold's edge\x1b[0m`
            : `  \x1b[90mexcluida\x1b[0m`
          : ""),
    );
  }
  console.log();
  await closePool();
  process.exit(0);
}

/**
 * The terminal view. The numbers come from the module; here we only choose
 * colours, widths and what is said beside each figure.
 */
const b = await computeBenchmark(SEARCH, candidates);

if (!b) {
  console.error(`\n✗ No issuance found matching "${SEARCH}".`);
  console.error(`  Listado:  npm run db:benchmark -- --list\n`);
  await closePool();
  process.exit(1);
}

const o = b.target;

console.log(`\n${"═".repeat(78)}`);
console.log(`${o.name}`);
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  ${o.filed.slice(0, 10)} · ${o.pool} loans · ${o.vintage} cohort\x1b[0m`,
);
console.log(
  `  \x1b[90m${b.pairs.length} pares comparables` +
    (b.excluded.length > 0
      ? ` · ${b.excluded.length} excluded for being single-type: ` +
        b.excluded.map((e) => e.name.slice(0, 24)).join(", ")
      : "") +
    `\x1b[0m`,
);

/** The refusal, which is part of the answer and not an empty screen. */
if (!b.evaluable) {
  console.log(
    `\n  \x1b[31mCannot be evaluated: ${MIN_PAIRS} pairs are needed and there are ${b.pairs.length}.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mWith fewer, "departs from the market" would be a claim about ${b.pairs.length}\x1b[0m`,
  );
  console.log(`  \x1b[90mdocuments. The correct answer is that it is unknown.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

if (b.targetSingleType) {
  console.log(
    `\n  \x1b[33mThis issuance is ${pct(o.dominantShare)} ${o.dominantType}:\x1b[0m`,
  );
  console.log(
    `  \x1b[90mit is not a diversified conduit and the comparison against the cohort will\x1b[0m`,
  );
  console.log(`  \x1b[90mshow guaranteed differences that mean nothing.\x1b[0m`);
}

console.log(`\n${"─".repeat(78)}`);
console.log(`Position within the ${o.vintage} cohort`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  metric         this issuance  cohort (p25–median–p75)       position`);
console.log(`  ${"─".repeat(72)}`);

for (const m of b.metrics) {
  if (m.value === null) {
    console.log(
      `  ${m.spec.label.padEnd(14)} ` +
        `\x1b[90m${m.noData === "issuance" ? "no data in this issuance" : `only ${m.pairsWithData} pairs with data`}\x1b[0m`,
    );
    continue;
  }
  const f = m.spec.fmt;
  console.log(
    `  ${m.spec.label.padEnd(14)} ${f(m.value).padStart(12)}   ` +
      `${f(m.p25!).padStart(8)} ${f(m.p50!).padStart(8)} ${f(m.p75!).padStart(8)}      ` +
      `${m.extreme ? (m.aggressive ? "\x1b[33m" : "\x1b[36m") : "\x1b[90m"}${m.rank}ª de ${m.total}\x1b[0m` +
      (m.aggressive ? "  \x1b[33m← more aggressive\x1b[0m" : ""),
  );
}

console.log(`\n${"─".repeat(78)}`);
console.log("Composition against the cohort");
console.log(`${"─".repeat(78)}\n`);
console.log(`  type               this issuance   cohort    difference`);
console.log(`  ${"─".repeat(58)}`);

for (const c of b.composition) {
  const notable = Math.abs(c.difference) > 0.1;
  console.log(
    `  ${c.type.padEnd(18)} ${pct(c.own).padStart(12)}   ${pct(c.cohort).padStart(7)}    ` +
      `${notable ? "\x1b[33m" : "\x1b[90m"}${(c.difference > 0 ? "+" : "") + pct(c.difference)}\x1b[0m` +
      `  \x1b[90m${c.loans} loan(s)\x1b[0m`,
  );
}

/**
 * The resolution the percentage hides. With 25 loans each is worth 4 points, so
 * a "+9%" is two loans.
 */
console.log(
  `\n  \x1b[90mEach loan is worth ${pct(b.pointPerLoan, 1)} of this pool (${o.pool} loans):\x1b[0m`,
);
console.log(
  `  \x1b[90ma 9-point difference is ${Math.max(1, Math.round(0.09 / b.pointPerLoan))} loans, not a trend.\x1b[0m`,
);
console.log(
  `\n  \x1b[90mThe position is ordinal, not a percentile: with ${b.pairs.length} pairs a percentile\x1b[0m`,
);
console.log(
  `  \x1b[90mhas a resolution of ~${b.percentileResolution.toFixed(0)} points and presenting it with decimals\x1b[0m`,
);
console.log(`  \x1b[90mwould suggest a precision that does not exist.\x1b[0m`);
console.log(`\n  \x1b[90mThe same comparison as a page:  npm run db:page -- "${SEARCH ?? o.name.slice(0, 14)}"\x1b[0m\n`);

await closePool();

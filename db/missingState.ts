/**
 * The 790 loans with an empty state: what they are.
 *
 *   npm run db:missing-state
 *
 * WHY IT NEEDS ASKING
 *
 * `db:fix-states` recovered 1,107 loans that had the state name written out in
 * full. That leaves 790 with the cell EMPTY, and there is nothing there to map:
 * it is not a formatting problem, the datum is not present.
 *
 * The suspicion was multi-state portfolios —a loan over properties in five
 * states does not have ONE state— and one piece of supporting evidence turned up
 * on its own: among the odd values the monitor found a literal `"Various
 * Various"`. A clue is not proof, and I have already been wrong predicting on
 * less evidence than this.
 *
 * THE TWO EXPLANATIONS ARE CHEAP TO TELL APART
 *
 * If they are portfolios, they are SPREAD OUT: every conduit issuance has some,
 * so they should appear a few at a time in almost every filing.
 *
 * If it is a parser defect, they are PILED UP in a few filings, which is exactly
 * the shape the `property_type` gap had —where one issuance, BBCMS 2022-C17,
 * accounted for a huge share on its own.
 *
 * Concentration is the discriminator, and it does not depend on my guessing
 * which one it is.
 *
 * WHAT ELSE IS MEASURED
 *
 * `property_count > 1` is the direct test of multi-property, the same one
 * `db:type-gap` used. And if the portfolio explanation holds, the city and the
 * postcode have to be missing TOO: a portfolio across five states does not have
 * one city either. If the city is there and the state is not, the explanation is
 * something else and it is the parser.
 *
 * THIS FIXES NOTHING
 *
 * It is a one-run diagnostic, not a script to keep. If the answer is
 * "portfolios", the fix is not to fill in the state but to make `/comps` aware
 * they exist; if it is the parser, the fix is the parser.
 */

import { closePool, ping, query } from "./client.js";
import { STATE_CODES } from "../harvest/normalize/states.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const codes = [...STATE_CODES];
/** Genuinely empty, not "oddly written": the odd ones were fixed by db:fix-states. */
const EMPTY = `(l.state IS NULL OR btrim(l.state) = '')`;

console.log(`\n${"═".repeat(78)}`);
console.log("Loans with an empty state: portfolios or a parser defect?");
console.log(`${"═".repeat(78)}\n`);

const { rows: tot } = await query<{ empty: string; total: string; invalid: string }>(
  `SELECT count(*) FILTER (WHERE ${EMPTY})::text AS empty,
          count(*)::text AS total,
          count(*) FILTER (WHERE l.state IS NOT NULL AND btrim(l.state) <> ''
                             AND NOT (btrim(l.state) = ANY($1)))::text AS invalid
     FROM corpus.loans l`,
  [codes],
);
const empty = Number(tot[0]!.empty);
if (empty === 0) {
  console.log(`  There are no loans left with an empty state.\n`);
  await closePool();
  process.exit(0);
}
console.log(
  `  ${empty} empty out of ${Number(tot[0]!.total).toLocaleString("en-US")} loans` +
    `  ·  ${tot[0]!.invalid} more with a value that is not a state\n`,
);

/**
 * THE DISCRIMINATOR.
 *
 * It is compared against the total number of issuances in the corpus, not
 * against a chosen threshold: what matters is what share of filings has at least
 * one.
 */
const { rows: conc } = await query<{
  issuances_with: string; issuances_total: string; top5: string; median: string;
}>(
  `WITH per_filing AS (
     SELECT l.accession, count(*) FILTER (WHERE ${EMPTY}) AS empty
       FROM corpus.loans l GROUP BY 1
   )
   SELECT count(*) FILTER (WHERE empty > 0)::text AS issuances_with,
          count(*)::text                          AS issuances_total,
          (SELECT sum(empty) FROM (
             SELECT empty FROM per_filing ORDER BY empty DESC LIMIT 5) t)::text AS top5,
          (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY empty)
             FROM per_filing WHERE empty > 0)::text AS median
     FROM per_filing`,
);
const withAny = Number(conc[0]!.issuances_with);
const totalIssuances = Number(conc[0]!.issuances_total);
const top5 = Number(conc[0]!.top5);

console.log(`  \x1b[1mConcentration\x1b[0m`);
console.log(
  `    ${withAny} of ${totalIssuances} issuances (${((withAny / totalIssuances) * 100).toFixed(0)}%) have at least one`,
);
console.log(
  `    the worst 5 account for ${top5} of ${empty} (${((top5 / empty) * 100).toFixed(0)}%)` +
    `  ·  median per affected issuance: ${conc[0]!.median}`,
);

const spread = withAny / totalIssuances >= 0.5 && top5 / empty <= 0.35;
const piled = top5 / empty >= 0.5;
console.log(
  spread
    ? `    \x1b[32m→ spread out: consistent with portfolios, not with a format defect\x1b[0m`
    : piled
      ? `    \x1b[33m→ piled up: a few issuances account for most of it — see which ones below\x1b[0m`
      : `    \x1b[33m→ mixed: neither spread nor concentrated, probably both at once\x1b[0m`,
);

/**
 * The direct test. If they are portfolios, `property_count > 1`; and the city
 * has to be missing too, because a portfolio across five states does not have
 * one city either.
 *
 * The deciding row is the last one: an empty state WITH a city present cannot be
 * a portfolio. That is the parser losing a column.
 */
const { rows: ev } = await query<Record<string, string>>(
  `SELECT count(*)::text                                                    AS n,
          count(pc.value) FILTER (WHERE pc.value::numeric > 1)::text        AS multi,
          count(pc.value)::text                                             AS with_count,
          count(*) FILTER (WHERE l.city IS NULL OR btrim(l.city) = '')::text AS without_city,
          count(*) FILTER (WHERE l.city IS NOT NULL AND btrim(l.city) <> '')::text AS with_city,
          count(*) FILTER (WHERE lower(btrim(coalesce(l.city, ''))) LIKE 'various%')::text AS city_various,
          count(*) FILTER (WHERE l.property_type IS NULL)::text             AS without_type
     FROM corpus.loans l
     LEFT JOIN corpus.facts pc
            ON pc.loan_id = l.id AND pc.metric_key = 'property_count'
           AND pc.value ~ '^[0-9.]+$'
    WHERE ${EMPTY}`,
);
const e = ev[0]!;
const line = (label: string, n: string, over = empty) =>
  console.log(
    `    ${label.padEnd(34)} ${String(n).padStart(5)}  ` +
      `\x1b[90m${((Number(n) / over) * 100).toFixed(0)}%\x1b[0m`,
  );

console.log(`\n  \x1b[1mWhat those loans have\x1b[0m`);
line("have property_count", e.with_count!);
line("property_count > 1 (multi-property)", e.multi!);
line("have no city either", e.without_city!);
line("city says 'Various'", e.city_various!);
line("have no property type either", e.without_type!);
console.log(
  `\n    \x1b[1mhave a city but no state: ${e.with_city}\x1b[0m` +
    `  \x1b[90m← a multi-state portfolio cannot have ONE city;\x1b[0m`,
);
console.log(`    \x1b[90m   these are the parser losing the column, not the market\x1b[0m`);

/**
 * THE BLIND SPOT IN THE DISCRIMINATOR ABOVE.
 *
 * "Spread across 214 of 233 issuances" rules out ONE broken issuance explaining
 * everything. It does not rule out a broken YEAR: if the 2020 format loses the
 * column, all forty 2020 issuances have it and the spread looks just as healthy.
 *
 * The first run showed seven of the eight worst issuances in 2020, and my test
 * was not looking at that. So the rate is measured by year.
 */
const { rows: years } = await query<{ year: string; empty: string; of: string; issuances: string }>(
  `SELECT to_char(f.filed_at, 'YYYY') AS year,
          count(*) FILTER (WHERE ${EMPTY})::text AS empty,
          count(*)::text                          AS of,
          count(DISTINCT l.accession)::text       AS issuances
     FROM corpus.loans l JOIN corpus.filings f ON f.accession = l.accession
    GROUP BY 1 ORDER BY 1`,
);
console.log(`\n  \x1b[1mRate by issuance year\x1b[0m`);
const rates = years.map((a) => Number(a.empty) / Math.max(1, Number(a.of)));
const meanRate = rates.reduce((t, v) => t + v, 0) / Math.max(1, rates.length);
for (const [i, a] of years.entries()) {
  const t = rates[i]!;
  /** Twice the mean is arbitrary, but it is stated rather than hidden. */
  const high = t >= meanRate * 2;
  const bar = "█".repeat(Math.round(t * 60));
  console.log(
    `    ${a.year}  ${String(a.empty).padStart(4)} of ${String(a.of).padStart(5)}` +
      `  ${(t * 100).toFixed(1).padStart(5)}%  ${high ? "\x1b[33m" : "\x1b[90m"}${bar}\x1b[0m` +
      (high ? `  \x1b[33m← more than twice the mean (${(meanRate * 100).toFixed(1)}%)\x1b[0m` : ""),
  );
}

/**
 * THE DECIDING QUERY.
 *
 * For each issuance with many empties: do those loans have `property_count > 1`?
 *
 * If they do, they are genuine portfolios and the high rate belongs to the
 * issuance, not the parser. If they do NOT, the Annex A carries the datum and we
 * lost it.
 *
 * It is the same question the aggregate already answered at 74%, but asked where
 * the aggregate cannot: in the tail. A healthy average coexists with one broken
 * issuance.
 */
const { rows: worst } = await query<{
  company: string; accession: string; n: string; of: string; multi: string;
}>(
  `SELECT f.company_name AS company, l.accession,
          count(*) FILTER (WHERE ${EMPTY})::text AS n,
          count(*)::text                          AS of,
          count(*) FILTER (WHERE ${EMPTY} AND pc.value IS NOT NULL
                             AND pc.value::numeric > 1)::text AS multi
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.facts pc
            ON pc.loan_id = l.id AND pc.metric_key = 'property_count'
           AND pc.value ~ '^[0-9.]+$'
    GROUP BY 1, 2 HAVING count(*) FILTER (WHERE ${EMPTY}) > 0
    ORDER BY count(*) FILTER (WHERE ${EMPTY}) DESC LIMIT 10`,
);
console.log(`\n  \x1b[1mIssuances with the most empties — and whether those loans are portfolios\x1b[0m`);
let suspicious = 0;
for (const p of worst) {
  const n = Number(p.n);
  const multi = Number(p.multi);
  const share = multi / Math.max(1, n);
  /**
   * If fewer than half of an issuance's empties have property_count > 1, the
   * portfolio explanation does not cover that issuance.
   */
  const isSuspicious = share < 0.5;
  if (isSuspicious) suspicious++;
  console.log(
    `    ${p.company.slice(0, 40).padEnd(42)} ${String(n).padStart(3)}/${String(p.of).padEnd(3)}` +
      `  \x1b[${isSuspicious ? "33" : "32"}m${multi} are portfolios (${(share * 100).toFixed(0)}%)\x1b[0m` +
      ` \x1b[90m${p.accession}\x1b[0m`,
  );
}

console.log(
  suspicious === 0
    ? `\n  \x1b[32mNo issuance in the tail is explained by the parser: they are all portfolios.\x1b[0m`
    : `\n  \x1b[33m${suspicious} issuance(s) where most of the empties are NOT portfolios.\x1b[0m\n` +
        `  \x1b[33mThere the Annex A carries the state and we are losing it.\x1b[0m`,
);

/**
 * THE TWO POPULATIONS, WHICH IS THE REAL ANSWER.
 *
 * The previous run gave 585 of 790 with `property_count > 1` and the ten tail
 * issuances at 0%. That is not a contradiction: they are two different groups
 * added together.
 *
 *   with property_count  → multi-property portfolio. The Annex A says how many
 *                          properties there are and gives no state because there
 *                          is not ONE. The datum is not missing: it does not
 *                          exist.
 *
 *   without property_count → we do not even know how many properties it has. If
 *                          it is also missing the type, we did not lose a
 *                          column: we lost the whole property characteristics
 *                          block.
 *
 * The confirmation is whether the two gaps coincide on the same rows. If the 205
 * without a count are nearly the same as those without a type, the
 * `property_type` gap —item #37— and this one are THE SAME DEFECT seen from two
 * sides, and fixing it counts twice.
 */
const { rows: pop } = await query<Record<string, string>>(
  `WITH v AS (
     SELECT l.id, l.accession, l.property_type,
            (SELECT value FROM corpus.facts
              WHERE loan_id = l.id AND metric_key = 'property_count'
                AND value ~ '^[0-9.]+$' LIMIT 1) AS pc
       FROM corpus.loans l WHERE ${EMPTY}
   )
   SELECT count(*) FILTER (WHERE pc IS NOT NULL)::text                          AS portfolio,
          count(*) FILTER (WHERE pc IS NULL)::text                              AS blind,
          count(*) FILTER (WHERE pc IS NULL AND property_type IS NULL)::text     AS blind_without_type,
          count(*) FILTER (WHERE pc IS NOT NULL AND property_type IS NULL)::text AS portfolio_without_type,
          count(DISTINCT accession) FILTER (WHERE pc IS NULL)::text              AS blind_issuances
     FROM v`,
);
const b = pop[0]!;
const blind = Number(b.blind);
console.log(`\n  \x1b[1mThe two populations\x1b[0m`);
console.log(
  `    \x1b[32m${b.portfolio} multi-property portfolios\x1b[0m` +
    `  \x1b[90m— the Annex A says how many properties; there is no ONE state to put\x1b[0m`,
);
console.log(
  `    \x1b[33m${blind} with no property count\x1b[0m` +
    `  \x1b[90m— across ${b.blind_issuances} issuances; of those, ${b.blind_without_type} have no type either\x1b[0m`,
);
const overlap = Number(b.blind_without_type) / Math.max(1, blind);
console.log(
  overlap >= 0.8
    ? `\n  \x1b[33m${(overlap * 100).toFixed(0)}% of the blind ones have no type either: we did not lose a\x1b[0m\n` +
        `  \x1b[33mcolumn, we lost the whole characteristics block. This gap and the\x1b[0m\n` +
        `  \x1b[33mproperty_type one (#37) are the same defect from two sides.\x1b[0m`
    : `\n  \x1b[90mOnly ${(overlap * 100).toFixed(0)}% of the blind ones also lack a type: the two gaps\x1b[0m\n` +
        `  \x1b[90mdo not coincide, so they are different defects and need attacking separately.\x1b[0m`,
);

/**
 * WHAT WE DISCARD AT HARVEST TIME, WHICH IS WHERE THE MISSING GEOGRAPHY IS.
 *
 * I said out loud that portfolios "cannot be fixed by harvesting" because the
 * Annex A carries no state for them. That is false, and it is worth writing
 * down.
 *
 * The Annex A carries TWO kinds of row: one per loan and one per property
 * securing it. A loan over five properties has its row with the balance and five
 * more rows with the address, city and state of each. The harvester classifies,
 * keeps the loan rows and discards the property rows — in the Benchmark 2020-B16
 * fixture that is 50 discarded against 33 loans.
 *
 * So the state of the 585 portfolios is not missing from the document. We have
 * it in front of us and we throw it away. And there was no table to put it in:
 * the schema had filings, loans, observations, facts, performance, delinquency
 * and unmapped_cells, and none for properties.
 *
 * HOW IT IS MEASURED, AND A PROXY THAT MEASURED NOTHING
 *
 * The first version estimated it by subtraction over `stats`: data rows minus
 * stored loans. It gave ~0 and for a moment I believed it.
 *
 * It was wrong by construction. `keepLoanRows` runs in `batch.ts` BEFORE
 * `rowsToObservations`, so `dataRows` already counts only the rows that survived
 * the filter. The subtraction measured the subtotals that fall away afterwards,
 * not the properties. A number with two decimals of confidence about the wrong
 * question, which nearly closed a line of investigation that was correct.
 *
 * Now the harvester records it properly in `stats.propertyRowsDropped`. The 233
 * already-harvested issuances do not have it, so until the next harvest this
 * shows the bound derived from the three fixtures —138 property rows over 84
 * loans— and says that it is an extrapolation.
 */
const { rows: disc } = await query<{ with_count: string; dropped: string; of: string }>(
  `SELECT count(*) FILTER (WHERE stats->>'propertyRowsDropped' IS NOT NULL)::text AS with_count,
          coalesce(sum((stats->>'propertyRowsDropped')::int), 0)::text            AS dropped,
          count(*)::text                                                          AS of
     FROM corpus.filings`,
);
const d = disc[0]!;
console.log(`\n  \x1b[1mProperty rows discarded at harvest time\x1b[0m`);
if (Number(d.with_count) === 0) {
  /** 138 property rows over 84 loans across the three fixtures = 1.64 per loan. */
  const FIXTURE_RATIO = 138 / 84;
  const est = Math.round(Number(tot[0]!.total) * FIXTURE_RATIO);
  console.log(
    `    none of the ${d.of} issuances records the count — they were harvested before we measured it`,
  );
  console.log(
    `    \x1b[33m~${est.toLocaleString("en-US")} rows estimated\x1b[0m` +
      `  \x1b[90mextrapolating 1.64 per loan from the three fixtures\x1b[0m`,
  );
  console.log(
    `    \x1b[90mit is an extrapolation from 3 documents to 233: good enough to decide\x1b[0m`,
  );
  console.log(`    \x1b[90mwhether measuring it properly is worth it, not to quote\x1b[0m`);
} else {
  console.log(
    `    \x1b[1m${Number(d.dropped).toLocaleString("en-US")} rows\x1b[0m across ${d.with_count} of ${d.of} issuances` +
      ` \x1b[90m(the rest were harvested before we measured it)\x1b[0m`,
  );
}
console.log(
  `    \x1b[90meach carries the address, city and state of ONE property: that is where\x1b[0m`,
);
console.log(
  `    \x1b[90mthe geography of the ${b.portfolio} portfolios is\x1b[0m`,
);

console.log(
  `\n  \x1b[90mA portfolio of five properties in Texas DOES have a state, and today it does\x1b[0m`,
);
console.log(
  `  \x1b[90mnot appear in a query for Texas. That is not the market: it is the schema.\x1b[0m\n`,
);

await closePool();

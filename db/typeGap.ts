/**
 * The loans with no property type: what they are, before deciding what to do.
 *
 *   npm run db:type-gap
 *
 * WHY NOW, AND WHY IT STARTS BY LOOKING RATHER THAN FIXING
 *
 * The product index shows fifteen rows reading "34/35": loans that exist in the
 * issuance and do not enter the composition measurement because they have no
 * type. It stopped being backlog debt and became a column on the face of the
 * product.
 *
 * The temptation is to write the fix directly —fill the type in from another
 * column— but which "other column" depends on WHY it is missing, and there are at
 * least four possible reasons that call for different fixes:
 *
 *   1. The loan has several properties of different types. The Annex A puts
 *      "Various" in the loan row and the real type in the property rows, which
 *      the harvester discards. Here there is NO type to recover: the loan
 *      genuinely does not have one, and the right answer may be a "Various"
 *      category rather than a null.
 *   2. The issuance uses a header the mapping does not recognise. That is fixed
 *      in the taxonomy and recovers every loan of that issuance at once.
 *   3. The cell is empty in the document. There is nothing to be done.
 *   4. The value exists but falls into the CASE's 'Unclassified'. That is not
 *      this script —those loans DO have a property_type— but it is worth counting
 *      alongside because the two are easy to confuse when reading.
 *
 * All four look different in the data and the fix for one does not help the
 * others. So first we look.
 *
 * THE HYPOTHESIS I HOLD, WRITTEN DOWN BEFORE THE RESULT
 *
 * That they are multi-property. Seventeen loans spread across fifteen issuances
 * —nearly one per issuance, concentrating in none— does not look like an unmapped
 * header: that would give you all the loans of one or two issuances together. A
 * rare phenomenon spread evenly across documents looks more like a property of
 * the loan than a defect of the parser.
 *
 * If that is it, the fix is NOT to fill in the datum: it is to stop counting them
 * as absent. And then the product question becomes whether "Various" is a
 * composition category or a row of its own.
 *
 * WHAT IT GAVE, AND WHERE THE HYPOTHESIS FALLS SHORT
 *
 * For 2026 it was entirely right: all 17 are portfolios, every one with two or
 * more properties and with names that say so —"ExchangeRight 75", "Patoma
 * Partners 4-Pack", "Mountain Industrial Portfolio" with ninety. None has an
 * unmapped type column.
 *
 * But the whole corpus is 362 loans, not 17. I was looking at one cohort and
 * talking about the corpus, which is the unit-of-analysis error all over again.
 *
 * And over those 362 the hypothesis explains most but not all:
 *
 *   212 of 362 (59%) have property_count > 1 — multi-property confirmed
 *   253 of 362 (70%) are called Various or Portfolio
 *   but 2020 has 121 of 1,430 (8.5%), four times the rate of the rest, and one
 *   single issuance concentrates 19
 *
 * An issuance with 19 loans lacking a type is NOT multi-property: it is a header
 * the mapping does not recognise. So there are two populations and only one of
 * them is the one I described.
 *
 * The cut that separates them is added below, rather than writing a fix that
 * addresses the one I already understood and leaves the other where it is.
 *
 * AND A TEST THAT COULD NOT FAIL, WRITTEN RIGHT HERE
 *
 * The first version of that cut looked for the unmapped header in
 * `corpus.unmapped_cells`. That table has `value_num NUMERIC NOT NULL` and the
 * harvester does `if (value === null) continue`: only what parses as a number
 * gets in. A property type is text, so it can NEVER be there.
 *
 * So the query always returned empty, and that emptiness read as "the Annex A
 * does not publish the column" when it actually meant "we cannot know this way".
 * The opposite conclusion to the true one, in the script whose only purpose was
 * to distinguish the two populations.
 *
 * The correct source is `corpus.filings.columns_unmapped`, which stores the
 * header names at the mapping stage, before it matters whether the value is text
 * or a number.
 *
 * AND WITH THE RIGHT SOURCE, THREE POPULATIONS APPEARED, NOT TWO
 *
 * The `~* 'type|property'` filter I used was far too wide and produced three
 * false leads in a row. None of these headers is a property type:
 *
 *   "Title Type"           — fee versus leasehold: the interest in the land.
 *   "Appraised Value Type" — as-is versus as-stabilized: what the appraisal assumes.
 *   "Footnotes (for Loan and Property Information)" — footnotes.
 *
 * They appear in almost every issuance because they are ordinary columns the
 * mapping does not use, not because they have anything to do with the gap. A
 * substring filter finds whatever contains the word, and "type" appears in half a
 * dozen different concepts in an Annex A.
 *
 * What DID appear, in GS 2020 and Benchmark 2020-B21 —the two concentrating 19
 * and 17— is something else:
 *
 *   "Loan / Property Flag Loan Property"
 *   "Property Name Dearborn Flex P..."
 *
 * That is not a header: it is a header with the first data row glued inside it.
 * It is task #48, and it explains why the type column does not map in those
 * issuances either — their header is corrupted too.
 *
 * And a third remains that is neither: BBCMS 2022-C17 with 8 of 8 loans lacking a
 * type, no unmapped headers and no "Various" names. It is the issuance of task
 * #40, already open for having 39 observations.
 *
 *   population 1  multi-property portfolios   ~70%   nothing to recover
 *   population 2  headers with glued-in data          task #48
 *   population 3  BBCMS 2022-C17                      task #40
 *
 * Three causes, three fixes, and the first diagnosis had them as one.
 */

import { closePool, ping, query } from "./client.js";
import { METRIC_SPECS, scoreHeader } from "../harvest/normalize/columnMap.js";
import { corpusState, provenanceStamp } from "./provenance.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const num = (v: number) => v.toLocaleString("en-US");

console.log(`\n${"═".repeat(78)}`);
console.log("Loans with no property type");
console.log(`${"═".repeat(78)}`);

// ---------------------------------------------------------------------------
// 1. How many there are, and whether they concentrate anywhere
// ---------------------------------------------------------------------------

const { rows: byVintage } = await query<{
  vintage: string; loans: string; no_type: string; issuances: string; iss_with_gap: string;
}>(
  `SELECT extract(year FROM f.filed_at)::int::text AS vintage,
          count(*)::text AS loans,
          count(*) FILTER (WHERE l.property_type IS NULL)::text AS no_type,
          count(DISTINCT l.accession)::text AS issuances,
          count(DISTINCT l.accession) FILTER (WHERE l.property_type IS NULL)::text AS iss_with_gap
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
    GROUP BY 1 ORDER BY 1`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("By vintage");
console.log(`${"─".repeat(78)}\n`);
console.log(`  vintage    loans   no type      %      issuances with a gap`);
console.log(`  ${"─".repeat(62)}`);
let totalMissing = 0;
let total = 0;
for (const r of byVintage) {
  const missing = Number(r.no_type), n = Number(r.loans);
  totalMissing += missing;
  total += n;
  console.log(
    `  ${r.vintage}   ${num(n).padStart(9)} ${String(missing).padStart(10)} ${pct(missing / Math.max(1, n), 1).padStart(7)}` +
      `      ${r.iss_with_gap} de ${r.issuances}` +
      (missing / Math.max(1, n) > 0.05 ? `  \x1b[33m← concentrado\x1b[0m` : ""),
  );
}
console.log(
  `\n  \x1b[1m${totalMissing} of ${num(total)} loans\x1b[0m (${pct(totalMissing / Math.max(1, total), 2)}) have no type across the whole corpus.`,
);

/**
 * The shape decides the diagnosis.
 *
 * If the gaps pile up in a few issuances, it is an unmapped header and it is
 * fixed in the taxonomy. If they are spread one at a time, it is a property of
 * the loan and the taxonomy has nothing to do with it.
 */
const { rows: shape } = await query<{ per_issuance: string; issuances: string; max_in_one: string }>(
  `WITH x AS (
     SELECT accession, count(*) FILTER (WHERE property_type IS NULL) AS no_type,
            count(*) AS n
       FROM corpus.loans GROUP BY accession
   )
   SELECT round(avg(no_type) FILTER (WHERE no_type > 0), 2)::text AS per_issuance,
          count(*) FILTER (WHERE no_type > 0)::text AS issuances,
          max(no_type)::text AS max_in_one
     FROM x`,
);
const f0 = shape[0]!;
console.log(
  `  \x1b[90mSpread across ${f0.issuances} issuances, ${f0.per_issuance} per issuance on average, ` +
    `${f0.max_in_one} in the worst.\x1b[0m`,
);
console.log(
  Number(f0.max_in_one) <= 3
    ? `  \x1b[90mNo issuance concentrates them: it does not look like an unmapped header.\x1b[0m`
    : `  \x1b[33mSome issuance concentrates ${f0.max_in_one}: there it may well be the mapping.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 2. What IS known about those loans
// ---------------------------------------------------------------------------

/**
 * `property_count` is the direct test of the multi-property hypothesis, and
 * `property_name` the indirect one: Annex A documents write "Various" or list
 * several.
 */
const { rows: whatIsKnown } = await query<{
  total: string; with_count: string; multi: string; name_various: string;
  with_detail: string; with_units: string; with_dscr: string;
}>(
  `WITH missing AS (SELECT id, property_name FROM corpus.loans WHERE property_type IS NULL)
   SELECT count(*)::text AS total,
          count(pc.value)::text AS with_count,
          count(*) FILTER (WHERE pc.value ~ '^[0-9.]+$' AND pc.value::numeric > 1)::text AS multi,
          count(*) FILTER (WHERE s.property_name ~* 'various|portfolio')::text AS name_various,
          count(pd.value)::text AS with_detail,
          count(un.value)::text AS with_units,
          count(ds.value)::text AS with_dscr
     FROM missing s
     LEFT JOIN corpus.facts pc ON pc.loan_id = s.id AND pc.metric_key = 'property_count'
     LEFT JOIN corpus.facts pd ON pd.loan_id = s.id AND pd.metric_key = 'property_type_detailed'
     LEFT JOIN corpus.facts un ON un.loan_id = s.id AND un.metric_key = 'units'
     LEFT JOIN corpus.facts ds ON ds.loan_id = s.id AND ds.metric_key = 'dscr'`,
);
const q = whatIsKnown[0]!;

console.log(`\n${"─".repeat(78)}`);
console.log("What is known about the loans with no type");
console.log(`${"─".repeat(78)}\n`);
const line = (et: string, v: string, nota = "") =>
  console.log(
    `  ${et.padEnd(34)} ${String(v).padStart(5)} de ${q.total}` +
      `  ${pct(Number(v) / Math.max(1, Number(q.total)), 0).padStart(6)}   \x1b[90m${nota}\x1b[0m`,
  );
line("have property_count", q.with_count);
line("...and it is greater than 1", q.multi, "← multi-property: they have no ONE type");
line("are called Various / Portfolio", q.name_various, "the clue in the name");
line("have property_type_detailed", q.with_detail, "← if they do, it can be derived");
line("have units", q.with_units, "the rest of the parsing worked");
line("have dscr", q.with_dscr, "they are not phantom rows");

/**
 * The distinction that decides the fix: a multi-property loan has no type to
 * recover, and a single-property loan without a type genuinely lost it.
 */
console.log(
  `\n  \x1b[90mA loan with several properties does not HAVE a type — the Annex A writes\x1b[0m`,
);
console.log(
  `  \x1b[90m"Various" and the types live in the property rows, which get discarded.\x1b[0m`,
);
console.log(
  `  \x1b[90mThere the fix is not to fill the datum in: it is to stop counting it as absent.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 3. The rows, one by one — there are seventeen
// ---------------------------------------------------------------------------

const { rows: detail } = await query<{
  issuance: string; loan_ref: string | null; name: string | null;
  count: string | null; detail: string | null; unmapped: string | null;
}>(
  `SELECT f.company_name AS issuance, l.loan_ref, l.property_name AS name,
          pc.value AS count, pd.value AS detail,
          (SELECT string_agg(h, ' · ')
             FROM jsonb_array_elements_text(f.columns_unmapped) AS h
            WHERE h ~* '(property|asset|collateral|general)\\s*type'
              AND h !~* 'title|appraised|footnote') AS unmapped
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
     LEFT JOIN corpus.facts pc ON pc.loan_id = l.id AND pc.metric_key = 'property_count'
     LEFT JOIN corpus.facts pd ON pd.loan_id = l.id AND pd.metric_key = 'property_type_detailed'
    WHERE l.property_type IS NULL
      AND extract(year FROM f.filed_at) = extract(year FROM now())
    ORDER BY f.company_name, l.row_index`,
);

console.log(`\n${"─".repeat(78)}`);
console.log(`The rows of the current cohort — ${detail.length}`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  issuance                       ref     props   name / subtype`);
console.log(`  ${"─".repeat(72)}`);
for (const r of detail) {
  console.log(
    `  ${(r.issuance ?? "").slice(0, 30).padEnd(31)} ${(r.loan_ref ?? "—").slice(0, 6).padEnd(7)} ` +
      `${(r.count ?? "—").padStart(5)}   ` +
      `\x1b[90m${(r.detail ?? r.name ?? "(no name)").slice(0, 34)}\x1b[0m`,
  );
  if (r.unmapped) {
    console.log(`  \x1b[33m      unmapped columns containing 'type': ${r.unmapped.slice(0, 60)}\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// 4. The other gap, which gets confused with this one
// ---------------------------------------------------------------------------

/**
 * 'Unclassified' is NOT the same as having no type.
 *
 * Those loans do have a property_type and the CASE does not recognise it, so they
 * enter the composition as a category of their own and pollute the distance
 * without warning. It is counted alongside because the two read identically on
 * the page.
 */
const { rows: unclassified } = await query<{ type: string; n: string }>(
  `SELECT l.property_type AS type, count(*)::text AS n
     FROM corpus.loans l
    WHERE l.property_type IS NOT NULL
      AND l.property_type !~* 'multifamily|cooperative|garden|low rise|mid rise|student'
      AND l.property_type !~* 'retail|anchored|single tenant'
      AND l.property_type !~* 'office|cbd|suburban|medical'
      AND l.property_type !~* 'industrial|warehouse|flex'
      AND l.property_type !~* 'storage'
      AND l.property_type !~* 'hospitality|hotel|service|extended stay'
      AND l.property_type !~* 'mixed'
      AND l.property_type !~* 'manufactured'
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 15`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("And the other gap: they have a type, but the CASE does not recognise it");
console.log(`${"─".repeat(78)}\n`);
if (unclassified.length === 0) {
  console.log(`  \x1b[32mNone. Every value falls into some category.\x1b[0m`);
} else {
  const totalUnclassified = unclassified.reduce((t, r) => t + Number(r.n), 0);
  for (const r of unclassified) {
    console.log(`  ${r.type.slice(0, 44).padEnd(46)} ${String(r.n).padStart(5)}`);
  }
  console.log(
    `\n  \x1b[33m${totalUnclassified} loans enter the composition as 'Unclassified'.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mThey are not a gap: they are a category that exists and nobody decided on.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mIt adds to the distance like any other, so two issuances with many of these\x1b[0m`,
  );
  console.log(`  \x1b[90mlook alike for a reason that is not about the business.\x1b[0m`);
}

/**
 * WHY A HEADER DOES NOT MAP, USING THE REAL MAPPER.
 *
 * Reasoning about the pattern by reading it is no use: `scoreHeader` returns 0
 * both when no pattern matches and when an `exclude` blocked it, and those two
 * call for opposite fixes. The real function is run against the real header and
 * it reports which of the two happened.
 *
 * The suspicion, written before running it: the `exclude` patterns are unanchored
 * substrings. `property_type` excludes /sub/i so as not to swallow "Subordinate",
 * and that also kills any header containing "Suburban" — which is an office
 * subtype and appears as a VALUE when the data row ended up glued to the header.
 * It already happened once in this file with /per\s*\/ matching "per" inside
 * "Property".
 */
function whyItDoesNotMap(header: string): string {
  const clean = header.replace(/\s+/g, " ").trim();
  const spec = METRIC_SPECS.find((m) => m.key === "property_type");
  if (!spec) return "\x1b[90m      (the property_type metric does not exist)\x1b[0m";

  const blocker = spec.exclude?.find((re) => re.test(clean));
  if (blocker) {
    const m = clean.match(blocker);
    return (
      `\x1b[31m      blocked by the exclude ${String(blocker)} — matches "${m?.[0]}"\x1b[0m` +
      `\n  \x1b[90m      the pattern is unanchored, so it matches inside a word\x1b[0m`
    );
  }
  const s = scoreHeader(clean, spec);
  if (s > 0) {
    return `\x1b[33m      maps with score ${s.toFixed(2)} — another metric or column took it\x1b[0m`;
  }
  return `\x1b[90m      no pattern matches: it needs adding to the taxonomy\x1b[0m`;
}

// ---------------------------------------------------------------------------
// 5. The issuances that CONCENTRATE: there it is not multi-property
// ---------------------------------------------------------------------------

/**
 * The second population, which the hypothesis does not explain.
 *
 * A single loan without a type in an issuance is a portfolio. Nineteen in the
 * same issuance is not: that is a column the mapping did not recognise, and it is
 * fixed in the taxonomy, recovering all of them at once.
 *
 * The evidence is in `filings.columns_unmapped`: if that issuance has an unmapped
 * header containing "type" or "property", the diagnosis is closed. If it does
 * not, the Annex A does not publish the column and there is nothing to recover.
 *
 * NOT in `unmapped_cells`, which was the first attempt: that table only stores
 * numeric cells, so looking for a text column there is a query that returns empty
 * by construction.
 */
const { rows: concentrated } = await query<{
  issuance: string; vintage: string; n: string; no_type: string;
  various: string; with_count: string; headers: string | null; glued: string | null;
}>(
  `WITH x AS (
     SELECT l.accession, f.company_name AS issuance,
            extract(year FROM f.filed_at)::int AS vintage,
            count(*) AS n,
            count(*) FILTER (WHERE l.property_type IS NULL) AS no_type,
            count(*) FILTER (WHERE l.property_type IS NULL
                               AND l.property_name ~* 'various|portfolio') AS various
       FROM corpus.loans l
       JOIN corpus.filings f ON f.accession = l.accession
      GROUP BY 1, 2, 3
   )
   SELECT x.issuance, x.vintage::text, x.n::text, x.no_type::text, x.various::text,
          (SELECT count(*)::text FROM corpus.loans l2
             JOIN corpus.facts pc ON pc.loan_id = l2.id AND pc.metric_key = 'property_count'
            WHERE l2.accession = x.accession AND l2.property_type IS NULL) AS with_count,
          (SELECT string_agg(h, ' · ')
             FROM corpus.filings f2,
                  LATERAL jsonb_array_elements_text(f2.columns_unmapped) AS h
            WHERE f2.accession = x.accession
              AND h ~* '(property|asset|collateral|general)\\s*type'
              AND h !~* 'title|appraised|footnote') AS headers,
          (SELECT string_agg(h, ' § ')
             FROM corpus.filings f3,
                  LATERAL jsonb_array_elements_text(f3.columns_unmapped) AS h
            WHERE f3.accession = x.accession
              AND (length(h) > 45 OR h ~ '[0-9]{3}')) AS glued
     FROM x
    WHERE x.no_type >= 5
    ORDER BY x.no_type DESC LIMIT 12`,
);

console.log(`\n${"─".repeat(78)}`);
console.log("The issuances that concentrate — there the diagnosis is different");
console.log(`${"─".repeat(78)}\n`);
if (concentrated.length === 0) {
  console.log(`  \x1b[32mNo issuance reaches 5 loans without a type.\x1b[0m`);
} else {
  console.log(`  issuance                        vintage   no type / pool   "Various"   with count`);
  console.log(`  ${"─".repeat(76)}`);
  for (const r of concentrated) {
    const missing = Number(r.no_type), n = Number(r.n), vv = Number(r.various);
    console.log(
      `  ${r.issuance.slice(0, 30).padEnd(32)} ${r.vintage}   ${String(missing).padStart(6)} / ${String(n).padEnd(5)}` +
        `  ${String(vv).padStart(7)}   ${String(r.with_count).padStart(7)}` +
        (vv / Math.max(1, missing) < 0.5 ? `  \x1b[33m← these are not portfolios\x1b[0m` : ""),
    );
    if (r.headers) {
      for (const h of r.headers.split(" § ")) {
        console.log(`  \x1b[32m    header: ${h.slice(0, 100)}\x1b[0m`);
        console.log(`  ${whyItDoesNotMap(h)}`);
      }
    }
    /**
     * The signature of task #48: a header longer than 45 characters or with three
     * consecutive digits is not a header, it is one with data glued inside. If the
     * block's header is corrupted, the type column does not map either.
     */
    if (r.glued) {
      console.log(`  \x1b[33m    headers with glued-in data (#48): ${r.glued.slice(0, 56)}\x1b[0m`);
    }
  }
  console.log(
    `\n  \x1b[90mThree populations, three fixes. Multi-property portfolios: nothing to\x1b[0m`,
  );
  console.log(
    `  \x1b[90mrecover, a "Various" category is needed. Headers with glued-in data: that\x1b[0m`,
  );
  console.log(
    `  \x1b[90mis task #48 and fixing it recovers the whole issuance. And BBCMS 2022-C17,\x1b[0m`,
  );
  console.log(
    `  \x1b[90mwhich is neither and was already open as #40.\x1b[0m`,
  );
  console.log(
    `\n  \x1b[90m"Title Type" and "Appraised Value Type" are NOT property types — they are\x1b[0m`,
  );
  console.log(
    `  \x1b[90mfee vs leasehold and as-is vs as-stabilized. The earlier filter surfaced them.\x1b[0m`,
  );
}

const state = await corpusState();
await closePool();
console.log(`\n\x1b[90m  ${provenanceStamp(state)}\x1b[0m\n`);

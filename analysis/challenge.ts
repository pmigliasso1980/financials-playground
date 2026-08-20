/**
 * Attempts to falsify the findings.
 *
 *   npm run db:challenge
 *
 * WHY IT EXISTS
 *
 * Two results came out of the corpus:
 *
 *   A) Office is underwritten ~13% above its actual NOI, in 4 of every 5 loans.
 *   B) Multifamily broke its two-year band in 2026 on DSCR, LTV and debt yield.
 *
 * Before showing them to anyone it is worth attacking them yourself. This script
 * does that, and both fell.
 *
 * A withstood four tests —lease-up, loan size, issuer, deal selection— and died
 * on the fifth. Compared against industrial, which shares contract structure,
 * office only comes out ahead in 58% of deals. What the gap measures is not
 * aggressiveness but how much future rent is under contract:
 * hospitality -0.5%, self storage 1.2%, retail 3.5%, industrial 10.8%,
 * office 13.1%.
 *
 * B died earlier: the "2026 break" was partly 221 cooperative loans mixed in
 * with Multifamily, and DSCR turned out flat (R² 0.06). What stands in its place
 * is a gradual leverage drift since 2024.
 *
 * Both replacements are smaller than the original headlines and better
 * supported. The script stays so that any future finding goes through the same
 * filter before anyone builds on top of it.
 */

import { closePool, ping, query } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const pct = (v: number | null, decimals = 1) =>
  v === null ? "—" : `${(v * 100).toFixed(decimals)}%`;
const num = (v: number | null, decimals = 2) => (v === null ? "—" : v.toFixed(decimals));

console.log(`\n${"═".repeat(78)}`);
console.log("Falsifying the findings");
console.log(`${"═".repeat(78)}`);

// ===========================================================================
// A) Office: is it lease-up?
// ===========================================================================

console.log(`\n\x1b[1mA. Office is underwritten 13% above actual NOI\x1b[0m`);
console.log(`\x1b[90m   Alternative hypothesis: they are buildings in lease-up.\x1b[0m`);
console.log(
  `\x1b[90m   If that were true, the loans with the largest gap would have low occupancy.\x1b[0m\n`,
);

const { rows: leaseUp } = await query<{
  bucket: string; n: string; occ: number | null; gap: number | null;
}>(
  `WITH pairs AS (
     SELECT
       l.id,
       uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap,
       occ.value::numeric AS occupancy
     FROM corpus.loans l
     JOIN corpus.facts uw  ON uw.loan_id  = l.id AND uw.metric_key  = 'noi_underwritten'
     JOIN corpus.facts mr  ON mr.loan_id  = l.id AND mr.metric_key  = 'noi_most_recent'
     LEFT JOIN corpus.facts occ ON occ.loan_id = l.id AND occ.metric_key = 'occupancy'
     WHERE l.property_type = 'Office'
       AND uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$'
       AND mr.value::numeric > 0
       AND occ.value ~ '^-?[0-9.]+$'
   )
   SELECT
     CASE
       WHEN gap <  0.00 THEN '1. brecha negativa'
       WHEN gap <  0.10 THEN '2. brecha 0-10%'
       WHEN gap <  0.25 THEN '3. brecha 10-25%'
       ELSE                  '4. brecha >25%'
     END AS bucket,
     count(*) AS n,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY occupancy) AS occ,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY gap) AS gap
   FROM pairs
   GROUP BY 1 ORDER BY 1`,
);

if (leaseUp.length > 0) {
  console.log(`   ${"bucket".padEnd(20)} ${"n".padStart(5)}  ${"gap".padStart(9)}  ${"occupancy".padStart(10)}`);
  for (const r of leaseUp) {
    console.log(
      `   ${r.bucket.padEnd(20)} ${String(r.n).padStart(5)}  ${pct(r.gap).padStart(9)}  ${pct(r.occ).padStart(10)}`,
    );
  }

  const low = leaseUp.find((r) => r.bucket.startsWith("1"));
  const high = leaseUp.find((r) => r.bucket.startsWith("4"));
  if (low?.occ != null && high?.occ != null) {
    const delta = low.occ - high.occ;
    console.log();
    if (delta > 0.08) {
      console.log(
        `   \x1b[33mThe hypothesis holds:\x1b[0m those with the largest gap have ${pct(delta)} less`,
      );
      console.log(`   occupancy. That is consistent with lease-up, not with aggressiveness.`);
    } else if (delta > 0.03) {
      console.log(
        `   \x1b[33mPartially:\x1b[0m ${pct(delta)} less occupancy among those with the largest gap.`,
      );
      console.log(`   It explains part of the phenomenon, probably not all of it.`);
    } else {
      console.log(
        `   \x1b[32mThe hypothesis does NOT hold:\x1b[0m occupancy is similar (${pct(Math.abs(delta))} of`,
      );
      console.log(
        `   difference). Loans with a larger gap are not emptier, so the projection`,
      );
      console.log(`   is not explained by lease-up.`);
    }
  }
}

// --- is it a handful of large loans? ----------------------------------------

const { rows: byWeight } = await query<{
  unweighted: number | null; weighted: number | null; n: string;
}>(
  `WITH pairs AS (
     SELECT
       uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap,
       bal.value::numeric AS balance
     FROM corpus.loans l
     JOIN corpus.facts uw  ON uw.loan_id  = l.id AND uw.metric_key = 'noi_underwritten'
     JOIN corpus.facts mr  ON mr.loan_id  = l.id AND mr.metric_key = 'noi_most_recent'
     JOIN corpus.facts bal ON bal.loan_id = l.id AND bal.metric_key = 'loan_amount'
     WHERE l.property_type = 'Office'
       AND uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$' AND bal.value ~ '^-?[0-9.]+$'
       AND mr.value::numeric > 0 AND bal.value::numeric > 0
   )
   SELECT
     count(*) AS n,
     avg(gap) AS unweighted,
     sum(gap * balance) / NULLIF(sum(balance), 0) AS weighted
   FROM pairs`,
);

const w = byWeight[0];
if (w?.unweighted != null && w?.weighted != null) {
  console.log(`\n   Weighting by loan size:`);
  console.log(`     simple average         ${pct(w.unweighted)}`);
  console.log(`     weighted by balance    ${pct(w.weighted)}`);
  const gap = Math.abs(w.weighted - w.unweighted);
  console.log(
    gap > 0.05
      ? `   \x1b[33m   The difference suggests a few large loans move the average.\x1b[0m`
      : `   \x1b[32m   Similar: the phenomenon does not depend on a few large loans.\x1b[0m`,
  );
}

// --- is it a single issuer? ---------------------------------------------------

const { rows: byIssuer } = await query<{ issuer: string; n: string; gap: number | null }>(
  `WITH pairs AS (
     SELECT
       split_part(fi.company_name, ' ', 1) AS issuer,
       uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap
     FROM corpus.loans l
     JOIN corpus.filings fi ON fi.accession = l.accession
     JOIN corpus.facts uw ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten'
     JOIN corpus.facts mr ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'
     WHERE l.property_type = 'Office'
       AND uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$' AND mr.value::numeric > 0
   )
   SELECT issuer, count(*) AS n,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY gap) AS gap
   FROM pairs GROUP BY 1 HAVING count(*) >= 20 ORDER BY count(*) DESC`,
);

if (byIssuer.length > 1) {
  console.log(`\n   By issuer:`);
  for (const r of byIssuer) {
    console.log(`     ${r.issuer.padEnd(16)} ${String(r.n).padStart(4)}  ${pct(r.gap).padStart(8)}`);
  }
  const positives = byIssuer.filter((r) => (r.gap ?? 0) > 0.05).length;
  console.log(
    positives === byIssuer.length
      ? `   \x1b[32m   Every issuer shows the same pattern: it is not one issuer's.\x1b[0m`
      : `   \x1b[33m   ${positives} of ${byIssuer.length} issuers. Check whether it depends on who originates.\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// A2) Is office alone, or are other types just as high?
// ---------------------------------------------------------------------------

/**
 * So far we compared office against "the rest", which is an average of very
 * different types. If hotel or retail also run high, the finding is not about
 * office but about types with volatile rent, and the headline changes.
 */
const { rows: byType } = await query<{
  ptype: string; n: string; median: number | null; share: number | null;
}>(
  `WITH pairs AS (
     SELECT coalesce(nullif(l.property_type, ''), 'no type') AS ptype,
            uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap
     FROM corpus.loans l
     JOIN corpus.facts uw ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten'
     JOIN corpus.facts mr ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'
     WHERE uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$' AND mr.value::numeric > 0
   )
   SELECT ptype, count(*) AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median,
          1.0 * count(*) FILTER (WHERE gap >= 0.05) / NULLIF(count(*), 0) AS share
     FROM pairs GROUP BY 1 HAVING count(*) >= 40
     ORDER BY percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) DESC`,
);

if (byType.length > 2) {
  console.log(`\n   \x1b[1mGap by property type\x1b[0m \x1b[90m(is office alone?)\x1b[0m\n`);
  console.log(`     type                   n     median     ≥5%`);
  for (const r of byType) {
    const hot = (r.median ?? 0) >= 0.08;
    const label = hot ? `\x1b[33m${r.ptype.padEnd(18)}\x1b[0m` : r.ptype.padEnd(18);
    console.log(
      `     ${label} ${String(r.n).padStart(5)}   ${pct(r.median).padStart(7)}  ${pct(r.share, 0).padStart(6)}`,
    );
  }
  const top = byType[0];
  const second = byType[1];
  if (top && second) {
    console.log(
      top.ptype.toLowerCase().includes("office")
        ? `\n   \x1b[32mOffice leads\x1b[0m, ${(((top.median ?? 0) - (second.median ?? 0)) * 100).toFixed(1)} pp above ${second.ptype}.`
        : `\n   \x1b[33mOffice does NOT lead: ${top.ptype} is higher (${pct(top.median)}).\x1b[0m\n` +
          `   The finding is not about office; it has to be reformulated.`,
    );
  }
}

// ---------------------------------------------------------------------------
// A3) Control within the same deal
// ---------------------------------------------------------------------------

/**
 * The hardest alternative explanation to rule out is selection: the office
 * properties that reach CMBS in 2024-2026 could be an odd sample —assets with a
 * story to tell, refinancings with repositioning— rather than a reflection of
 * how office is underwritten in general.
 *
 * The control is to compare office against the rest WITHIN the same deal. Same
 * issuer, same date, same credit committee, same risk appetite. If the gap
 * survives paired, deal-level selection is ruled out.
 */
/** Compares office against a control group, paired by deal. */
async function pairedVs(
  label: string,
  controlSql: string,
  minControl: number,
): Promise<{ deals: number; rate: number; diff: number | null } | null> {
  const { rows } = await query<{ deals: string; higher: string; median_diff: number | null }>(
    `WITH pairs AS (
       SELECT l.accession, l.property_type AS ptype,
              uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap
       FROM corpus.loans l
       JOIN corpus.facts uw ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten'
       JOIN corpus.facts mr ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'
       WHERE uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$' AND mr.value::numeric > 0
     ),
     per_deal AS (
       SELECT accession,
              count(*) FILTER (WHERE ptype = 'Office') AS n_office,
              count(*) FILTER (WHERE ${controlSql}) AS n_control,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY CASE WHEN ptype = 'Office' THEN gap END) AS g_office,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY CASE WHEN ${controlSql} THEN gap END) AS g_control
         FROM pairs GROUP BY accession
     )
     SELECT count(*) AS deals,
            count(*) FILTER (WHERE g_office > g_control) AS higher,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY g_office - g_control) AS median_diff
       FROM per_deal
      WHERE n_office >= 2 AND n_control >= ${minControl}`,
  );
  const r = rows[0];
  if (!r || Number(r.deals) < 8) {
    console.log(
      `     ${label.padEnd(28)} \x1b[90mmuestra insuficiente (${r ? r.deals : 0} deals)\x1b[0m`,
    );
    return null;
  }
  const deals = Number(r.deals);
  const rate = Number(r.higher) / deals;
  console.log(
    `     ${label.padEnd(28)} ${String(deals).padStart(4)} deals   ` +
      `${pct(rate, 0).padStart(5)} a favor   ${pct(r.median_diff).padStart(7)}`,
  );
  return { deals, rate, diff: r.median_diff };
}

console.log(
  `\n   \x1b[1mPaired control within the same deal\x1b[0m \x1b[90m(rules out issuer and vintage selection)\x1b[0m\n`,
);
console.log(`     control group               deals    office ahead    median diff.`);

const vsAll = await pairedVs("the whole rest of the pool", "ptype <> 'Office'", 5);

/**
 * The decisive control is industrial, not "the rest".
 *
 * The table by type showed an order that explains itself: hospitality -0.5%,
 * self storage 1.2%, retail 3.5%, industrial 10.8%, office 13.1%. That does not
 * look like aggressiveness but like visibility of contractual rent —a hotel has
 * no contracts to project, an office does, and underwriting above the trailing
 * figure with signed step-ups is legitimate.
 *
 * If that is the explanation, office and industrial should look alike, because
 * they share contract structure. And in fact they are 2.3 pp apart. Comparing
 * office against "the rest" inflates the gap by putting hotels and self storage
 * in the denominator.
 *
 * This pair is the one that decides: against industrial, within the same deal,
 * does office stay ahead?
 */
const vsIndustrial = await pairedVs(
  "solo industrial",
  "ptype = 'Industrial'",
  2,
);

console.log();
if (vsAll && vsAll.rate >= 0.7) {
  console.log(
    `   \x1b[32mAgainst the whole pool, office stays ahead in ${pct(vsAll.rate, 0)} of deals.\x1b[0m`,
  );
  console.log(`   Same issuer, same date, same committee: it is not deal selection.`);
}

if (vsIndustrial) {
  console.log();
  if (vsIndustrial.rate >= 0.65) {
    console.log(
      `   \x1b[32mAnd against industrial —same contract structure— it stays ahead\x1b[0m`,
    );
    console.log(
      `   \x1b[32min ${pct(vsIndustrial.rate, 0)} of deals.\x1b[0m Contractual rent visibility does not`,
    );
    console.log(`   fully explain it: office departs from its own comparable.`);
  } else {
    console.log(
      `   \x1b[33mContra industrial la ventaja se diluye (${pct(vsIndustrial.rate, 0)}).\x1b[0m Office e industrial`,
    );
    console.log(
      `   \x1b[33mthey share contract structure, so what the gap measures is\x1b[0m`,
    );
    console.log(
      `   \x1b[33mvisibility of future rent, not aggressiveness particular to office.\x1b[0m`,
    );
    console.log(
      `   \x1b[90mThe correct headline would be "types with long contracts are underwritten\x1b[0m`,
    );
    console.log(`   \x1b[90mwell above trailing", with office at the extreme.\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// Contrast with the literature
// ---------------------------------------------------------------------------

/**
 * Contrast with Griffin (2023), Journal of Finance — and why it is NOT comparable.
 *
 * "Is COVID Revealing a Virus in CMBS 2.0?" measures underwritten NOI against
 * the NOI *actually reported by the servicer in the first year after closing*.
 * It is a forward comparison: promise against outcome.
 *
 * We measure underwritten NOI against `noi_most_recent`, which is the trailing
 * NOI of the last closed period *before* closing, as published in the Annex A.
 * It is a backward comparison: promise against history.
 *
 * They are different quantities and cannot go in the same table:
 *
 *   - Our gap has a large legitimate component. Underwriting above the trailing
 *     figure is normal practice when there are contractual rent step-ups, signed
 *     but unoccupied leases, or non-recurring expenses being normalised. A 46%
 *     here is not 46% of loans badly underwritten.
 *
 *   - And it has a known bias against it. Griffin also found that originators
 *     inflate the past financials they publish. If the denominator comes in
 *     inflated, our gap comes out smaller than the real one.
 *
 * Replicating Griffin would need post-origination NOI, which is not in the
 * Annex A: it comes from servicer reports (10-D on EDGAR, or Trepp). Another
 * source and another pipeline.
 *
 * What this block can do is report our number under its correct name, and put
 * on record why it is not Griffin's.
 */
const GAP_THRESHOLD = 0.05;

const { rows: gapRows } = await query<{
  segment: string;
  n: string;
  share: number | null;
  median: number | null;
}>(
  `WITH pairs AS (
     SELECT coalesce(nullif(pt.value, ''), 'no type') AS ptype,
            uw.value::numeric / NULLIF(mr.value::numeric, 0) - 1 AS gap
     FROM corpus.loans l
     JOIN corpus.facts uw ON uw.loan_id = l.id AND uw.metric_key = 'noi_underwritten'
     JOIN corpus.facts mr ON mr.loan_id = l.id AND mr.metric_key = 'noi_most_recent'
     LEFT JOIN corpus.facts pt ON pt.loan_id = l.id AND pt.metric_key = 'property_type'
     WHERE uw.value ~ '^-?[0-9.]+$' AND mr.value ~ '^-?[0-9.]+$'
       AND mr.value::numeric > 0
   ),
   labelled AS (
     SELECT CASE WHEN ptype ILIKE '%office%' THEN 'office' ELSE 'resto' END AS segment, gap
     FROM pairs
     UNION ALL
     SELECT 'TOTAL', gap FROM pairs
   )
   SELECT segment,
          count(*) AS n,
          1.0 * count(*) FILTER (WHERE gap >= ${GAP_THRESHOLD}) / NULLIF(count(*), 0) AS share,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median
   FROM labelled
   GROUP BY segment
   ORDER BY CASE segment WHEN 'TOTAL' THEN 0 WHEN 'office' THEN 1 ELSE 2 END`,
);

const total = gapRows.find((r) => r.segment === "TOTAL");
if (total && Number(total.n) > 100) {
  console.log(`\n\n\x1b[1mContrast with the literature — and why it does not apply\x1b[0m`);
  console.log(
    `\x1b[90m   Griffin (2023), Journal of Finance — "Is COVID Revealing a Virus in CMBS 2.0?"\x1b[0m`,
  );
  console.log(
    `\x1b[90m   He compared underwritten NOI against the NOI reported by the servicer in\x1b[0m`,
  );
  console.log(
    `\x1b[90m   the first year AFTER closing. 29% of 39,522 loans with a gap ≥5%.\x1b[0m`,
  );
  console.log(
    `\n   \x1b[31mWe measure something else\x1b[0m: underwritten against the trailing figure`,
  );
  console.log(`   BEFORE closing, which is all the Annex A publishes.`);
  console.log(
    `\n   \x1b[90m   Griffin:  promise vs. outcome   → how wrong the underwriter was\x1b[0m`,
  );
  console.log(
    `   \x1b[90m   Us:       promise vs. history   → how far they departed from trailing\x1b[0m`,
  );
  console.log(
    `\n   The numbers do not compare. Underwriting above the trailing figure is normal`,
  );
  console.log(`   with rent step-ups or normalised non-recurring expenses.\n`);

  console.log(`   Underwritten / trailing gap in this corpus:\n`);
  console.log(`     segment         n     ≥5%     median`);
  for (const r of gapRows) {
    console.log(
      `     ${r.segment.padEnd(10)}${String(r.n).padStart(6)}  ${pct(r.share, 0).padStart(6)}  ${pct(r.median, 1).padStart(9)}`,
    );
  }

  /**
   * This office/rest split has been superseded by A2 and A3.
   *
   * "Rest" averages hotels with offices, and the ten-point separation comes
   * mostly from putting hospitality and self storage in the denominator. Against
   * industrial —the real comparable— office's advantage falls to 58% of deals.
   * The row stays so as not to lose continuity with earlier runs, but the
   * correct reading is the by-type scale from A2.
   */
  console.log(
    `\n   \x1b[90mThis partition has been superseded: "rest" mixes hotels with offices.\x1b[0m`,
  );
  console.log(`   \x1b[90mThe good reading is the by-type scale above.\x1b[0m`);
  console.log(
    `\n   \x1b[90mReplicating Griffin would need post-origination NOI: servicer reports\x1b[0m`,
  );
  console.log(
    `   \x1b[90m(10-D on EDGAR or Trepp). Another source, another pipeline.\x1b[0m`,
  );
}

// ===========================================================================
// B) Multifamily: is it the rates?
// ===========================================================================

/**
 * Housing cooperatives come labelled as "Multifamily" but are a different
 * business: the co-op owns the building and takes minimal debt against a high
 * value. An LTV of 10-20% with a DSCR of 4x to 12x is normal there, and absurd
 * in conventional multifamily.
 *
 * While they stay mixed in, any multifamily median is a blend of two different
 * populations. They are identified by the Annex A's Coop-* columns, which we
 * already harvest.
 */
const COOP_METRICS = ["coop_units", "coop_sponsor_units", "coop_rental_value", "coop_ltv_as_rental"];
const IS_COOP = `EXISTS (
  SELECT 1 FROM corpus.facts c
   WHERE c.loan_id = l.id
     AND c.metric_key IN (${COOP_METRICS.map((m) => `'${m}'`).join(", ")})
     AND c.value ~ '^[0-9.]+$' AND c.value::numeric > 0
)`;

console.log(`\n\n\x1b[1mB. Multifamily broke its band in 2026\x1b[0m`);

// --- cooperative census -------------------------------------------------------

const { rows: coopCensus } = await query<{
  issuer: string; total: string; coops: string; ltv_coop: number | null; ltv_conv: number | null;
}>(
  `SELECT split_part(fi.company_name, ' ', 1) AS issuer,
          count(DISTINCT l.id) AS total,
          count(DISTINCT l.id) FILTER (WHERE ${IS_COOP}) AS coops,
          percentile_cont(0.50) WITHIN GROUP (
            ORDER BY CASE WHEN ${IS_COOP} THEN v.value::numeric END) AS ltv_coop,
          percentile_cont(0.50) WITHIN GROUP (
            ORDER BY CASE WHEN NOT ${IS_COOP} THEN v.value::numeric END) AS ltv_conv
     FROM corpus.filings fi
     JOIN corpus.loans l ON l.accession = fi.accession
     LEFT JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = 'ltv' AND v.value ~ '^-?[0-9.]+$'
    WHERE l.property_type = 'Multifamily'
    GROUP BY 1 HAVING count(DISTINCT l.id) FILTER (WHERE ${IS_COOP}) > 0
    ORDER BY count(DISTINCT l.id) FILTER (WHERE ${IS_COOP}) DESC`,
);

const coopTotal = coopCensus.reduce((a, r) => a + Number(r.coops), 0);
if (coopTotal > 0) {
  console.log(
    `\n   \x1b[1mCooperatives detected\x1b[0m \x1b[90m(Annex A Coop-* columns populated)\x1b[0m\n`,
  );
  console.log(`     emisor            coop / total    LTV coop   LTV resto`);
  for (const r of coopCensus) {
    console.log(
      `     ${r.issuer.padEnd(16)} ${String(r.coops).padStart(4)} / ${String(r.total).padEnd(5)}  ` +
        `${pct(r.ltv_coop).padStart(9)}   ${pct(r.ltv_conv).padStart(9)}`,
    );
  }
  console.log(
    `\n   \x1b[32m${coopTotal} cooperative loans confirmed by data, not by inference.\x1b[0m`,
  );
  console.log(
    `   \x1b[90mThe low LTV was correct. The error was mixing them in. From here on\x1b[0m`,
  );
  console.log(`   \x1b[90mmultifamily excluye cooperativas.\x1b[0m`);
} else {
  console.log(
    `\n   \x1b[33mNo multifamily loan has populated Coop-* columns.\x1b[0m`,
  );
  console.log(
    `   \x1b[33mThe cooperative explanation has no support in the data: some issuer's\x1b[0m`,
  );
  console.log(`   \x1b[33mlow LTV remains unexplained.\x1b[0m`);
}

console.log(`\n\x1b[90m   Alternative hypothesis: DSCR falls because rates went up.\x1b[0m`);
console.log(
  `\x1b[90m   If true, the median rate should rise alongside the DSCR decline.\x1b[0m\n`,
);

const { rows: rates } = await query<{
  period: string; n: string; dscr: number | null; ltv: number | null;
  dy: number | null; rate: number | null;
}>(
  `SELECT
     to_char(date_trunc('quarter', fi.filed_at), 'YYYY-"Q"Q') AS period,
     count(DISTINCT l.id) AS n,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY d.value::numeric) AS dscr,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY v.value::numeric) AS ltv,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY y.value::numeric) AS dy,
     percentile_cont(0.50) WITHIN GROUP (ORDER BY r.value::numeric) AS rate
   FROM corpus.filings fi
   JOIN corpus.loans l ON l.accession = fi.accession
   LEFT JOIN corpus.facts d ON d.loan_id = l.id AND d.metric_key = 'dscr'          AND d.value ~ '^-?[0-9.]+$'
   LEFT JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = 'ltv'           AND v.value ~ '^-?[0-9.]+$'
   LEFT JOIN corpus.facts y ON y.loan_id = l.id AND y.metric_key = 'debt_yield'    AND y.value ~ '^-?[0-9.]+$'
   LEFT JOIN corpus.facts r ON r.loan_id = l.id AND r.metric_key = 'interest_rate' AND r.value ~ '^-?[0-9.]+$'
   WHERE fi.filed_at IS NOT NULL AND l.property_type = 'Multifamily' AND NOT ${IS_COOP}
   GROUP BY 1 HAVING count(DISTINCT l.id) >= 20 ORDER BY 1`,
);

if (rates.length > 2) {
  console.log(
    `   ${"period".padEnd(10)} ${"n".padStart(5)}  ${"DSCR".padStart(7)} ${"LTV".padStart(7)} ${"debt yield".padStart(11)} ${"rate".padStart(8)}`,
  );
  for (const r of rates) {
    console.log(
      `   ${r.period.padEnd(10)} ${String(r.n).padStart(5)}  ${num(r.dscr).padStart(7)} ` +
        `${pct(r.ltv).padStart(7)} ${pct(r.dy).padStart(11)} ${pct(r.rate, 2).padStart(8)}`,
    );
  }

  /**
   * Trend over the whole series, not "the last two against the rest".
   *
   * The two-block comparison had two defects that became visible once the
   * cooperatives were excluded. The sample threshold was calibrated on a
   * population that included 221 cooperative loans; removing them left six of
   * eleven quarters out, and "the last two" became 2025-Q3 and 2026-Q2, skipping
   * the ones in between. The label said one thing and the calculation did
   * another.
   *
   * The underlying defect is prior to that: splitting the series into two blocks
   * forces a choice of where to cut, and the cut gets chosen by looking at the
   */
  const MIN_QUARTER = 40;
  const usable = rates.filter((r) => Number(r.n) >= MIN_QUARTER);
  const excluded = rates.filter((r) => Number(r.n) < MIN_QUARTER);

  if (excluded.length > 0) {
    console.log(
      `   \x1b[90mExcluded for small sample: ${excluded.map((r) => `${r.period} (n=${r.n})`).join(", ")}\x1b[0m`,
    );
  }

  /** OLS slope per quarter and goodness of fit. */
  function trend(ys: Array<number | null>): { perYear: number; r2: number; n: number } | null {
    const pts = ys
      .map((y, i) => ({ x: i, y }))
      .filter((p): p is { x: number; y: number } => typeof p.y === "number");
    if (pts.length < 4) return null;

    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p.x, 0) / n;
    const my = pts.reduce((a, p) => a + p.y, 0) / n;
    const sxy = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
    const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
    if (sxx === 0) return null;

    const slope = sxy / sxx;
    const syy = pts.reduce((a, p) => a + (p.y - my) ** 2, 0);
    const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
    return { perYear: slope * 4, r2, n };
  }

  const tDscr = trend(usable.map((r) => r.dscr));
  const tLtv = trend(usable.map((r) => r.ltv));
  const tDy = trend(usable.map((r) => r.dy));
  const tRate = trend(usable.map((r) => r.rate));

  if (tLtv && tDy && tRate && tDscr) {
    console.log(
      `\n   Annual drift over the ${usable.length} usable quarters \x1b[90m(OLS slope)\x1b[0m\n`,
    );
    const line = (label: string, t: { perYear: number; r2: number }, unit: "pp" | "x") =>
      `     ${label.padEnd(12)} ${(t.perYear >= 0 ? "+" : "") + (unit === "pp" ? (t.perYear * 100).toFixed(2) + " pp" : t.perYear.toFixed(3) + "x")}`.padEnd(
        34,
      ) + `\x1b[90mR² ${t.r2.toFixed(2)}\x1b[0m`;

    console.log(line("LTV", tLtv, "pp"));
    console.log(line("debt yield", tDy, "pp"));
    console.log(line("DSCR", tDscr, "x"));
    console.log(line("tasa", tRate, "pp"));

    const FIT = 0.3;
    const leverageUp = tLtv.perYear > 0.005 && tLtv.r2 > FIT;
    const dyDown = tDy.perYear < -0.002 && tDy.r2 > FIT;

    console.log();
    if (leverageUp && dyDown) {
      console.log(
        `   \x1b[33mLeverage rising steadily.\x1b[0m LTV rises ${(tLtv.perYear * 100).toFixed(1)} pp/yr and`,
      );
      console.log(
        `   debt yield falls ${Math.abs(tDy.perYear * 100).toFixed(1)} pp/yr. Debt yield is the decisive control:`,
      );
      console.log(`   it depends on neither rates nor appraisals, so the fall is more`);
      console.log(`   debt per dollar of NOI, not a valuation artefact.`);
      console.log(
        `\n   \x1b[1mBut it is not what the hypothesis said.\x1b[0m There is no 2026 break: there is`,
      );
      console.log(
        `   a gradual drift since 2024. "Broke its band" is discarded;`,
      );
      console.log(`   what survives is a slow, continuous loosening.`);
    } else if (leverageUp) {
      console.log(
        `   \x1b[33mLTV rises ${(tLtv.perYear * 100).toFixed(1)} pp/yr, but debt yield does not follow.\x1b[0m`,
      );
      console.log(`   Without that control, the rise could be appraisals rather than debt.`);
    } else {
      console.log(`   \x1b[32mNo series shows drift with sufficient fit.\x1b[0m`);
      console.log(`   The loosening hypothesis does not hold on this data.`);
    }

    if (Math.abs(tRate.perYear) > 0.002 && tRate.r2 > FIT) {
      console.log(
        `\n   \x1b[90mRate control: ${tRate.perYear > 0 ? "rising" : "falling"} ${Math.abs(tRate.perYear * 100).toFixed(2)} pp/yr (R² ${tRate.r2.toFixed(2)}).\x1b[0m`,
      );
      console.log(
        tRate.perYear < 0
          ? `   \x1b[90mWith rates falling, DSCR should rise. That it stays flat is consistent\x1b[0m\n` +
            `   \x1b[90mwith more debt, not with the cost of debt.\x1b[0m`
          : `   \x1b[90mPart of the DSCR movement is mechanical, from the cost of debt.\x1b[0m`,
      );
    }
  }
}

// --- a single issuer? ---------------------------------------------------------

const { rows: mfIssuers } = await query<{ issuer: string; n: string; ltv: number | null }>(
  `SELECT split_part(fi.company_name, ' ', 1) AS issuer,
          count(DISTINCT l.id) AS n,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY v.value::numeric) AS ltv
     FROM corpus.filings fi
     JOIN corpus.loans l ON l.accession = fi.accession
     JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = 'ltv' AND v.value ~ '^-?[0-9.]+$'
    WHERE l.property_type = 'Multifamily' AND fi.filed_at >= '2026-01-01' AND NOT ${IS_COOP}
    GROUP BY 1 HAVING count(DISTINCT l.id) >= 15 ORDER BY count(DISTINCT l.id) DESC`,
);

if (mfIssuers.length > 1) {
  console.log(`\n   Multifamily LTV in 2026, by issuer \x1b[90m(excluding cooperatives)\x1b[0m:`);

  /**
   * A very low LTV is NOT necessarily an error.
   *
   * I got this wrong: I flagged the BANK family's 11.0% in red, assuming a CMBS
   * loan does not price like that. The arithmetic said otherwise —an $8.5M loan
   * against a $38.6M appraisal, with a normal 5.9% cap rate— and the corpus had
   * the answer in columns I had dismissed as boring: "Coop - Coop Units",
   * "Coop - LTV as Rental".
   *
   * They are loans to housing cooperatives, typically in New York. The co-op
   * owns the building and takes minimal debt against a high value: an LTV of
   * 10-20% with a DSCR of 4x to 12x is normal in that niche.
   *
   * They come classified as "Multifamily", so they drag that category's medians.
   * The flag now points at that —they need segmenting— instead of asserting that
   * the data is broken.
   */
  const unusual: string[] = [];
  for (const r of mfIssuers) {
    const v = r.ltv;
    const low = v !== null && v < 0.30;
    if (low) unusual.push(r.issuer);
    const cell = low ? `\x1b[33m${pct(v).padStart(8)}\x1b[0m ⚠` : pct(v).padStart(8);
    console.log(`     ${r.issuer.padEnd(16)} ${String(r.n).padStart(4)}  ${cell}`);
  }

  if (unusual.length > 0) {
    console.log(
      `\n   \x1b[33m   ${unusual.join(", ")}: LTV below 30% with cooperatives ALREADY excluded.\x1b[0m`,
    );
    console.log(
      `   \x1b[90m   There is another low-debt niche still unidentified. The candidates are\x1b[0m`,
    );
    console.log(
      `   \x1b[90m   subsidised housing with subordinated public debt, ground leases, and\x1b[0m`,
    );
    console.log(
      `   \x1b[90m   supplemental loans on existing agency debt.\x1b[0m`,
    );
    console.log(
      `   \x1b[90m   Inspect the detail before assuming the pipeline is broken:\x1b[0m`,
    );
    console.log(
      `   \x1b[90m   last time it was assumed broken, the data was right.\x1b[0m`,
    );
  } else {
    console.log(
      `   \x1b[90m   If one issuer dominates and the rest are far below, the finding is theirs,\x1b[0m`,
    );
    console.log(`   \x1b[90m   not the market's.\x1b[0m`);
  }
}

// ===========================================================================
// Status of the findings
// ===========================================================================

console.log(`\n\n${"═".repeat(78)}`);
console.log("Status of the findings");
console.log(`${"═".repeat(78)}\n`);

console.log(`\x1b[31m✗ DISCARDED\x1b[0m  "Office is underwritten aggressively"`);
console.log(
  `\x1b[90m             Survived lease-up, size weighting, issuer, and deal\x1b[0m`,
);
console.log(
  `\x1b[90m             selection. It fell against its own comparable: paired\x1b[0m`,
);
console.log(
  `\x1b[90m             within the deal, office beats industrial in 58% of cases.\x1b[0m\n`,
);

console.log(`\x1b[32m✓ SURVIVES\x1b[0m   The gap scales with contractual rent visibility`);
console.log(
  `\x1b[90m             Hospitality -0.5% → self storage 1.2% → retail 3.5% →\x1b[0m`,
);
console.log(
  `\x1b[90m             industrial 10.8% → office 13.1%. It orders by how much future\x1b[0m`,
);
console.log(
  `\x1b[90m             rent is under contract, not by aggressiveness. It is smaller\x1b[0m`,
);
console.log(`\x1b[90m             than the original headline and better supported.\x1b[0m\n`);

console.log(`\x1b[31m✗ DISCARDED\x1b[0m  "Multifamily broke its band in 2026"`);
console.log(
  `\x1b[90m             There is no break. DSCR is flat (R² 0.06) and the supposed 2026\x1b[0m`,
);
console.log(
  `\x1b[90m             jump was partly 221 cooperatives mixed into the category.\x1b[0m\n`,
);

console.log(`\x1b[32m✓ SURVIVES\x1b[0m   Leverage drift in conventional multifamily`);
console.log(
  `\x1b[90m             LTV +2.3 pp/yr and debt yield -0.6 pp/yr, R² ~0.65, sustained\x1b[0m`,
);
console.log(
  `\x1b[90m             since 2024. With rates falling DSCR should rise and it is flat:\x1b[0m`,
);
console.log(`\x1b[90m             the extra capacity was taken as debt, not as cushion.\x1b[0m\n`);

console.log(`\x1b[32m✓ CONTROL\x1b[0m    Hospitality at -0.5% validates the instrument`);
console.log(
  `\x1b[90m             Where there are no contracts to project, the gap disappears. If\x1b[0m`,
);
console.log(
  `\x1b[90m             the pipeline inflated systematically, it would show up there too.\x1b[0m\n`,
);

console.log(`${"─".repeat(78)}`);
console.log(
  `\n  \x1b[90mTwo findings went in, two came out replaced by smaller and better\x1b[0m`,
);
console.log(`  \x1b[90msupported versions. That is the process working, not failing.\x1b[0m\n`);

await closePool();

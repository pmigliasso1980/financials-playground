/**
 * Mapping Annex A columns to our metrics.
 *
 * This is the heart of the harvester and the part that breaks most. Every issuer
 * names the columns differently, and sometimes the same issuer changes between
 * deals. Real examples of the same concept:
 *
 *   NOI:        "Most Recent NOI", "UW NOI", "Underwritten Net Operating Income",
 *               "NOI ($)", "Most Recent NOI ($)", "T-12 NOI"
 *   Ocupancia:  "Occupancy", "% Occupied", "Occupancy Rate", "Physical Occupancy (%)"
 *   Unidades:   "Units", "Units/Rooms/Pads", "# of Units", "Units/SF"
 *
 * Strategy: patterns per metric, with scoring. Not exact matching, because the
 * first new issuer breaks that.
 *
 * IMPORTANT NOTE on NOI: there are two distinct concepts that are best NOT
 * mixed. "UW NOI" (underwritten) is the originator's projection; "Most Recent
 * NOI" is what the property actually produced. We map them to separate metrics —
 * exactly the kind of distinction that makes the Deal Index useful.
 */

export type MetricKey =
  | "noi_underwritten"
  | "noi_most_recent"
  | "noi_second_most_recent"
  | "noi_third_most_recent"
  | "egi_underwritten"
  | "egi_most_recent"
  | "egi_second_most_recent"
  | "egi_third_most_recent"
  | "expenses_underwritten"
  | "expenses_most_recent"
  | "expenses_second_most_recent"
  | "expenses_third_most_recent"
  | "net_cash_flow"
  | "dscr_ncf"
  | "debt_yield_ncf"
  | "ltv_whole_loan"
  | "ltv_total_debt"
  | "ltv_maturity"
  | "dscr_whole_loan"
  | "dscr_total_debt"
  | "debt_yield_whole_loan"
  | "debt_yield_total_debt"
  | "unit_of_measure"
  | "property_type_detailed"
  | "coop_units"
  | "coop_sponsor_units"
  | "coop_rental_value"
  | "coop_ltv_as_rental"
  | "loan_property_flag"
  | "loan_id"
  | "occupancy"
  | "occupancy_economic"
  | "units"
  | "square_feet"
  | "year_built"
  | "year_renovated"
  | "loan_amount"
  | "appraised_value"
  | "ltv"
  | "dscr"
  | "debt_yield"
  | "interest_rate"
  | "interest_rate_mezzanine"
  | "interest_rate_subordinate"
  | "property_type"
  | "loan_seller"
  | "property_name"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "cap_rate"
  | "debt_service_pi"
  | "debt_service_io"
  | "amortization_type"
  | "interest_accrual_method"
  | "ard_loan"
  | "term_original"
  | "term_remaining"
  | "amortization_term_original"
  | "amortization_term_remaining"
  | "io_period_original"
  | "io_period_remaining"
  | "origination_date"
  | "first_payment_date"
  | "seasoning_months"
  | "property_count"
  | "underwritten_replacement_reserve"
  | "underwritten_tilc"
  | "reserve_tax_upfront"
  | "reserve_tax_monthly"
  | "reserve_insurance_upfront"
  | "reserve_insurance_monthly"
  | "reserve_replacement_upfront"
  | "reserve_replacement_monthly"
  | "reserve_replacement_cap"
  | "reserve_tilc_upfront"
  | "reserve_tilc_monthly"
  | "reserve_tilc_cap"
  | "reserve_debt_service_upfront"
  | "reserve_debt_service_monthly"
  | "reserve_debt_service_cap"
  | "reserve_deferred_maintenance"
  | "reserve_other_upfront"
  | "reserve_other_monthly"
  | "reserve_other_cap"
  | "reserve_other_description"
  | "holdback_amount"
  | "holdback_description"
  | "lockbox_type"
  | "cash_management"
  | "balance_whole_loan"
  | "balance_pari_passu_trust"
  | "balance_pari_passu_non_trust"
  | "balance_subordinate"
  | "balance_mezzanine"
  | "balance_maturity"
  | "balance_original"
  | "pool_share"
  | "balance_total_debt"
  | "balance_senior_total";

export interface MetricSpec {
  key: MetricKey;
  label: string;
  unit: "currency" | "percent" | "ratio" | "count" | "years" | "text";
  entity: "deal" | "property";
  /** Patterns that add score if they appear in the header. */
  patterns: RegExp[];
  /** Patterns that disqualify — they prevent false positives. */
  exclude?: RegExp[];
}

/**
 * NOTE ON SATELLITE COLUMNS
 *
 * A real Annex A does not have one NOI column: it has a cluster.
 *
 *   Underwritten Net Operating Income ($)   ← the one we want
 *   Underwritten NOI DSCR (x)
 *   Underwritten NOI Debt Yield (%)
 *   Third Most Recent NOI Date
 *   Third Most Recent Description
 *
 * They all contain "NOI" or "Underwritten". Without these exclusions, the first
 * one to appear takes the metric and the real column is orphaned. It happened
 * with real data: a hotel's NOI was stored as 1.83, which was its DSCR.
 */
const NOI_SATELLITES = [
  /dscr/i,
  /debt\s*yield/i,
  /\bdate\b/i,
  /description/i,
  /reserve/i,
  /ff\s*&?\s*e/i,
  /\bti\s*\/\s*lc\b/i,
  /cash\s*flow/i,
  /\begi\b/i,
  /expenses?/i,
  /occupancy/i,
];

/**
 * Order matters: the more specific metrics go first, so that "Most Recent NOI"
 * does not fall into the generic underwritten NOI pattern, nor "Unit of Measure"
 * into the one for "Units".
 */
/**
 * "Total Debt" is not always written "Total Debt".
 *
 * INCIDENT: fifteen 2020-2021 issuances did not close a single row of the debt
 * yield identity. The cause was one word: the header reads "Total Mortgage Debt
 * UW NOI Debt Yield" and the exclusion required the two words adjacent, so it
 * does not match with "Mortgage" in between.
 *
 * The effect was twofold, which is why it took so long to see. The total-debt
 * ratio entered as if it were the senior one —impossible to close against any
 * senior balance, because the denominator includes the subordinate debt— and at
 * the same time `debt_yield_total_debt`, which exists precisely to receive it,
 * did not capture it either, for the same reason. One metric was contaminated
 * and the other left empty by the same bug.
 *
 * "Total Senior Notes" does NOT belong here: that is trust + pari passu, which
 * is exactly the denominator we use. Excluding it would break the Benchmark
 * issuances. The "service" lookahead is not paranoia: "Total Debt Service
 * Coverage Ratio" is a legitimate senior DSCR, and without the lookahead this
 * exclusion would discard it. The previous exclusion had the same hole; widening
 * it raises the risk.
 */
const TOTAL_DEBT = /total\s*(mortgage|secured|combined)?\s*debt(?!\s*service)/i;

/**
 * Trailing NOI columns disguised as underwritten.
 *
 * CSAIL 2020-C19 publishes "Third Most Recent NOI Debt Yield" and no column
 * simply called "debt yield". Our pattern /\bnoi\s*debt\s*yield/i took it: we
 * stored as an underwritten ratio a ratio computed on the NOI from two years
 * before closing. It is not a badly parsed number, it is a different number.
 */
const HISTORICAL = [/most\s*recent/i, /\btrailing\b/i, /\bt-?12\b/i, /\bhistorical\b/i];

export const METRIC_SPECS: MetricSpec[] = [
  /**
   * NOTE ON VINTAGES
   *
   * An Annex A publishes the same concept across several periods:
   *
   *   Third Most Recent NOI ($)     ← ~3 years ago
   *   Second Most Recent NOI ($)    ← ~2 years ago
   *   Most Recent NOI ($)           ← the last closed one
   *   Underwritten NOI ($)          ← the originator's projection
   *
   * The generic pattern /most recent.*noi/ matches the first three and keeps
   * whichever appears earliest in the spreadsheet, which tends to be the OLDEST.
   * With real data that labelled an NOI from three periods ago as if it were the
   * current one: $9.7M when the underwritten figure was $10.9M.
   *
   * Each vintage gets its own metric. Besides avoiding the error, it gives the
   * Index a time series: "how has the NOI been evolving?" becomes answerable.
   */
  {
    key: "noi_third_most_recent",
    label: "Third Most Recent NOI",
    unit: "currency",
    entity: "property",
    patterns: [/\bthird\s*most\s*recent\b.*\bnoi\b/i, /\bthird\s*most\s*recent\s*net\s*operating/i],
    exclude: NOI_SATELLITES,
  },
  {
    key: "noi_second_most_recent",
    label: "Second Most Recent NOI",
    unit: "currency",
    entity: "property",
    patterns: [/\bsecond\s*most\s*recent\b.*\bnoi\b/i, /\bsecond\s*most\s*recent\s*net\s*operating/i],
    exclude: NOI_SATELLITES,
  },
  {
    key: "noi_most_recent",
    label: "Most Recent NOI",
    unit: "currency",
    entity: "property",
    patterns: [
      /\b(most\s*recent|t-?12|ttm|trailing)\b.*\bnoi\b/i,
      /\bnoi\b.*\b(most\s*recent|t-?12|ttm|trailing)\b/i,
      /\b(most\s*recent|trailing)\s*net\s*operating\s*income/i,
    ],
    // A real Annex A carries satellite columns around the NOI —date,
    // description, DSCR, debt yield— that contain the word "NOI" and would steal
    // the metric. See the NOTE on satellite columns above.
    // And the earlier vintages already have their own metric.
    exclude: [...NOI_SATELLITES, /\b(second|third|fourth)\s*most\s*recent\b/i],
  },
  {
    key: "noi_underwritten",
    label: "Underwritten NOI",
    unit: "currency",
    entity: "property",
    patterns: [
      /\b(uw|u\/w|underwrit\w*)\b.*\bnoi\b/i,
      /\bnoi\b.*\b(uw|u\/w|underwrit\w*)\b/i,
      /\bunderwritten\s*net\s*operating\s*income/i,
      /^\s*noi\b/i,
      /\bnet\s*operating\s*income/i,
    ],
    exclude: [/most\s*recent/i, /t-?12/i, /ttm/i, /trailing/i, /ncf/i, ...NOI_SATELLITES],
  },
  /**
   * EGI AND EXPENSES: ONE KEY PER COLUMN, LIKE NOI.
   *
   * They used to be four keys for eight columns: `effective_gross_income`
   * lumped "Underwritten EGI" with "Most Recent EGI", and `egi_prior_period`
   * lumped "Second" with "Third Most Recent". The pairs tied on score and
   * `mapColumns` broke the tie by column order, which depends on how the blocks
   * ended up after `joinAnnexTables` and varies by issuance.
   *
   * Detected with `harvest:ties`: all four keys tied across the 6 sampled
   * issuances, one per vintage.
   *
   * Underwritten and Most Recent are not variants of the same thing: one is the
   * underwriter's projection and the other is what the building produced. It is
   * exactly the distinction that supports the Griffin measurement, and it was
   * being decided by column order.
   *
   * `real.test.ts` already asserted the correct intent —EGI to underwritten,
   * prior_period to third— and passed, but because of the fixture's order, not
   * because of the taxonomy. A validation that could not fail.
   *
   * NOI already had the four keys separated from the start. This copies that
   * structure rather than inventing one.
   */
  {
    key: "egi_third_most_recent",
    label: "Third Most Recent EGI",
    unit: "currency",
    entity: "property",
    patterns: [/\bthird\s*most\s*recent\b.*\begi\b/i, /\bthird\s*most\s*recent\s*effective\s*gross/i],
  },
  {
    key: "egi_second_most_recent",
    label: "Second Most Recent EGI",
    unit: "currency",
    entity: "property",
    patterns: [/\bsecond\s*most\s*recent\b.*\begi\b/i, /\bsecond\s*most\s*recent\s*effective\s*gross/i],
  },
  {
    key: "egi_most_recent",
    label: "Most Recent EGI",
    unit: "currency",
    entity: "property",
    patterns: [/\bmost\s*recent\b.*\begi\b/i, /\bmost\s*recent\s*effective\s*gross/i],
    exclude: [/\b(second|third|fourth)\s*most\s*recent\b/i],
  },
  {
    key: "egi_underwritten",
    label: "Underwritten EGI",
    unit: "currency",
    entity: "property",
    patterns: [
      /\bunderwritten\b.*\begi\b/i,
      /\bu\/?w\b.*\begi\b/i,
      /\bunderwritten\s*effective\s*gross/i,
      // Fallback: an Annex A with a single, unqualified EGI column.
      /\begi\b/i,
      /effective\s*gross\s*income/i,
    ],
    exclude: [/most\s*recent/i],
  },
  {
    key: "expenses_third_most_recent",
    label: "Third Most Recent Expenses",
    unit: "currency",
    entity: "property",
    patterns: [/\bthird\s*most\s*recent\b.*expenses?/i],
  },
  {
    key: "expenses_second_most_recent",
    label: "Second Most Recent Expenses",
    unit: "currency",
    entity: "property",
    patterns: [/\bsecond\s*most\s*recent\b.*expenses?/i],
  },
  {
    key: "expenses_most_recent",
    label: "Most Recent Expenses",
    unit: "currency",
    entity: "property",
    patterns: [/\bmost\s*recent\b.*expenses?/i],
    exclude: [/\b(second|third|fourth)\s*most\s*recent\b/i],
  },
  {
    key: "expenses_underwritten",
    label: "Underwritten Expenses",
    unit: "currency",
    entity: "property",
    patterns: [
      /\bunderwritten\b.*expenses?/i,
      /\bu\/?w\b.*expenses?/i,
      /operating\s*expenses?/i,
      /\bopex\b/i,
      /total\s*expenses?/i,
      /^\s*expenses?\b/i,
      /\bexpenses?\s*\(\$\)/i,
    ],
    exclude: [/most\s*recent/i],
  },
  /**
   * Physical and economic occupancy are different metrics: the economic one
   * deducts concessions and bad debt, so it is always lower. Many Annex A
   * documents publish only the economic one, so unifying them under an
   * "economic" exclusion would leave us with none.
   */
  {
    key: "occupancy_economic",
    label: "Economic Occupancy",
    unit: "percent",
    entity: "property",
    patterns: [/economic\s*occupancy/i, /\beconomic\s*occ\b/i],
    exclude: [/\bdate\b/i],
  },
  {
    key: "occupancy",
    label: "Occupancy",
    unit: "percent",
    entity: "property",
    /**
     * THE ORDER HERE IS NOT COSMETIC: IT BREAKS TIES.
     *
     * `scoreHeader` scores 1 - i*0.08 by the pattern's position, so two headers
     * falling on the same pattern tie, and `mapColumns` resolves the tie by
     * column order.
     *
     * The conduit Annex A —which is a shared template: the headers come out
     * byte for byte identical across BMO, Benchmark, Wells, JPMorgan and BANK—
     * carries six occupancy columns: `Leased Occupancy (%)`, `Underwritten Hotel
     * Occupancy (%)` and the historical series `Most Recent` / `Second` /
     * `Third`. They all matched only `/occupancy/` and tied at 0.76.
     *
     * Since `joinAnnexTables` merges the blocks into a single table and the
     * mapping runs once over the joined headers, whichever came first won — and
     * that depends on the block order, which varies by issuance.
     *
     * When a hotel column won, only the hotels ended up with data. In 7 of the
     * 2026 issuances the count of loans with occupancy was exactly the count of
     * hotels: BANK5 6 of 35 with 18% hospitality, BMO 2026-C15 zero of 16 with
     * no hotels at all.
     *
     * Worse than the hole: the values that were there were not the same metric
     * as in the other 21 issuances. Coverage looked like 76% and inside it were
     * two different quantities mixed together.
     */
    patterns: [
      // The conduit column: covers every asset type. It wins whenever present.
      /leased\s*occ/i,
      /physical\s*occ/i,
      /%\s*occupied/i,
      /\boccupied\b.*%/i,
      // Generic: includes "Underwritten Hotel Occupancy" and "Most Recent
      // Occupancy". They are real occupancy and are useful when there is no
      // Leased —a single-hotel issuance has nothing else— but they lose to it.
      /\boccupancy\b/i,
    ],
    /**
     * "area", "sf" and "rentable" appear when a group header like
     * "Physical & Occupancy" gets glued to an area column.
     *
     * The ordinal historical series is excluded entirely: "Second/Third/Fourth/
     * Fifth Most Recent" are old snapshots of the same asset, not current
     * occupancy. Plain "Most Recent" is NOT excluded — in several formats it is
     * the current column and the only one there is.
     */
    exclude: [
      /economic/i,
      /\bdate\b/i,
      /\barea\b/i,
      /rentable/i,
      /\bsf\b/i,
      /square/i,
      /(second|third|fourth|fifth)\s+most\s+recent/i,
    ],
  },
  {
    key: "unit_of_measure",
    label: "Unit of Measure",
    unit: "text",
    entity: "property",
    // Goes BEFORE `units`: "Unit of Measure" starts with "Unit" and if we do not
    // win priority over it, `units` takes this text column and "Number of Units"
    // —the real count— goes unmapped.
    patterns: [/unit\s*of\s*measure/i, /^\s*measure\b/i],
  },
  {
    key: "units",
    label: "Units",
    unit: "count",
    entity: "property",
    patterns: [
      /\bnumber\s*of\s*units\b/i,
      /#\s*of\s*units/i,
      /units?\s*\/\s*(rooms|pads|beds|keys)/i,
      /^\s*units?\b/i,
      /\b(rooms|keys|pads)\b/i,
    ],
    exclude: [/per\s*unit/i, /\/\s*unit/i, /price/i, /of\s*measure/i],
  },
  {
    key: "square_feet",
    label: "Square Feet",
    unit: "count",
    entity: "property",
    patterns: [
      /\bnet\s*rentable\s*area\b/i,
      /\bsquare\s*feet\b/i,
      /\bsq\.?\s*ft\.?\b/i,
      /\bnra\b/i,
      /\bgla\b/i,
      /\bsf\b/i,
    ],
    /**
     * Careful about excluding plain /rent/: it kills "Net Rentable Area", which
     * is one of the most common names for this very column.
     *
     * The `%` cases are another story. "Largest Tenant % of NRA" contains "NRA"
     * and this pattern was taking it: at Tysons Corner Center we were storing 14
     * as the area —the percentage the largest tenant occupies— instead of the
     * square footage. A two-digit value in a metric that should have six,
     * invisible unless you read the provenance row by row.
     */
    exclude: [
      /per\s*s(q|f)/i, /\/\s*s(q|f)/i, /price/i, /\brent\s+roll\b/i,
      /%/, /percent/i, /\bshare\b/i, /largest\s*tenant/i, /\btenant\s*\d/i,
    ],
  },
  {
    key: "year_built",
    label: "Year Built",
    unit: "years",
    entity: "property",
    patterns: [/year\s*built/i, /^\s*built\b/i, /\byoc\b/i],
  },
  {
    key: "year_renovated",
    label: "Year Renovated",
    unit: "years",
    entity: "property",
    patterns: [/year\s*renovated/i, /^\s*renovated\b/i],
  },
  {
    key: "loan_amount",
    label: "Loan Amount",
    unit: "currency",
    entity: "deal",
    /**
     * THE TRUST'S BALANCE, NOT THE LOAN'S.
     *
     * An Annex A publishes seven different balances for the same loan. This
     * metric is the one belonging to this trust at the cut-off date; the other
     * six have their own metrics further down.
     *
     * Preferring "Cut-off Date Balance" over "Original Balance" is not
     * aesthetic: the original is the amount at origination and the cut-off one
     * is what was outstanding when the trust bought it. For a loan that has
     * already amortised, they are not the same.
     *
     * INCIDENT: it pointed at "Original Balance ($)" with no qualifier excluded.
     * At Tysons Corner Center it stored $2,460,000 —this trust's slice of a
     * $709M loan split across dozens of issuances— and with that the computed
     * debt yield gave 3947%. The arithmetic identities gave it away: the balance
     * implied by debt yield and the one implied by LTV agreed at 288x, to three
     * digits.
     */
    /**
     * "Current Balance" in the Benchmark/JPMDB 2020 format.
     *
     * Those issuances publish "Original Balance ($)" and "Current Balance ($)"
     * instead of original and cut-off. Without the pattern, `loan_amount` fell
     * on the original —the amount at origination, not what was outstanding when
     * the trust bought it— and on a loan that has amortised they are not the
     * same number. That is 97 loans across 8 issuances, among them Benchmark
     * 2020-B17 and B20.
     *
     * It goes AFTER the cut-off one so that where both exist the explicit wins.
     */
    patterns: [
      /cut-?off\s*date\s*(principal\s*)?balance/i,
      /^\s*current\s*balance\b/i,
      /original\s*(principal\s*)?balance/i,
      /\bloan\s*amount\b/i,
      /\boriginal\s*loan\b/i,
    ],
    exclude: [
      /per\s*(unit|sf|room|key)/i, /\/\s*(unit|sf)/i,
      /whole\s*loan/i, /pari\s*passu/i, /companion/i, /subordinate/i,
      /mezzanine/i, TOTAL_DEBT, /maturity|ard/i, /%|percent/i,
      /ground\s*lease/i, /pool/i, /additional\s*debt/i, /senior\s*notes?/i,
    ],
  },
  {
    key: "appraised_value",
    label: "Appraised Value",
    unit: "currency",
    entity: "property",
    patterns: [/appraised\s*value/i, /appraisal\s*value/i, /^\s*value\b/i],
    /**
     * "Appraised Value Type" is a TEXT column ("As Is", "As Stabilized") and it
     * tied at 1.00 with "Appraised Value ($)".
     *
     * The "per" exclude was unanchored: it matched the substring inside any word
     * —"Property" contains it— so it excluded headers that had nothing to do
     * with it. Anchored with \b it does what it said it did.
     */
    exclude: [/date/i, /\bper\b/i, /\btype\b/i],
  },
  /**
   * NOTE ON DEBT STRUCTURES
   *
   * An Annex A publishes the same ratio against different denominators:
   *
   *   Cut-off Date LTV Ratio (%)               ← the loan that is in THIS trust
   *   Whole Loan Cut-off Date LTV Ratio (%)    ← includes the pari passu notes
   *                                              left in other trusts
   *   Total Debt Cut-off Date LTV Ratio (%)    ← adds mezzanine and subordinate
   *   LTV Ratio at Maturity / ARD (%)          ← at maturity, not at closing
   *
   * These are not nuances: the whole loan LTV can be 60% while the trust's is
   * 45%. A generic /ltv/ pattern takes the first column that appears and the
   * result depends on column order.
   *
   * With real data it took "Whole Loan Cut-off Date LTV", which only exists for
   * split loans: 8 of 32. Coverage at 25% is what gave the problem away —the
   * value itself was correct, it just belonged to a different metric.
   *
   * The variants go first so the base pattern does not take them.
   */
  {
    key: "ltv_whole_loan",
    label: "Whole Loan LTV",
    unit: "percent",
    entity: "deal",
    patterns: [/whole\s*loan\b.*\bltv\b/i, /\bltv\b.*whole\s*loan/i],
    exclude: [/maturity/i, /\bard\b/i],
  },
  {
    key: "ltv_total_debt",
    label: "Total Debt LTV",
    unit: "percent",
    entity: "deal",
    patterns: [/total\s*(mortgage\s*)?debt\b.*\bltv\b/i, /\bltv\b.*total\s*(mortgage\s*)?debt/i],
    exclude: [/maturity/i, /\bard\b/i],
  },
  {
    key: "ltv_maturity",
    label: "LTV at Maturity",
    unit: "percent",
    entity: "deal",
    patterns: [/\bltv\b.*\b(maturity|ard|balloon)\b/i, /\b(maturity|balloon)\b.*\bltv\b/i],
  },
  {
    key: "ltv",
    label: "LTV",
    unit: "percent",
    entity: "deal",
    patterns: [/cut-?off\s*date\s*ltv/i, /\bltv\b/i, /loan[-\s]*to[-\s]*value/i],
    exclude: [/maturity/i, /balloon/i, /\bard\b/i, /whole\s*loan/i, TOTAL_DEBT, /\bcoop\b/i],
  },
  /**
   * Real Annex A documents carry TWO DSCRs and TWO debt yields: one on NOI and
   * one on NCF (net cash flow, which deducts capex and TI/LC reserves). They are
   * different metrics —NCF is always more conservative— and mapping them to the
   * same one would lose exactly the difference an analyst cares about.
   *
   * Order matters: the explicit variants go before the generic pattern.
   */
  /**
   * DSCR and debt yield suffer the same multiplication as LTV: each appears
   * against the trust's loan, against the whole loan and against total debt. The
   * variants go first and the base pattern excludes them, so that which one wins
   * does not depend on column order.
   */
  {
    key: "dscr_whole_loan",
    label: "Whole Loan DSCR",
    unit: "ratio",
    entity: "deal",
    patterns: [/whole\s*loan\b.*\bdscr\b/i, /\bdscr\b.*whole\s*loan/i],
  },
  {
    key: "dscr_total_debt",
    label: "Total Debt DSCR",
    unit: "ratio",
    entity: "deal",
    patterns: [/total\s*(mortgage\s*)?debt\b.*\bdscr\b/i, /\bdscr\b.*total\s*(mortgage\s*)?debt/i],
  },
  {
    key: "dscr_ncf",
    label: "NCF DSCR",
    unit: "ratio",
    entity: "deal",
    patterns: [/\bncf\s*dscr\b/i, /dscr.*\bncf\b/i],
    exclude: [/whole\s*loan/i, TOTAL_DEBT],
  },
  {
    key: "dscr",
    label: "DSCR",
    unit: "ratio",
    entity: "deal",
    patterns: [/\bnoi\s*dscr\b/i, /\bdscr\b/i, /debt\s*service\s*coverage/i],
    exclude: [/\bncf\b/i, /whole\s*loan/i, TOTAL_DEBT],
  },
  {
    key: "debt_yield_whole_loan",
    label: "Whole Loan Debt Yield",
    unit: "percent",
    entity: "deal",
    patterns: [/whole\s*loan\b.*debt\s*yield/i, /debt\s*yield.*whole\s*loan/i],
  },
  {
    key: "debt_yield_total_debt",
    label: "Total Debt Debt Yield",
    unit: "percent",
    entity: "deal",
    patterns: [/total\s*(mortgage\s*)?debt\b.*debt\s*yield/i],
  },
  {
    key: "debt_yield_ncf",
    label: "NCF Debt Yield",
    unit: "percent",
    entity: "deal",
    patterns: [/\bncf\s*debt\s*yield/i, /debt\s*yield.*\bncf\b/i],
    exclude: [/whole\s*loan/i, TOTAL_DEBT],
  },
  {
    key: "debt_yield",
    label: "Debt Yield",
    unit: "percent",
    entity: "deal",
    patterns: [/\bnoi\s*debt\s*yield/i, /debt\s*yield/i],
    exclude: [/\bncf\b/i, /whole\s*loan/i, TOTAL_DEBT, ...HISTORICAL],
  },
  {
    key: "net_cash_flow",
    label: "Net Cash Flow",
    unit: "currency",
    entity: "property",
    patterns: [/\bnet\s*cash\s*flow\b/i],
    exclude: [/dscr/i, /debt\s*yield/i],
  },
  {
    key: "property_type_detailed",
    label: "Detailed Property Type",
    unit: "text",
    entity: "property",
    patterns: [/detailed\s*property\s*type/i, /property\s*sub-?type/i],
  },
  /**
   * COOPERATIVE LOANS
   *
   * A housing cooperative —typically in New York— owns the building and takes
   * very small debt against a very high value. An LTV of 10-20% with a DSCR of
   * 4x to 12x is normal there, not an error.
   *
   * They come classified as "Multifamily", so without distinguishing them they
   * drag that category's medians down. In the BANK deals they are half the pool:
   * the multifamily LTV median came out at 11%.
   *
   * They are detected by the specific columns the Annex dedicates to them.
   */
  {
    key: "coop_units",
    label: "Co-op Units",
    unit: "count",
    entity: "property",
    patterns: [/\bcoop\b.*\bcoop\s*units\b/i, /^\s*co-?op\s*units\b/i],
  },
  {
    key: "coop_sponsor_units",
    label: "Co-op Sponsor Units",
    unit: "count",
    entity: "property",
    patterns: [/\bcoop\b.*sponsor\s*units/i, /co-?op.*sponsor\s*units/i],
  },
  {
    key: "coop_rental_value",
    label: "Co-op Rental Value",
    unit: "currency",
    entity: "property",
    patterns: [/\bcoop\b.*rental\s*value/i, /co-?op.*rental\s*value/i],
  },
  {
    key: "coop_ltv_as_rental",
    label: "Co-op LTV as Rental",
    unit: "percent",
    entity: "deal",
    // The LTV the building would have if valued as a rental rather than as a
    // cooperative. It is the number comparable against normal multifamily.
    patterns: [/\bcoop\b.*ltv.*rental/i, /ltv\s*as\s*rental/i],
  },
  {
    key: "loan_property_flag",
    label: "Loan / Property Flag",
    unit: "text",
    entity: "deal",
    // Distinguishes the loan's row from the rows of its properties.
    // Without this, a loan with 2 properties generates 3 deals.
    // "Loan/Prop." is the abbreviation the 2020-2021 issuances use for the same
    // flag. Without it, the property rows of those vintages get counted as
    // loans —the bug that already cost us a whole iteration.
    patterns: [
      /loan\s*\/\s*property\s*flag/i,
      /loan\s*or\s*property/i,
      /^\s*loan\s*\/\s*prop\.?\s*$/i,
      // Plain "Loan": the 2020 issuances title the column that way, and its
      // values are "Loan" and "Property". It is told apart from the identifier
      // by its values, not by its name.
      /^\s*loan\s*$/i,
      // "Property Flag": Morgan Stanley 2021-L5 and its family. Same values
      // —"Loan" and "Property"— with the name inverted relative to the others.
      //
      // INCIDENT: without this pattern the classification falls back to the
      // heuristic, which on L5 left 19 loans and 52 property rows out of 71. The
      // real split is 65 and 6. Forty-six whole loans were being lost, silently:
      // no sanity check fires because the ones that remain are fine.
      /^\s*property\s*flag\s*$/i,
    ],
    // "Property Flag" must not take property_name or property_type, which run
    // later in the array but could compete for the same header.
    exclude: [/\bname\b/i, /\btype\b/i, /\bcount\b/i, /#/],
  },
  {
    key: "loan_id",
    label: "Loan ID",
    unit: "text",
    entity: "deal",
    /**
     * The key for joining the Annex A's horizontal blocks, and for joining
     * against the servicer report.
     *
     * SIX NAMES FOR THE SAME COLUMN.
     *
     * The first two patterns covered the 2022-2026 issuances. Against the
     * 2020-2021 ones they matched none: 33 issuances and 2,919 loans were left
     * WITHOUT an identifier, and therefore with no way to be joined to their
     * performance. Nothing visible failed —the loans harvested fine— they just
     * did not match anything afterwards.
     *
     * The names, with how many filings each appears in:
     *
     *   Mortgage Loan Number   13      Loan No.        2
     *   Control Number          7      Loan/Prop.      4  (that is the flag, not the id)
     *   Loan #                  5      Loan            4  (ALSO the flag)
     *
     * And the identifier in those same issuances is called plain "ID", in the
     * column next to it. Two columns for what the modern format solves with one.
     *
     * PLAIN "Loan" IS THE FLAG. I added it here thinking it was an abbreviated
     * identifier, and it was exactly the error the paragraph below warns about.
     * The symptom took a run to appear and came twofold: the loan_refs ended up
     * with the values "Loan" and "Property" —the flag's— and, since
     * `loan_property_flag` was left with no column, the property rows stopped
     * being filtered. Benchmark 2020-B18 went from 65 loans to 155 and its
     * observations per loan fell from 40 to 3.9.
     *
     * Both symptoms were the same bug. And the test I wrote asserted that
     * "Loan" should map to loan_id, so the suite blessed it.
     *
     * THE EXCLUSIONS ARE NOT OPTIONAL. "Mortgage Loan Seller" appears in 9
     * filings and matches /mortgage\s*loan/ perfectly; it would store the bank's
     * name as the identifier. Same for "Net Mortgage Loan Rate", "Crossed Loan",
     * "Loan per Net Rentable Area" and "Pari Passu Companion Loan Annual Debt
     * Service". A generous pattern without exclusions turns a hole into wrong
     * data, which is worse.
     */
    patterns: [
      /^\s*loan\s*id\b/i,
      /loan\s*id\s*number/i,
      /mortgage\s*loan\s*number/i,
      /control\s*number/i,
      /^\s*loan\s*#/i,
      /^\s*loan\s*no\.?\s*$/i,
      // The 2020 issuances split in two what the modern format joins: column 0
      // with the flag ("Loan"/"Property") and column 1 with the number, titled
      // just "ID". Without this pattern no block of those filings has a key,
      // none is joinable, and the horizontal join is left with the only table
      // that did have one —the mezzanine debt table, of one row.
      /^\s*id\s*$/i,
    ],
    exclude: [
      /seller/i, /rate/i, /cross/i, /flag/i, /\bper\b/i, /companion/i,
      /debt\s*service/i, /balance/i, /amount/i, /%|percent/i, /group/i,
      /purpose/i, /term/i, /type/i,
    ],
  },
  /**
   * Rates multiply by debt structure too.
   *
   * An Annex A publishes the mortgage loan's rate, the subordinate debt's and
   * the mezzanine's. Without separating them they all end up in `interest_rate`
   * and contaminate any series: mezzanine prices well above.
   *
   * Found while checking why a quarter's median rate came out at 84%.
   */
  {
    key: "interest_rate_mezzanine",
    label: "Mezzanine Interest Rate",
    unit: "percent",
    entity: "deal",
    patterns: [/mezzanine\b.*(interest\s*)?rate/i, /\bmezz\b.*rate/i],
  },
  {
    key: "interest_rate_subordinate",
    label: "Subordinate Interest Rate",
    unit: "percent",
    entity: "deal",
    patterns: [
      /subordinate\b.*(interest\s*)?rate/i,
      /companion\s*loan\b.*rate/i,
      /\bb-?note\b.*rate/i,
    ],
  },
  {
    key: "interest_rate",
    label: "Interest Rate",
    unit: "percent",
    entity: "deal",
    patterns: [/interest\s*rate/i, /\bcoupon\b/i, /mortgage\s*rate/i],
    exclude: [
      /type/i, /accrual/i,
      /mezzanine/i, /\bmezz\b/i, /subordinate/i, /companion/i, /\bb-?note\b/i,
    ],
  },
  {
    key: "cap_rate",
    label: "Cap Rate",
    unit: "percent",
    entity: "property",
    patterns: [/\bcap\s*rate\b/i, /capitalization\s*rate/i],
  },
  {
    key: "property_type",
    label: "Property Type",
    unit: "text",
    entity: "property",
    /**
     * "General Property Type" and "Detailed Property Type" tied at 1.00, so
     * which taxonomy got stored depended on the block order.
     *
     * They are not interchangeable granularities: the general one gives ~9
     * categories ("Retail"), the detailed one dozens ("Anchored Retail",
     * "Unanchored"). This column is the stratum for the single-type exclusion,
     * for benchmark composition and for every comparison by type — mixing them
     * makes two issuances incomparable with nothing to indicate it.
     *
     * The general one is preferred: fewer categories, more pairs per cell, and
     * it is the one the existing cuts already use. The detailed one has its own
     * key, `property_type_detailed`.
     */
    patterns: [/general\s*property\s*type/i, /property\s*type/i, /^\s*type\b/i, /asset\s*type/i],
    exclude: [/loan/i, /rate/i, /sub/i, /detailed/i],
  },
  {
    key: "loan_seller",
    label: "Mortgage Loan Seller",
    unit: "text",
    /**
     * WHO ORIGINATED THE LOAN, WHICH IS NOT WHO ASSEMBLED THE ISSUANCE
     *
     * All the "issuer" analysis had been attributing to BANK or BBCMS what their
     * sellers did. A BANK deal groups loans originated by Bank of America,
     * Morgan Stanley and Wells Fargo; the shelf is the packager.
     *
     * And it is the variable that can CONFIRM the effect rather than merely fail
     * to kill it: the same seller places into several issuances, so the design
     * is crossed by construction. Wells Fargo sells into BANK (SIR 0.42) and
     * into its own shelf (1.20). If the seller is what matters, holding it fixed
     * should flatten that difference.
     *
     * The entity is `property` because that is the Annex A's row level, not
     * because the seller describes a property: on a loan with several properties
     * the value repeats. It works anyway — the question is asked at loan level
     * and there the value is unique.
     *
     * THE EXCLUSIONS
     *
     * "Mortgage Loan Seller" already appeared in this file, but only as an
     * exclusion for `loan_amount` —the header appears in 9 filings and the
     * amount pattern was capturing it. Here the inverse path has to be avoided:
     * columns that talk about the seller without naming it, like the number of
     * loans it contributed or its percentage of the pool.
     */
    entity: "property",
    patterns: [
      /mortgage\s*loan\s*seller/i,
      /^\s*loan\s*seller\b/i,
      /\boriginator\b/i,
      /originating\s*(lender|bank)/i,
      /\bseller\b/i,
    ],
    exclude: [/count/i, /number\s*of/i, /#/, /\bpct\b/i, /percent/i, /%/, /balance/i, /amount/i],
  },
  {
    key: "property_name",
    label: "Property Name",
    unit: "text",
    entity: "property",
    patterns: [/property\s*name/i, /^\s*property\b/i, /loan\s*name/i],
    exclude: [/type/i, /address/i, /city/i, /state/i],
  },
  {
    key: "address",
    label: "Address",
    unit: "text",
    entity: "property",
    patterns: [/\baddress\b/i, /^\s*street\b/i],
  },
  {
    key: "city",
    label: "City",
    unit: "text",
    entity: "property",
    patterns: [/^\s*city\b/i],
  },
  {
    key: "state",
    label: "State",
    unit: "text",
    entity: "property",
    patterns: [/^\s*state\b/i],
  },
  {
    key: "zip",
    label: "Zip",
    unit: "text",
    entity: "property",
    patterns: [/\bzip\b/i, /postal\s*code/i],
  },

  // -------------------------------------------------------------------------
  // Blocks that used to be discarded whole
  // -------------------------------------------------------------------------
  //
  // An Annex A splits its columns into horizontal blocks joined by Loan ID.
  // Three of those blocks had NO mapped column at all, so `findHeaderRow`
  // —which requires four matches— judged them non-Annex and the pipeline
  // discarded them entirely. No loans were lost (the same IDs are in the blocks
  // we did read) but these metrics were, and invisibly: the "unmapped columns"
  // listing only covers blocks we actually opened.
  //
  // ORDEN Y COLISIONES
  //
  // The reserves go first and the debt service excludes them explicitly,
  // because "Upfront Debt Service Reserve" contains "Debt Service" and without
  // that `debt_service_pi` would take it. Same problem between "Underwritten TI
  // / LC" —an NCF deduction— and "Upfront TI/LC Reserve" —an escrow at closing:
  // they sound alike and are different things, so each excludes the other.

  {
    key: "reserve_tax_upfront",
    label: "Upfront RE Tax Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/upfront\s*(re\s*)?tax\s*reserve/i, /\btax\s*reserve\b.*upfront/i],
  },
  {
    key: "reserve_tax_monthly",
    label: "Monthly RE Tax Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/monthly\s*(re\s*)?tax\s*reserve/i],
  },
  {
    key: "reserve_insurance_upfront",
    label: "Upfront Insurance Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/upfront\s*insurance\s*reserve/i],
  },
  {
    key: "reserve_insurance_monthly",
    label: "Monthly Insurance Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/monthly\s*insurance\s*reserve/i],
  },
  {
    key: "reserve_replacement_cap",
    label: "Replacement Reserve Cap",
    unit: "currency",
    entity: "deal",
    patterns: [/replacement\s*reserve\s*caps?/i, /(replacement|ff\s*&?\s*e).*\bcaps?\b/i],
    exclude: [/\bti\s*\/?\s*lc\b/i],
  },
  {
    key: "reserve_replacement_upfront",
    label: "Upfront Replacement / PIP Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/upfront\s*replacement/i, /upfront.*\bpip\b/i],
    exclude: [/\bcaps?\b/i],
  },
  {
    key: "reserve_replacement_monthly",
    label: "Monthly Replacement / FF&E Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/monthly\s*replacement/i, /monthly.*ff\s*&?\s*e\s*reserve/i],
    exclude: [/\bcaps?\b/i],
  },
  {
    key: "reserve_tilc_cap",
    label: "TI/LC Reserve Cap",
    unit: "currency",
    entity: "deal",
    patterns: [/\bti\s*\/?\s*lc\b.*\bcaps?\b/i],
  },
  {
    key: "reserve_tilc_upfront",
    label: "Upfront TI/LC Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/upfront\s*ti\s*\/?\s*lc/i],
    exclude: [/\bcaps?\b/i, /underwritten/i],
  },
  {
    key: "reserve_tilc_monthly",
    label: "Monthly TI/LC Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/monthly\s*ti\s*\/?\s*lc/i],
    exclude: [/\bcaps?\b/i, /underwritten/i],
  },
  {
    key: "reserve_debt_service_cap",
    label: "Debt Service Reserve Cap",
    unit: "currency",
    entity: "deal",
    patterns: [/debt\s*service\s*reserve\s*caps?/i],
  },
  {
    key: "reserve_debt_service_upfront",
    label: "Upfront Debt Service Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/upfront\s*debt\s*service\s*reserve/i],
    exclude: [/\bcaps?\b/i],
  },
  {
    key: "reserve_debt_service_monthly",
    label: "Monthly Debt Service Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/monthly\s*debt\s*service\s*reserve/i],
    exclude: [/\bcaps?\b/i],
  },
  {
    key: "reserve_deferred_maintenance",
    label: "Upfront Deferred Maintenance Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/deferred\s*maintenance/i],
  },
  {
    key: "reserve_other_description",
    label: "Other Reserve Description",
    unit: "text",
    entity: "deal",
    patterns: [/other\s*reserve\s*description/i],
  },
  {
    key: "reserve_other_cap",
    label: "Other Reserve Cap",
    unit: "currency",
    entity: "deal",
    patterns: [/other\s*reserve\s*caps?/i],
  },
  {
    key: "reserve_other_upfront",
    label: "Upfront Other Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/upfront\s*other\s*reserve/i],
    exclude: [/\bcaps?\b/i, /description/i],
  },
  {
    key: "reserve_other_monthly",
    label: "Monthly Other Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/monthly\s*other\s*reserve/i],
    exclude: [/\bcaps?\b/i, /description/i],
  },

  // --- NCF deductions, not escrows -----------------------------------------
  //
  // These two are the difference between NOI and NCF: the underwriter subtracts
  // a theoretical replacement reserve and another for leasing commissions and
  // incentives. They are not deposited money —that is the reserve_* above— but a
  // calculation adjustment. Having them allows verifying NCF = NOI − these two.
  {
    key: "underwritten_replacement_reserve",
    label: "Underwritten Replacement / FF&E Reserve",
    unit: "currency",
    entity: "property",
    patterns: [/underwritten\s*replacement/i, /underwritten.*ff\s*&?\s*e\s*reserve/i],
  },
  {
    key: "underwritten_tilc",
    label: "Underwritten TI / LC",
    unit: "currency",
    entity: "property",
    patterns: [/underwritten\s*ti\s*\/?\s*lc/i],
  },

  // --- debt service and loan structure --------------------------------------
  {
    key: "debt_service_pi",
    label: "Annual Debt Service (P&I)",
    unit: "currency",
    entity: "deal",
    patterns: [/annual\s*debt\s*service\s*\(?\s*p\s*&?\s*i/i, /debt\s*service\s*\(?\s*p\s*&?\s*i/i],
    exclude: [/reserve/i, /coverage/i, /\bdscr\b/i],
  },
  {
    key: "debt_service_io",
    label: "Annual Debt Service (IO)",
    unit: "currency",
    entity: "deal",
    patterns: [/annual\s*debt\s*service\s*\(?\s*io\b/i, /debt\s*service\s*\(?\s*io\b/i],
    exclude: [/reserve/i, /coverage/i, /\bdscr\b/i],
  },
  {
    key: "amortization_type",
    label: "Amortization Type",
    unit: "text",
    entity: "deal",
    patterns: [/amorti[sz]ation\s*type/i],
  },
  {
    key: "interest_accrual_method",
    label: "Interest Accrual Method",
    unit: "text",
    entity: "deal",
    patterns: [/interest\s*accrual\s*method/i, /accrual\s*(method|basis)/i],
  },
  {
    key: "ard_loan",
    label: "ARD Loan",
    unit: "text",
    entity: "deal",
    patterns: [/\bard\s*loan\b/i],
  },
  {
    key: "io_period_original",
    label: "Original Interest-Only Period",
    unit: "count",
    entity: "deal",
    patterns: [/original\s*interest[-\s]*only\s*period/i, /original\s*\bio\b\s*period/i],
  },
  {
    key: "io_period_remaining",
    label: "Remaining Interest-Only Period",
    unit: "count",
    entity: "deal",
    patterns: [/remaining\s*interest[-\s]*only\s*period/i, /remaining\s*\bio\b\s*period/i],
  },
  {
    key: "amortization_term_original",
    label: "Original Amortization Term",
    unit: "count",
    entity: "deal",
    patterns: [/original\s*amorti[sz]ation\s*term/i],
  },
  {
    key: "amortization_term_remaining",
    label: "Remaining Amortization Term",
    unit: "count",
    entity: "deal",
    patterns: [/remaining\s*amorti[sz]ation\s*term/i],
  },
  {
    key: "term_original",
    label: "Original Term To Maturity / ARD",
    unit: "count",
    entity: "deal",
    patterns: [/original\s*term\s*to\s*maturity/i],
    exclude: [/amorti/i, /interest[-\s]*only/i],
  },
  {
    key: "term_remaining",
    label: "Remaining Term To Maturity / ARD",
    unit: "count",
    entity: "deal",
    patterns: [/remaining\s*term\s*to\s*maturity/i],
    exclude: [/amorti/i, /interest[-\s]*only/i],
  },
  {
    key: "origination_date",
    label: "Origination Date",
    unit: "text",
    entity: "deal",
    patterns: [/origination\s*date/i],
  },
  {
    key: "first_payment_date",
    label: "First Payment Date",
    unit: "text",
    entity: "deal",
    patterns: [/first\s*payment\s*date/i],
  },
  {
    key: "seasoning_months",
    label: "Seasoning",
    unit: "count",
    entity: "deal",
    patterns: [/\bseasoning\b/i],
  },
  {
    key: "property_count",
    label: "# of Properties",
    unit: "count",
    entity: "deal",
    patterns: [/#\s*of\s*properties/i, /number\s*of\s*properties/i],
  },

  // --- cash flow control ----------------------------------------------------
  {
    key: "holdback_amount",
    label: "Holdback / Earnout Amount",
    unit: "currency",
    entity: "deal",
    patterns: [/holdback\s*\/?\s*earnout\s*amount/i, /\bearnout\s*amount/i],
    exclude: [/description/i],
  },
  {
    key: "holdback_description",
    label: "Holdback / Earnout Description",
    unit: "text",
    entity: "deal",
    patterns: [/holdback\s*\/?\s*earnout\s*description/i, /\bearnout\s*description/i],
  },
  {
    key: "lockbox_type",
    label: "Lockbox Type",
    unit: "text",
    entity: "deal",
    patterns: [/\blockbox\b/i],
  },
  {
    key: "cash_management",
    label: "Cash Management",
    unit: "text",
    entity: "deal",
    patterns: [/cash\s*management/i],
  },
  // -------------------------------------------------------------------------
  // The other six balances
  // -------------------------------------------------------------------------
  //
  // It is the same trap as LTV, worse. With LTV there were three denominators;
  // with the balance there are seven columns named almost identically that mean
  // different things. The ratios the issuer publishes —debt yield, DSCR, LTV—
  // are computed against the entire loan, not against the trust's portion, so
  // without these columns no identity can close on the large loans.

  {
    key: "balance_whole_loan",
    label: "Whole Loan Cut-off Date Balance",
    unit: "currency",
    entity: "deal",
    patterns: [/whole\s*loan\s*cut-?off\s*date\s*balance/i, /whole\s*loan\s*balance/i],
    exclude: [/%|percent/i, /ltv/i, /dscr/i, /debt\s*yield/i],
  },
  /**
   * The full senior, published in a single column.
   *
   * FOUND BY THE RECONCILER, NOT BY READING HEADERS
   *
   * The issuer's ratios are computed against trust + non-trust pari passu, and
   * we were assembling that by adding two metrics. It turns out several
   * issuances publish that total in a column of its own —"Total Cut-off Date
   * Pari Passu Debt"— and we were ignoring it.
   *
   * It did not come from looking at the list of unmapped columns: it came from
   * asking which cell of each row is worth the balance implied by the identity.
   * 33 loans across 4 issuances matched within 1%, with examples like 1,001.0M
   * against an implied 1,001.3M. The column was identified by its value, not by
   * its name.
   *
   * It is worth more than the sum when present: it does not depend on both parts
   * having been mapped correctly, nor on the Annex publishing both.
   *
   * NOT to be confused with `balance_total_debt`, which also includes the
   * subordinate and the mezzanine. They coincide only when the loan has no
   * junior debt, which is why "Total Debt Cut-off Balance" also turned up in the
   * reconciler — that one stays where it is, because on a loan with a B-note it
   * would give an inflated denominator.
   */
  {
    key: "balance_senior_total",
    label: "Total Senior (Trust + Pari Passu) Cut-off Balance",
    unit: "currency",
    entity: "deal",
    patterns: [
      /total\s*cut-?off\s*date\s*pari\s*passu\s*debt/i,
      /total\s*current\s*balance\s*pari\s*passu\s*debt/i,
      /total\s*pari\s*passu\s*debt\s*(cut-?off|current)/i,
      /total\s*senior\s*notes?\s*cut-?off\s*date\s*balance/i,
      /senior\s*notes?\s*cut-?off\s*date\s*balance/i,
      // The original goes last: same criterion as loan_amount, where both exist
      // the cut-off date one wins.
      /total\s*original\s*balance\s*pari\s*passu\s*debt/i,
    ],
    exclude: [
      /%|percent/i, /\bltv\b/i, /dscr/i, /debt\s*yield/i,
      /per\s*(unit|sf)/i, /\(y\s*\/\s*n\)/i, /monthly|annual/i,
    ],
  },
  {
    key: "balance_pari_passu_trust",
    label: "Trust Pari Passu Cut-off Date Balance",
    unit: "currency",
    entity: "deal",
    patterns: [/\btrust\s*pari\s*passu\b.*balance/i],
    exclude: [/non-?\s*trust/i, /%|percent/i],
  },
  {
    key: "balance_pari_passu_non_trust",
    label: "Non-Trust Pari Passu Companion Loan Cut-off Date Balance",
    unit: "currency",
    entity: "deal",
    /**
     * The second pattern covers the issuances that do not write "non-trust".
     *
     * A "companion loan" is, by definition, the portion that is NOT in this
     * trust: if it were, it would not be a companion. So "Cut-off Date Pari
     * Passu Companion Loan Balance ($)" is the same concept under another name.
     * It appears in 7 issuances that today have 144 loans with a broken debt
     * yield.
     *
     * It is an inference about terminology, not a certainty. The proof is the
     * identity: if mapping it makes the debt yield close on those 144, the
     * concept was what we think. If the denominator overshoots, the column also
     * included the trust's portion and it has to be subtracted.
     *
     * The exclusions are the flags and the flows: the same block carries
     * "Pari Passu (Y/N)" and "Pari Passu Companion Loan Annual Debt Service ($)".
     */
    /**
     * ORIGINAL AND CUT-OFF DATE ARE NOT THE SAME BALANCE HERE EITHER.
     *
     * `loan_amount` distinguishes the two —it prefers the cut-off one and sends
     * the original to its own metric— because on a loan that has amortised they
     * do not coincide. This metric had forgotten to make the same distinction.
     *
     * The result was worse than an imprecise number: the denominator was adding
     * the trust's cut-off date balance to the companion's ORIGINAL balance. Two
     * different dates in the same sum. CF 2020-CF4 and Benchmark 2020-B18 mapped
     * "Non-Trust Pari Passu Original Balance($)" and none of their rows closed
     * the debt yield identity.
     *
     * The patterns run from more specific to more general: where the Annex
     * publishes both columns the cut-off one wins, and where only the original
     * exists that is used —with the mixed date, but visible in the header we store.
     */
    patterns: [
      /non-?\s*trust\s*pari\s*passu.*cut-?off\s*date.*balance/i,
      /cut-?off\s*date\s*pari\s*passu(?!.*\btrust\b).*balance/i,
      /pari\s*passu\s*companion\s*loan\s*cut-?off.*balance/i,
      /non-?\s*trust\s*pari\s*passu.*balance/i,
      /pari\s*passu\s*companion\s*loan.*balance/i,
      // "Pari Passu Piece Non-Trust Cut-Off Balance" y "Original Balance Piece
      // Non-Trust ($)": 52 loans across 5 issuances, identified by the
      // reconciler because their value equals what the trust balance is missing.
      /pari\s*passu\s*piece\s*non-?\s*trust.*balance/i,
      /balance\s*piece\s*non-?\s*trust/i,
    ],
    exclude: [
      /%|percent/i, /\(y\s*\/\s*n\)/i, /control/i,
      /debt\s*service/i, /monthly|annual/i, /per\s*(unit|sf)/i,
    ],
  },
  {
    key: "balance_subordinate",
    label: "Subordinate Companion Loan Cut-off Date Balance",
    unit: "currency",
    entity: "deal",
    patterns: [/subordinate\s*companion.*balance/i, /\bb-?note\b.*balance/i],
    exclude: [/%|percent/i],
  },
  {
    key: "balance_mezzanine",
    label: "Mezzanine Debt Cut-off Date Balance",
    unit: "currency",
    entity: "deal",
    patterns: [/mezzanine\s*debt.*balance/i, /\bmezz\b.*balance/i],
    exclude: [/%|percent/i, /rate/i],
  },
  {
    key: "balance_total_debt",
    label: "Total Debt Cut-off Date Balance",
    unit: "currency",
    entity: "deal",
    // The denominator of ltv_total_debt and debt_yield_total_debt, which we were
    // already mapping without ever having its base. It appears in 176 filings.
    patterns: [/total\s*(mortgage\s*)?debt\s*cut-?off\s*date\s*balance/i, /total\s*(mortgage\s*)?debt\s*balance/i],
    exclude: [/%|percent/i, /ltv/i, /dscr/i, /debt\s*yield/i, /\bper\b/i],
  },
  {
    key: "balance_maturity",
    label: "Maturity / ARD Balance",
    unit: "currency",
    entity: "deal",
    patterns: [/maturity\s*\/?\s*ard\s*balance/i, /balloon\s*balance/i],
    exclude: [/%|percent/i, /ltv/i],
  },
  {
    key: "balance_original",
    label: "Original Balance",
    unit: "currency",
    entity: "deal",
    /**
     * The generic pattern goes third ON PURPOSE.
     *
     * `scoreHeader` decays 0.08 per position, so this spec scores 0.84 on
     * "Original Balance ($)" while `loan_amount` scores 0.92 on the same header.
     * The assignment is greedy and global, so the effect is:
     *
     *   there is "Cut-off Date Balance"  → loan_amount takes it (1.00) and the
     *                                      original falls here
     *   only "Original Balance" exists   → loan_amount takes it (0.92 > 0.84)
     *
     * It is the fallback that was needed: an Annex A that does not publish a
     * cut-off date balance still has to produce `loan_amount`. Without this
     * order, that format family would be left with no balance, silently.
     */
    patterns: [
      // The first two are unusual spellings and are here only so the generic one
      // lands at index 2 and scores 0.84. "Original Principal Balance" does NOT
      // go above: it is the same column written out in full, and putting it
      // first stole the balance from `loan_amount` in the Annex A files that use it.
      /original\s*balance\s*at\s*securiti[sz]ation/i,
      /balance\s*at\s*origination/i,
      /original\s*(principal\s*)?balance/i,
    ],
    exclude: [
      /whole\s*loan/i, /pari\s*passu/i, /companion/i, /subordinate/i,
      /mezzanine/i, /%|percent/i, /cut-?off/i,
    ],
  },
  {
    key: "pool_share",
    label: "% of Initial Pool Balance",
    unit: "percent",
    entity: "deal",
    patterns: [/%\s*of\s*initial\s*pool\s*balance/i, /%\s*of\s*pool/i],
  },
];

export interface ColumnMatch {
  columnIndex: number;
  header: string;
  metric: MetricSpec;
  score: number;
}

/**
 * Does this text identify a metric on its own, without context?
 *
 * Used by the HTML header merging to decide whether it needs to glue the group
 * header on. "Net Rentable Area (SF)" stands alone; plain "NOI" does not —it
 * could be underwritten or trailing— and needs the group.
 *
 * The threshold is high on purpose: when in doubt it is better to merge,
 * because an ambiguous header can be disambiguated by the group, but a header
 * contaminated by the group gets mapped wrong silently.
 */
export function mapsToSomeMetric(header: string, minScore = 0.9): boolean {
  for (const spec of METRIC_SPECS) {
    if (scoreHeader(header, spec) >= minScore) return true;
  }
  return false;
}

/**
 * Scores a header against a metric.
 * 0 = does not apply. The more specific the matching pattern, the higher.
 */
export function scoreHeader(header: string, spec: MetricSpec): number {
  const clean = header.replace(/\s+/g, " ").trim();
  if (!clean) return 0;

  if (spec.exclude?.some((re) => re.test(clean))) return 0;

  for (let i = 0; i < spec.patterns.length; i++) {
    if (spec.patterns[i]!.test(clean)) {
      // The first patterns in the list are the most specific.
      return 1 - i * 0.08;
    }
  }
  return 0;
}

/**
 * Maps a spreadsheet's headers to metrics.
 *
 * It resolves conflicts: if two columns match the same metric, the higher score
 * wins. If one column matches several metrics, the higher score wins. That is
 * how we stop "UW NOI" and "Most Recent NOI" ending up in the same one.
 */
export function mapColumns(headers: string[]): {
  matches: ColumnMatch[];
  unmapped: Array<{ columnIndex: number; header: string }>;
} {
  const candidates: ColumnMatch[] = [];

  headers.forEach((header, columnIndex) => {
    if (!header?.trim()) return;
    for (const metric of METRIC_SPECS) {
      const score = scoreHeader(header, metric);
      if (score > 0) candidates.push({ columnIndex, header, metric, score });
    }
  });

  candidates.sort((a, b) => b.score - a.score);

  const usedColumns = new Set<number>();
  const usedMetrics = new Set<MetricKey>();
  const matches: ColumnMatch[] = [];

  for (const c of candidates) {
    if (usedColumns.has(c.columnIndex) || usedMetrics.has(c.metric.key)) continue;
    usedColumns.add(c.columnIndex);
    usedMetrics.add(c.metric.key);
    matches.push(c);
  }

  matches.sort((a, b) => a.columnIndex - b.columnIndex);

  const unmapped = headers
    .map((header, columnIndex) => ({ columnIndex, header }))
    .filter((h) => h.header?.trim() && !usedColumns.has(h.columnIndex));

  return { matches, unmapped };
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/**
 * Converts the cell's raw value to the metric's type.
 *
 * Annex A documents mix formats without mercy: "$1,234,567", "1234567", "94.5%",
 * "0.945", "1.25x", "N/A", "-", "" and empty cells. Returns null when there is
 * no datum — which is different from zero.
 */
export function parseValue(raw: unknown, unit: MetricSpec["unit"]): string | null {
  if (raw === null || raw === undefined) return null;

  if (unit === "text") {
    const s = String(raw).trim();
    return s && !isNullish(s) ? s : null;
  }

  let s = String(raw).trim();
  if (!s || isNullish(s)) return null;

  const hadPercentSign = s.includes("%");
  const isNegative = /^\(.*\)$/.test(s); // contabilidad: (1,234) = -1234

  /**
   * A number with a space in the middle is not a number.
   *
   */
  const withoutMoney = s.replace(/[$,()%]/g, "").replace(/x$/i, "").trim();
  if (/\d[\s\u00a0]+\d/.test(withoutMoney)) return null;

  s = s
    .replace(/[$,\s]/g, "")
    .replace(/[()]/g, "")
    .replace(/x$/i, "")
    .replace(/%/g, "");

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  let value = isNegative ? -n : n;

  if (unit === "percent") {
    // "94.5%" → 0.945 ; "0.945" is already a fraction.
    // Heuristic: with a % sign, or without one but > 1.5, we assume a percentage.
    if (hadPercentSign || value > 1.5) value = value / 100;
    // Dividing by 100 introduces floating-point noise: 93.1/100 gives
    // 0.9309999999999999. We round to 6 decimals, which is more precision than
    // any Annex A reports.
    value = round(value, 6);
  }

  if (unit === "ratio") {
    value = round(value, 4);
  }

  if (unit === "count" || unit === "years") {
    value = Math.round(value);
    // A year out of range is junk, not data.
    if (unit === "years" && (value < 1700 || value > 2100)) return null;
  }

  return String(value);
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/**
 * Recognises aggregation rows: totals, subtotals, averages.
 *
 * Annex A documents interleave these rows among the data and they have to be
 * discarded. Counting observations is not enough: a "TOTAL" row with summed NOI
 * and balance has enough data to pass the count filter.
 */
export function looksLikeAggregateRow(textValues: Array<string | null>): boolean {
  const AGGREGATE = /^\s*(grand\s+)?(total|subtotal|sub-total|average|avg|weighted\s*average|wtd\.?\s*avg|sum|count|min|max|median)\b/i;
  return textValues.some((v) => v !== null && AGGREGATE.test(v));
}

/**
 * "No data" markers that appear in real Annex A documents.
 *
 * `NAP` (not applicable) and `NAV` (not available) are CMBS convention and mean
 * different things to an analyst, but for us both are an absent datum.
 * `Various` appears when a loan covers several properties with different values
 * — that is not a number either.
 */
function isNullish(s: string): boolean {
  return /^(n\/?a|na|nap|nav|none|null|various|-+|—|\.\.\.)$/i.test(s.trim());
}

/**
 * Finds the header row in a spreadsheet.
 *
 * Annex A documents start with title rows, logos and notes before the real
 * table. We look for the first row that maps at least `minMatches` metrics.
 */
export function findHeaderRow(
  rows: unknown[][],
  opts: { maxScan?: number; minMatches?: number } = {},
): { rowIndex: number; headers: string[]; matchCount: number } | null {
  const maxScan = opts.maxScan ?? 30;
  const minMatches = opts.minMatches ?? 4;

  let best: { rowIndex: number; headers: string[]; matchCount: number } | null = null;

  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const headers = (rows[i] ?? []).map((c) => (c === null || c === undefined ? "" : String(c)));
    const nonEmpty = headers.filter((h) => h.trim()).length;
    if (nonEmpty < minMatches) continue;

    const { matches } = mapColumns(headers);
    if (matches.length >= minMatches && (!best || matches.length > best.matchCount)) {
      best = { rowIndex: i, headers, matchCount: matches.length };
    }
  }

  return best;
}

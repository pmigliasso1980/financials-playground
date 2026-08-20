/**
 * CRE taxonomy definitions.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 *
 * `columnMap.ts` solves the technical problem: which pattern matches which
 * column. This file holds the domain problem: what each metric means and why it
 * is distinct from its neighbours.
 *
 * The separation is deliberate. The patterns are code and a programmer reviews
 * them; the definitions are industry knowledge and have to be reviewable by
 * someone who underwrites deals, without reading TypeScript. `npm run taxonomy`
 * generates a document for exactly that.
 *
 * Every entry here earned its place by breaking something with real data. The
 * ones with no note never caused a problem.
 */

import type { MetricKey } from "./columnMap.js";

/**
 * Taxonomy version.
 *
 * Recorded with every observation so we can measure whether a change improved
 * or worsened corpus coverage. Bump it when metrics are added or redefined, not
 * when a pattern is adjusted.
 */
/**
 * 2026.08.17: the corpus starts storing property rows.
 *
 * The version is bumped because the content of a harvest changed, not because a
 * metric changed. `harvest:batch` re-harvests anything that does not match this
 * version, so all 233 issuances are marked to be downloaded again — it is the
 * only way to populate corpus.properties without writing a separate migration
 * path.
 */
export const TAXONOMY_VERSION = "2026.08.17";

export interface MetricDefinition {
  /** What it measures, in one sentence someone in the industry would understand. */
  definition: string;
  /**
   * What it gets confused with and how to tell them apart. Only where there was
   * a real problem.
   */
  disambiguation?: string;
  /** What happened when it was wrong. The evidence for why the distinction matters. */
  incident?: string;
  /** Conceptual family, for grouping in the document. */
  family?: string;
}

export const DEFINITIONS: Partial<Record<MetricKey, MetricDefinition>> = {
  // -------------------------------------------------------------------------
  // The seven balances
  // -------------------------------------------------------------------------

  balance_whole_loan: {
    family: "Balances",
    definition:
      "The balance of the entire loan, adding up all the pari passu notes wherever they sit.",
    disambiguation:
      "This is the number the issuer computes its ratios against, because the NOI it publishes is for the whole property. Comparing the whole NOI against the trust's portion is comparing things of different scales.",
  },
  balance_pari_passu_non_trust: {
    family: "Balances",
    definition:
      "The part of the loan that sits in OTHER issuances, with the same payment priority as ours.",
    disambiguation:
      "Added to the trust balance it gives the senior total. 'Pari passu' means they get paid equally: neither note is subordinated to the other, they are just split across different issuances.",
  },
  balance_subordinate: {
    family: "Balances",
    definition:
      "Debt on the same property that gets paid AFTER the senior notes. Usually called a B-note.",
    disambiguation:
      "It is not pari passu: it is subordinated. That is why 'whole loan' LTV and plain LTV differ —one includes it and the other does not— and why a loan can look conservative at trust level and leveraged at property level.",
  },
  balance_mezzanine: {
    family: "Balances",
    definition:
      "Debt secured by the owner's equity interests, not by the property.",
    disambiguation:
      "It does not appear in the loan's LTV but it exists and competes for the same cash flow. It is the layer that makes 'total debt LTV' larger than 'whole loan LTV'.",
  },
  balance_original: {
    family: "Balances",
    definition: "The amount at origination, before any amortisation.",
    disambiguation:
      "It differs from the cut-off date balance only on loans that have already amortised something. In a mostly interest-only pool they are nearly identical, and that coincidence is precisely what makes them easy to confuse.",
  },

  // -------------------------------------------------------------------------
  // Debt service and loan structure
  // -------------------------------------------------------------------------

  debt_service_pi: {
    family: "Debt service",
    definition:
      "The annual principal and interest payment the loan requires once it starts amortising. It is the denominator of the DSCR.",
    disambiguation:
      "It lives alongside 'Annual Debt Service (IO)', which is the payment during the interest-only period and is always smaller. A loan with two years of IO has two different debt services depending on the moment, and the published DSCR is usually computed against the IO one — which makes it look better than it will be once amortisation starts.",
    incident:
      "This metric did not exist: the whole Annex A block containing it was being discarded because none of its columns was mapped. We had been reading the already-computed DSCR without ever having its two parts, that is, with no way to verify it or recompute it under a different assumption.",
  },
  debt_service_io: {
    family: "Debt service",
    definition:
      "The annual payment during the interest-only period, with no principal amortisation.",
    disambiguation:
      "Always smaller than the P&I. The difference between the two is how much the instalment rises when the IO ends, and it is the direct measure of refinancing risk for a loan that currently pays comfortably.",
  },
  amortization_type: {
    family: "Debt service",
    definition:
      "How the loan repays principal: 'Interest Only' for its whole life, 'Amortizing' from the start, or 'Interest Only, Amortizing' with partial IO.",
    disambiguation:
      "A pool that is mostly Interest Only amortises nothing, so all the principal falls due at the end. It is a structural characteristic that no ratio metric shows.",
  },
  term_original: {
    family: "Debt service",
    definition: "Original term to maturity or to the ARD, in months.",
    disambiguation:
      "Not to be confused with the amortisation term, which is usually much longer —typically 360 months— and defines the instalment, not the maturity. A loan with a term of 120 and amortisation of 360 repays a small fraction of principal before maturing.",
  },
  amortization_term_original: {
    family: "Debt service",
    definition:
      "The term over which the instalment is computed, in months. Normally 360, even when the loan matures much sooner.",
    disambiguation:
      "It is a calculation assumption, not a real date. The two terms share the word 'term' and the unit, and confusing them either triples or thirds the loan's horizon.",
  },
  ard_loan: {
    family: "Debt service",
    definition:
      "Whether the loan has an Anticipated Repayment Date: a date at which repayment is expected and after which the rate rises sharply and cash flow is swept to amortise.",
    disambiguation:
      "The ARD acts as the effective maturity even when legal maturity is later. The 'at maturity' LTV and DSCR of a loan with an ARD are computed at the ARD, not at legal maturity.",
  },

  // -------------------------------------------------------------------------
  // Reserves: money deposited versus calculation adjustments
  // -------------------------------------------------------------------------
  //
  // This is the slipperiest distinction in the new block, because the names are
  // nearly identical and the concepts have nothing in common.

  underwritten_tilc: {
    family: "Reserves",
    definition:
      "An annual deduction the underwriter subtracts from NOI for leasing commissions and tenant improvements. It is not money that exists: it is an adjustment to estimate sustainable cash flow.",
    disambiguation:
      "It gets confused with 'Upfront TI/LC Reserve', which IS money deposited in escrow at closing. One is a model assumption and the other is a bank balance. The header differs only in the first word —'Underwritten' versus 'Upfront'— and both contain 'TI/LC'.",
    incident:
      "Together with underwritten_replacement_reserve it is the difference between NOI and NCF. Without them we had both ends of that subtraction and neither of the subtrahends, so there was no way to verify that NCF = NOI − reserves.",
  },
  underwritten_replacement_reserve: {
    family: "Reserves",
    definition:
      "An annual deduction for replacing capital components —roofs, equipment, furniture in hotels. Like the previous one, it is a calculation adjustment, not a deposit.",
    disambiguation:
      "Its escrow twin is 'Upfront Replacement / PIP Reserve'. In hotels it appears as FF&E, which is the same idea under another name.",
  },
  reserve_tilc_upfront: {
    family: "Reserves",
    definition:
      "Money actually deposited at closing to cover future leasing commissions and tenant improvements.",
    disambiguation:
      "It is a real balance, unlike underwritten_tilc which is an assumption. A building with high vacancy usually comes with a large reserve here: the lender wants the money set aside before lending.",
  },
  reserve_debt_service_upfront: {
    family: "Reserves",
    definition:
      "A fund deposited at closing to pay instalments if cash flow falls short.",
    disambiguation:
      "It contains the phrase 'Debt Service' just like the debt service metrics, but it is the opposite: not an obligation, a cushion against one. Its presence usually indicates the lender doubted the property would cover the instalment from day one.",
  },

  // -------------------------------------------------------------------------
  // Cash flow control
  // -------------------------------------------------------------------------

  lockbox_type: {
    family: "Cash flow control",
    definition:
      "Who collects the rent. 'Hard' means tenants pay directly into a lender-controlled account; 'Soft' means the borrower collects and transfers; 'Springing' means it activates if a threshold is breached.",
    disambiguation:
      "It is one of the few Annex A variables that describes control rather than magnitude. Two loans with the same DSCR and a different lockbox have very different loss severities if the borrower comes under stress.",
  },
  cash_management: {
    family: "Cash flow control",
    definition:
      "Whether excess cash is swept into lender accounts. Usually activated by a trigger rather than from closing.",
  },
  holdback_amount: {
    family: "Cash flow control",
    definition:
      "Part of the loan approved but not funded, released if the property meets a condition —leasing a space, reaching an NOI.",
    disambiguation:
      "A large holdback indicates the current balance does not reflect the full loan. Ratios computed on the funded balance look better than they will be once the rest is released.",
  },

  // -------------------------------------------------------------------------
  // Operating result
  // -------------------------------------------------------------------------

  noi_underwritten: {
    family: "Operating result",
    definition:
      "The NOI the originator projects for the loan. It is an estimate, not a historical figure: it incorporates signed leases not yet producing, expected savings and projected stabilisation.",
    disambiguation:
      "It is not the same as actual NOI. The difference between the two measures how far underwriting stretches, and is one of the few market-aggressiveness signals computable from public data.",
    incident:
      "The header 'Underwritten NOI DSCR (x)' contains the words 'Underwritten' and 'NOI', so a generic pattern took it. A hotel's NOI was stored as 1.83 —its DSCR— instead of $10,932,267.",
  },
  noi_most_recent: {
    family: "Operating result",
    definition:
      "The NOI of the last closed period, normally the trailing twelve months. It is what the property actually produced.",
    disambiguation:
      "An Annex A publishes up to four vintages of NOI. The pattern /most recent.*noi/ also matches 'Second Most Recent' and 'Third Most Recent'.",
    incident:
      "Without distinguishing them, whichever appeared first in the spreadsheet won —usually the oldest. A hotel in Chicago reported $9.7M when its latest NOI was $11.4M: a 17% difference, under the wrong label.",
  },
  noi_second_most_recent: {
    family: "Operating result",
    definition: "The NOI of the second-to-last closed period, typically two years ago.",
    disambiguation:
      "Together with third most recent it forms the historical series. Keeping them separate makes it possible to answer how a property has been evolving, not just where it stands.",
  },
  noi_third_most_recent: {
    family: "Operating result",
    definition: "The NOI from three periods ago.",
  },
  net_cash_flow: {
    family: "Operating result",
    definition:
      "NOI minus capital reserves: replacements, tenant improvements and leasing commissions. It is what is actually left to service the debt.",
    disambiguation:
      "Always smaller than NOI. Ratios computed on NCF are more conservative than those computed on NOI, and an Annex A publishes both.",
  },
  egi_underwritten: {
    family: "Operating result",
    definition:
      "Potential gross income minus vacancy, concessions and bad debt, per the underwriter's projection. The numerator before subtracting expenses.",
    disambiguation:
      "It is a projection, not a measurement: not to be confused with egi_most_recent, which is what the building produced in the last reported period.",
  },
  egi_most_recent: {
    family: "Operating result",
    definition: "EGI actually realised in the last reported period.",
  },
  expenses_underwritten: {
    family: "Operating result",
    definition: "Operating expenses projected by the underwriter. EGI minus expenses gives NOI.",
  },
  expenses_most_recent: {
    family: "Operating result",
    definition: "Operating expenses actually incurred in the last reported period.",
  },

  // -------------------------------------------------------------------------
  // Debt structure
  // -------------------------------------------------------------------------

  ltv: {
    family: "Debt structure",
    definition:
      "Loan-to-value of the loan that sits in THIS trust, measured against the appraisal at closing.",
    disambiguation:
      "A large loan is split into pari passu notes distributed across several trusts. The trust LTV measures only the piece securitised here; the whole loan measures the entire loan; total debt additionally adds mezzanine and subordinate. Three different denominators.",
    incident:
      "We mapped 'Whole Loan Cut-off Date LTV' instead of 'Cut-off Date LTV'. Since only split loans have a whole loan figure, coverage came out at 8 of 32 loans. The value was correct; the metric was another one.",
  },
  ltv_whole_loan: {
    family: "Debt structure",
    definition:
      "LTV measured against the entire loan, including the pari passu notes that stayed in other trusts.",
    disambiguation:
      "It only exists for split loans. Its absence on a loan is not a missing datum: it means the loan is not structured that way.",
  },
  ltv_total_debt: {
    family: "Debt structure",
    definition:
      "LTV including all the debt on the property: the mortgage loan plus mezzanine and subordinate.",
    disambiguation:
      "It is the asset's real leverage. It can be substantially larger than the trust LTV, and it is the number that matters for assessing default risk.",
  },
  ltv_maturity: {
    family: "Debt structure",
    definition:
      "LTV projected to maturity or to the anticipated repayment date, after the period's amortisation.",
    disambiguation:
      "It measures refinancing risk, not leverage at origination. On interest-only loans it coincides with the closing LTV.",
  },
  dscr: {
    family: "Debt structure",
    definition:
      "Debt service coverage computed on NOI: how many times the operating result covers the payments.",
    disambiguation:
      "Distinguish it from DSCR on NCF, which deducts reserves and is always lower. And from the whole loan and total debt variants, which change the denominator.",
  },
  dscr_ncf: {
    family: "Debt structure",
    definition:
      "Coverage computed on net cash flow, that is, after capital reserves. The conservative measure.",
  },
  dscr_whole_loan: {
    family: "Debt structure",
    definition: "DSCR against the debt service of the entire loan, not just the trust's piece.",
  },
  dscr_total_debt: {
    family: "Debt structure",
    definition: "DSCR against the service of all the debt, mezzanine included.",
  },
  debt_yield: {
    family: "Debt structure",
    definition:
      "NOI divided by the loan balance. It measures the lender's return if it had to take the property, without depending on appraisals.",
    disambiguation:
      "Unlike LTV, it does not use the appraised value, so it is not distorted when appraisals inflate. That is why many underwriters prefer it.",
  },
  debt_yield_ncf: {
    family: "Debt structure",
    definition: "Debt yield computed on net cash flow.",
  },
  debt_yield_whole_loan: {
    family: "Debt structure",
    definition: "Debt yield against the balance of the entire loan.",
  },
  debt_yield_total_debt: {
    family: "Debt structure",
    definition: "Debt yield against the total debt on the property.",
  },
  loan_amount: {
    family: "Balances",
    definition:
      "The balance of the loan THIS trust holds as of the cut-off date. It is what the issuance bought, not what the borrower owes.",
    disambiguation:
      "An Annex A publishes seven balances for the same loan and this is only one of them. The ratios the issuer publishes —debt yield, DSCR, LTV— are not computed against this number when the loan is split across several trusts: they are computed against the entire loan, because the NOI it publishes is for the whole property.",
    incident:
      "It pointed at 'Original Balance ($)' without excluding qualifiers. Tysons Corner Center came out with $2,460,000 —this trust's slice of a $709M loan— and the computed debt yield gave 3947%. The arithmetic identities gave it away: the balance implied by debt yield and the one implied by LTV agreed at 288x to three digits.",
  },
  interest_rate: {
    family: "Debt structure",
    definition: "The mortgage loan's rate.",
    disambiguation:
      "An Annex A also publishes the subordinate debt rate and the mezzanine rate, which price well above. Mixing them contaminates any cost-of-debt series.",
    incident:
      "A time series showed median rates of 84% and 0% in certain quarters. The raw values were '480' and '360': amortisation terms in months reaching the rate column via a badly adopted table. No range validation existed because each loose value looked like a percentage.",
  },

  // -------------------------------------------------------------------------
  // Cooperatives
  // -------------------------------------------------------------------------

  coop_units: {
    family: "Cooperatives",
    definition:
      "The number of units in a housing cooperative. Its presence identifies the loan as cooperative, which is a segment with its own economics.",
    disambiguation:
      "Cooperatives come classified as Multifamily but do not behave the same way: the co-op owns the building and takes minimal debt against a high value. An LTV of 10-20% with a DSCR of 4x to 12x is normal there.",
    incident:
      "I flagged a median LTV of 11% in one issuer family as broken data, assuming a CMBS loan does not price like that. The arithmetic said otherwise —an $8.5M loan against a $38.6M appraisal, a normal 5.9% cap rate— and the columns that explained it had been sitting in the unmapped headers list for hours, dismissed as niche. The error was interpretation, not extraction: the data was right all along.",
  },
  coop_ltv_as_rental: {
    family: "Cooperatives",
    definition:
      "The LTV the building would have if valued as a rental property instead of as a cooperative.",
    disambiguation:
      "It is the only leverage number comparable between a cooperative and conventional multifamily. A cooperative's normal LTV cannot go in the same table as everyone else's.",
  },
  coop_rental_value: {
    family: "Cooperatives",
    definition: "Value of the building appraised as a rental property.",
  },
  coop_sponsor_units: {
    family: "Cooperatives",
    definition:
      "Units still retained by the original conversion sponsor. A high proportion indicates an immature cooperative, with more risk.",
  },

  // -------------------------------------------------------------------------
  // Occupancy
  // -------------------------------------------------------------------------

  occupancy: {
    family: "Occupancy",
    definition:
      "Physical or leased occupancy: what proportion of the space is occupied or under contract.",
    disambiguation:
      "Different from economic occupancy, which deducts concessions and bad debt and is always lower or equal. Many Annex A documents publish only one of the two.",
    incident:
      "An /economic/ exclusion meant to separate them ended up discarding the only occupancy that Annex published, and we were left with none.",
  },
  occupancy_economic: {
    family: "Occupancy",
    definition:
      "Economic occupancy: the proportion of potential income actually collected, after concessions, free-rent periods and bad debt.",
    disambiguation:
      "A building can be 100% leased and have 85% economic occupancy if it gave away free months. The gap between the two is a signal of market softness.",
  },

  // -------------------------------------------------------------------------
  // Physical
  // -------------------------------------------------------------------------

  units: {
    family: "Physical",
    definition:
      "The number of countable units: apartments, hotel rooms, pads or beds depending on the asset type.",
    disambiguation:
      "An Annex A uses a single 'Number of Units' column for everything and a separate column, 'Unit of Measure', says what is being counted. When the measure is an area, the number is NOT units.",
    incident:
      "A warehouse entered the index with 425,000 units. The sanity check caught it, but the initial diagnosis was wrong: it was assumed to be a mapping error when it was semantic.",
  },
  unit_of_measure: {
    family: "Physical",
    definition:
      "What the units column counts: Units, Rooms, Pads, Beds or SF. Without this datum, comparing assets is meaningless.",
  },
  square_feet: {
    family: "Physical",
    definition: "Net rentable area.",
    disambiguation:
      "It can come from its own column or from 'Number of Units' when the measure is SF. Multifamily and hospitality report units; office, retail and industrial report area.",
    incident:
      "The /nra/ pattern was taking 'Largest Tenant % of NRA'. At Tysons Corner Center we were storing 14 as the area —the percentage the largest tenant occupies— instead of the square footage. A two-digit value where there should be six, invisible except by reading the provenance row by row.",
  },
  year_built: {
    family: "Physical",
    definition: "Year of construction.",
    disambiguation:
      "Loans over several properties report 'Various'. That is an absent datum, not a year.",
  },

  // -------------------------------------------------------------------------
  // Valuation
  // -------------------------------------------------------------------------

  appraised_value: {
    family: "Valuation",
    definition: "The appraised value used to compute the LTV.",
    disambiguation:
      "Annex A documents also publish an 'Appraised Value Type' indicating whether it is as-is, as-stabilized or as-complete. Without that qualifier, comparing appraisals across loans can mislead.",
  },
  cap_rate: {
    family: "Valuation",
    definition: "Capitalisation rate: NOI over value.",
    disambiguation:
      "When it is not published it can be derived from the NOI and the appraisal, but the result depends on which NOI is used —underwritten or actual— and the two give different numbers.",
  },

  // -------------------------------------------------------------------------
  // Structural
  // -------------------------------------------------------------------------

  loan_property_flag: {
    family: "Document structure",
    definition:
      "Indicates whether the row describes a loan or one of the properties securing it.",
    disambiguation:
      "A loan over three properties generates four rows: one for the loan and three for properties. Treating them all as loans multiplies the portfolio and adds the balance several times over.",
    incident:
      "A $70M loan over two hotels was counted as three deals and added $140M to the pool.",
  },
  loan_id: {
    family: "Document structure",
    definition:
      "The loan's identifier within the pool. It is the key that allows joining the horizontal blocks the Annex A is split into.",
  },
};

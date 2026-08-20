# CRE taxonomy

> Version 2026.08.17 · 101 metrics

This document describes how we interpret the columns of a CMBS Annex A.
It is meant for someone who underwrites deals to review and flag what is
wrong or missing, without reading code.

**Why it exists.** The data is public: anyone can download the same SEC
filings. What is not trivial is interpreting them. An Annex A publishes NOI
across four vintages, LTV against three different denominators, and DSCR on
two bases. Confusing them produces plausible, wrong numbers —the kind of
error that does not stand out and contaminates everything derived from it.

## Errors that motivated these distinctions

Each was detected with real data. In every case the extracted value was
correct and the label was wrong.

**Annual Debt Service (P&I)** — This metric did not exist: the whole Annex A block containing it was being discarded because none of its columns was mapped. We had been reading the already-computed DSCR without ever having its two parts, that is, with no way to verify it or recompute it under a different assumption.

**Underwritten TI / LC** — Together with underwritten_replacement_reserve it is the difference between NOI and NCF. Without them we had both ends of that subtraction and neither of the subtrahends, so there was no way to verify that NCF = NOI − reserves.

**Underwritten NOI** — The header 'Underwritten NOI DSCR (x)' contains the words 'Underwritten' and 'NOI', so a generic pattern took it. A hotel's NOI was stored as 1.83 —its DSCR— instead of $10,932,267.

**Most Recent NOI** — Without distinguishing them, whichever appeared first in the spreadsheet won —usually the oldest. A hotel in Chicago reported $9.7M when its latest NOI was $11.4M: a 17% difference, under the wrong label.

**LTV** — We mapped 'Whole Loan Cut-off Date LTV' instead of 'Cut-off Date LTV'. Since only split loans have a whole loan figure, coverage came out at 8 of 32 loans. The value was correct; the metric was another one.

**Loan Amount** — It pointed at 'Original Balance ($)' without excluding qualifiers. Tysons Corner Center came out with $2,460,000 —this trust's slice of a $709M loan— and the computed debt yield gave 3947%. The arithmetic identities gave it away: the balance implied by debt yield and the one implied by LTV agreed at 288x to three digits.

**Interest Rate** — A time series showed median rates of 84% and 0% in certain quarters. The raw values were '480' and '360': amortisation terms in months reaching the rate column via a badly adopted table. No range validation existed because each loose value looked like a percentage.

**Co-op Units** — I flagged a median LTV of 11% in one issuer family as broken data, assuming a CMBS loan does not price like that. The arithmetic said otherwise —an $8.5M loan against a $38.6M appraisal, a normal 5.9% cap rate— and the columns that explained it had been sitting in the unmapped headers list for hours, dismissed as niche. The error was interpretation, not extraction: the data was right all along.

**Occupancy** — An /economic/ exclusion meant to separate them ended up discarding the only occupancy that Annex published, and we were left with none.

**Units** — A warehouse entered the index with 425,000 units. The sanity check caught it, but the initial diagnosis was wrong: it was assumed to be a mapping error when it was semantic.

**Square Feet** — The /nra/ pattern was taking 'Largest Tenant % of NRA'. At Tysons Corner Center we were storing 14 as the area —the percentage the largest tenant occupies— instead of the square footage. A two-digit value where there should be six, invisible except by reading the provenance row by row.

**Loan / Property Flag** — A $70M loan over two hotels was counted as three deals and added $140M to the pool.

## Metrics

### Operating result

#### Third Most Recent NOI

`noi_third_most_recent` · currency · property level

The NOI from three periods ago.

<details><summary>Headers that capture it</summary>

```
  third most recent … noi
  third most recent net operating

  se descarta si contiene:
    dscr
    debt yield
    date
    description
    reserve
    ff & e
    ti / lc
    cash flow
    egi
    expenses
    occupancy
```

</details>

#### Second Most Recent NOI

`noi_second_most_recent` · currency · property level

The NOI of the second-to-last closed period, typically two years ago.

**How to tell it apart.** Together with third most recent it forms the historical series. Keeping them separate makes it possible to answer how a property has been evolving, not just where it stands.

<details><summary>Headers that capture it</summary>

```
  second most recent … noi
  second most recent net operating

  se descarta si contiene:
    dscr
    debt yield
    date
    description
    reserve
    ff & e
    ti / lc
    cash flow
    egi
    expenses
    occupancy
```

</details>

#### Most Recent NOI

`noi_most_recent` · currency · property level

The NOI of the last closed period, normally the trailing twelve months. It is what the property actually produced.

**How to tell it apart.** An Annex A publishes up to four vintages of NOI. The pattern /most recent.*noi/ also matches 'Second Most Recent' and 'Third Most Recent'.

<details><summary>Headers that capture it</summary>

```
  (most recent|t-12|ttm|trailing) … noi
  noi … (most recent|t-12|ttm|trailing)
  (most recent|trailing) net operating income

  se descarta si contiene:
    dscr
    debt yield
    date
    description
    reserve
    ff & e
    ti / lc
    cash flow
    egi
    expenses
    occupancy
    (second|third|fourth) most recent
```

</details>

#### Underwritten NOI

`noi_underwritten` · currency · property level

The NOI the originator projects for the loan. It is an estimate, not a historical figure: it incorporates signed leases not yet producing, expected savings and projected stabilisation.

**How to tell it apart.** It is not the same as actual NOI. The difference between the two measures how far underwriting stretches, and is one of the few market-aggressiveness signals computable from public data.

<details><summary>Headers that capture it</summary>

```
  (uw|u/w|underwrit\w*) … noi
  noi … (uw|u/w|underwrit\w*)
  underwritten net operating income
  noi
  net operating income

  se descarta si contiene:
    most recent
    t-12
    ttm
    trailing
    ncf
    dscr
    debt yield
    date
    description
    reserve
    ff & e
    ti / lc
    cash flow
    egi
    expenses
    occupancy
```

</details>

#### Most Recent EGI

`egi_most_recent` · currency · property level

EGI actually realised in the last reported period.

<details><summary>Headers that capture it</summary>

```
  most recent … egi
  most recent effective gross

  se descarta si contiene:
    (second|third|fourth) most recent
```

</details>

#### Underwritten EGI

`egi_underwritten` · currency · property level

Potential gross income minus vacancy, concessions and bad debt, per the underwriter's projection. The numerator before subtracting expenses.

**How to tell it apart.** It is a projection, not a measurement: not to be confused with egi_most_recent, which is what the building produced in the last reported period.

<details><summary>Headers that capture it</summary>

```
  underwritten … egi
  u/w … egi
  underwritten effective gross
  egi
  effective gross income

  se descarta si contiene:
    most recent
```

</details>

#### Most Recent Expenses

`expenses_most_recent` · currency · property level

Operating expenses actually incurred in the last reported period.

<details><summary>Headers that capture it</summary>

```
  most recent … expenses

  se descarta si contiene:
    (second|third|fourth) most recent
```

</details>

#### Underwritten Expenses

`expenses_underwritten` · currency · property level

Operating expenses projected by the underwriter. EGI minus expenses gives NOI.

<details><summary>Headers that capture it</summary>

```
  underwritten … expenses
  u/w … expenses
  operating expenses
  opex
  total expenses
  expenses
  expenses \(\)

  se descarta si contiene:
    most recent
```

</details>

#### Net Cash Flow

`net_cash_flow` · currency · property level

NOI minus capital reserves: replacements, tenant improvements and leasing commissions. It is what is actually left to service the debt.

**How to tell it apart.** Always smaller than NOI. Ratios computed on NCF are more conservative than those computed on NOI, and an Annex A publishes both.

<details><summary>Headers that capture it</summary>

```
  net cash flow

  se descarta si contiene:
    dscr
    debt yield
```

</details>

### Occupancy

#### Economic Occupancy

`occupancy_economic` · percent · property level

Economic occupancy: the proportion of potential income actually collected, after concessions, free-rent periods and bad debt.

**How to tell it apart.** A building can be 100% leased and have 85% economic occupancy if it gave away free months. The gap between the two is a signal of market softness.

<details><summary>Headers that capture it</summary>

```
  economic occupancy
  economic occ

  se descarta si contiene:
    date
```

</details>

#### Occupancy

`occupancy` · percent · property level

Physical or leased occupancy: what proportion of the space is occupied or under contract.

**How to tell it apart.** Different from economic occupancy, which deducts concessions and bad debt and is always lower or equal. Many Annex A documents publish only one of the two.

<details><summary>Headers that capture it</summary>

```
  leased occ
  physical occ
  % occupied
  occupied … %
  occupancy

  se descarta si contiene:
    economic
    date
    area
    rentable
    sf
    square
    (second|third|fourth|fifth) most recent
```

</details>

### Physical

#### Unit of Measure

`unit_of_measure` · text · property level

What the units column counts: Units, Rooms, Pads, Beds or SF. Without this datum, comparing assets is meaningless.

<details><summary>Headers that capture it</summary>

```
  unit of measure
  measure
```

</details>

#### Units

`units` · count · property level

The number of countable units: apartments, hotel rooms, pads or beds depending on the asset type.

**How to tell it apart.** An Annex A uses a single 'Number of Units' column for everything and a separate column, 'Unit of Measure', says what is being counted. When the measure is an area, the number is NOT units.

<details><summary>Headers that capture it</summary>

```
  number of units
  # of units
  units / (rooms|pads|beds|keys)
  units
  (rooms|keys|pads)

  se descarta si contiene:
    per unit
    / unit
    price
    of measure
```

</details>

#### Square Feet

`square_feet` · count · property level

Net rentable area.

**How to tell it apart.** It can come from its own column or from 'Number of Units' when the measure is SF. Multifamily and hospitality report units; office, retail and industrial report area.

<details><summary>Headers that capture it</summary>

```
  net rentable area
  square feet
  sq. ft.
  nra
  gla
  sf

  se descarta si contiene:
    per s(q|f)
    / s(q|f)
    price
    rent roll
    %
    percent
    share
    largest tenant
    tenant \d
```

</details>

#### Year Built

`year_built` · years · property level

Year of construction.

**How to tell it apart.** Loans over several properties report 'Various'. That is an absent datum, not a year.

<details><summary>Headers that capture it</summary>

```
  year built
  built
  yoc
```

</details>

### Balances

#### Loan Amount

`loan_amount` · currency · loan level

The balance of the loan THIS trust holds as of the cut-off date. It is what the issuance bought, not what the borrower owes.

**How to tell it apart.** An Annex A publishes seven balances for the same loan and this is only one of them. The ratios the issuer publishes —debt yield, DSCR, LTV— are not computed against this number when the loan is split across several trusts: they are computed against the entire loan, because the NOI it publishes is for the whole property.

<details><summary>Headers that capture it</summary>

```
  cut-off date (principal )balance
  current balance
  original (principal )balance
  loan amount
  original loan

  se descarta si contiene:
    per (unit|sf|room|key)
    / (unit|sf)
    whole loan
    pari passu
    companion
    subordinate
    mezzanine
    total (mortgage|secured|combined) debt(! service)
    maturity|ard
    %|percent
    ground lease
    pool
    additional debt
    senior notes
```

</details>

#### Whole Loan Cut-off Date Balance

`balance_whole_loan` · currency · loan level

The balance of the entire loan, adding up all the pari passu notes wherever they sit.

**How to tell it apart.** This is the number the issuer computes its ratios against, because the NOI it publishes is for the whole property. Comparing the whole NOI against the trust's portion is comparing things of different scales.

<details><summary>Headers that capture it</summary>

```
  whole loan cut-off date balance
  whole loan balance

  se descarta si contiene:
    %|percent
    ltv
    dscr
    debt yield
```

</details>

#### Non-Trust Pari Passu Companion Loan Cut-off Date Balance

`balance_pari_passu_non_trust` · currency · loan level

The part of the loan that sits in OTHER issuances, with the same payment priority as ours.

**How to tell it apart.** Added to the trust balance it gives the senior total. 'Pari passu' means they get paid equally: neither note is subordinated to the other, they are just split across different issuances.

<details><summary>Headers that capture it</summary>

```
  non- trust pari passu … cut-off date … balance
  cut-off date pari passu(! … trust) … balance
  pari passu companion loan cut-off … balance
  non- trust pari passu … balance
  pari passu companion loan … balance
  pari passu piece non- trust … balance
  balance piece non- trust

  se descarta si contiene:
    %|percent
    \(y / n\)
    control
    debt service
    monthly|annual
    per (unit|sf)
```

</details>

#### Subordinate Companion Loan Cut-off Date Balance

`balance_subordinate` · currency · loan level

Debt on the same property that gets paid AFTER the senior notes. Usually called a B-note.

**How to tell it apart.** It is not pari passu: it is subordinated. That is why 'whole loan' LTV and plain LTV differ —one includes it and the other does not— and why a loan can look conservative at trust level and leveraged at property level.

<details><summary>Headers that capture it</summary>

```
  subordinate companion … balance
  b-note … balance

  se descarta si contiene:
    %|percent
```

</details>

#### Mezzanine Debt Cut-off Date Balance

`balance_mezzanine` · currency · loan level

Debt secured by the owner's equity interests, not by the property.

**How to tell it apart.** It does not appear in the loan's LTV but it exists and competes for the same cash flow. It is the layer that makes 'total debt LTV' larger than 'whole loan LTV'.

<details><summary>Headers that capture it</summary>

```
  mezzanine debt … balance
  mezz … balance

  se descarta si contiene:
    %|percent
    rate
```

</details>

#### Original Balance

`balance_original` · currency · loan level

The amount at origination, before any amortisation.

**How to tell it apart.** It differs from the cut-off date balance only on loans that have already amortised something. In a mostly interest-only pool they are nearly identical, and that coincidence is precisely what makes them easy to confuse.

<details><summary>Headers that capture it</summary>

```
  original balance at securiti[sz]ation
  balance at origination
  original (principal )balance

  se descarta si contiene:
    whole loan
    pari passu
    companion
    subordinate
    mezzanine
    %|percent
    cut-off
```

</details>

### Valuation

#### Appraised Value

`appraised_value` · currency · property level

The appraised value used to compute the LTV.

**How to tell it apart.** Annex A documents also publish an 'Appraised Value Type' indicating whether it is as-is, as-stabilized or as-complete. Without that qualifier, comparing appraisals across loans can mislead.

<details><summary>Headers that capture it</summary>

```
  appraised value
  appraisal value
  value

  se descarta si contiene:
    date
    per
    type
```

</details>

#### Cap Rate

`cap_rate` · percent · property level

Capitalisation rate: NOI over value.

**How to tell it apart.** When it is not published it can be derived from the NOI and the appraisal, but the result depends on which NOI is used —underwritten or actual— and the two give different numbers.

<details><summary>Headers that capture it</summary>

```
  cap rate
  capitalization rate
```

</details>

### Debt structure

#### Whole Loan LTV

`ltv_whole_loan` · percent · loan level

LTV measured against the entire loan, including the pari passu notes that stayed in other trusts.

**How to tell it apart.** It only exists for split loans. Its absence on a loan is not a missing datum: it means the loan is not structured that way.

<details><summary>Headers that capture it</summary>

```
  whole loan … ltv
  ltv … whole loan

  se descarta si contiene:
    maturity
    ard
```

</details>

#### Total Debt LTV

`ltv_total_debt` · percent · loan level

LTV including all the debt on the property: the mortgage loan plus mezzanine and subordinate.

**How to tell it apart.** It is the asset's real leverage. It can be substantially larger than the trust LTV, and it is the number that matters for assessing default risk.

<details><summary>Headers that capture it</summary>

```
  total (mortgage )debt … ltv
  ltv … total (mortgage )debt

  se descarta si contiene:
    maturity
    ard
```

</details>

#### LTV at Maturity

`ltv_maturity` · percent · loan level

LTV projected to maturity or to the anticipated repayment date, after the period's amortisation.

**How to tell it apart.** It measures refinancing risk, not leverage at origination. On interest-only loans it coincides with the closing LTV.

<details><summary>Headers that capture it</summary>

```
  ltv … (maturity|ard|balloon)
  (maturity|balloon) … ltv
```

</details>

#### LTV

`ltv` · percent · loan level

Loan-to-value of the loan that sits in THIS trust, measured against the appraisal at closing.

**How to tell it apart.** A large loan is split into pari passu notes distributed across several trusts. The trust LTV measures only the piece securitised here; the whole loan measures the entire loan; total debt additionally adds mezzanine and subordinate. Three different denominators.

<details><summary>Headers that capture it</summary>

```
  cut-off date ltv
  ltv
  loan[-\s]*to[-\s]*value

  se descarta si contiene:
    maturity
    balloon
    ard
    whole loan
    total (mortgage|secured|combined) debt(! service)
    coop
```

</details>

#### Whole Loan DSCR

`dscr_whole_loan` · ratio · loan level

DSCR against the debt service of the entire loan, not just the trust's piece.

<details><summary>Headers that capture it</summary>

```
  whole loan … dscr
  dscr … whole loan
```

</details>

#### Total Debt DSCR

`dscr_total_debt` · ratio · loan level

DSCR against the service of all the debt, mezzanine included.

<details><summary>Headers that capture it</summary>

```
  total (mortgage )debt … dscr
  dscr … total (mortgage )debt
```

</details>

#### NCF DSCR

`dscr_ncf` · ratio · loan level

Coverage computed on net cash flow, that is, after capital reserves. The conservative measure.

<details><summary>Headers that capture it</summary>

```
  ncf dscr
  dscr … ncf

  se descarta si contiene:
    whole loan
    total (mortgage|secured|combined) debt(! service)
```

</details>

#### DSCR

`dscr` · ratio · loan level

Debt service coverage computed on NOI: how many times the operating result covers the payments.

**How to tell it apart.** Distinguish it from DSCR on NCF, which deducts reserves and is always lower. And from the whole loan and total debt variants, which change the denominator.

<details><summary>Headers that capture it</summary>

```
  noi dscr
  dscr
  debt service coverage

  se descarta si contiene:
    ncf
    whole loan
    total (mortgage|secured|combined) debt(! service)
```

</details>

#### Whole Loan Debt Yield

`debt_yield_whole_loan` · percent · loan level

Debt yield against the balance of the entire loan.

<details><summary>Headers that capture it</summary>

```
  whole loan … debt yield
  debt yield … whole loan
```

</details>

#### Total Debt Debt Yield

`debt_yield_total_debt` · percent · loan level

Debt yield against the total debt on the property.

<details><summary>Headers that capture it</summary>

```
  total (mortgage )debt … debt yield
```

</details>

#### NCF Debt Yield

`debt_yield_ncf` · percent · loan level

Debt yield computed on net cash flow.

<details><summary>Headers that capture it</summary>

```
  ncf debt yield
  debt yield … ncf

  se descarta si contiene:
    whole loan
    total (mortgage|secured|combined) debt(! service)
```

</details>

#### Debt Yield

`debt_yield` · percent · loan level

NOI divided by the loan balance. It measures the lender's return if it had to take the property, without depending on appraisals.

**How to tell it apart.** Unlike LTV, it does not use the appraised value, so it is not distorted when appraisals inflate. That is why many underwriters prefer it.

<details><summary>Headers that capture it</summary>

```
  noi debt yield
  debt yield

  se descarta si contiene:
    ncf
    whole loan
    total (mortgage|secured|combined) debt(! service)
    most recent
    trailing
    t-12
    historical
```

</details>

#### Interest Rate

`interest_rate` · percent · loan level

The mortgage loan's rate.

**How to tell it apart.** An Annex A also publishes the subordinate debt rate and the mezzanine rate, which price well above. Mixing them contaminates any cost-of-debt series.

<details><summary>Headers that capture it</summary>

```
  interest rate
  coupon
  mortgage rate

  se descarta si contiene:
    type
    accrual
    mezzanine
    mezz
    subordinate
    companion
    b-note
```

</details>

### Cooperatives

#### Co-op Units

`coop_units` · count · property level

The number of units in a housing cooperative. Its presence identifies the loan as cooperative, which is a segment with its own economics.

**How to tell it apart.** Cooperatives come classified as Multifamily but do not behave the same way: the co-op owns the building and takes minimal debt against a high value. An LTV of 10-20% with a DSCR of 4x to 12x is normal there.

<details><summary>Headers that capture it</summary>

```
  coop … coop units
  co-op units
```

</details>

#### Co-op Sponsor Units

`coop_sponsor_units` · count · property level

Units still retained by the original conversion sponsor. A high proportion indicates an immature cooperative, with more risk.

<details><summary>Headers that capture it</summary>

```
  coop … sponsor units
  co-op … sponsor units
```

</details>

#### Co-op Rental Value

`coop_rental_value` · currency · property level

Value of the building appraised as a rental property.

<details><summary>Headers that capture it</summary>

```
  coop … rental value
  co-op … rental value
```

</details>

#### Co-op LTV as Rental

`coop_ltv_as_rental` · percent · loan level

The LTV the building would have if valued as a rental property instead of as a cooperative.

**How to tell it apart.** It is the only leverage number comparable between a cooperative and conventional multifamily. A cooperative's normal LTV cannot go in the same table as everyone else's.

<details><summary>Headers that capture it</summary>

```
  coop … ltv … rental
  ltv as rental
```

</details>

### Document structure

#### Loan / Property Flag

`loan_property_flag` · text · loan level

Indicates whether the row describes a loan or one of the properties securing it.

**How to tell it apart.** A loan over three properties generates four rows: one for the loan and three for properties. Treating them all as loans multiplies the portfolio and adds the balance several times over.

<details><summary>Headers that capture it</summary>

```
  loan / property flag
  loan or property
  loan / prop.
  loan
  property flag

  se descarta si contiene:
    name
    type
    count
    #
```

</details>

#### Loan ID

`loan_id` · text · loan level

The loan's identifier within the pool. It is the key that allows joining the horizontal blocks the Annex A is split into.

<details><summary>Headers that capture it</summary>

```
  loan id
  loan id number
  mortgage loan number
  control number
  loan #
  loan no.
  id

  se descarta si contiene:
    seller
    rate
    cross
    flag
    per
    companion
    debt service
    balance
    amount
    %|percent
    group
    purpose
    term
    type
```

</details>

### Reserves

#### Upfront TI/LC Reserve

`reserve_tilc_upfront` · currency · loan level

Money actually deposited at closing to cover future leasing commissions and tenant improvements.

**How to tell it apart.** It is a real balance, unlike underwritten_tilc which is an assumption. A building with high vacancy usually comes with a large reserve here: the lender wants the money set aside before lending.

<details><summary>Headers that capture it</summary>

```
  upfront ti / lc

  se descarta si contiene:
    caps
    underwritten
```

</details>

#### Upfront Debt Service Reserve

`reserve_debt_service_upfront` · currency · loan level

A fund deposited at closing to pay instalments if cash flow falls short.

**How to tell it apart.** It contains the phrase 'Debt Service' just like the debt service metrics, but it is the opposite: not an obligation, a cushion against one. Its presence usually indicates the lender doubted the property would cover the instalment from day one.

<details><summary>Headers that capture it</summary>

```
  upfront debt service reserve

  se descarta si contiene:
    caps
```

</details>

#### Underwritten Replacement / FF&E Reserve

`underwritten_replacement_reserve` · currency · property level

An annual deduction for replacing capital components —roofs, equipment, furniture in hotels. Like the previous one, it is a calculation adjustment, not a deposit.

**How to tell it apart.** Its escrow twin is 'Upfront Replacement / PIP Reserve'. In hotels it appears as FF&E, which is the same idea under another name.

<details><summary>Headers that capture it</summary>

```
  underwritten replacement
  underwritten … ff & e reserve
```

</details>

#### Underwritten TI / LC

`underwritten_tilc` · currency · property level

An annual deduction the underwriter subtracts from NOI for leasing commissions and tenant improvements. It is not money that exists: it is an adjustment to estimate sustainable cash flow.

**How to tell it apart.** It gets confused with 'Upfront TI/LC Reserve', which IS money deposited in escrow at closing. One is a model assumption and the other is a bank balance. The header differs only in the first word —'Underwritten' versus 'Upfront'— and both contain 'TI/LC'.

<details><summary>Headers that capture it</summary>

```
  underwritten ti / lc
```

</details>

### Debt service

#### Annual Debt Service (P&I)

`debt_service_pi` · currency · loan level

The annual principal and interest payment the loan requires once it starts amortising. It is the denominator of the DSCR.

**How to tell it apart.** It lives alongside 'Annual Debt Service (IO)', which is the payment during the interest-only period and is always smaller. A loan with two years of IO has two different debt services depending on the moment, and the published DSCR is usually computed against the IO one — which makes it look better than it will be once amortisation starts.

<details><summary>Headers that capture it</summary>

```
  annual debt service \( p & i
  debt service \( p & i

  se descarta si contiene:
    reserve
    coverage
    dscr
```

</details>

#### Annual Debt Service (IO)

`debt_service_io` · currency · loan level

The annual payment during the interest-only period, with no principal amortisation.

**How to tell it apart.** Always smaller than the P&I. The difference between the two is how much the instalment rises when the IO ends, and it is the direct measure of refinancing risk for a loan that currently pays comfortably.

<details><summary>Headers that capture it</summary>

```
  annual debt service \( io
  debt service \( io

  se descarta si contiene:
    reserve
    coverage
    dscr
```

</details>

#### Amortization Type

`amortization_type` · text · loan level

How the loan repays principal: 'Interest Only' for its whole life, 'Amortizing' from the start, or 'Interest Only, Amortizing' with partial IO.

**How to tell it apart.** A pool that is mostly Interest Only amortises nothing, so all the principal falls due at the end. It is a structural characteristic that no ratio metric shows.

<details><summary>Headers that capture it</summary>

```
  amorti[sz]ation type
```

</details>

#### ARD Loan

`ard_loan` · text · loan level

Whether the loan has an Anticipated Repayment Date: a date at which repayment is expected and after which the rate rises sharply and cash flow is swept to amortise.

**How to tell it apart.** The ARD acts as the effective maturity even when legal maturity is later. The 'at maturity' LTV and DSCR of a loan with an ARD are computed at the ARD, not at legal maturity.

<details><summary>Headers that capture it</summary>

```
  ard loan
```

</details>

#### Original Amortization Term

`amortization_term_original` · count · loan level

The term over which the instalment is computed, in months. Normally 360, even when the loan matures much sooner.

**How to tell it apart.** It is a calculation assumption, not a real date. The two terms share the word 'term' and the unit, and confusing them either triples or thirds the loan's horizon.

<details><summary>Headers that capture it</summary>

```
  original amorti[sz]ation term
```

</details>

#### Original Term To Maturity / ARD

`term_original` · count · loan level

Original term to maturity or to the ARD, in months.

**How to tell it apart.** Not to be confused with the amortisation term, which is usually much longer —typically 360 months— and defines the instalment, not the maturity. A loan with a term of 120 and amortisation of 360 repays a small fraction of principal before maturing.

<details><summary>Headers that capture it</summary>

```
  original term to maturity

  se descarta si contiene:
    amorti
    interest[-\s]*only
```

</details>

### Cash flow control

#### Holdback / Earnout Amount

`holdback_amount` · currency · loan level

Part of the loan approved but not funded, released if the property meets a condition —leasing a space, reaching an NOI.

**How to tell it apart.** A large holdback indicates the current balance does not reflect the full loan. Ratios computed on the funded balance look better than they will be once the rest is released.

<details><summary>Headers that capture it</summary>

```
  holdback / earnout amount
  earnout amount

  se descarta si contiene:
    description
```

</details>

#### Lockbox Type

`lockbox_type` · text · loan level

Who collects the rent. 'Hard' means tenants pay directly into a lender-controlled account; 'Soft' means the borrower collects and transfers; 'Springing' means it activates if a threshold is breached.

**How to tell it apart.** It is one of the few Annex A variables that describes control rather than magnitude. Two loans with the same DSCR and a different lockbox have very different loss severities if the borrower comes under stress.

<details><summary>Headers that capture it</summary>

```
  lockbox
```

</details>

#### Cash Management

`cash_management` · text · loan level

Whether excess cash is swept into lender accounts. Usually activated by a trigger rather than from closing.

<details><summary>Headers that capture it</summary>

```
  cash management
```

</details>

### Other

#### Third Most Recent EGI

`egi_third_most_recent` · currency · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  third most recent … egi
  third most recent effective gross
```

</details>

#### Second Most Recent EGI

`egi_second_most_recent` · currency · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  second most recent … egi
  second most recent effective gross
```

</details>

#### Third Most Recent Expenses

`expenses_third_most_recent` · currency · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  third most recent … expenses
```

</details>

#### Second Most Recent Expenses

`expenses_second_most_recent` · currency · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  second most recent … expenses
```

</details>

#### Year Renovated

`year_renovated` · years · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  year renovated
  renovated
```

</details>

#### Detailed Property Type

`property_type_detailed` · text · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  detailed property type
  property sub-type
```

</details>

#### Mezzanine Interest Rate

`interest_rate_mezzanine` · percent · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  mezzanine … (interest )rate
  mezz … rate
```

</details>

#### Subordinate Interest Rate

`interest_rate_subordinate` · percent · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  subordinate … (interest )rate
  companion loan … rate
  b-note … rate
```

</details>

#### Property Type

`property_type` · text · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  general property type
  property type
  type
  asset type

  se descarta si contiene:
    loan
    rate
    sub
    detailed
```

</details>

#### Mortgage Loan Seller

`loan_seller` · text · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  mortgage loan seller
  loan seller
  originator
  originating (lender|bank)
  seller

  se descarta si contiene:
    count
    number of
    #
    pct
    percent
    %
    balance
    amount
```

</details>

#### Property Name

`property_name` · text · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  property name
  property
  loan name

  se descarta si contiene:
    type
    address
    city
    state
```

</details>

#### Address

`address` · text · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  address
  street
```

</details>

#### City

`city` · text · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  city
```

</details>

#### State

`state` · text · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  state
```

</details>

#### Zip

`zip` · text · property level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  zip
  postal code
```

</details>

#### Upfront RE Tax Reserve

`reserve_tax_upfront` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  upfront (re )tax reserve
  tax reserve … upfront
```

</details>

#### Monthly RE Tax Reserve

`reserve_tax_monthly` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  monthly (re )tax reserve
```

</details>

#### Upfront Insurance Reserve

`reserve_insurance_upfront` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  upfront insurance reserve
```

</details>

#### Monthly Insurance Reserve

`reserve_insurance_monthly` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  monthly insurance reserve
```

</details>

#### Replacement Reserve Cap

`reserve_replacement_cap` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  replacement reserve caps
  (replacement|ff & e) … caps

  se descarta si contiene:
    ti / lc
```

</details>

#### Upfront Replacement / PIP Reserve

`reserve_replacement_upfront` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  upfront replacement
  upfront … pip

  se descarta si contiene:
    caps
```

</details>

#### Monthly Replacement / FF&E Reserve

`reserve_replacement_monthly` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  monthly replacement
  monthly … ff & e reserve

  se descarta si contiene:
    caps
```

</details>

#### TI/LC Reserve Cap

`reserve_tilc_cap` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  ti / lc … caps
```

</details>

#### Monthly TI/LC Reserve

`reserve_tilc_monthly` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  monthly ti / lc

  se descarta si contiene:
    caps
    underwritten
```

</details>

#### Debt Service Reserve Cap

`reserve_debt_service_cap` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  debt service reserve caps
```

</details>

#### Monthly Debt Service Reserve

`reserve_debt_service_monthly` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  monthly debt service reserve

  se descarta si contiene:
    caps
```

</details>

#### Upfront Deferred Maintenance Reserve

`reserve_deferred_maintenance` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  deferred maintenance
```

</details>

#### Other Reserve Description

`reserve_other_description` · text · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  other reserve description
```

</details>

#### Other Reserve Cap

`reserve_other_cap` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  other reserve caps
```

</details>

#### Upfront Other Reserve

`reserve_other_upfront` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  upfront other reserve

  se descarta si contiene:
    caps
    description
```

</details>

#### Monthly Other Reserve

`reserve_other_monthly` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  monthly other reserve

  se descarta si contiene:
    caps
    description
```

</details>

#### Interest Accrual Method

`interest_accrual_method` · text · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  interest accrual method
  accrual (method|basis)
```

</details>

#### Original Interest-Only Period

`io_period_original` · count · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  original interest[-\s]*only period
  original io period
```

</details>

#### Remaining Interest-Only Period

`io_period_remaining` · count · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  remaining interest[-\s]*only period
  remaining io period
```

</details>

#### Remaining Amortization Term

`amortization_term_remaining` · count · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  remaining amorti[sz]ation term
```

</details>

#### Remaining Term To Maturity / ARD

`term_remaining` · count · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  remaining term to maturity

  se descarta si contiene:
    amorti
    interest[-\s]*only
```

</details>

#### Origination Date

`origination_date` · text · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  origination date
```

</details>

#### First Payment Date

`first_payment_date` · text · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  first payment date
```

</details>

#### Seasoning

`seasoning_months` · count · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  seasoning
```

</details>

#### # of Properties

`property_count` · count · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  # of properties
  number of properties
```

</details>

#### Holdback / Earnout Description

`holdback_description` · text · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  holdback / earnout description
  earnout description
```

</details>

#### Total Senior (Trust + Pari Passu) Cut-off Balance

`balance_senior_total` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  total cut-off date pari passu debt
  total current balance pari passu debt
  total pari passu debt (cut-off|current)
  total senior notes cut-off date balance
  senior notes cut-off date balance
  total original balance pari passu debt

  se descarta si contiene:
    %|percent
    ltv
    dscr
    debt yield
    per (unit|sf)
    \(y / n\)
    monthly|annual
```

</details>

#### Trust Pari Passu Cut-off Date Balance

`balance_pari_passu_trust` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  trust pari passu … balance

  se descarta si contiene:
    non- trust
    %|percent
```

</details>

#### Total Debt Cut-off Date Balance

`balance_total_debt` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  total (mortgage )debt cut-off date balance
  total (mortgage )debt balance

  se descarta si contiene:
    %|percent
    ltv
    dscr
    debt yield
    per
```

</details>

#### Maturity / ARD Balance

`balance_maturity` · currency · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  maturity / ard balance
  balloon balance

  se descarta si contiene:
    %|percent
    ltv
```

</details>

#### % of Initial Pool Balance

`pool_share` · percent · loan level

*No documented definition.*

<details><summary>Headers that capture it</summary>

```
  % of initial pool balance
  % of pool
```

</details>

## How to review this

The questions with the most value if you work in the industry:

1. Is any definition wrong?
2. Is a distinction that matters missing? For example: is it worth separating
   occupancy by asset type, or NOI adjusted for single tenants?
3. Is any of these distinctions irrelevant in practice?
4. Are there Annex A columns we do not capture and should?

To see which columns went unmapped in the current corpus: `npm run db:stats`.

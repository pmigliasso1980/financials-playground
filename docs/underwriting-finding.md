# Five dead hypotheses and the instrument that killed them

> **Status: five dead hypotheses. None survives correction for multiple
> comparisons.**
> The original finding — the collapse of NOI growth by vintage — is false. The
> last candidate, an originator with excess transfers, eroded with each control
> until it lost significance. See "The fifth: LMF".
>
> This document used to claim that delivered NOI growth collapsed from 11.5% in
> the 2021 vintage to 1.0% in 2024. It did not survive verification. What follows
> is the record of how it died and of what is left standing, because that is more
> reusable than the number that would replace it.

---

## What was claimed

Over 233 CMBS issuances and 9,694 loans harvested from public SEC filings, what the
originator projected at underwriting was compared against what the property
delivered afterwards, using the servicer reports (10-D) as the source of the actual
outcome.

The conclusion was:

> Between 2021 and 2024 projected NOI growth stayed almost constant (4.2% → 3.9%)
> while delivered growth collapsed (11.5% → 1.0%). Underwriting did not become more
> aggressive; the market stopped validating it.

It sounded good, it had a plausible mechanical explanation, and it was even checked
against Moody's NOI index, falling inside their published band for the 2019-2023
vintages. None of that was enough.

---

## How it died

### First blow: the sample does not represent its pool

The loans with a servicer report are ~2,200 of 8,935. Comparing vintages assumes
each subsample resembles its pool, or at least that it deviates the same way in all
of them. Neither was true.

| vintage | pool | with 10-D | coverage | median balance with/without | ratio |
|---|---|---|---|---|---|
| 2020 | 1,430 | 365 | 26% | 20.0M / 10.5M | **1.90x** |
| 2021 | 1,664 | 556 | 33% | 14.1M / 8.8M | 1.61x |
| 2022 | 1,111 | 536 | 48% | 14.3M / 10.0M | 1.43x |
| 2023 | 792 | 311 | 39% | 24.0M / 39.0M | **0.62x** |
| 2024 | 1,401 | 397 | 28% | 21.0M / 18.3M | 1.15x |

**The bias changes sign.** In 2020 the 10-D joins against loans 90% larger than the
rest of the pool; in 2023 against loans 38% smaller. Dispersion 3.10x, against a
threshold of 1.5x fixed before looking at the numbers.

A constant bias would have broken nothing: every vintage would be shifted the same
way and the comparison between them would hold. What breaks the series is the bias
varying.

### Second blow: at constant size there is no fall

The way to separate the size effect from the time effect is to compare within a
fixed size band. 10M-30M was chosen **before** seeing the result, because the
medians of the five subsamples all fall inside it.

| vintage | n | delivered NOI | projected over historical |
|---|---|---|---|
| 2020 | 89 | 2.5% | 3.0% |
| 2021 | 157 | 8.7% | 3.6% |
| 2022 | 145 | 4.1% | 3.5% |
| 2023 | 89 | 5.6% | 3.4% |
| 2024 | 120 | 2.5% | 4.3% |

**2020 and 2024 give exactly the same: 2.5%.** There is no collapse, there is a
hump with 2021 as its peak. And both ends of the original headline moved towards
the centre — 11.5% became 8.7%, 1.0% became 2.5% — which is the signature of a
composition effect.

A temptation that had to be resisted: comparing 2021 → 2024 instead of 2020 → 2024
gives a fall of 6.2 points and would have passed the survival threshold. But
choosing 2021 as the starting point is choosing the peak of the curve to maximise
the fall — the same error already made earlier in this project measuring "stability
between vintages" by comparing the ends of a U.

### Third blow: no vintage is distinguishable from any other

Bootstrap of 2,000 replicates per vintage, fixed seed, over the same band:

| vintage | n | median | 95% CI | width |
|---|---|---|---|---|
| 2020 | 89 | 2.5% | [−1.6% , 6.9%] | 8.5% |
| 2021 | 157 | 8.7% | [3.3% , 12.9%] | 9.6% |
| 2022 | 145 | 4.1% | [0.8% , 8.2%] | 7.4% |
| 2023 | 89 | 5.6% | [−3.1% , 12.5%] | 15.6% |
| 2024 | 120 | 2.5% | [0.3% , 5.0%] | 4.7% |

- Typical standard error of an annual median: **2.37%**
- Minimum detectable difference between two vintages: **6.6%**
- **Vintage pairs with non-overlapping intervals: 0 of 10**

Not even the largest difference — 2021 against 2024, 6.2 points — reaches the noise
floor.

---

## What does NOT explain the failure

It is tempting to close with "the sample was too small". That is not true and it is
worth saying so, because the correct conclusion is a different one.

The claimed effect was 10.5 points and the noise floor is 6.6. **The sample could
have detected it.** If the collapse had been real, it would have shown. What
happened is not that the instrument was blind: it is that the effect is not there,
and the original 10.5 points were sample composition.

Nor is it a matter of harvesting a great deal more. Bringing the floor down to 5
points needs ~2x more loans per vintage, from 120 to ~208. That is achievable —
today 10-D coverage is 26-48%, there are 176 loans that do not join against their
report, six BANK issuances that do not report full years, and the 2025-2026 vintages
have not matured yet. But before doing that work it is worth asking whether a
5-point effect would be interesting.

---

## What does remain standing

**Projected growth is flat.** 3.0 · 3.6 · 3.5 · 3.4 · 4.3 across five vintages,
within the size band. That half of the original finding survives stratification
intact. Originators project NOI growth in a narrow, stable range regardless of where
the cycle is.

It is a minor result but a real one, and it is the only one that survived
everything.

**The corpus.** 233 issuances, 9,694 loans, 101 metrics, verified against the
issuer's own arithmetic identities:

| identity | closes |
|---|---|
| debt yield = NOI / balance | 99% |
| LTV = balance / appraised value | 99% |
| NCF = NOI − replacement − TI/LC | 100% |
| DSCR (NCF) | 95% |
| DSCR (NOI) | 95% |
| pool share sum | 207 issuances, 201 give 100% |

**The Annex A traps**, documented in `docs/cre-taxonomy.md`. They are written down
nowhere else and each came from a number that did not add up.

---

## The other hypotheses

This is not the first to die. Before it fell:

**"Office is underwritten more aggressively."** The gap between projected and
historical was larger in offices, but it vanished once we noticed it was explained
by the contractual visibility of the rent: assets with long leases — office,
industrial, retail — allow projecting over rent already signed, and the "gap" was
measuring that, not aggressiveness.

**"Multifamily breaks the LTV band."** The median multifamily LTV came out at 11%,
which looked like an enormous anomaly. They were New York housing co-operatives,
which take very small debt against a very high value and come classified as
multifamily. In the BANK deals they are half the pool.

**"BANK underwrites four times better than BBCMS."** The most expensive of all,
because it survived longest. Adjusted for vintage, property type and DSCR tercile,
the BANK shelf transferred to special servicing with an SIR of 0.42 against BBCMS's
1.66, with intervals that did not touch.

It survived **nine** attempts to kill it: join coverage (97.7%), the population each
servicer lists, the delinquency block format, the parser's filters, the raw value
verified across twenty issuances, the master servicer, the special servicer,
composition by property type, and an entire 10-D block — "Specially Serviced Loan
Detail" — that the parser was not reading and which contributed 35 events.

It died with the tenth, which was the first that was not defensive. Mapping the
Annex A's *Mortgage Loan Seller* column and standardising by **originator ×
vintage**, no issuer departs: BANK 1.01 · BBCMS 1.10 · BMO 1.03 · Wells 0.83, every
interval containing 1.

BANK does not underwrite better: **it buys from other originators**. Its pool comes
from NCB — National Cooperative Bank, housing co-operatives, 396 loans with zero
events — plus BANA, WFB and MSMCH. BBCMS's comes from Barclays, LMF and UBS. Between
originators the real variation runs from 0% to 11.2%.

**Four out of four.** That pattern matters more than any of the four separately.

---

## The two errors that made the fourth expensive

**The category error.** A CMBS shelf is not an originator: it is a vehicle that
packages loans bought from several banks. Attributing underwriting quality to it was
congratulating the box for what the factory did, and that could have been said on
day one with no data at all. Nine sophisticated attacks on the numerator and the
denominator do not compensate for a badly chosen unit of analysis.

**The answer was written in this file.** The section above has said, for weeks, that
New York co-operatives come classified as multifamily and that *"in the BANK deals
they are half the pool"*. That is exactly the mechanism that ended up explaining the
gap. It was rediscovered by another route — from the seller data — without rereading
the project's own documentation.

Both are failures of the same type: **available knowledge that was not consulted
because attention was on defending a claim rather than on explaining it.**

---

## The asymmetry between attacking and explaining

The nine attacks asked *"is this an artefact?"*. All nine said no, and none brought
anything closer to the truth. Nine "not an artefact"s do not make an "it is real".

The tenth asked *"what would this be if it were real?"* — and in a single attempt
showed the effect lived one level down. A concrete rival hypothesis is worth more
than any amount of defensive verification, because it can confirm as well as refute.

**Practical rule:** after three failed attacks on a finding, stop attacking it and
formulate the most specific alternative explanation you can. If none can be
formulated, that is the finding.

---

## The fifth: LMF

After killing the issuer effect, the variation ended up where it belonged: between
**originators**. Comparing each loan against others of the same property type, the
same vintage, the same DSCR tercile and the same LTV tercile:

| originator | SIR | 95% CI | loans | events |
|---|---|---|---|---|
| NCB | 0.00 | [0.00 , 0.57] | 365 | 0 |
| LMF | 1.89 | [1.28 , 2.70] | 270 | 30 |
| UBS AG | 2.21 | [1.18 , 3.78] | 172 | 13 |

With those controls LMF passed Bonferroni (z = 3.49, p ≈ 0.0005) and UBS did not
(z = 2.86, p ≈ 0.0042). NCB was measuring product — housing co-operatives — not
skill.

> Those two z values were computed by hand for this document: **the script did not
> apply a multiple-comparisons correction**, so its count of "departs" and the
> document's were never comparable. When it was added, the ordering flipped once the
> balance control was included — see the UBS AG section below.

**But one control was missing, and it was the one that mattered.** `db:mechanism`
went looking for what distinguishes LMF's loans that leverage does not capture:
interest-only, replacement reserves, NOI projection over historical. All three came
out flat or against — LMF has FEWER full-IO loans than the rest, 72% against 79%.

The only thing that moved was the **balance**: median of 5.9M against 11.3M in the
same subtypes. Size was not controlled in any of the twelve attacks.

| cumulative control | LMF's SIR |
|---|---|
| type × vintage | 3.61 |
| + DSCR tercile | 2.26 |
| + LTV tercile | 1.90 |
| + balance tercile | **1.51** — p = 0.024, does not pass Bonferroni |

Four controls, four bites, without exception. That monotone pattern is the signature
of a residue being explained away, not of an effect that resists. One more control —
geography, sponsor quality — would probably take it to ~1.2.

**Conclusion: LMF's excess is composition all the way down, and the corpus ran out
of controls before it reached 1.** It is not proved that LMF underwrites like the
others; it is proved that this corpus cannot show it underwrites worse.

### Why this result is different from the four that died

**It is at the correct unit of analysis.** The originator decides who to lend to; the
issuer only chooses who to buy from.

**It survived a bidirectional test.** The controls for type, DSCR and LTV could only
shrink the residue, and they did: 3.61 → 2.26 → 1.89. A control that reduces is
weakly informative. The distribution by vintage could move it in both directions: if
LMF's 30 events were clustered in 2021-2022 it was a cycle bet, not underwriting.
They are spread across **all five vintages**, with 34% in its worst year against 12%
of its pool being there.

BMO and MSMCH did turn out to be cycle bets: 72% of BMO's events in 2023, 67% of
MSMCH's in 2021.

**It is not confounded with the issuer.** LMF places into four different shelves.

### The fourteenth attack: product within type, which did not kill it

This section used to say the most dangerous remaining control was the subtype:
`property_type` does not capture **product**, co-operatives live inside multifamily,
and that exact mechanism killed the issuer effect. It was the attack with the best
prior of any that remained.

It was run. The stratum became `property_type_detailed × vintage × DSCR × LTV ×
balance`.

| stratum | LMF: obs | expected | SIR |
|---|---|---|---|
| coarse type × vintage × DSCR × LTV × balance | 30 | 19.8 | **1.51** |
| subtype × vintage × DSCR × LTV × balance | 27 | 17.9 | **1.51** |

**It moved nothing.** LMF's excess is not product within type, and the mechanism
that explained BANK does not explain LMF.

Three reasons to believe that zero rather than suspect the control was not applied:

- The sub-sampling did happen: subtype coverage is 75% and LMF's observed events
  fell from 30 to 27. They are different samples giving the same ratio, not the same
  run twice.
- The stratum did not collapse. With ~100 cells for 168 events that was the obvious
  risk, and the signature does not appear: 1 of 13 originators with expected glued to
  observed, and the self-reference of the main ones between 21% and 32%.
- Losing 25% of the sample runs **against** the sceptic, not for them. The subset
  with a subtype is richer in events than the total — 13.8% against 11.2% in LMF —
  so the attrition did not erase the excess: it left it intact on a smaller base.

What the cut did do was widen the interval. With 27 events instead of 30, LMF's CI
comes to **[1.00 , 2.20]**: pressed against the null without excluding it. It still
does not pass Bonferroni. So the result neither vindicates LMF nor buries it — it
survived the best remaining attack and is still not citable.

**What is left open, and this corpus cannot close it.** Geography and sponsor
quality are missing. And on the three things that were controlled there is a reading
the document has to carry: subtype, balance and in part LTV may be **LMF's strategy
and not confounders**. If LMF chooses to lend small, in Mid Rise and more leveraged,
controlling for that takes away credit for its own decisions. A control on a mediator
makes the effect disappear by construction. Both readings are defensible and the data
does not separate them; what changes is the question:

> without controls → "does LMF's book perform worse?" — yes, 11.2% against ~3%, and
> that is not in dispute.
> with controls → "does LMF perform worse than another lender making the same loan?"
> — cannot be asserted.

### The fifteenth: the observation window, which had never been looked at

It turned up while measuring something else. There are **158 trusts and 158
reports**: exactly one 10-D per issuance. So "event" never meant "transferred" — it
means *had transferred as of the date of the single report we harvested from that
issuance*, and that date varies.

It varies even within the same vintage, which is the scale at which the SIR
standardises:

| vintage | exposure p25 · p50 · p75 | range |
|---|---|---|
| 2020 | 4.71 · 5.47 · 6.15 years | 2.76 |
| 2022 | 3.43 · 3.71 · 4.00 | 2.15 |
| 2024 | 1.48 · 1.68 · 1.85 | 1.23 |

An originator placing into the issuances observed later accumulates more transfers
without underwriting worse. It was operating across all fourteen previous attacks and
in the number this document quotes.

**But that it varies is not enough.** If the window varies at random with respect to
who originated, it averages out. The SIR only goes wrong if a seller systematically
places into the issuances seen later, and that can be measured: each seller's
exposure deviation within its vintage.

The worst case in the corpus is **GACC at +0.226 years over a mean of 3.97: a bias of
5.7%** assuming a constant transfer rate. None reaches 10%.

And for LMF the deviation is **−0.142 years**: it has *less* exposure than the average
of its vintages, so correcting for this would raise its SIR by around 3.6% rather than
lower it. The confounder is real, it is small, and in the case that matters it runs
against the convenient explanation.

It is the first of the fifteen attacks that ends neither in "it died" nor in "it
cannot be measured", but in "it exists, it was measured, and it is too small to
explain anything".

### The corpus ceiling, which now has a number

With 13 comparisons Bonferroni requires z > 2.89, and since the SE of log(SIR) is
1/√obs, detecting an SIR of 1.51 requires **50 events** in that originator. LMF has
27. The minimum detectable today is **1.74**.

| SIR to detect | events needed |
|---|---|
| 2.00 | 18 |
| **1.74** | **27 — what there is** |
| 1.51 | 50 |
| 1.30 | 122 |

And that factor of 1.9x cannot be obtained by harvesting. Of the 2,702 loans with an
Annex A and no 10-D, **2,585 are from 2025 and 2026**: vintages without a single event
yet. Harvesting them raises the denominator and not the numerator — it is the case
where more data makes the power worse. What is missing is not in EDGAR: it is in
time.

**Operational conclusion: the question of underwriting by originator is closed for
this corpus.** Not for lack of method — fifteen attacks, all answered — but because
resolving 1.51 requires a mature corpus that does not exist today.

### UBS AG: the one nobody looked at, and that this corpus cannot measure

Adding Bonferroni to the script — which it lacked — changed who the candidate was.
With type × vintage × DSCR × LTV × balance, **LMF does not pass (z = 2.28) and UBS AG
does (z = 2.97 against a threshold of 2.91)**. The project spent thirteen attacks on
LMF and none on UBS. The difference between them was not the evidence: it was the
attention.

The right control for UBS is the subtype, because **6 of its 13 events are in 11
Limited Service loans, at 54.5% against 9.2% for the corpus in that same subtype**.
Limited service and full service hotels are different products inside Hospitality.

That control cannot be run. UBS has 177 loans and with the full stratum 121 remain,
below the minimum pool of 150 fixed before looking. Lowering the threshold now would
be choosing it knowing who it lets in.

What can be said with no threshold at all: **removing those 11 loans, UBS goes from
7.3% to 4.2%** (7 events over 166). Half its excess is eleven loans. That is not a
dismissal — it is a description, and picking the worst subtype to remove always
lowers the rate — but it sets the scale of what would be under investigation.

**UBS AG's status is "not measured", which is not the same as "does not depart".**

---

## The lesson, which is the reusable part

Each hypothesis died for a different reason and none died from better reasoning. They
died because an instrument capable of killing them was built:

1. **The arithmetic identities** (`db:identities`) — independently mapped metrics
   have to satisfy the relationships the issuer used to compute them. Verification
   with no external source.
2. **The pool sum** — the shares sum to one by construction. It is the only check
   that detects **absence**; every other one looks at the quality of what is present.
3. **The reconciler** — the value implied by an identity compared against the
   unmapped cells of the same row. It turns "read eighty-seven headers and guess"
   into a numeric match.
4. **The bias check** (`analysis/bias.ts`) — does the subsample resemble its pool?
5. **The noise floor** (`analysis/power.ts`) — what effect can this sample detect?

The last two are the ones that killed this finding, and both were built **after**
believing it. That is the wrong order and it is worth admitting: the project spent
months accumulating data and weeks verifying the mapping before asking whether the
question was answerable with the available sample.

**The noise floor should be computed before looking for the effect, not after
finding it.** It costs an afternoon and it decides whether the rest is worth doing.

### Note on a correction that was wrong

In a later review a section was added here claiming that `db:power`'s verdict had
expired: that when this document was written the MDE exceeded the claimed effect, and
that it flipped as the corpus grew.

**That is false.** The MDE was 6.6% when it was written and it is 6.7% today. It never
changed sides, and this document already said the right thing in the section "What
does NOT explain the failure": the claimed effect was 10.5 points, the noise floor
6.6, the sample could detect it, and what failed was not the instrument but that the
effect is not there.

How the error was reached, because that is the reusable part: this 345-line document
was audited by reading the header and the closing — around 84 lines — and a correction
was asserted about content that had not been read. The section refuting it is halfway
down and is called exactly "What does NOT explain the failure", written to prevent
this reading.

A `grep` over a document finds the lines matching what you already suspect. Reading it
whole finds the ones that contradict you.

What did hold up from that review, and is worth keeping: the title said four
hypotheses when the status said five, and the counts were 222 issuances and 8,935
loans when today they are 233 and 9,694.

---

## What comes next

The corpus works. What does not work is asking it about differences between vintages
on a variable as noisy as an individual property's NOI growth.

Two routes, and both avoid the problem rather than fighting it:

**A less noisy outcome variable.** Delinquency is binary, has far less variance than a
ratio of two numbers with fat tails, and needs far less sample to detect a difference
in rates. It is in the same 10-D filings already being downloaded: today one single
column of that document is read.

**Cross-sectional questions.** With no time axis, n goes from ~120 per cell to
thousands. How underwritten debt yield varies by asset type controlling for LTV, which
debt structures concentrate which profiles, how reserves are distributed. There the
corpus has sample to spare.

What I would **not** do: more trusts on the same question. It doubles the mapping work
to move the noise floor from 6.6 to 4.7 points.

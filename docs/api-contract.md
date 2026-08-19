# The API contract

> **Status: partly superseded.** This document was written **before** any code, on
> purpose: the hard part of this API is not HTTP, it is that it has to be able to
> say "unknown" without looking like an error, and that gets decided in the
> contract or it never gets decided.
>
> What actually shipped is `/comps` — a different resource from the ones proposed
> below, aimed at a broker with a deal rather than at an issuance in its cohort.
> The cross-cutting rules R1–R5 all survived and are implemented. The resources in
> the "Resources" section are still a proposal; `/cohorts` and `/issuances` do not
> exist. Kept because the reasoning is what matters, and because a proposal that
> was overtaken is more useful when you can see how.
>
> Implemented today: `GET /comps`, `GET /corpus`, `GET /health`, plus `/` and
> `/scenarios` which serve HTML.

## Why this contract and not a generic one

A reader of this repository can reasonably ask why an API over a CMBS corpus needs
design decisions of its own. The answer is that fifteen attacks on the data left
four facts a generic contract would erase, and erasing them turns the product into
something that claims more than it knows:

1. **With pools of 15 to 70 loans, most differences are not differences.** One loan
   is worth up to 7.1% of an issuance's composition, so "+4%" is half a loan:
   rounding noise wearing the face of a datum.

2. **A verdict has three states, not two.** There are issuances where the result
   changes depending on how the reference is weighted. Forcing them into
   "different" or "same" is choosing on the user's behalf without telling them.

3. **"Cannot be evaluated" is an answer, not a failure.** An issuance with fewer
   than 15 comparable pairs has no benchmark. That is not a 404 nor a server error:
   it is the state of the knowledge.

4. **Underwriting by originator is NOT measurable with this corpus.** It is
   documented in `underwriting-finding.md`: fifteen attacks, no citable originator,
   and the ceiling computed — 50 events are needed where there are 27. Any endpoint
   returning a "risk score" would be selling what the project itself proved it
   cannot support.

All four translate into concrete rules below.

---

## Cross-cutting rules

### R1 · Every measurement travels with its resolution

Never a number alone. Always the number and how much the smallest unit composing it
is worth.

```json
{ "value": 0.28, "grain": 0.029, "unit": "share", "base": 34 }
```

`grain` is `1 / base`: with 34 typed loans, one loan is 2.9 points. A client showing
"28%" next to "26%" without looking at `grain` is drawing a difference of less than
one loan.

This is not defensive decoration: the index in this same session reordered four
issuances when a 0.3-point defect was corrected, and every jump fell below the
grain. Without a published `grain`, that reordering looks like product instability
instead of what it is: noise inside the declared resolution.

### R2 · Every statistic travels with its null

```json
{ "distance": 0.31, "null": 0.17, "p": 0.0005 }
```

Never `distance` alone. A distance of 0.31 is enormous in a pool of 70 and expected
in one of 15 — the null is what makes the observed value legible. The project read a
null value as if it were signal four times before imposing this rule.

### R3 · The ranking travels as a band, not a position

The response carries `band: "different" | "borderline" | "market"` and the numeric
value. **It does not carry "3rd of 25".** A client can sort if it wants, but the API
does not hand out an ordinal position that, at these pool sizes, means nothing
between neighbours.

### R4 · Provenance is mandatory on every response

```json
"corpus": {
  "issuances": 233, "loans": 9694, "withPerformance": 2231,
  "taxonomy": "2026.08.17"
}
```

A number that depends on the sample and is quoted without saying which sample it was
measured against cannot be verified. It also gives the client its cache
invalidation key: if `taxonomy` changes, the numbers changed even if the contract
did not.

### R5 · What is excluded is declared, not omitted

```json
"pool": { "total": 35, "withType": 34,
          "excluded": [{ "reason": "no_property_type", "n": 1 }] }
```

If the API returns only `34`, the client computes percentages over a base it does
not know was trimmed. There are currently 362 loans with no type in the corpus — of
which ~70% are multi-property portfolios that genuinely do not have one — and that
distinction has to reach the client.

---

## What shipped: `GET /comps`

The implemented resource. It answers a broker's question rather than an analyst's:
"I have a property of this type, in this state, of this size — what terms did
similar loans get?"

```
GET /comps?state=GA&type=Multifamily&amount=28000000&target_ltv=0.70
```

It applies R1 through R5:

- every distribution declares its own `base`, which is not the total (R1, R5)
- the geographic `ladder` shows every rung tried, with what each returned (R2's
  spirit: the context that makes the number legible)
- `sufficient: false` is a **200** with the reason and what widening would give
- `corpus.provenanceStamp` and `corpus.channel` travel on every response (R4)

The full field list is in `api/comps.ts`; the two HTML pages read it directly, and
`npm run api:contract` checks that they only read fields the API declares.

---

## Proposed resources (not implemented)

### `GET /cohorts/{vintage}`

The index of a vintage. Equivalent to `db:catalog`.

```json
{
  "vintage": "2026",
  "issuances": 28,
  "comparable": 25,
  "aggregate": { "different": 8, "expectedByChance": 1.25, "borderline": 1 },
  "grain": 0.071,
  "items": [ /* see below */ ],
  "setAside": {
    "singleType": [ /* depart by definition: they do not enter the count */ ],
    "notEvaluated": [ /* not enough pairs */ ]
  },
  "corpus": { … }
}
```

`singleType` and `notEvaluated` go in their own key and **not** in `items`. Mixing
them would count a tautology as a finding (an issuance that is 100% hospitality
departs from the cohort by definition) and count an "unknown" as a "does not
depart".

### `GET /issuances/{id}`

One issuance. Equivalent to `db:page`.

```json
{
  "id": "0001234567-26-000123",
  "name": "BANK 2026-BNK52",
  "vintage": "2026",
  "pool": { "total": 70, "withType": 70, "excluded": [] },
  "evaluable": true,
  "verdict": {
    "band": "different",
    "distance": 0.378, "null": 0.122,
    "p": 0.0005, "pByIssuance": 0.0007,
    "robust": true
  },
  "composition": [
    { "type": "Hospitality", "own": 0.20, "cohort": 0.09,
      "difference": 0.11, "loansOfDifference": 8, "belowResolution": false }
  ],
  "terms": [ /* DSCR, LTV, debt yield… */ ],
  "pairs": 24,
  "corpus": { … }
}
```

**`evaluable: false` is a 200.** With the reason:

```json
{ "evaluable": false,
  "reason": { "code": "insufficient_pairs", "pairs": 9, "minimum": 15 },
  "verdict": null }
```

A 404 means "this issuance is not in the corpus". A 422 means "you asked for
something malformed". Not having enough pairs is neither: it is a property of the
world, and the client has to be able to distinguish it from an outage.

### `GET /issuances/{id}/loans`

The normalised Annex A rows, with their provenance. It is the project's most solid
asset and the one that depends least on any conclusion surviving.

### `GET /corpus`

The state of the corpus: which vintages, how many issuances, coverage by metric,
taxonomy version. Without this a client cannot tell whether a missing datum is the
document's fault or the harvester's. **This one is implemented.**

---

## What the API does NOT expose, and why

| Not exposed | Why |
|---|---|
| Risk score per loan or issuance | Fifteen attacks and no citable originator. The corpus has an SIR MDE of 1.74 and the real effects sit at 1.5. Publishing a score would be selling precision that does not exist. |
| Originator ranking | Same reason. `analysis/sellerEffect.ts` exists as an analysis tool, not as a product. |
| Default prediction | The corpus measures "had transferred as of the date of the single 10-D harvested", with exposure windows varying between 1.2 and 4.3 years inside the same vintage. It is not a well-defined survival variable. |
| Percentiles of the metrics | With 24 pairs a percentile has a resolution of ~4 points. The ordinal position and the interquartile range are exposed, which is what the data supports. |

This table is part of the contract, not a footnote. It is the difference between a
tool you can believe and one that always answers something.

---

## Conventions reused from the earlier work

From the emulation that was deleted, the parts that proved useful when implemented
and not merely elegant on paper:

- **The `request_id` / `timestamp` / `data` envelope.** It costs one line and makes
  any user report debuggable.
- **Errors with a readable `code` alongside the HTTP status.** `insufficient_pairs`
  can be branched on in the client; a bare 422 cannot.
- **Cursor pagination.** With an offset, a re-harvest between two pages duplicates
  or skips rows.

---

## What still has to be decided before writing more code

| Decision | Why it blocks |
|---|---|
| Auth? | If the corpus is public —they are EDGAR documents— it may not be needed. It changes the whole middleware. |
| Is the HTML served from here or kept separate? | Today `db:catalog` generates loose files that open on a double click. That is a virtue, not a shortcoming. |
| Snapshot or live? | If the taxonomy changes, the numbers change. An API serving the current state is not reproducible; one serving versioned snapshots is, and is more work. |

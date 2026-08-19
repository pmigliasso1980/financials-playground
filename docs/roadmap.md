# Roadmap

> This is not the feasibility table. That one ordered by what costs least; this one
> orders by what has to be **found out**. Doing the easy thing first because it is
> easy is how products nobody asked for get built.
>
> Each phase ends in an **answered question**, not a list of crossed-off tasks. If a
> phase does not change what we do next, it should not be here.

## Done

| | |
|---|---|
| Corpus | 9,694 loans across 233 issuances, with cell-by-cell provenance |
| `/comps` | geographic ladder state → region → country, minimum of 10, refuses rather than inventing |
| Screen | `localhost:8787`, use cases in the empty state, `/scenarios` for all twelve at once |
| MCP | the corpus as an assistant's tool |
| Monitor | automatic weekly watch, speaks up only if something changed |

Twelve scenarios run against the real corpus. Eight answered, one correct refusal,
three at the edge of the threshold.

---

## Phase 1 · Is this useful to anyone? · days

**Almost none of this is code.**

- Run `api:scenarios` after the ladder and confirm the failures resolved.
- **Show it to three brokers.** Not a demo: ask them for a real deal they have on
  their desk today and search for it in front of them.
- Note what they ask that the tool does not answer. That — and not our intuition —
  is what defines phase 2.

**The question:** does anyone change a decision because of what they see here?

**If the answer is no**, the rest of this document does not matter and we have to
go back to the question of what to build. It is the most valuable possible outcome
of this phase, because it is the only one that avoids months of wrong work.

---

## Phase 2 · Depends on what they say · weeks

Two mutually exclusive branches. **The user chooses, not us.**

### Branch A — "this is useful but my deals are not conduit"

Rent roll and T-12 ingestion, reusing the harvester. It is the most defensible
asset we have: a normaliser for tabular financial documents with 137 tests, which
turned out to be the valuable thing rather than the CMBS corpus. The corpus was the
training ground.

It is also the first step of Lev's workflow, and there we already have the hard
part built.

### Branch B — "this is useful but I need to send it to someone"

Deal object, pipeline, sharing. It is CRUD and it is where Lev's product lives.
Technically easy, useless without users — which is why it sits behind phase 1 and
not in front of it.

---

## Phase 3 · Stop being a feature · months

The real risk in all of this is that "conduit CMBS comparables" becomes a tab
inside Lev or CompStak before it becomes a company.

What prevents that is not adding screens: it is the data being **the infrastructure
others consume**. API, MCP, and eventually the published corpus. That is why the
MCP was built in phase zero and not here — it is cheap and it defines what we are.

---

## What is not on the roadmap, and why

| | |
|---|---|
| **Lender matching** | 3,500 commercial relationships. You do not program that. |
| **Risk score** | Fifteen attacks, none survived. Documented in `underwriting-finding.md`. If it shows up in a pitch, it is a lie. |
| **Machine learning** | 206 events across the whole corpus and a minimum detectable effect of 1.74x. There is nothing to train on. |
| **Harvesting more CMBS** | 96% of what is missing is vintages with no events: harvesting them makes the power worse. Measured in `db:growth`. |
| **CRM** | Phase 2 branch B, and only if a user asks for it. |

---

## The alarm signal

**If at any point every item on the roadmap is code, something is wrong.**

The bottleneck today is not technical. It is that there are no users, and no
quantity of endpoints solves that. Phase 1 is almost entirely conversations, and it
is the only one that can invalidate everything else.

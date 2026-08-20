# Building our own CRE API

> Starting point: everything learned from Lev + the mock working.
> This document is for deciding, not for implementing. Decisions marked
> **⟶ yours** need you to choose before I write code.
>
> **Status note.** This was written when the project was still deciding whether to
> integrate with Lev or build its own corpus. It chose the corpus. Several of the
> decisions below have since been made by doing them, and §8 was badly out of date;
> both are marked inline rather than deleted, because the reasoning is the part
> worth keeping.

---

## 1. What we already have

The "mock" is not disposable. It is a server that already implements:

| Piece | Status | Reusable |
|---|---|---|
| HTTP contract (envelope, errors, request_id) | Working | Yes, as is |
| Cursor + offset pagination | Working | Yes, as is |
| Filters with operators, sparse fieldsets, includes | Working | Yes, as is |
| Auth with API keys + granular scopes | Working | Solid base |
| Rate limiting with two buckets | Working | Yes, as is |
| Idempotency with expiry | Working | Yes, as is |
| Credit ledger with preview | Working | Solid base |
| **Three-level Deal Index** | Working | **Yes — the most valuable part** |
| Complete CRE data model | Working | Yes, as a schema |
| AI layer with fallback | Working | Yes |

**What it lacks to be a real API:**

- Persistence. Today everything lives in memory and is lost on restart.
- Real document ingestion. Today the extracted text is seeded by hand.
- Real multi-tenancy (today there are two hardcoded accounts).
- Production auth: key hashing, rotation, OAuth if needed.
- Migrations, observability, deployment.

That is known work, not research. The hard part is elsewhere.

> **What happened.** The emulation was deleted; see §7. Persistence went to
> Postgres, which is what `db/` is. The Deal Index's promotion logic survived in
> `db/corpus.ts`, applied to the real corpus.

---

## 2. What is genuinely hard

It is worth being honest about what makes Lev strong, because it determines
whether there is room or not.

### 2.1 The moat we cannot copy

**7,000+ lenders with programmes, appetite, contacts and recent activity.**

That dataset is Lev's central asset and it does not get built by writing code. It
gets built by running a brokerage for years, or by buying data, or by scraping —
with the legal problems that brings.

Without lender data, a "lender match" has nothing to match. It is the difference
between our mock (12 invented lenders) and their product.

**Implication:** any plan depending on competing in *lender matching* starts from
behind. If we go that way, we first have to solve where the data comes from.

### 2.2 Expensive but feasible

**Document extraction.** Turning a rent roll in XLSX, a T-12 in scanned PDF or an
80-page OM into structured observations with provenance.

Lev charges by size and type (`DOC-S/M/L/XL` × `TEXT/TABLE`), which reveals that
they have extraction infrastructure with tiered costs. With current models this is
achievable, but not trivial: OCR for scans, table parsing, and above all
**evaluation** — knowing whether the extraction came out right.

### 2.3 What we already solved

**The Deal Index.** The three-level model with explicit promotion logic is working.
And our version has something Lev's does not expose: the `rationale` for why each
value won.

That is not a minor detail. In underwriting, "where did this number come from and
why do we believe this document and not the other one?" is *the* question.

---

## 3. Where there may be room

Three hypotheses, not mutually exclusive. None is obvious; one has to be chosen.

### A. A narrower vertical

Lev covers all of CRE. A product that does *one* thing much better — only
multifamily, only construction lending, only one geographic market — can gain in
depth what it loses in breadth, and needs far less data.

*Advantage:* the lender moat shrinks to a manageable subset.
*Risk:* smaller market.

### B. An intelligence layer over someone else's data

Do not compete on data: integrate. The system of record stays the CRM the client
already uses, and we contribute the Index + extraction + reasoning.

*Advantage:* removes the lender dataset problem.
*Risk:* you depend on integrations, and Lev does this too.

### C. Infrastructure for others

Sell the Deal Index and extraction as primitives to others building CRE software.
Do not compete with Lev on the final product but on the layer beneath it.

*Advantage:* the moat is technical, not data.
*Risk:* the CRE developer market is small.

**⟶ yours:** which of these, or another.

> **What happened.** In practice the project went closest to A and C: one narrow
> question (conduit CMBS comparables) exposed as API and MCP. See `roadmap.md`.

---

## 4. Architecture decisions

### 4.1 Lev-compatible contract or our own?

| | Compatible | Our own |
|---|---|---|
| Migration from Lev | Trivial | Requires client work |
| Design freedom | Tied to their decisions | Total |
| Perception | "Clone" | Own product |

My reading: **start compatible in the good parts and diverge where their design has
seams**. Their contract has solid decisions (envelope with request_id, stable
cursor, idempotency, granular scopes) not worth reinventing. But it also has things
I would fix:

- `total_rate` meaning spread or all-in depending on context — that is a trap.
- `404` for both "does not exist" and "no access" — defensible, but it makes
  debugging harder.
- No webhooks: forces polling.
- The checklist state split across `status` + `is_completed` is confusing.

**⟶ yours:** compatible, our own, or compatible-with-improvements.

> **What happened.** Our own. `api/comps.ts` keeps the envelope and the readable
> error codes and nothing else; see `api-contract.md`.

### 4.2 Persistence

I recommend **Postgres**. The model is relational (deals → properties →
observations → facts), you need transactions for fact promotion, and `jsonb` covers
the semi-structured parts.

For the Index's semantic search: `pgvector` in the same database avoids adding a
service. If it grows, migrate.

*Alternative:* SQLite for the prototype, migrating later. Faster to start, less
realistic.

**⟶ yours:** Postgres from day one, or SQLite first.

> **What happened.** Postgres from day one. No pgvector: there is no semantic search
> in the product as built.

### 4.3 The Index: keywords, embeddings or LLM?

Today we have an LLM with a keyword fallback. For production:

- **Embeddings** for retrieval (fast, cheap, scales).
- **LLM** only for reranking the top-N and for generating the reasoning.

That hybrid is cheaper and faster than calling the model with the whole catalogue,
which is what our prototype does.

> **What happened.** Neither. The product has no LLM in it at all; the honest answer
> to "when do we use ML?" was that there is nothing here to train on and nothing to
> retrieve. See `roadmap.md`.

### 4.4 Document extraction

The minimum pipeline:

```
upload → detect type → (OCR if needed) → chunking →
structured extraction per metric → observation with confidence + snippet →
promotion → canonical fact
```

The part most people underestimate: **evaluation**. Without a labelled document set
you do not know whether a prompt change improved or degraded the extraction.

**SOLVED** — see §4.5.

### 4.5 Where the evaluation data comes from

No private documents are needed to start. The harvester (`harvest/`) downloads the
**Annex A** of CMBS prospectuses from SEC EDGAR: public spreadsheets with hundreds
of real properties and their metrics.

What makes them especially useful: **the pair comes ready-made**. The Annex A is
the structured truth; the prospectus PDF describes the same loans in prose. That is
exactly the (unstructured document → structured facts) pair needed to evaluate
extraction.

Other complementary sources:

| Source | What it contributes |
|---|---|
| Fannie Mae Multifamily Loan Performance | 72k+ loans, 62 attributes — real distributions |
| FHFA Public Use Database | property size, UPB, seller type |
| MISMO Commercial Rent Roll Dataset | the industry standard for rent roll fields |
| Public rent roll and T-12 templates | real layouts for generating credible synthetics |
| FinTabNet | 113k financial tables — the sub-problem of extracting tables from PDF |

**MISMO deserves separate attention.** Today the `metric_definitions` are ones I
invented reading Lev's docs. Aligning them to the MISMO standard would give us
interoperability and credibility at no cost. It is a bounded, high-return task.

**The limitation that remains:** a synthetic set tells you whether the pipeline
works, not whether it survives the world. Real rent rolls come in forty formats,
sometimes scanned crooked, with handwritten notes. That no longer blocks starting,
but it is still something to obtain in parallel.

---

## 5. Proposed v0

If I had to choose where to start, without yet knowing the product:

1. **Persist what already works.** Migrate the in-memory store to Postgres, keeping
   the contract intact. The current smoke test is the safety net: if it stays
   green, the migration broke nothing.

2. **Real ingestion of a single document type.** Pick the most common one — rent
   roll in XLSX — and build the full pipeline through to observations. One type
   solved properly teaches more than five half-done.

3. **Replace the Index's ranking with embeddings + rerank.**

4. **Only then decide the product**, with the infrastructure running.

Steps 1-3 are valuable under any of the three hypotheses in §3. That work does not
get thrown away.

---

## 6. What I need from you

| Decision | Why it blocks |
|---|---|
| ~~Product hypothesis (§3)~~ | ~~Determines whether the lender dataset is a problem~~ |
| ~~Compatible or own contract (§4.1)~~ | ~~Determines the design of every endpoint~~ |
| ~~Postgres or SQLite (§4.2)~~ | ~~Determines the setup~~ |
| ~~Real documents?~~ | ~~Solved: EDGAR (§4.5)~~ |

All four were resolved by building. The open decisions now are in
`api-contract.md`: auth, where the HTML is served from, and snapshot versus live.

## 7. The Lev emulation: what was kept and why it was deleted

In the first stage we built a complete emulation of Lev's API — around 7,000 lines
across `mock/`, `src/` and the `harvest/load/` bridge — so we could work against
their contract without a paid account. When the project moved from *integrating
with Lev* to *building our own corpus*, that code was orphaned but stayed in the
repository, and kept accruing interest: `metricBridge.ts` was an exhaustive
`Record<MetricKey, …>`, so **every new harvester metric had to be registered in a
store nobody consulted any more.** The four cooperative metrics went through that
for no reason at all.

It was deleted. What follows is what was worth keeping and was not in the reference
document.

### Contract conventions we would reuse

The ones that turned out genuinely useful when implemented, rather than merely
elegant on paper:

- **The `request_id` / `timestamp` / `data` envelope.** The cost is one line; the
  benefit is that any response is traceable in logs without correlating by
  timestamp. We would do it again.
- **Cursor and offset as mutually exclusive modes,** with the cursor incompatible
  with `sort`. It sounds arbitrary until you try to paginate a set that reorders
  between pages.
- **Granular scopes separating reading from acting.** `ai:actions` separate from
  `deals:write` lets you give an agent permission to suggest without permission to
  write. It is the distinction used most in practice.
- **Idempotency with explicit expiry.** Storing the original response and returning
  it unchanged on a retry avoids the ugly case: the client retries on a timeout and
  creates twice.

> The detailed description used to live in `lev-referencia-tecnica.md`, which was
> removed from the repository — it was 1,222 lines compiled from Lev's own
> documentation, third-party material in a public repo. What was ours is the list
> above.

### The AI layer pattern

`mock/ai/` implemented semantic search and matching with a real LLM and a
deterministic fallback behind the same interface. The pattern worth keeping, in one
line: **the deterministic route is not a degraded plan B, it is the tests' oracle.**
With the LLM off the suite runs offline and verifies the shape of the response;
with the LLM on it verifies the quality. If the fallback returned something
structurally different, that property would be lost.

### The promotion logic

`mock/store/promotion.ts` resolved multiple observations of the same metric into a
canonical value. That logic **was not lost**: it lives in `db/corpus.ts`, applied to
the real corpus, and is in fact a better version because it operates on
observations with true provenance rather than a synthetic seed.

## 8. Current state

> This section was written when the corpus had 100 filings and 3,579 loans. It has
> been updated; the earlier figures are kept in the git history.

```
harvest/                   harvesting from SEC EDGAR
  edgar/                   SEC client, discovery of Annex A and 10-D
  normalize/               column mapping → observations with provenance
  parse/                   HTML/xlsx tables, servicer report
  test.ts · real.test.ts · scale.test.ts · fixtures.test.ts · servicer.test.ts

db/                        the corpus in Postgres
  migrations/              001 corpus · 002 performance · 003-015 views and fixes
  corpus.ts                writing and reading, promotion to facts
  identities.ts            arithmetic verification of the mapping
  monitor.ts               daily watch, prints only what changed
  servicerBatch.ts         batch harvest of performance

analysis/                  archived analyses, one question each
  challenge.ts             falsification of the origination findings
  outcomes.ts              underwriting against outcome

api/ · mcp/                the product: /comps, the UI, the MCP tool
```

The corpus: 233 filings, 9,694 loans, 101 metrics, and 2,231 loans with actual
post-closing NOI.

**Operational constraint:** I have no network access to the Anthropic API from
where I run, and the harvests against EDGAR are run by the user.

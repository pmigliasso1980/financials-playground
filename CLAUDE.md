# Context for Claude

A corpus of CMBS loans built from public SEC filings, with the tools to interrogate
it and to try to prove it wrong.

Start by reading `docs/underwriting-finding.md` — the result and its holes — and
`docs/cre-taxonomy.md`, which documents the 94 metrics with the incident that
motivated each distinction.

**The project is in English.** It was written in Spanish and migrated; anything
still in Spanish is a leftover, and `python3 tools/find-spanish.py` finds it.

---

## How we work here

These are not style preferences. Each came out of a concrete mistake that cost
time, and they are here so it does not repeat.

### State what you expect to see BEFORE running anything

It is the rule that produced the most value. Almost every error was caught because
a number came back different from the one announced, not by reasoning:

- "DSCR rises to 99%" → it rose to 95%, and that 5% was real
- "the cause is the rate limit" → it was a missing environment variable
- "B18 goes back to 65 loans" → it was not re-harvested, and that exposed a blind
  selector

A prediction that cannot be wrong is useless. "It could go up or down" falsifies
nothing.

### After three failed attacks, stop attacking and explain

The claim "BANK underwrites four times better than BBCMS" survived **nine** attempts
to kill it: join coverage, listed population, block format, parser filters, raw
values across twenty issuances, master servicer, special servicer, composition by
property type, and an entire 10-D block the parser was not reading.

All nine asked the same thing: *"is this an artefact?"*. All nine said no, and none
brought anything closer to the truth. **Nine "not an artefact"s do not make an "it
is real".**

The tenth asked *"what would this be if it were real?"* and killed it in one go: the
shelf does not originate loans, it buys them. Standardising by seller × vintage, no
issuer departs.

A concrete rival hypothesis is worth more than any amount of defensive
verification, because it can confirm as well as refute. If none can be formulated,
that is the finding.

### Before attacking a finding, reread what the project already wrote

The explanation for that gap had been in `docs/underwriting-finding.md` for weeks:
*"New York co-ops come classified as multifamily; in the BANK deals they are half
the pool"*. It was rediscovered three days later by another route, without having
reread the file.

### The unit of analysis is chosen before the method

A CMBS shelf packages loans bought from several originators. Asking it "who
underwrites better?" is a category error no statistical sophistication corrects, and
one that was visible without any data.

### Thresholds are fixed before seeing the number

In `analysis/challenge.ts` and `analysis/outcomes.ts` the cuts are written before
running the query. Choosing the threshold by looking at the result is choosing the
conclusion.

### Diagnostics show values, not counts

A count confirms the hypothesis; a sample of the raw datum can break it.

- "83 of 83 rows with loan_ref" → sounded healthy
- `"Loan", "Property", "Property"` → showed the identifier was the flag

The three most expensive bugs were all uncovered by looking at the value, never at
the aggregate metric.

### Do not define anything by symptom

I made the same mistake three times. The targeted re-harvest selected filings by
"has no identifier"; then I fixed the mapping, the symptom became "has a rubbish
identifier", and the selector passed them as healthy. I changed the criterion to
"usable identifier", and the next fix left a filing with a single numeric id out of
83 — it passed too.

**A detector defined over "X is missing" goes blind when the failure mode becomes "X
is present but wrong", which is the commoner case in data pipelines.**

`--refresh-stale` uses the taxonomy version each filing was harvested with. That
predicate does not move when you fix something.

### A failure has to say which of its causes it is

"33 unmatched" has three causes with three different fixes. Before trying to fix,
make the error distinguish them. See `db/servicerBatch.ts`.

### A diagnostic that does not switch off when its cause is fixed is noise

The "Where they fail" section of `db:identities` kept alarming with 27 cases out of
3,528. If the residue is small, say so.

### Tests can pin an error in place

I wrote a test asserting that `"Loan"` mapped to `loan_id`. It was the flag. The
suite certified the bug on every run. **Tests written by whoever wrote the mapping
are internal consistency, not verification.** The real verification is the
arithmetic identities (`db:identities`) and looking at raw values.

### A verification tool that cannot fail is the defect it exists to catch

This session produced five instruments that reported confidently on something they
were not looking at:

- the monitor computing its alert total with `reduce()` over its own `LIMIT 12`,
  reporting 1,585 where there were 1,900
- the Spanish detector matching accented characters, so a line with no accent
  counted as English
- `tsconfig.json`'s `include` omitting `api/`, `mcp/` and `analysis/`, so
  "typecheck clean" was a claim about part of the tree
- the fixture proxy measuring `dataRows − propertiesKept`, a subtraction that
  happens after the filter it was trying to measure
- the HTML contract checker matching one level deep, so it passed on the exact
  two-level bug it was written for

**Before trusting a checker, reintroduce the bug it exists to catch and confirm it
goes red.** A checker not tested against a known failure is a decoration.

### An index that is missing does not show until it explodes

`facts.observation_id` referenced `observations(id)` with ON DELETE SET NULL and no
index. Postgres does not index the referencing side of a foreign key. Every deleted
observation triggered a full Seq Scan of `facts`.

With a thousand rows it is instant; with half a million, a re-harvest goes from
minutes to hours. **There is no early signal**: a performance test with toy data
never finds it. Every column that is the referencing side of a CASCADE or SET NULL
needs an index, even if no read query uses it.

### A broken exclusion evicts, it does not merely dirty

The `debt_yield` exclusion said `/total\s*debt/i` and the real header was "Total
**Mortgage** Debt UW NOI Debt Yield". The word in the middle made it harmless.

What I expected: a few loans with the wrong ratio. What was happening: since a
column can only go to one metric, the total-debt one beat the senior one to the
place and the senior one was left with no destination —`debt_yield_total_debt` did
not claim it either, same regex. In BANK 2020-BNK26 that was 20 loans with someone
else's number and **55 with no number at all**.

Fixing the regex raised debt yield coverage from 92% to 96% and n from 8,302 to
8,609. **I predicted we would gain accuracy and lose coverage and we gained both**,
because my model of the damage was the wrong one.

An exclusion pattern that does not match does not leave things as they were: it
lets an impostor in to occupy the good one's place.

### An incomplete corpus is indistinguishable from a correct one

The five identities look at loans that are present. None sees the ones missing: if
the parser discards half the rows, the other half still closes its identities, its
values still look reasonable and the sanity checks still pass.

Morgan Stanley 2021-L5 dropped from 65 to 19 loans between two harvests and it was
noticed by accident, because the corpus total moved by 46 and I was looking for
another reason. We argued about whether the right number was 19 or 65 with no way to
decide.

`% of Initial Pool Balance` decides it for free: the shares sum to one by
construction. L5 summed to 63.7%, meaning **neither 19 nor 65 was correct** — the
total is around 30. It is present in 207 of 220 issuances and 201 sum to 100%.

It generalises: look for the quantity the document itself forces to sum to a known
total. It is the only family of check that detects absence.

### The noise floor goes BEFORE looking for the effect

Three hypotheses died in a row. The third — "delivered NOI collapsed from 11.5% to
1.0% between 2021 and 2024" — was the project's headline result.

The bootstrap over the per-vintage medians gave a standard error of 2.37% and a
minimum detectable difference of **6.6 points**. None of the 10 vintage pairs has
non-overlapping confidence intervals: with this sample, **no vintage is
distinguishable from any other**.

That calculation costs an afternoon and could have been done on day one. It was done
after months of harvesting and weeks of verifying the mapping.

What was NOT the cause: the sample was large enough. 10.5 points exceeds the 6.6
floor — if the collapse had been real, it would have shown. The effect was not
there.

**Before looking for an effect, measure what effect you can see.** If the noise
floor is bigger than what you are looking for, no analysis fixes it.

### An applied migration is not touched

Editing an already-run migration forces `db:reset`, which wipes the corpus. It
happened once, and the re-harvest failed afterwards. Changes go in a new file.

Migrations are tracked by filename, with no checksum — which is what makes editing
their *comments* safe, as the translation to English did across twelve files.

---

## Commands

```bash
npm run db:up && npm run db:migrate
npm run harvest:batch -- --limit 300 --years 7    # harvest (~5 min / 160 filings)
npm run harvest:batch -- --limit 300 --years 7 --refresh-stale   # re-harvest what
                                                  # was harvested with an old mapping

npm run db:identities     # is the mapping correct? — the strongest verification
npm run db:performance    # actual post-closing NOI, from the 10-D filings
npm run db:monitor        # what changed since the last run; exits 1 if anything did
npm run db:analyze        # distributions by asset type
npm run db:missing-state  # the loans with no state: portfolios or a parser defect?
npm run db:provenance     # which corpus each verdict was issued against

npm run api               # the product at localhost:8787
npm run api:scenarios     # the twelve scenarios against the real corpus
npm run api:smoke         # 26 checks against the running server
npm run api:contract      # the HTML pages against the API's field names

npm run test:all          # 137 checks, all offline
npm run typecheck         # covers harvest, db, api, mcp and analysis
```

Verification helpers in `tools/`, run directly with `python3`:

```bash
python3 tools/find-spanish.py            # leftover Spanish, by words not accents
python3 tools/check-sql.py db/*.ts       # SQL syntax via the real Postgres parser
python3 tools/check-html-contract.py     # same as npm run api:contract
```

**`SEC_USER_AGENT` is mandatory.** It is not a credential: EDGAR is public and free.
SEC requires a name and email in the header so they can warn you if your script
misbehaves. It goes in `.env` (already in `.gitignore`).

---

## Annex A traps that are documented nowhere else

They all came from a number that did not add up. They are in `docs/cre-taxonomy.md`
in more detail.

**Seven balances for the same loan.** The ratios the issuer publishes are computed
against *trust + non-trust pari passu*, not against the column labelled "Balance".
Using the wrong one gives debt yields of 3947%.

**Debt service is the trust's note; the DSCR is the whole loan.** It has to be scaled
by balance before dividing.

**A loan with an interest-only period has two debt service figures**, and the
published DSCR uses the smaller one.

**The 2020 format splits across two columns what the modern one joins:** column 0
with the `Loan`/`Property` flag, column 1 with the identifier titled just `"ID"`.

**There are errata in the documents.** Benchmark 2020-B16 publishes `"48 5%"` where
`48.5%` belongs. A number with an internal space returns null: repairing it would be
guessing between 48.5 and 485.

**"0.00" with empty dates means not reported**, not zero.

**The servicer's "Pros ID" varies by servicer.** At Computershare it is the
prospectus number; at Citigroup that column is called `OMCR` and the one labelled
"Loan ID" is the servicer's internal ID.

**An Annex A has two kinds of row.** One per loan and one per property securing it,
and the property rows carry the address, city and state of each. The harvester used
to discard them; `corpus.properties` and migration 014 exist to stop that. Measured
over the three fixtures: 138 discarded rows, all 138 with a state.

---

## State

233 issuances · 9,694 loans · 94 metrics · 2,231 loans with post-closing
performance.

Identities (taxonomy `2026.08.13`, before the pending re-harvest):

| identity | closes |
|---|---|
| debt yield = NOI / balance | 99% |
| LTV = balance / appraised value | 99% |
| NCF = NOI − replacement − TI/LC | 100% |
| DSCR (NCF) | 95% |
| DSCR (NOI) | 95% |

The correct denominator is `trust + non-trust pari passu` — or `balance_senior_total`
when the Annex publishes it: 97% against 75% for the trust balance alone.

Both DSCRs are capped by `debt_service_*` coverage (79-80%), not by a mapping error.

**The headline finding died.** See `docs/underwriting-finding.md`: at constant size
the fall in delivered NOI disappears — 2020 and 2024 give the same, 2.5% — and the
bootstrap shows no vintage is distinguishable from another. What survives is that
**projected** NOI is flat across vintages (3.0 · 3.6 · 3.5 · 3.4 · 4.3), and that
does hold up under stratification.

### Where to pick up

**The taxonomy was bumped to `2026.08.17` and the corpus has NOT been re-harvested
yet.** That version marks all 233 issuances as stale, which is how
`corpus.properties` gets populated. Until `npm run harvest:batch` runs, the
properties table is empty and `db:missing-state` will say so.

Recent work, in order:

1. **The state field.** 1,107 loans had the state spelled out in full and were
   invisible to every `/comps` query; `db:fix-states` recovered them. 790 remain
   with an empty state: ~585 are genuine multi-property portfolios and ~205 are a
   parser defect concentrated in 40 issuances.
2. **`corpus.properties`.** The property rows the harvester discarded now have a
   table and are tied to their loan by the issuer's numbering (3.01 → loan 3).
   Verified over the three fixtures: 138 of 138 tie.
3. **The migration to English.** Everything except `harvest/` and the two large
   docs. `tools/` holds the verification helpers built along the way.

### Open

- **`harvest/` is still in Spanish**, as are `docs/underwriting-finding.md` and
  `docs/cre-taxonomy.md` (the latter is generated — translate `definitions.ts` and
  regenerate, do not edit it by hand).
- **790 loans with an empty state**, in two populations that need different fixes.
- **362 loans with no `property_type`**, in three populations: portfolios, headers
  with data glued inside them (task #48), and BBCMS 2022-C17 (task #40).
- **The 2020 servicer join is still partial.** Benchmark 2020-B16/B18/B22 and DBJPM
  2020-C9 parse fine but join only 1-5 loans against their servicer report. The
  Annex A numbering of those vintages does not match the Pros ID.
- **The identities do not run automatically** after harvesting.
- **BANK 2021-BNK31 to BNK35** do not report full NOI years.
- `db/snapshot.ts` exists but its thresholds are invented. Do not trust it yet.

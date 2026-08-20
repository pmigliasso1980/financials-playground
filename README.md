# financials-playground

A corpus of commercial real estate loans built from public SEC filings, with the
tools to interrogate it and to try to prove it wrong.

233 CMBS issuances · 9,694 loans · 101 metrics · 2,231 loans with post-closing
performance.

---

## What is here

```
financials-playground/
├── docs/
│   ├── underwriting-finding.md     The result: projected against delivered growth
│   │                               by vintage, with its controls and its holes.
│   │                               Start here.
│   ├── cre-taxonomy.md             101 metrics, 55 with a definition, plus the
│   │                               incident that motivated each distinction.
│   │                               Generated: npm run taxonomy -- --write
│   ├── own-architecture.md         Design decisions and what was discarded
│   ├── api-contract.md             The /comps contract
│   ├── mcp.md                      The corpus as an assistant's tool
│   └── roadmap.md                  What comes next and what was ruled out
│
├── harvest/                        Harvesting from SEC EDGAR
│   ├── edgar/                      Client with SEC's rules, discovery of Annex A
│   │                               (FWP) and of servicer reports (10-D)
│   ├── parse/                      HTML and xlsx tables · servicer report
│   ├── normalize/                  Column mapping → observations with provenance
│   ├── batch.ts                    Resumable batch harvest
│   └── *.test.ts                   137 offline checks
│
├── db/                             The corpus in Postgres
│   ├── migrations/                 001 corpus · 002 performance · 003-015 views
│   ├── corpus.ts                   Writing, reading, promotion to facts
│   ├── identities.ts               Arithmetic verification of the mapping
│   ├── monitor.ts                  Daily watch: prints only what changed
│   ├── benchmark.ts / page.ts      One issuance against its cohort
│   └── explain.ts                  Which column each number came from
│
├── analysis/                       Archived analyses, one question each
│   ├── outcomes.ts                 Underwriting against outcome
│   ├── challenge.ts                Falsification of the origination findings
│   └── power.ts, bias.ts, …        Controls that killed several hypotheses
│
├── api/                            The product: /comps, the UI, the scenarios
├── mcp/                            The same corpus as an MCP tool
└── tools/                          Verification helpers (SQL, contracts, migration)
```

---

## Getting started

```bash
npm install
npm run db:up
npm run db:migrate

export SEC_USER_AGENT="Your Name you@email.com"   # or put it in .env
npm run harvest:batch -- --limit 100
```

`SEC_USER_AGENT` is not a credential: EDGAR is public and free, there is no
account and no API key. SEC requires every automated client to identify itself
with a name and email so they can warn you if your script misbehaves, rather than
blocking the IP range. Without it you get a 403.

Then:

```bash
npm run db:analyze         # distributions by asset type
npm run db:identities      # is the mapping correct?
npm run db:performance     # actual post-closing NOI, from the 10-D filings
npm run db:monitor         # what changed since the last run
npm run api                # the product, at http://localhost:8787
```

---

## Where the data comes from

All from EDGAR, no paid sources.

| What | Where | Form |
|---|---|---|
| Underwriting and history at closing | Annex A | FWP |
| Actual post-closing NOI | EX-99.1 of the monthly report | 10-D |

The Annex A publishes, per loan: the NOI the underwriter projected, up to four
vintages of historical NOI, three LTVs by denominator, two DSCRs, seven balances
and about a hundred and fifty more columns. The 10-D publishes what the property
actually produced afterwards.

---

## The part that is not obvious

The data is public: anyone can download the same files. What costs effort is
interpreting them, and the document does not declare its own conventions.

**An Annex A publishes seven balances for the same loan.** The ratios are computed
against *trust + non-trust pari passu*, not against the column labelled "Balance".
Using the wrong one gives debt yields of 3947%.

**Debt service is for the trust's note; the DSCR is for the whole loan.** It has to
be scaled by balance before dividing.

**A loan with an interest-only period has two debt service figures**, and the
published DSCR uses the smaller one.

**"0.00" with empty dates means not reported**, not zero.

Each of those is documented in `docs/cre-taxonomy.md` alongside the incident that
revealed it, because none was deduced by reading: they all came from a number that
did not add up.

---

## How it is verified

The corpus verifies itself. The issuer publishes ratios that have to be consistent
with the columns they derive from, and each column is mapped independently. If
independently mapped columns satisfy the relationships the issuer used to compute
them, the mapping is correct.

```
npm run db:identities
```

| identity | closes |
|---|---|
| DSCR (NCF) = NCF / debt service | 95% |
| DSCR (NOI) = underwritten NOI / debt service | 95% |
| NCF = NOI − replacement − TI/LC | 100% |
| Debt yield = underwritten NOI / balance | 99% |
| LTV = balance / appraised value | 99% |

It needs no external source, and it catches the class of error that no metric
looked at alone reveals.

Beyond that, each analysis tries to falsify its own result before reporting it:
`analysis/challenge.ts` and the control blocks in `analysis/outcomes.ts` have their
thresholds fixed in the code *before* seeing the numbers. Several findings died
there — they are recorded in the comments, along with what replaced them.

---

## What is broken and we know it

- **790 loans with an empty state.** Most are multi-property portfolios whose
  geography lives in the property rows the harvester used to discard; that is what
  `corpus.properties` and migration 014 exist to fix.
- **362 loans with no property type**, across three distinct populations —
  portfolios, headers with data glued inside them, and BBCMS 2022-C17.
- **The identities do not run automatically** after harvesting.
- Three issuances have their Annex A in a format we do not handle yet.

---

## Tests

```bash
npm run test:all       # 137 checks, all offline
npm run api:smoke      # 26 checks against the running server
npm run api:contract   # the HTML pages against the API's field names
```

The fixtures are real documents, trimmed, not synthetic. A test that passes on
invented data says nothing about the next Annex A.

---

## Constraints

- **Node ≥ 20.3.** The floor is set by `AbortSignal.any()`.
- **Maximum 10 requests per second to SEC.** The client limits to 8 for margin.
- **An applied migration is not touched.** Changes go in a new file; editing an old
  one forces `db:reset`, which wipes the corpus.
- **The API has no auth.** Do not expose it to the internet until that is decided.

/**
 * The use cases, run against the real corpus.
 *
 *   npm run api:scenarios
 *
 * WHY THIS AND NOT "WAIT FOR A BROKER TO USE IT"
 *
 * There is no broker. Saying "let's wait for feedback" was an elegant way of not
 * deciding: we are the users until there is another one, and we can exercise the
 * product today with scenarios we know exist in the market.
 *
 * IT IS NOT A TEST
 *
 * It does not assert that any result is correct. It runs twelve real situations
 * and shows what the product answers in each, so that the question "is this
 * useful?" gets looked at with data instead of argued about.
 *
 * The number that matters is how many of the twelve the corpus can answer. If it is
 * two, the product is very narrow. If it is ten, there is something here.
 *
 * THE SCENARIOS WERE CHOSEN SO IT WOULD FAIL
 *
 * The temptation would be to put twelve multifamily-in-Texas cases in and
 * celebrate. They are chosen the other way round: secondary markets, difficult
 * types, small and large amounts. If the product only works in the centre of the
 * distribution, I want that visible here and not when somebody tries it.
 *
 * AND A REFUSAL IS A USE CASE TOO
 *
 * That there are no conduit comparables for a 4 million dollar loan in a small
 * market is NOT a product failure: it is the answer. It means "this is not a
 * conduit deal, go to a bank or an agency."
 *
 * A PREDICTION OF MINE THAT WAS WRONG
 *
 * The first version marked "Retail OH 4M" as an expected refusal, on the grounds
 * that a small loan in a secondary market is not conduit. But the run showed 24
 * comparables nationally: it was not a channel problem, it was the same geography
 * problem as New Jersey.
 *
 * So I put an expectation into the test and the expectation was false. With the
 * geographic ladder that case should answer, so it is no longer marked.
 *
 * AND THEN THE LADDER OVERSHOT
 *
 * With the automatic national rung, all twelve cases started answering and the
 * refusals fell to ZERO. It looked like a triumph: it was the product losing its
 * ability to say no, because the country always has ten loans of any type.
 *
 * The automatic radius now stops at the region. And with `national: true` the
 * national answer can be asked for on purpose, which is a different claim.
 *
 * AND THE HAND-WRITTEN LABEL GOES, BECAUSE I GOT IT WRONG TWICE
 *
 * There used to be an `expectsEmpty` field I filled in by eye. I marked Ohio when I
 * should not have, then unmarked it when I should have, and on the last run the
 * script called three cases "problems" of which two were correct behaviour:
 * refusing with 3 comparables across the whole region is exactly what the product
 * has to do.
 *
 * The underlying error is one of design: **whether a refusal is correct cannot be
 * known a priori**, because it depends on how many comparables there are — which is
 * precisely what this script exists to measure. Labelling it beforehand puts my
 * conjecture inside the instrument.
 *
 * It is now classified by what the ladder shows, which is data and not an opinion:
 *
 *   region < 5      genuinely thin market, the refusal is the answer
 *   region 5 to 9   at the threshold's edge, worth a look
 *   region >= 10    there were enough and it refused anyway: that is a defect
 *
 * The last row is the only one that can accuse a bug, and it can fire.
 */

import { findComparables, type Criteria } from "./comps.js";
import { closePool, ping } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

interface Scenario {
  who: string;
  decides: string;
  criteria: Criteria;
}

const SCENARIOS: Scenario[] = [
  {
    who: "Broker · refinancing",
    decides: "whether the 70% LTV the client is asking for is realistic",
    criteria: { state: "GA", type: "Multifamily", amount: 28_000_000, targetLtv: 0.7 },
  },
  {
    who: "Broker · large market",
    decides: "what rate to expect in the most liquid corridor in the country",
    criteria: { state: "TX", type: "Multifamily", amount: 15_000_000 },
  },
  {
    who: "Broker · office",
    decides: "whether there is still conduit appetite for office and at what leverage",
    criteria: { state: "NY", type: "Office", amount: 45_000_000, targetLtv: 0.6 },
  },
  {
    who: "Broker · industrial",
    decides: "the debt yield warehouses are pricing at",
    criteria: { state: "CA", type: "Industrial", amount: 30_000_000 },
  },
  {
    who: "Broker · hospitality",
    decides: "whether to go conduit or to bridge debt",
    criteria: { state: "FL", type: "Hospitality", amount: 22_000_000 },
  },
  {
    who: "Broker · retail",
    decides: "what DSCR a shopping centre will be held to",
    criteria: { state: "FL", type: "Retail", amount: 12_000_000 },
  },
  {
    who: "Lender · pricing check",
    decides: "whether their quote is in market before sending it",
    criteria: { state: "NJ", type: "Industrial", amount: 25_000_000, targetLtv: 0.65 },
  },
  {
    who: "Investor · how much debt can I get",
    decides: "the realistic maximum leverage for modelling the purchase",
    criteria: { state: "NY", type: "Multifamily", amount: 60_000_000, targetLtv: 0.75 },
  },
  {
    who: "Broker · self storage",
    decides: "whether a niche type has a conduit market",
    criteria: { state: "AZ", type: "Self Storage", amount: 8_000_000 },
  },
  {
    who: "Broker · mixed use",
    decides: "how mixed use gets financed in an intermediate market",
    criteria: { state: "IL", type: "Mixed Use", amount: 20_000_000 },
  },
  {
    who: "Broker · small deal",
    decides: "whether a 4M loan in a secondary market is conduit",
    criteria: { state: "OH", type: "Retail", amount: 4_000_000 },
  },
  {
    who: "Broker · rare type in a small market",
    decides: "whether it is even worth calling a conduit originator",
    criteria: { state: "WY", type: "Manufactured", amount: 6_000_000 },
  },
];

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const fmt: Record<string, (v: number) => string> = {
  ltv: pct, debt_yield: pct, interest_rate: pct, dscr: (v) => `${v.toFixed(2)}x`,
};

console.log(`\n${"═".repeat(78)}`);
console.log("Use cases, against the real corpus");
console.log(`${"═".repeat(78)}`);

let answered = 0;
let thin = 0;
let atEdge = 0;
let defects = 0;

for (const scenario of SCENARIOS) {
  const c = scenario.criteria;
  const r = await findComparables(c);

  console.log(`\n${"─".repeat(78)}`);
  console.log(
    `  \x1b[1m${scenario.who}\x1b[0m — ${c.type} · ${c.state} · ` +
      `${(c.amount / 1e6).toFixed(0)}M USD`,
  );
  console.log(`  \x1b[90mDecides: ${scenario.decides}\x1b[0m\n`);

  if (!r.sufficient) {
    /**
     * The best rung tried automatically: region if it exists, otherwise the state.
     * The country does not count because it is not automatic.
     */
    const best = Math.max(
      ...r.ladder.filter((p) => p.scope !== "country").map((p) => p.found),
      0,
    );
    if (best >= 10) {
      defects++;
      console.log(
        `  \x1b[31mDEFECT: there were ${best} within the automatic radius and it refused anyway\x1b[0m`,
      );
    } else if (best >= 5) {
      atEdge++;
      console.log(
        `  \x1b[33m${best} comparables at the best radius — at the edge of the threshold of 10\x1b[0m`,
      );
    } else {
      thin++;
      console.log(
        `  \x1b[32m${best} comparables across the whole region — "there is no conduit market here"\x1b[0m` +
          `  \x1b[90m← the refusal is the answer\x1b[0m`,
      );
    }
    for (const p of r.ladder) {
      console.log(`    \x1b[90m${p.label} → ${p.found}\x1b[0m`);
    }
    for (const s of r.ifWidened) {
      console.log(`    \x1b[90m${s.criterion} → ${s.found}\x1b[0m`);
    }
    continue;
  }

  answered++;
  console.log(
    `  \x1b[1m${r.found} comparables\x1b[0m in ` +
      `${r.scope === "state" ? "" : "\x1b[33m"}${r.scopeLabel}\x1b[0m` +
      (r.scope === "state"
        ? ""
        : `  \x1b[90m(${r.ladder[0]!.label} alone: ${r.ladder[0]!.found})\x1b[0m`),
  );
  for (const m of r.distributions) {
    const f = fmt[m.metric] ?? ((v: number) => v.toFixed(2));
    console.log(
      `    ${m.label.padEnd(12)} ${f(m.p50).padStart(8)}   ` +
        `\x1b[90m${f(m.p25)} – ${f(m.p75)}  ·  over ${m.base}\x1b[0m`,
    );
  }
  if (r.target) {
    const share = r.target.reached / Math.max(1, r.target.of);
    console.log(
      `    \x1b[${share < 0.25 ? "33" : "32"}m→ ${r.target.reached} of ${r.target.of} ` +
        `reached ${pct(r.target.ltv)} LTV${
          share < 0.25 ? " — revisit the expectation" : " — it is in market"
        }\x1b[0m`,
    );
  }
}

await closePool();

console.log(`\n${"═".repeat(78)}`);
console.log(
  `  \x1b[1m${answered} of ${SCENARIOS.length}\x1b[0m scenarios answered with a range.`,
);
console.log(
  `  \x1b[90m${thin} correct refusals: fewer than 5 comparables across the whole region.\x1b[0m`,
);
if (atEdge > 0) {
  console.log(
    `  \x1b[33m${atEdge} at the edge: between 5 and 9, just short of the threshold of 10.\x1b[0m`,
  );
}
console.log(
  defects > 0
    ? `  \x1b[31m${defects} DEFECTS: there were 10 or more and the product refused anyway.\x1b[0m`
    : `  \x1b[32mNo defects: it never refused while having enough comparables.\x1b[0m`,
);
console.log(
  `\n  \x1b[90mThis does not verify that the numbers are correct: it shows what the product\x1b[0m`,
);
console.log(
  `  \x1b[90manswers, so the question "is this useful?" can be looked at with data.\x1b[0m\n`,
);

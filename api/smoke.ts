/**
 * API smoke test: runs against the live server, not against mocks.
 *
 *   npm run api        # terminal 1
 *   npm run api:smoke  # terminal 2
 *
 * WHY IT EXISTS, AND WHICH CHECK MOTIVATED IT
 *
 * The first version of the screen showed each comparable with a "to SEC" link that
 * was a search URL written from memory: empty parameters and `action` repeated
 * twice. It led nowhere, and the correct datum —`file_url`— was in the database
 * from the start.
 *
 * That passed the typecheck, passed review and was committed described as "takes
 * each comparable to its document on SEC". A string has no type to contradict it.
 *
 * So this file's central check is exactly that: **every URL the API returns has to
 * point at the real EDGAR file**, and the shape is verified against the real
 * pattern. It is the only test here that catches a hallucination rather than a
 * programming error.
 *
 * WHAT THIS SMOKE TEST DOES NOT DO
 *
 * It does not open the URLs. Verifying they return 200 would mean hitting sec.gov
 * on every run, and that turns a fast test into one that fails on the network. It
 * verifies the SHAPE; that the file exists is guaranteed by the harvester, which
 * downloaded it.
 *
 * WHY THE EMPTY EXPORT AT THE BOTTOM
 *
 * This file uses top-level `await`, which TypeScript only allows in a module. It
 * had no imports or exports, so it was not one — and it never compiled. That went
 * unnoticed because tsconfig's `include` did not cover `api/` at all, so `npm run
 * typecheck` never looked at this file. Both are fixed now.
 */

const BASE = process.env.API ?? "http://localhost:8787";

let ok = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    ok++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      \x1b[90m${detail}\x1b[0m` : ""}`);
  }
}

/**
 * The response body, loosely typed on purpose.
 *
 * The previous version spread `await res.json()` —typed `unknown`— into an object
 * literal, which does not compile. It ran under tsx because tsx strips types
 * without checking them.
 */
interface Envelope {
  status: number;
  request_id?: string;
  data?: Record<string, unknown> & { error?: Record<string, unknown> };
}

async function get(path: string): Promise<Envelope> {
  const res = await fetch(`${BASE}${path}`);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, ...body } as Envelope;
}

console.log(`\n  API smoke test — ${BASE}\n`);

try {
  const health = await get("/health");
  check("/health returns 200", health.status === 200);
  check("every response carries a request_id", typeof health.request_id === "string");
} catch {
  console.error(
    `\n  \x1b[31mCould not connect to ${BASE}.\x1b[0m Start the server with \x1b[1mnpm run api\x1b[0m\n`,
  );
  process.exit(1);
}

const corpus = await get("/corpus");
check("/corpus carries the provenance stamp", typeof corpus.data?.provenanceStamp === "string");
check(
  "/corpus lists the types",
  Array.isArray(corpus.data?.types) && (corpus.data.types as unknown[]).length > 0,
);

// ---------------------------------------------------------------------------
// Invalid parameters: all the errors at once, not the first one
// ---------------------------------------------------------------------------

const bad = await get("/comps?state=GEORGIA&type=Houses&amount=zero");
const badFailures = (bad.data?.error?.failures ?? []) as Array<{ expected?: string }>;
check("invalid parameters → 422", bad.status === 422);
check(
  "returns all THREE errors, not just the first",
  badFailures.length === 3,
  `returned ${badFailures.length}`,
);
check(
  "every error says what to send",
  badFailures.every((f) => typeof f.expected === "string"),
);

// ---------------------------------------------------------------------------
// That the refusal remains POSSIBLE, with a realistic query
// ---------------------------------------------------------------------------

/**
 * THIS BLOCK EXISTS BECAUSE THE PREVIOUS ONE WAS USELESS.
 *
 * The first version tested the refusal with self storage in Wyoming at 999 MILLION
 * dollars. So absurd that not even the national corpus covers it, so it passed
 * green even when the refusal was broken for every realistic query — which is
 * exactly what happened when the automatic national rung was added: `sufficient:
 * false` became unreachable and the smoke test said nothing.
 *
 * A test whose case is so far outside the distribution that it cannot fail in the
 * interesting region is not a test. Now it uses a query a broker could really
 * write: manufactured at 6M in Wyoming. There are 58 nationally, so if national
 * scope ever became automatic again, this goes red.
 */
const realistic = await get("/comps?state=WY&type=Manufactured&amount=6000000");
check(
  "a realistic query with no local market REFUSES",
  realistic.data?.sufficient === false,
  `answered with ${realistic.data?.found} comparables in "${realistic.data?.scopeLabel}"`,
);
check(
  "and offers national scope as an explicit option",
  ((realistic.data?.ladder ?? []) as Array<{ scope: string; found: number }>).some(
    (p) => p.scope === "country" && p.found > 0,
  ),
);

/** And with `national=1` it does answer: the door exists, it has to be opened deliberately. */
const withNational = await get("/comps?state=WY&type=Manufactured&amount=6000000&national=1");
check(
  "asking for national scope explicitly, it answers",
  withNational.data?.sufficient === true && withNational.data?.scope === "country",
  `sufficient=${withNational.data?.sufficient} scope=${withNational.data?.scope}`,
);

const empty = await get("/comps?state=WY&type=Self+Storage&amount=999000000");
const emptyLadder = (empty.data?.ladder ?? []) as Array<{ label: string }>;
check("query with no comparables → 200, NOT 404", empty.status === 200);
check("and declares itself insufficient", empty.data?.sufficient === false);
check(
  "shows the full geographic ladder",
  Array.isArray(empty.data?.ladder) && emptyLadder.length >= 2,
  `ladder: ${JSON.stringify(emptyLadder.map((p) => p.label))}`,
);
check(
  "and also offers loosening size and window",
  Array.isArray(empty.data?.ifWidened) && (empty.data.ifWidened as unknown[]).length === 2,
);

// ---------------------------------------------------------------------------
// The real query: this is where the check that motivated the file lives
// ---------------------------------------------------------------------------

const r = await get("/comps?state=NY&type=Multifamily&amount=25000000&months=60&target_ltv=70");
const criteria = r.data?.criteria as { targetLtv?: number } | undefined;
check("valid query → 200", r.status === 200);
check(
  "carries the channel's limit in the response",
  typeof (r.data?.corpus as { channel?: string } | undefined)?.channel === "string",
);
check(
  "carries the corpus provenance stamp",
  typeof (r.data?.corpus as { provenanceStamp?: string } | undefined)?.provenanceStamp === "string",
);
check(
  "the LTV was normalised from 70 to 0.70",
  criteria?.targetLtv === 0.7,
  `ended up as ${criteria?.targetLtv}`,
);

if (r.data?.sufficient) {
  const m = r.data.sample as Array<{ document: string; index: string; issuance: string }>;
  check("returns comparables", m.length > 0);

  /**
   * The scope has to be present and consistent with the ladder: if it says
   * "state", the first rung has to reach the minimum on its own.
   */
  check(
    "declares how far it widened the radius",
    ["state", "region", "country"].includes(r.data.scope as string),
    `scope: ${r.data.scope}`,
  );
  const firstRung = (r.data.ladder as Array<{ label: string; found: number }>)[0];
  check(
    "the scope is consistent with the ladder",
    r.data.scope !== "state" || (firstRung?.found ?? 0) >= 10,
    `says "${r.data.scope}" but ${firstRung?.label} has ${firstRung?.found}`,
  );

  /** THE CHECK. An invented URL dies here and nowhere else. */
  const badDocument = m.filter((c) => !/^https:\/\/www\.sec\.gov\/Archives\/edgar\//.test(c.document));
  check(
    "EVERY document points at the real EDGAR file",
    badDocument.length === 0,
    badDocument[0] ? `e.g. ${badDocument[0].document}` : undefined,
  );

  const PATTERN = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/\d{10}-\d{2}-\d{6}-index\.htm$/;
  const badIndex = m.filter((c) => !PATTERN.test(c.index));
  check(
    "EVERY index has the form cik/accession/accession-index.htm",
    badIndex.length === 0,
    badIndex[0] ? `e.g. ${badIndex[0].index}` : undefined,
  );

  check(
    "no URL was left with empty parameters",
    !m.some((c) => /[?&][a-z_]+=(&|$)/i.test(c.document) || /[?&][a-z_]+=(&|$)/i.test(c.index)),
  );

  /**
   * Each distribution declares its own base and that base cannot exceed the total:
   * if it did, it would be counting loans that are not comparables.
   */
  const dists = r.data.distributions as Array<{ base: number; label: string }>;
  const found = r.data.found as number;
  check("every metric declares its base", dists.every((d) => Number.isInteger(d.base) && d.base > 0));
  check(
    "no base exceeds the total number of comparables",
    dists.every((d) => d.base <= found),
    dists.map((d) => `${d.label}=${d.base}`).join(" · ") + ` vs ${found}`,
  );
} else {
  console.log(
    `  \x1b[33m·\x1b[0m the test query had no comparables (${r.data?.found}); ` +
      `the URL shapes could not be verified`,
  );
}

console.log(`\n  ${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${ok} ok · ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);

/**
 * Makes this file a module so top-level `await` is legal. Without it TypeScript
 * treats the file as a script and rejects every `await` above — which it had been
 * doing silently, because `api/` was outside tsconfig's `include`.
 */
export {};

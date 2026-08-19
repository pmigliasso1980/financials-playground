/**
 * Comparables: the one question this corpus can answer for a broker.
 *
 * "I have a property of this type, in this state, of this size. What terms did
 * similar loans get?"
 *
 * It is pure domain logic, with no HTTP, so it can be tested and so the server is
 * only transport.
 *
 * THE THREE RULES THAT COME FROM THE EARLIER WORK
 *
 * 1. It refuses rather than invents. Below the minimum there is no range to give,
 *    and returning the median of three loans is worse than not answering: it looks
 *    like an answer.
 *
 *    But before refusing it widens the radius: state, then census division, then
 *    the whole country. It stops at the FIRST rung that suffices, not the one that
 *    returns the most, because a comparable from another state is worse than one
 *    from your own and the radius opens only as far as needed.
 *
 * 2. Every number carries its base. Coverage is not the same across metrics
 *    —there may be 31 comparables and only 22 with a debt yield— so each
 *    distribution says how many it was computed over, not how many exist.
 *
 * 3. Every answer carries provenance and the channel's limit. This corpus is ONLY
 *    conduit CMBS: no banks, agencies, bridge debt or life companies. A broker
 *    comparing against this is comparing against one channel, and if the answer
 *    does not say so, it lies by omission.
 */

import { query } from "../db/client.js";
import { corpusState, provenanceStamp } from "../db/provenance.js";

/**
 * REVISED WITH DATA, AND THAT IS DECLARED.
 *
 * It was 5, fixed before seeing anything. The `api:scenarios` run showed why that
 * fell short: multifamily in Georgia returned 6 comparables and an LTV range of
 * 65.4% to 69.1%. An interquartile range built from six points is two or three
 * loans, and that range projects a precision it does not have.
 *
 * Raised to 10. It is not that 5 was "wrong" —it was a reasonable a priori count—
 * but that there is now evidence of what it got wrong, and that is worth more than
 * the purity of not touching it.
 */
export const MIN_COMPARABLES = 10;
export const DEFAULT_BAND = 0.5;
export const DEFAULT_MONTHS = 18;

export const PROPERTY_TYPES = [
  "Multifamily", "Retail", "Office", "Industrial",
  "Self Storage", "Hospitality", "Mixed Use", "Manufactured",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/**
 * THE NINE CENSUS DIVISIONS, AND WHY NOT THE FOUR REGIONS.
 *
 * `api:scenarios` made plain that the state filter is what breaks the product:
 * industrial in New Jersey found 4 comparables and 53 across the country. The
 * information is not missing, it is in the next state over — and a New Jersey
 * broker looks at Pennsylvania and New York comparables without hesitating.
 *
 * The four big regions (Northeast, Midwest, South, West) are too coarse: they put
 * Florida with West Virginia and California with Alaska. The nine divisions group
 * markets that genuinely compare with each other.
 *
 * It is not our taxonomy: it is the Census Bureau's, the same one the sector's
 * market reports use. Inventing our own regions would be one more arbitrary
 * decision to justify.
 */
export const DIVISIONS: Record<string, { name: string; states: string[] }> = {
  new_england: { name: "New England", states: ["CT", "ME", "MA", "NH", "RI", "VT"] },
  mid_atlantic: { name: "Mid-Atlantic", states: ["NJ", "NY", "PA"] },
  e_north_central: { name: "East North Central", states: ["IL", "IN", "MI", "OH", "WI"] },
  w_north_central: { name: "West North Central", states: ["IA", "KS", "MN", "MO", "NE", "ND", "SD"] },
  south_atlantic: { name: "South Atlantic", states: ["DE", "DC", "FL", "GA", "MD", "NC", "SC", "VA", "WV"] },
  e_south_central: { name: "East South Central", states: ["AL", "KY", "MS", "TN"] },
  w_south_central: { name: "West South Central", states: ["AR", "LA", "OK", "TX"] },
  mountain: { name: "Mountain", states: ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY"] },
  pacific: { name: "Pacific", states: ["AK", "CA", "HI", "OR", "WA"] },
};

export function divisionOf(state: string): { name: string; states: string[] } | null {
  const e = state.toUpperCase();
  for (const d of Object.values(DIVISIONS)) if (d.states.includes(e)) return d;
  return null;
}

/**
 * How far the radius had to open.
 *
 * "Country" is NOT just another rung of the ladder, and that distinction was paid
 * for dearly.
 *
 * The first version stepped automatically down to the country, and with that all
 * twelve test scenarios started answering. It looked like a triumph and it was a
 * regression: since the corpus always has ten loans of any type nationally,
 * `sufficient: false` became UNREACHABLE. The product lost its ability to say no,
 * which is the trait that distinguishes it from a spreadsheet.
 *
 * It is the same test-that-cannot-fail that appears all over this repository, this
 * time inside the product.
 *
 * And the numbers confirm it: retail at 4M in Ohio, nationally, gives an LTV of
 * 38.2% to 58.0%. Twenty points of interquartile range is not a comparable set, it
 * is the whole market — true and uninformative.
 *
 * So the automatic radius stops at the REGION. The country exists, but it has to
 * be asked for: it is a different claim —"this is how this gets financed
 * nationally", not "this is how it gets financed in your market"— and whoever asks
 * has to choose it.
 */
export type Scope = "state" | "region" | "country";

const CANON = `CASE
    WHEN l.property_type ~* 'multifamily|cooperative|garden|low rise|mid rise|student' THEN 'Multifamily'
    WHEN l.property_type ~* 'retail|anchored|single tenant' THEN 'Retail'
    WHEN l.property_type ~* 'office|cbd|suburban|medical' THEN 'Office'
    WHEN l.property_type ~* 'industrial|warehouse|flex' THEN 'Industrial'
    WHEN l.property_type ~* 'storage' THEN 'Self Storage'
    WHEN l.property_type ~* 'hospitality|hotel|service|extended stay' THEN 'Hospitality'
    WHEN l.property_type ~* 'mixed' THEN 'Mixed Use'
    WHEN l.property_type ~* 'manufactured' THEN 'Manufactured'
    ELSE 'Other'
  END`;

export interface Criteria {
  state: string;
  type: PropertyType;
  amount: number;
  /**
   * Explicitly ask for national scope. By default the ladder stops at the region,
   * so that the refusal remains possible.
   */
  national?: boolean;
  /** Width of the size band. 0.5 = ±50%. */
  band?: number;
  /** Look-back window from today. */
  months?: number;
  /** Optional: the LTV the client is asking for, to place it in the distribution. */
  targetLtv?: number;
}

export interface Distribution {
  metric: string;
  label: string;
  /** How many comparables it was computed over: NOT the total number of comparables. */
  base: number;
  p25: number;
  p50: number;
  p75: number;
}

export interface Comparable {
  loanId: number;
  issuance: string;
  date: string;
  property: string | null;
  city: string | null;
  amount: number;
  accession: string;
  /**
   * TWO URLS, BOTH READ FROM THE DATABASE AND NEITHER BUILT FROM MEMORY.
   *
   * `document` is exactly the file the harvester downloaded and parsed —the
   * `file_url` column of `corpus.filings`— so it opens the Annex A these numbers
   * came from and not a similar-looking search.
   *
   * `index` is the filing's page on EDGAR, built from cik + accession, for when
   * someone wants to see the rest of that issuance's documents.
   *
   * The first version of this was an EDGAR search URL I wrote from memory, with
   * empty parameters and `action` repeated twice: it led nowhere. The correct datum
   * was in the database from the start.
   */
  document: string;
  index: string;
}

/** One rung of the geographic ladder, with how many exist at that radius. */
export interface Rung {
  scope: Scope;
  label: string;
  found: number;
}

export type CompsResponse =
  | {
      sufficient: false;
      found: number;
      minimum: number;
      /** The full ladder, so it is visible that the radius was widened. */
      ladder: Rung[];
      /** What would happen if each criterion were loosened, so the asker decides. */
      ifWidened: Array<{ criterion: string; found: number }>;
      criteria: Criteria;
      corpus: { provenanceStamp: string; channel: string };
    }
  | {
      sufficient: true;
      found: number;
      /**
       * Which radius ended up being used. It travels in the response because it
       * changes what the number means: "31 in Texas" and "31 in West South
       * Central" are not the same claim, and the asker has to be able to tell them
       * apart.
       */
      scope: Scope;
      scopeLabel: string;
      ladder: Rung[];
      distributions: Distribution[];
      target: { ltv: number; reached: number; of: number } | null;
      sample: Comparable[];
      criteria: Criteria;
      corpus: { provenanceStamp: string; channel: string };
    };

/**
 * The filing's page on EDGAR: cik + accession without dashes + accession with
 * dashes. It is the only part built from a rule rather than read, which is why the
 * smoke test verifies it against a real accession.
 */
export function edgarIndexUrl(cik: string, accession: string): string {
  const clean = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${clean}/${accession}-index.htm`;
}

const CHANNEL =
  "Conduit CMBS from SEC EDGAR only. Does not include banks, agencies, bridge debt " +
  "or life insurance companies.";

/**
 * The shared WHERE clause, parameterised by geographic scope.
 *
 * `states = null` means the whole country. If this changes here, it changes in the
 * count, in the distributions and in the sample at once — which is the reason a
 * single function exists rather than three similar queries.
 */
function filter(c: Criteria, states: string[] | null) {
  const band = c.band ?? DEFAULT_BAND;
  const months = c.months ?? DEFAULT_MONTHS;
  const params: unknown[] = [
    c.type,
    c.amount * (1 - band),
    c.amount * (1 + band),
    String(months),
  ];
  let sql = `${CANON} = $1
          AND am.value::numeric BETWEEN $2 AND $3
          AND f.filed_at >= now() - ($4 || ' months')::interval`;
  if (states) {
    params.push(states);
    sql += `\n          AND nullif(btrim(l.state), '') = ANY($${params.length})`;
  }
  return { sql, params };
}

const FROM = `FROM corpus.loans l
   JOIN corpus.filings f ON f.accession = l.accession
   JOIN corpus.facts am ON am.loan_id = l.id AND am.metric_key = 'loan_amount'
                       AND am.value ~ '^[0-9.]+$' AND am.value::numeric > 0`;

async function count(c: Criteria, states: string[] | null): Promise<number> {
  const { sql, params } = filter(c, states);
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n ${FROM} WHERE ${sql}`,
    params,
  );
  return Number(rows[0]!.n);
}

const METRICS: Array<{ key: string; label: string; max: number }> = [
  { key: "ltv", label: "LTV", max: 2 },
  { key: "dscr", label: "DSCR", max: 20 },
  { key: "debt_yield", label: "Debt yield", max: 2 },
  { key: "interest_rate", label: "Rate", max: 1 },
];

export async function findComparables(c: Criteria): Promise<CompsResponse> {
  const state = await corpusState();
  const corpus = { provenanceStamp: provenanceStamp(state), channel: CHANNEL };
  const div = divisionOf(c.state);

  /**
   * THE LADDER: state, then region, then country.
   *
   * It stops at the FIRST rung that reaches the minimum, not the one that returns
   * the most. A comparable from another state is worse than one from the same
   * state, so the radius opens only as far as needed and never for its own sake.
   *
   * All three rungs are counted the same —including the ones not used— because
   * "4 in NJ, 19 in the Mid-Atlantic" tells the asker where their answer came from
   * and how far we had to go to find it.
   */
  const rungs: Array<{ scope: Scope; label: string; states: string[] | null }> = [
    { scope: "state", label: c.state.toUpperCase(), states: [c.state.toUpperCase()] },
    ...(div ? [{ scope: "region" as const, label: div.name, states: div.states }] : []),
    /** Only if asked for. See the comment on `Scope`. */
    ...(c.national ? [{ scope: "country" as const, label: "the whole country", states: null }] : []),
  ];

  const ladder: Rung[] = [];
  let chosen: (typeof rungs)[number] | null = null;
  for (const p of rungs) {
    const n = await count(c, p.states);
    ladder.push({ scope: p.scope, label: p.label, found: n });
    if (!chosen && n >= MIN_COMPARABLES) chosen = p;
  }

  /**
   * The national count is ALWAYS computed even when unused, so it can be offered
   * in the refusal. "There are no comparables in your market, but there are 58
   * nationally if you want to see them" is a better answer than a dead end, and it
   * leaves the decision with the asker.
   */
  if (!c.national) {
    const nCountry = await count(c, null);
    ladder.push({ scope: "country", label: "the whole country (must be asked for)", found: nCountry });
  }

  if (!chosen) {
    /**
     * Not even opening to the whole country is enough. Only then are the other two
     * axes —size and window— offered, because loosening them changes what counts
     * as a comparable, and that is the asker's decision and not ours.
     */
    return {
      sufficient: false,
      found: ladder[0]!.found,
      minimum: MIN_COMPARABLES,
      ladder,
      ifWidened: [
        { criterion: "±100% of amount instead of ±50%", found: await count({ ...c, band: 1 }, null) },
        { criterion: "last 36 months instead of 18", found: await count({ ...c, months: 36 }, null) },
      ],
      criteria: c,
      corpus,
    };
  }

  const scopeStates = chosen.states;
  const found = ladder.find((e) => e.scope === chosen!.scope)!.found;
  const { sql, params } = filter(c, scopeStates);

  /**
   * One query per metric: each has its own coverage, and computing them together
   * would require a FILTER per metric that obscures where each base comes from.
   */
  const distributions: Distribution[] = [];
  for (const m of METRICS) {
    const { rows } = await query<{ base: string; p25: string; p50: string; p75: string }>(
      `SELECT count(*)::text AS base,
              percentile_cont(0.25) WITHIN GROUP (ORDER BY v.value::numeric)::text AS p25,
              percentile_cont(0.50) WITHIN GROUP (ORDER BY v.value::numeric)::text AS p50,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY v.value::numeric)::text AS p75
         ${FROM}
         JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = $${params.length + 1}
                            AND v.value ~ '^[0-9.]+$'
                            AND v.value::numeric > 0 AND v.value::numeric < $${params.length + 2}
        WHERE ${sql}`,
      [...params, m.key, m.max],
    );
    const r = rows[0]!;
    if (Number(r.base) === 0) continue;
    distributions.push({
      metric: m.key, label: m.label, base: Number(r.base),
      p25: Number(r.p25), p50: Number(r.p50), p75: Number(r.p75),
    });
  }

  /** Where the client's request falls within what the channel actually delivered. */
  let target: { ltv: number; reached: number; of: number } | null = null;
  if (c.targetLtv != null) {
    const { rows } = await query<{ reached: string; of: string }>(
      `SELECT count(*) FILTER (WHERE v.value::numeric >= $${params.length + 1})::text AS reached,
              count(*)::text AS of
         ${FROM}
         JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = 'ltv'
                            AND v.value ~ '^[0-9.]+$'
                            AND v.value::numeric > 0 AND v.value::numeric <= 2
        WHERE ${sql}`,
      [...params, c.targetLtv],
    );
    target = {
      ltv: c.targetLtv,
      reached: Number(rows[0]!.reached),
      of: Number(rows[0]!.of),
    };
  }

  /**
   * The sample travels with its EDGAR document. A comparable you cannot open is a
   * number you have to take on trust; with the filing behind it, it is verifiable.
   */
  const { rows: sample } = await query<{
    id: string; issuance: string; date: string; property: string | null;
    city: string | null; state: string | null; amount: string; accession: string;
    cik: string; file_url: string;
  }>(
    `SELECT l.id::text, f.company_name AS issuance, f.filed_at::text AS date,
            l.property_name AS property, l.city AS city, l.state AS state,
            am.value AS amount, l.accession, f.cik, f.file_url
       ${FROM}
      WHERE ${sql}
      ORDER BY f.filed_at DESC, am.value::numeric DESC
      LIMIT 25`,
    params,
  );

  return {
    sufficient: true,
    found,
    scope: chosen.scope,
    scopeLabel: chosen.label,
    ladder,
    distributions,
    target,
    sample: sample.map((r) => ({
      loanId: Number(r.id), issuance: r.issuance, date: r.date.slice(0, 10),
      property: r.property,
      city: r.city && r.state ? `${r.city}, ${r.state}` : r.city,
      amount: Number(r.amount), accession: r.accession,
      document: r.file_url, index: edgarIndexUrl(r.cik, r.accession),
    })),
    criteria: c,
    corpus,
  };
}

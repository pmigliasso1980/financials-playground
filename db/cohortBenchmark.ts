/**
 * The cohort benchmark computation, without formatting.
 *
 * WHY IT IS A MODULE AND NOT PART OF THE SCRIPT
 *
 * `db:benchmark` prints to the terminal and `db:page` generates HTML. If each
 * queried the database on its own there would be two implementations of the same
 * comparison, and this session has already shown how that ends: occupancy had
 * two definitions coexisting —one required ten loans, the other one— and they
 * contradicted each other on the same screen without anyone noticing.
 *
 * The numbers live here. Consumers only choose how to display them.
 *
 * THE METHODOLOGICAL DECISIONS LIVE HERE TOO
 *
 * Pair threshold, single-type exclusion, minimum loans per metric: these are
 * decisions about what can be asserted, not about presentation. If they were
 * duplicated in each consumer, two views of the same deal could give different
 * answers.
 */

import { query } from "./client.js";
import { apart } from "./compositionDistance.js";

/** Fixed before looking at any data. */
export const MIN_PAIRS = 15;
export const TYPE_CONCENTRATION = 0.8;
export const MIN_PER_METRIC = 10;

export const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

export interface CohortMetric {
  key: string;
  label: string;
  min: number;
  max: number;
  fmt: (v: number) => string;
  /** Which direction is "more aggressive": tells you how to read the position. */
  aggressive: "high" | "low";
}

export const COHORT_METRICS: CohortMetric[] = [
  { key: "ltv", label: "LTV", min: 0.01, max: 2, fmt: (v) => pct(v, 1), aggressive: "high" },
  { key: "dscr", label: "DSCR", min: 0.1, max: 20, fmt: (v) => v.toFixed(2), aggressive: "low" },
  { key: "debt_yield", label: "Debt yield", min: 0.01, max: 1, fmt: (v) => pct(v, 1), aggressive: "low" },
  { key: "interest_rate", label: "Rate", min: 0.001, max: 0.2, fmt: (v) => pct(v, 2), aggressive: "high" },
  { key: "loan_amount", label: "Balance", min: 1e5, max: 1e10, fmt: (v) => `${(v / 1e6).toFixed(1)}M`, aggressive: "high" },
  { key: "occupancy", label: "Occupancy", min: 0.1, max: 1.01, fmt: (v) => pct(v, 1), aggressive: "low" },
];

export interface Issuance {
  accession: string;
  name: string;
  vintage: string;
  filed: string;
  pool: number;
  dominantType: string | null;
  dominantShare: number;
  /**
   * How many of those loans have a property type.
   *
   * `pool` counts every loan in the issuance and the composition is computed
   * only over those that have a type, so the two numbers are not the same. The
   * difference was visible in print —BMO 2026-C15 comes out with pool 14 in
   * `db:composition-signal` and 15 here— and nobody had looked at it.
   *
   * It matters because the null is simulated by drawing n loans at random: doing
   * it with 15 when the mix was measured over 14 gives the null less dispersion
   * than it should have, and that shifts the p-value TOWARDS "different". A small
   * bias —noise scales with 1/√n, so 15 against 14 is ~1.5%— but in the direction
   * of finding signal, and in the statistic that headlines the product.
   */
  typedPool: number;
}

export interface CohortMetricResult {
  spec: CohortMetric;
  /** null when the issuance does not have enough loans carrying the figure. */
  value: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  rank: number | null;
  total: number | null;
  /** true if it is among the first or last three of the cohort. */
  extreme: boolean;
  /** true if the extreme points towards the more aggressive side. */
  aggressive: boolean;
  /** Why there is no number, when there is none. */
  noData: "issuance" | "pairs" | null;
  pairsWithData: number;
}

export interface Composition {
  type: string;
  own: number;
  cohort: number;
  difference: number;
  /** true if the difference is smaller than one loan: it is not a difference. */
  belowResolution: boolean;
  /** How many loans of this issuance are of this type. */
  loans: number;
  /** How many loans account for the DIFFERENCE against the cohort. */
  loansOfDifference: number;
}

export interface Benchmark {
  target: Issuance;
  pairs: Issuance[];
  excluded: Issuance[];
  /** false when there are not enough pairs: the right answer is "unknown". */
  evaluable: boolean;
  /** true if the issuance itself is single-type and the comparison does not apply. */
  targetSingleType: boolean;
  metrics: CohortMetricResult[];
  composition: Composition[];
  /** How much of the pool one loan is worth: the real resolution of the composition. */
  pointPerLoan: number;
  /** Resolution in points a percentile would have with these pairs. */
  percentileResolution: number;
  /**
   * How far the property mix departs, and whether that beats chance.
   *
   * Measured with `db:composition-signal` over the 2026 cohort: 13 of 25
   * conduits depart more than chance, against 1.25 expected. The test was
   * verified before being used by generating issuances FROM the null: it found 2
   * of 28, against 1.4 expected.
   *
   * That 13 is NOT the one `db:catalog` shows, which gives 8. They are different
   * references —the catalogue excludes single-type deals from the pool and
   * requires both weightings to agree— and the detail is in the header of
   * `catalog.ts`. An earlier version of this comment said "10", which is neither.
   *
   * The six metrics track the same thing more weakly —rho = 0.59 between how
   * many depart and how far the mix departs— because composition causes the
   * deviation: hotels are underwritten differently from apartments.
   *
   * (An earlier version of this comment said the metrics were "indistinguishable
   * from the null, z = 0.00". That test compared each issuance against the
   * interquartile range of the others in the same set, where the marginal rate is
   * 50% by exchangeability whether or not there is signal: it had no power.)
   */
  distance: number;
  nullDistance: number;
  pValue: number;
  /**
   * The same computation with the reference weighted by ISSUANCE instead of by
   * loan, and whether the two agree.
   *
   * Measured: over 2026, by loan there are 13 significant issuances and by
   * issuance 15, agreeing on 13. The aggregate is robust —both figures are
   * overwhelming against 1.4 expected— but two issuances change sides, and one is
   * BANK5 2026-5YR24.
   *
   * So the per-issuance verdict is NOT robust in the borderline cases. A page
   * that says "different" or "indistinguishable" depending on a weighting chosen
   * without thinking asserts more than it knows, so when the two disagree we say
   * that instead of picking one.
   */
  pValueByIssuance: number;
  /** true if both weightings give the same verdict at 5%. */
  robust: boolean;
}

/**
 * The available issuances, with what is needed to decide who enters the
 * reference cohort.
 *
 * The pool is counted SEPARATELY from the types. The first version joined
 * `corpus.loans` with the types CTE —one row per (issuance, type)— and each loan
 * was counted once per type present: BANK5 2026-5YR24 came out with 315 loans
 * instead of 35. A join fan-out breaks nothing visibly, so it is avoided by
 * construction and not by attention.
 */
export async function loadCandidates(): Promise<Issuance[]> {
  const { rows } = await query<{
    accession: string; name: string; vintage: string; filed: string;
    pool: string; typed_pool: string; dominant_type: string | null;
    dominant_share: string | null;
  }>(
    `WITH pools AS (
       SELECT accession, count(*) AS pool,
              count(*) FILTER (WHERE property_type IS NOT NULL) AS typed_pool
         FROM corpus.loans GROUP BY accession
     ),
     types AS (
       SELECT l.accession, l.property_type AS type, count(*) AS n,
              row_number() OVER (PARTITION BY l.accession ORDER BY count(*) DESC) AS rn,
              sum(count(*)) OVER (PARTITION BY l.accession) AS total
         FROM corpus.loans l
        WHERE l.property_type IS NOT NULL
        GROUP BY l.accession, l.property_type
     ),
     dominant AS (
       SELECT accession, type, (n::numeric / nullif(total, 0)) AS share
         FROM types WHERE rn = 1
     )
     SELECT f.accession, f.company_name AS name,
            extract(year FROM f.filed_at)::int::text AS vintage,
            f.filed_at::text AS filed,
            p.pool::text,
            p.typed_pool::text,
            d.type AS dominant_type,
            d.share::text AS dominant_share
       FROM corpus.filings f
       JOIN pools p ON p.accession = f.accession
       LEFT JOIN dominant d ON d.accession = f.accession
      WHERE f.filed_at IS NOT NULL
      ORDER BY f.filed_at DESC`,
  );

  return rows.map((r) => ({
    accession: r.accession,
    name: r.name,
    vintage: r.vintage,
    filed: r.filed,
    pool: Number(r.pool),
    typedPool: Number(r.typed_pool),
    dominantType: r.dominant_type,
    dominantShare: Number(r.dominant_share ?? 0),
  }));
}

/**
 * Computes an issuance's benchmark against its cohort.
 *
 * Returns `null` only if the issuance is not found. Not having enough pairs is
 * NOT an error: it is an answer, and it travels in `evaluable`.
 */
export async function computeBenchmark(
  search: string | null,
  candidates?: Issuance[],
): Promise<Benchmark | null> {
  const all = candidates ?? (await loadCandidates());
  const target = search
    ? all.find((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    : all[0];
  if (!target) return null;

  /**
   * The reference group: the OTHER issuances of the same year, without the
   * single-type ones.
   *
   * Excluding itself is obvious and easy to forget: with 28 issuances, including
   * itself shifts the position by almost four points.
   */
  const sameVintage = all.filter(
    (c) => c.vintage === target.vintage && c.accession !== target.accession,
  );
  const pairs = sameVintage.filter((c) => c.dominantShare <= TYPE_CONCENTRATION);
  const excluded = sameVintage.filter((c) => c.dominantShare > TYPE_CONCENTRATION);

  const base: Omit<
    Benchmark,
    "metrics" | "composition" | "distance" | "nullDistance" | "pValue" | "pValueByIssuance" | "robust"
  > = {
    target,
    pairs,
    excluded,
    evaluable: pairs.length >= MIN_PAIRS,
    targetSingleType: target.dominantShare > TYPE_CONCENTRATION,
    pointPerLoan: 1 / Math.max(1, target.typedPool),
    percentileResolution: 100 / (pairs.length + 1),
  };

  if (!base.evaluable) {
    return {
      ...base, metrics: [], composition: [],
      distance: 0, nullDistance: 0, pValue: 1, pValueByIssuance: 1, robust: true,
    };
  }

  const accessions = [target.accession, ...pairs.map((p) => p.accession)];
  const metrics: CohortMetricResult[] = [];

  for (const spec of COHORT_METRICS) {
    const { rows } = await query<{ accession: string; median: string }>(
      `SELECT l.accession,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY fa.value::numeric)::text AS median
         FROM corpus.facts fa
         JOIN corpus.loans l ON l.id = fa.loan_id
        WHERE fa.metric_key = $1
          AND fa.value ~ '^-?[0-9.]+$'
          AND fa.value::numeric BETWEEN ${spec.min} AND ${spec.max}
          AND l.accession = ANY($2)
        GROUP BY l.accession
       HAVING count(*) >= ${MIN_PER_METRIC}`,
      [spec.key, accessions],
    );

    const own = rows.find((r) => r.accession === target.accession);
    const others = rows
      .filter((r) => r.accession !== target.accession)
      .map((r) => Number(r.median))
      .sort((a, b) => a - b);

    if (!own || others.length < MIN_PAIRS) {
      metrics.push({
        spec, value: null, p25: null, p50: null, p75: null, rank: null, total: null,
        extreme: false, aggressive: false,
        noData: !own ? "issuance" : "pairs",
        pairsWithData: others.length,
      });
      continue;
    }

    const v = Number(own.median);
    const q = (p: number) => others[Math.min(others.length - 1, Math.floor(p * others.length))]!;
    const rank = others.filter((x) => x < v).length + 1;
    const total = others.length + 1;
    const extreme = rank <= 3 || rank >= total - 2;

    metrics.push({
      spec, value: v,
      p25: q(0.25), p50: q(0.5), p75: q(0.75),
      rank, total, extreme,
      aggressive:
        (spec.aggressive === "high" && rank >= total - 2) ||
        (spec.aggressive === "low" && rank <= 3),
      noData: null,
      pairsWithData: others.length,
    });
  }

  /**
   * The composition, with the categories canonicalised.
   *
   * The Annex A publishes both the general and the detailed taxonomy. It is
   * normalised to the coarse categories because those are the ones with enough
   * loans per cell for a percentage to mean anything.
   */
  /**
   * The composition of EACH pair, so it can be weighted by issuance.
   *
   * The query below returns the loan-weighted aggregate; this one returns each
   * issuance's vector separately, which is what is needed to average them with
   * equal weight.
   */
  const { rows: perPair } = await query<{ accession: string; type: string; share: string }>(
    `WITH canon AS (
       SELECT l.accession,
              CASE
                WHEN l.property_type ~* 'multifamily|cooperative|garden|low rise|mid rise|student' THEN 'Multifamily'
                WHEN l.property_type ~* 'retail|anchored|single tenant' THEN 'Retail'
                WHEN l.property_type ~* 'office|cbd|suburban|medical' THEN 'Office'
                WHEN l.property_type ~* 'industrial|warehouse|flex' THEN 'Industrial'
                WHEN l.property_type ~* 'storage' THEN 'Self Storage'
                WHEN l.property_type ~* 'hospitality|hotel|service|extended stay' THEN 'Hospitality'
                WHEN l.property_type ~* 'mixed' THEN 'Mixed Use'
                WHEN l.property_type ~* 'manufactured' THEN 'Manufactured'
                ELSE 'Unclassified'
              END AS type
         FROM corpus.loans l
        WHERE l.property_type IS NOT NULL AND l.accession = ANY($1)
     ),
     tot AS (SELECT accession, count(*) AS n FROM canon GROUP BY accession)
     SELECT c.accession, c.type,
            (count(*)::numeric / nullif(t.n, 0))::text AS share
       FROM canon c JOIN tot t ON t.accession = c.accession
      GROUP BY c.accession, c.type, t.n`,
    [accessions],
  );
  const compositionOf = new Map<string, Map<string, number>>();
  for (const r of perPair) {
    const m = compositionOf.get(r.accession) ?? new Map<string, number>();
    m.set(r.type, Number(r.share));
    compositionOf.set(r.accession, m);
  }

  const { rows: mix } = await query<{ type: string; own: string; cohort: string }>(
    `WITH canon AS (
       SELECT l.accession,
              CASE
                WHEN l.property_type ~* 'multifamily|cooperative|garden|low rise|mid rise|student' THEN 'Multifamily'
                WHEN l.property_type ~* 'retail|anchored|single tenant' THEN 'Retail'
                WHEN l.property_type ~* 'office|cbd|suburban|medical' THEN 'Office'
                WHEN l.property_type ~* 'industrial|warehouse|flex' THEN 'Industrial'
                WHEN l.property_type ~* 'storage' THEN 'Self Storage'
                WHEN l.property_type ~* 'hospitality|hotel|service|extended stay' THEN 'Hospitality'
                WHEN l.property_type ~* 'mixed' THEN 'Mixed Use'
                WHEN l.property_type ~* 'manufactured' THEN 'Manufactured'
                ELSE 'Unclassified'
              END AS type
         FROM corpus.loans l
        WHERE l.property_type IS NOT NULL AND l.accession = ANY($1)
     ),
     totals AS (
       SELECT count(*) FILTER (WHERE accession = $2) AS n_own,
              count(*) FILTER (WHERE accession <> $2) AS n_cohort
         FROM canon
     )
     SELECT c.type,
            (count(*) FILTER (WHERE c.accession = $2)::numeric
              / nullif(t.n_own, 0))::text AS own,
            (count(*) FILTER (WHERE c.accession <> $2)::numeric
              / nullif(t.n_cohort, 0))::text AS cohort
       FROM canon c CROSS JOIN totals t
      GROUP BY c.type, t.n_own, t.n_cohort
      ORDER BY count(*) FILTER (WHERE c.accession = $2) DESC`,
    [accessions, target.accession],
  );

  const compositionRow = (r: { type: string; own: string | null; cohort: string | null }) => {
    const own = Number(r.own ?? 0);
    const cohort = Number(r.cohort ?? 0);
    const difference = own - cohort;
    /**
     * A difference smaller than one loan is not a difference.
     *
     * With 35 loans each is worth 2.9 points, so 0.4 points is 0.14 loans: there
     * is no issuance that differs by that. It was shown as "+0%", which looks
     * like an arithmetic error and was in fact a difference below the pool's
     * resolution.
     */
    const point = 1 / Math.max(1, target.typedPool);
    return {
      type: r.type,
      own,
      cohort,
      difference,
      belowResolution: Math.abs(difference) < point,
      loans: Math.round(own * target.typedPool),
      /** How many loans account for the difference, which is not the same as `loans`. */
      loansOfDifference: Math.round(Math.abs(difference) / point),
    };
  };

  /**
   * THE PRESENTATION FILTER CANNOT TOUCH THE STATISTIC'S VECTOR.
   *
   * There used to be a single list: absent and marginal types were filtered out,
   * and that same filtered list fed the distance. With that, a type at 0% in the
   * issuance and 1.5% in the cohort disappeared from the vector, and two things
   * happened.
   *
   * The distance was UNDERSTATED, because that 1.5-point difference was real and
   * stopped being summed.
   *
   * And the null was wrong in a worse way: the cumulative of q ended at 0.985
   * instead of 1, so 1.5% of the draws fell out of range and the
   * `if (i < 0) i = q.length - 1` assigned them to the LAST category in the
   * order. A mass of probability belonging to one type ended up in another,
   * chosen by however the SQL happened to sort.
   *
   * Neither is visible from looking at the result: the distance still looks
   * reasonable and the p-value still comes out. It surfaced while reconciling why
   * this file counts 8 different issuances and `db:composition-signal` counts 13.
   *
   * Now there are two lists: `composition` is filtered, `fullComposition` is not.
   */
  const fullComposition: Composition[] = mix.map(compositionRow);
  const composition = fullComposition.filter((r) => r.own > 0 || r.cohort >= 0.02);

  /**
   * Does the mix depart more than chance produces?
   *
   * The null discounts pool size, which is the part that matters: 15 loans
   * deviate from the average mix by sampling far more than 70. Without that,
   * small issuances would always look the most different.
   *
   * The reference is the `pairs` —the same ones everything else on this page
   * uses— and not the whole cohort. Including the single-type deals would shift
   * the reference mix towards multifamily and make every conduit look like it
   * departs in the same direction.
   */
  const withMix = fullComposition;
  const pVec = withMix.map((c) => c.own);
  const qVec = withMix.map((c) => c.cohort);
  const perLoan = apart(pVec, qVec, target.typedPool);

  /**
   * The same measurement with the reference weighted by issuance.
   *
   * The null is re-simulated inside `apart`: changing the reference also changes
   * which distances chance produces, so reusing the previous one would compare
   * against the wrong null.
   */
  const qByIssuance = withMix.map((c) => {
    const sum = pairs.reduce(
      (x, pair) => x + (compositionOf.get(pair.accession)?.get(c.type) ?? 0),
      0,
    );
    return sum / Math.max(1, pairs.length);
  });
  const perIssuance = apart(pVec, qByIssuance, target.typedPool);

  return {
    ...base,
    metrics,
    composition,
    distance: perLoan.distance,
    nullDistance: perLoan.nullMedian,
    pValue: perLoan.p,
    pValueByIssuance: perIssuance.p,
    robust: perLoan.p < 0.05 === perIssuance.p < 0.05,
  };
}

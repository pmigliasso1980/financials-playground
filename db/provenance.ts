/**
 * Which corpus a verdict was issued against, and whether it has expired.
 *
 * WHY IT EXISTS, AND THE CORRECTED STORY
 *
 * The first version of this comment said the `db:power` verdict had expired:
 * that the MDE exceeded the claimed effect and flipped as the corpus grew. That
 * is false — the MDE was 6.6% when the document was written and it is 6.7%
 * today, and `docs/underwriting-finding.md` already said so correctly, in a
 * section titled "What does NOT explain the failure".
 *
 * What actually happened is simpler and more uncomfortable: the work summaries
 * written around the document claimed the hypotheses died "for lack of power",
 * when the document said the opposite. And while auditing it, a story about
 * expiry was invented to explain the discrepancy, without having read the
 * section that resolved it.
 *
 * So the module still earns its place, for a different reason than it claimed:
 *
 * A number that depends on the sample and is quoted without saying which sample
 * it was measured against cannot be verified. Nobody could check "MDE 6.7%"
 * without re-running it, and that friction is what let a summary say one thing
 * and the document another for weeks. The stamp does not prevent the misreading,
 * but it makes it checkable in one line.
 *
 * And the threshold registry solves a different, real problem: there are six
 * arbitrary numbers spread across five files, with three very different kinds of
 * justification, and until now that was written down nowhere.
 *
 * WHAT IT DOES, AND WHAT IT DOES NOT
 *
 * Two small things:
 *
 *   1. A stamp with the state of the corpus, to print at the foot of any
 *      conclusion. Without it, quoting "MDE 6.7%" in a document does not say
 *      which sample it was measured on.
 *
 *   2. A registry of thresholds with the corpus each was justified against, and
 *      a warning when the corpus has grown enough to make rereading worthwhile.
 *
 * It revalidates NOTHING. A warning that a threshold may have expired does not
 * say it is wrong; it says the justification was written against a different
 * sample. Confusing the two would be the same old error in a new version.
 */

import { query } from "./client.js";

export interface CorpusState {
  issuances: number;
  loans: number;
  observations: number;
  withPerformance: number;
  taxonomy: string;
  /**
   * How many taxonomy versions coexist in the corpus.
   *
   * More than one means part of it was never re-harvested, and so a conclusion
   * about the whole corpus mixes two different mappings. That matters concretely
   * today: between 2026.08.9 and 2026.08.13, occupancy, the EGI and expense
   * keys, property_type and the phantom-row filter all changed.
   */
  versions: number;
}

export async function corpusState(): Promise<CorpusState> {
  const { rows } = await query<{
    issuances: string; loans: string; observations: string;
    with_performance: string; taxonomy: string | null; versions: string;
  }>(
    `SELECT (SELECT count(*) FROM corpus.filings)::text AS issuances,
            (SELECT count(*) FROM corpus.loans)::text AS loans,
            (SELECT count(*) FROM corpus.facts)::text AS observations,
            (SELECT count(DISTINCT loan_id) FROM corpus.performance)::text AS with_performance,
            -- The mapping version lives inside stats, not in its own column.
            -- We take the maximum and also count how many distinct ones there
            -- are: if there is more than one, part of the corpus was never
            -- re-harvested and any conclusion mixes two mappings.
            (SELECT max(stats->>'taxonomyVersion') FROM corpus.filings) AS taxonomy,
            (SELECT count(DISTINCT stats->>'taxonomyVersion') FROM corpus.filings)::text AS versions`,
  );
  const r = rows[0]!;
  return {
    issuances: Number(r.issuances),
    loans: Number(r.loans),
    observations: Number(r.observations),
    withPerformance: Number(r.with_performance),
    taxonomy: r.taxonomy ?? "?",
    versions: Number(r.versions),
  };
}

/** The line that goes at the foot of any sample-dependent conclusion. */
export function provenanceStamp(e: CorpusState): string {
  const n = (x: number) => x.toLocaleString("en-US");
  return (
    `Measured against ${n(e.issuances)} issuances · ${n(e.loans)} loans · ` +
    `${n(e.withPerformance)} with performance · taxonomy ${e.taxonomy}` +
    (e.versions > 1
      ? ` — WARNING: ${e.versions} taxonomy versions coexist, part of the corpus was never re-harvested`
      : "")
  );
}

/**
 * The project's thresholds and the corpus each one was justified against.
 *
 * `loans` is the size of the corpus when the number was chosen. It is not
 * decoration: if the corpus is much larger today, the justification was written
 * on a different sample and is worth rereading.
 *
 * ON WHY SOME SAY "no empirical basis"
 *
 * A threshold can be arbitrary without being wrong, but the distinction is worth
 * writing down. `MAX_EXCESS` in db:cohort flags 4 of 7 vintages, and when a
 * criterion flags the majority the likely explanation is that it sits below the
 * natural value — it is compared against the floor for equal pools, and real
 * pools range from 15 to 70 loans.
 */
export const THRESHOLDS: Array<{
  script: string;
  name: string;
  value: string;
  loans: number;
  note: string;
}> = [
  {
    script: "db:power",
    name: "CLAIMED_EFFECT",
    value: "10.5%",
    loans: 8935,
    note: "external reference: the effect the finding declared. It does not expire with the corpus, but the MDE it is compared against does — and it has already flipped once.",
  },
  {
    script: "db:cohort",
    name: "MAX_EXCESS",
    value: "1.6x the floor",
    loans: 9694,
    note: "NO empirical basis. Flags 4 of 7 usable vintages. Still missing: a simulation of what the ratio is worth when pools vary the way real ones do.",
  },
  {
    script: "db:cohort / cohortBenchmark",
    name: "MIN_PAIRS",
    value: "15",
    loans: 8935,
    note: "an a priori count: ten pairs to talk about deciles, fifteen so the decile does not depend on a single document. Independent of the corpus.",
  },
  {
    script: "cohortBenchmark",
    name: "TYPE_CONCENTRATION",
    value: "0.8",
    loans: 9694,
    note: "verified inert: conduits reach 63% and single-type deals 100%, with nothing in between. Any value between 0.64 and 0.99 gives the same answer.",
  },
  {
    script: "cohortBenchmark",
    name: "MIN_PER_METRIC",
    value: "10 loans",
    loans: 9694,
    note: "it decided which issuances appeared as 'no data' for occupancy when the problem was something else. Worth remembering that this threshold has visible consequences.",
  },
  {
    script: "annexStructure",
    name: "MAX_PHANTOM_SHARE",
    value: "15%",
    loans: 9694,
    note: "abstention guard for the structural filter. With pools of 25-70 loans and 1-2 phantom rows, the margin is wide.",
  },
];

/**
 * Warns which thresholds were justified against a noticeably smaller corpus.
 *
 * The 25% is not a statistical threshold: it is when rereading becomes
 * worthwhile. A corpus 5% larger changes no conclusion; one 40% larger can flip
 * an MDE, as has already happened.
 */
export function stalenessWarnings(e: CorpusState, minimumGrowth = 0.25): string[] {
  const warnings: string[] = [];
  for (const t of THRESHOLDS) {
    const grew = (e.loans - t.loans) / Math.max(1, t.loans);
    if (grew >= minimumGrowth) {
      warnings.push(
        `${t.script} · ${t.name} = ${t.value} — justified with ${t.loans.toLocaleString("en-US")} loans, ` +
          `today there are ${e.loans.toLocaleString("en-US")} (+${(grew * 100).toFixed(0)}%)`,
      );
    }
  }
  return warnings;
}

/** Those flagged as having no empirical basis, whether or not the corpus grew. */
export function metricsWithoutBaseline(): string[] {
  return THRESHOLDS.filter((t) => /NO empirical basis/i.test(t.note)).map(
    (t) => `${t.script} · ${t.name} = ${t.value} — ${t.note}`,
  );
}

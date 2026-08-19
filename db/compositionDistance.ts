/**
 * How far a mix departs from its reference, and how far it would depart by
 * chance.
 *
 * WHY THIS MODULE EXISTS
 *
 * The same computation was written twice —in `compositionSignal.ts` and in
 * `cohortBenchmark.ts`— with the same distance, the same seed and the same
 * number of simulations. Identical copies, not variants.
 *
 * And they produced different numbers for the same question: 13 issuances with a
 * different mix on one side and 8 on the other. The difference was not in the
 * computation but in WHAT IS PASSED TO IT —which issuances form the reference
 * and which are counted— but with two implementations that was invisible: you
 * had to read both and compare them by hand, which is what nobody does.
 *
 * With a single function, the difference between the two counts ends up where it
 * belongs: in the call arguments, visible on one line.
 *
 * WHAT IT MEASURES, IN PLAIN TERMS
 *
 * The distance is total variation —half the sum of the absolute differences—
 * and it reads directly: 0.20 means you would have to move 20% of the pool to
 * reach the reference mix.
 *
 * THE NULL DISCOUNTS POOL SIZE, WHICH IS THE PART THAT MATTERS
 *
 * A pool of 15 loans departs from the average mix by pure sampling far more than
 * one of 70. Comparing raw distances would reward small issuances for being
 * small. So the null is explicit: if these n loans had been drawn at random from
 * the reference, what distance would we expect?
 */

/** Total variation between two vectors of proportions. */
export const totalVariation = (a: number[], b: number[]) =>
  0.5 * a.reduce((s, x, i) => s + Math.abs(x - b[i]!), 0);

/**
 * Seeded generator, so the same run gives the same result.
 *
 * A p-value that changes between runs cannot be quoted, and the project already
 * uses a fixed seed in the bootstraps for the same reason.
 */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const SIMULATIONS = 4000;
export const SEED = 0xc0ffee;

export interface Apart {
  /** How much of the pool has to move to reach the reference. */
  distance: number;
  /**
   * The median of what chance produces at this pool size.
   *
   * Named `nullMedian` and not `null`: the latter is legal as a property name
   * and reads like a mistake every time.
   */
  nullMedian: number;
  /**
   * Empirical right tail, uncorrected.
   *
   * It can come out as exactly 0 when none of the 4,000 replicates reaches the
   * observed value. That does NOT mean "impossible by chance": it means "fewer
   * than 1 in 4,000", and whoever prints it should say `< 0.0003` rather than
   * `0.0000`.
   */
  p: number;
}

/**
 * @param p     composition of the issuance, as proportions summing to 1
 * @param q     composition of the reference, in the same category order
 * @param pool  how many loans the issuance has — this sets the null's noise
 */
export function apart(p: number[], q: number[], pool: number): Apart {
  const distance = totalVariation(p, q);

  // Cumulative of q, for sampling the multinomial.
  const cumulative: number[] = [];
  q.reduce((x, v) => (cumulative.push(x + v), x + v), 0);

  const rand = rng(SEED);
  const sim: number[] = [];
  for (let b = 0; b < SIMULATIONS; b++) {
    const c = new Array(q.length).fill(0);
    for (let k = 0; k < pool; k++) {
      const u = rand();
      let i = cumulative.findIndex((a) => u < a);
      if (i < 0) i = q.length - 1;
      c[i]++;
    }
    sim.push(totalVariation(c.map((x) => x / Math.max(1, pool)), q));
  }
  sim.sort((a, b) => a - b);

  return {
    distance,
    nullMedian: sim[Math.floor(sim.length / 2)]!,
    p: sim.filter((x) => x >= distance).length / sim.length,
  };
}

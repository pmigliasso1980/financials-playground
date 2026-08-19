/**
 * One issuance's page: the benchmark shaped like something a person reads.
 *
 *   npm run db:page                  # the most recent one
 *   npm run db:page -- BNK52
 *   npm run db:page -- BNK52 --open
 *
 * WHAT CHANGES RELATIVE TO `db:benchmark`
 *
 * The numbers are the same —they come from `cohortBenchmark.ts`, which is the
 * only place they are computed— and what changes is who it speaks to. The
 * terminal speaks to whoever is building; this speaks to someone looking at a
 * deal.
 *
 * THE CONTENT DECISION THAT MATTERS
 *
 * The resolution warnings do not go in small print at the bottom. They go beside
 * the number they qualify.
 *
 * With a pool of 25 loans each is worth 4 points of composition, so a "+9%" is
 * two loans. With 24 pairs, the difference between 12th and 14th place is one
 * document. A product that shows "+9%" and "12th of 25" without that beside it is
 * not informing: it is suggesting a precision the data does not have, and this
 * session showed four times how easy it is to believe a well-formatted number.
 *
 * THERE ARE NO DEPENDENCIES
 *
 * One HTML file with the CSS inside. It opens on a double click, it can be
 * emailed, it needs no server. If there is a web app later, this file is the
 * template for the detail page.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { closePool, ping } from "./client.js";
import { computeBenchmark, loadCandidates, pct } from "./cohortBenchmark.js";
import { render } from "./pageRender.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const args = process.argv.slice(2);
const SEARCH = args.find((a) => !a.startsWith("--")) ?? null;

// ---------------------------------------------------------------------------

const candidates = await loadCandidates();
const dir = new URL("../out/", import.meta.url).pathname;

const slugOf = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * `--all`: generates the page for every issuance in the cohort and measures
 * something a single page cannot show.
 *
 * THE PRODUCT QUESTION
 *
 * In BANK5 2026-5YR24, five of the six metrics fall inside the cohort's
 * interquartile range. If that happens across all 28, the metrics table —which is
 * half the page— informs nothing, and the only thing distinguishing an issuance is
 * its property mix. If it happens in 10 of 28, it informs quite a lot.
 *
 * Those are two different products and the difference is a number nobody
 * measured. It is cheap to measure now because the computation lives in a module.
 */
if (args.includes("--all")) {
  const vintage = String(new Date().getFullYear());
  const cohort = candidates.filter((c) => c.vintage === vintage);
  await mkdir(dir, { recursive: true });

  console.log(`\n${"═".repeat(78)}`);
  console.log(`Does the metrics table inform? — ${vintage} cohort`);
  console.log(`${"═".repeat(78)}\n`);
  console.log(`  issuance                             pool   evaluated   outside p25-p75`);
  console.log(`  ${"─".repeat(74)}`);

  let totalEvaluated = 0;
  let totalOutside = 0;
  const outsideByMetric = new Map<string, { outside: number; evaluated: number }>();
  /**
   * For the question I failed to measure: do out-of-range metrics predict that
   * the mix is different?
   *
   * I asserted that the coincidence between "5 of 6 outside" and "significant
   * mix" was noise, without measuring it, in the same paragraph where I
   * criticised doing exactly that. If the two figures correlate, the metrics
   * table is not decorative: it is a redundant view of the same signal, and that
   * changes why it gets demoted.
   */
  const pairsForRho: Array<{ outside: number; d: number }> = [];

  for (const c of cohort) {
    const bm = await computeBenchmark(c.name, candidates);
    if (!bm) continue;
    await writeFile(`${dir}${slugOf(c.name)}.html`, render(bm), "utf8");

    if (!bm.evaluable) {
      console.log(
        `  ${c.name.slice(0, 34).padEnd(36)} ${String(c.pool).padStart(5)}   \x1b[90mnot evaluable\x1b[0m`,
      );
      continue;
    }

    /**
     * "Outside" means outside the interquartile range, not the ordinal position.
     *
     * The position says where it falls; the range says whether that is
     * distinguishable from the middle of the market. An issuance can be 19th of
     * 25 and still sit inside the box: it is the upper half, but it does not
     * depart.
     */
    const withData = bm.metrics.filter((m) => m.value !== null);
    const outside = withData.filter((m) => m.value! < m.p25! || m.value! > m.p75!);
    totalEvaluated += withData.length;
    totalOutside += outside.length;
    for (const m of withData) {
      const e = outsideByMetric.get(m.spec.label) ?? { outside: 0, evaluated: 0 };
      e.evaluated++;
      if (m.value! < m.p25! || m.value! > m.p75!) e.outside++;
      outsideByMetric.set(m.spec.label, e);
    }

    pairsForRho.push({ outside: outside.length, d: bm.distance - bm.nullDistance });

    console.log(
      `  ${c.name.slice(0, 34).padEnd(36)} ${String(c.pool).padStart(5)}   ` +
        `${String(withData.length).padStart(9)}   ` +
        `${outside.length === 0 ? "\x1b[90m" : outside.length >= 3 ? "\x1b[33m" : ""}${outside.length}\x1b[0m` +
        (outside.length > 0 ? `  \x1b[90m${outside.map((m) => m.spec.label).join(", ")}\x1b[0m` : ""),
    );
  }

  console.log(`\n${"─".repeat(78)}`);

  /**
   * THE NULL VALUE IS 50%, NOT ZERO.
   *
   * The interquartile range contains 50% of a distribution by definition. If this
   * issuance is exchangeable with its peers, the probability of falling outside
   * the others' range is 50%. An observed 50% is not signal: it is exactly what
   * chance predicts.
   *
   * The first version compared against 0.25 —a threshold I wrote before measuring
   * anything, without asking what the expected value under the null was— and
   * printed "the table distinguishes" in response to the result that means
   * precisely the opposite. The sixth verdict this session computed against the
   * wrong reference.
   *
   * Now the contrast is against 50% with its standard error. With n issuances,
   * SE = sqrt(0.25/n): with 28 that is 9.4 points, so you would need to leave
   * 50 ± 19 to assert anything at two standard errors.
   */
  const share = totalEvaluated ? totalOutside / totalEvaluated : 0;
  const n = cohort.length;
  const se = Math.sqrt(0.25 / Math.max(1, n));
  const z = (share - 0.5) / se;

  console.log(
    `\n  \x1b[1m${totalOutside} of ${totalEvaluated} measurements outside the range (${pct(share)})\x1b[0m`,
  );
  /**
   * THIS MEASUREMENT HAS NO POWER. IT IS KEPT SO IT DOES NOT GET QUOTED AGAIN.
   *
   * Each issuance is compared against the interquartile range of the OTHERS in
   * the same set. By exchangeability the marginal rate is 50% whether or not
   * there is signal: if every issuance were identical it would give 50%, and if
   * they were radically different it would too. There is no external reference —
   * the set is measured against itself.
   *
   * So the null and the observed coincide by construction, and "z = 0.00" is
   * evidence of nothing. I presented it as a negative finding and reordered the
   * page leaning on it.
   *
   * What does decide is below: the correlation between how many metrics depart
   * and how far the mix departs. There you do have two independent quantities
   * that may or may not move together, and they do (rho = 0.59).
   */
  console.log(
    `  \x1b[31mThis number measures nothing:\x1b[0m each issuance is compared against the range of`,
  );
  console.log(
    `  the others in the same set, so by exchangeability the marginal rate is 50%`,
  );
  console.log(
    `  whether or not there is signal. The null and the observed coincide by construction.`,
  );
  console.log(
    `  \x1b[90mSE = ${pct(se, 1)} with ${n} issuances, z = ${z.toFixed(2)} — and that z could not have been anything else.\x1b[0m`,
  );

  console.log(`\n  By metric (same problem, listed for comparison):\n`);
  for (const [label, e] of outsideByMetric) {
    const sh = e.evaluated ? e.outside / e.evaluated : 0;
    const seM = Math.sqrt(0.25 / Math.max(1, e.evaluated));
    const zM = (sh - 0.5) / seM;
    /**
     * No verdict per metric: the z inherits the aggregate's problem.
     *
     * It used to say "indistinguishable from chance", which is the conclusion of
     * the test with no power. The z could not have been anything else, so calling
     * it indistinguishable attributes to the data something the construction
     * fixes.
     */
    console.log(
      `    ${label.padEnd(14)} ${String(e.outside).padStart(3)} of ${String(e.evaluated).padStart(3)}   ` +
        `${pct(sh).padStart(4)}   \x1b[90mz = ${zM >= 0 ? "+" : ""}${zM.toFixed(2)}\x1b[0m`,
    );
  }

  /**
   * Spearman correlation between "metrics outside the range" and "how far the mix
   * departs above the null".
   *
   * Spearman and not Pearson: the count of metrics outside runs 0 to 6 and the
   * distance is continuous and skewed; rank is the only comparable thing.
   *
   * The excess over the null (d − null) and not raw d: d grows when the pool is
   * small, and so does the count of metrics outside, so correlating them directly
   * would measure pool size at both ends.
   */
  if (pairsForRho.length >= 10) {
    const rank = (xs: number[]) => {
      const order = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
      const r = new Array(xs.length).fill(0);
      for (let k = 0; k < order.length; ) {
        let j = k;
        while (j + 1 < order.length && order[j + 1]!.v === order[k]!.v) j++;
        const mid = (k + j) / 2 + 1;
        for (let m = k; m <= j; m++) r[order[m]!.i] = mid;
        k = j + 1;
      }
      return r;
    };
    const rx = rank(pairsForRho.map((p) => p.outside));
    const ry = rank(pairsForRho.map((p) => p.d));
    const n2 = pairsForRho.length;
    const mx = rx.reduce((a, b) => a + b, 0) / n2;
    const my = ry.reduce((a, b) => a + b, 0) / n2;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n2; i++) {
      num += (rx[i]! - mx) * (ry[i]! - my);
      dx += (rx[i]! - mx) ** 2;
      dy += (ry[i]! - my) ** 2;
    }
    const rho = num / Math.sqrt(dx * dy);
    /** Student's t with n−2 degrees of freedom: the |t| ≈ 2 threshold for 26 df. */
    const t = rho * Math.sqrt((n2 - 2) / Math.max(1e-9, 1 - rho * rho));

    console.log(`\n${"─".repeat(78)}\n`);
    console.log(
      `  \x1b[1mMetrics outside the range against excess distance: rho = ${rho.toFixed(3)}\x1b[0m` +
        ` \x1b[90m(t = ${t.toFixed(2)}, ${n2 - 2} df)\x1b[0m`,
    );
    console.log(
      Math.abs(t) >= 2
        ? `\n  \x1b[33mThey correlate.\x1b[0m The metrics table is not decorative: it is a\n` +
            `  redundant view of the same signal as the composition. Demoting it is still\n` +
            `  correct —it says the same thing worse— but for a different reason than I gave.`
        : `\n  \x1b[32mThey do not correlate.\x1b[0m That BNK52 has 5 metrics outside and a different\n` +
            `  mix, and BANK5 none and a normal mix, is a coincidence of two cases. With 6\n` +
            `  metrics per issuance, having 5 outside happens often by chance.`,
    );
  }

  console.log(`\n  ${cohort.length} pages in ${dir}\n`);
  await closePool();
  process.exit(0);
}

const b = await computeBenchmark(SEARCH, candidates);

if (!b) {
  console.error(`\n✗ No issuance found matching "${SEARCH}".`);
  console.error(`  List them:  npm run db:benchmark -- --list\n`);
  await closePool();
  process.exit(1);
}

await mkdir(dir, { recursive: true });
const path = `${dir}${slugOf(b.target.name)}.html`;
await writeFile(path, render(b), "utf8");

console.log(`\n  ${b.target.name}`);
console.log(
  `  \x1b[90m${b.target.pool} loans · ${b.pairs.length} pairs · ` +
    `${b.evaluable ? `${b.metrics.filter((m) => m.value !== null).length} of ${b.metrics.length} metrics evaluated` : "not evaluable"}\x1b[0m`,
);
console.log(`\n  → ${path}\n`);

await closePool();

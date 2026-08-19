/**
 * The HTML for one issuance: the template, separated from whoever invokes it.
 *
 * WHY IT WAS SPLIT OUT
 *
 * It lived inside `page.ts`, which is a script with top-level `await`: importing
 * it from anywhere else executes it. When the index appeared —which needs to
 * generate the same pages— the alternative was duplicating 280 lines of template
 * and CSS, and two copies of an HTML file diverge on the first correction made to
 * only one of them.
 *
 * It is the same reason `cohortBenchmark.ts` exists: a computation or a template
 * shared by two commands lives in a module, not in the script that needed it
 * first.
 */

import {
  MIN_PAIRS, pct,
  type Benchmark, type Composition, type CohortMetricResult,
} from "./cohortBenchmark.js";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The position within the cohort's range, as a bar.
 *
 * It draws the p25–p75 range and a dot where this issuance falls. A dot inside
 * the box says "market" far faster than "13th of 25", and both numbers are
 * present anyway.
 *
 * The dot is clamped to 0–100% of the width: an issuance more extreme than p25 or
 * p75 sits on the edge instead of falling outside the drawing, and the "13th of
 * 25" beside it says how far outside it is.
 */
function bar(m: CohortMetricResult): string {
  if (m.value === null || m.p25 === null || m.p75 === null || m.p50 === null) return "";
  const lo = Math.min(m.p25, m.value);
  const hi = Math.max(m.p75, m.value);
  const span = hi - lo || 1;
  const x = (v: number) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  return `<div class="bar">
      <div class="box" style="left:${x(m.p25).toFixed(1)}%;width:${(x(m.p75) - x(m.p25)).toFixed(1)}%"></div>
      <div class="med" style="left:${x(m.p50).toFixed(1)}%"></div>
      <div class="dot${m.aggressive ? " agr" : ""}" style="left:${x(m.value).toFixed(1)}%"></div>
    </div>`;
}

function metricRow(m: CohortMetricResult): string {
  if (m.value === null) {
    const reason =
      m.noData === "issuance"
        ? "this issuance does not publish the figure"
        : `only ${m.pairsWithData} pairs with data — ${MIN_PAIRS} are needed`;
    return `<tr class="nd">
      <th>${esc(m.spec.label)}</th>
      <td colspan="4"><span class="muted">Not evaluated: ${esc(reason)}</span></td>
    </tr>`;
  }
  const f = m.spec.fmt;
  return `<tr>
    <th>${esc(m.spec.label)}</th>
    <td class="val">${esc(f(m.value))}</td>
    <td class="coh">${esc(f(m.p25!))} · <b>${esc(f(m.p50!))}</b> · ${esc(f(m.p75!))}</td>
    <td class="viz">${bar(m)}</td>
    <td class="pos${m.extreme ? (m.aggressive ? " agr" : " ext") : ""}">${m.rank}<span class="muted"> of ${m.total}</span>${
      m.aggressive ? '<div class="tag">more aggressive</div>' : ""
    }</td>
  </tr>`;
}

function compositionRow(c: Composition): string {
  const notable = Math.abs(c.difference) > 0.1;
  const w = (v: number) => Math.min(100, v * 100 * 2.2).toFixed(1);
  /**
   * A difference smaller than one loan is shown as "—", not as "+0%".
   *
   * The rounded percentage made what was really a difference below the pool's
   * resolution look like an arithmetic error: with 35 loans, 0.4 points is 0.14
   * loans.
   */
  const diff = c.belowResolution
    ? `<span class="muted">—</span>`
    : `${c.difference > 0 ? "+" : ""}${pct(c.difference)}`;
  /**
   * And the right-hand column says how many loans ARE THE DIFFERENCE, not how
   * many the issuance has. The previous version showed "-13% · 5 loans" and those
   * 5 were BANK5's multifamily, not the gap against the cohort: two different
   * numbers read as one.
   */
  const detail = c.belowResolution
    ? `less than one loan of difference`
    : `${c.loansOfDifference} loan${c.loansOfDifference === 1 ? "" : "s"} of difference` +
      ` · this issuance has ${c.loans}`;
  return `<tr${notable ? ' class="notable"' : ""}>
    <th>${esc(c.type)}</th>
    <td class="mini"><div class="mb"><i style="width:${w(c.own)}%"></i></div>${pct(c.own)}</td>
    <td class="mini"><div class="mb coh"><i style="width:${w(c.cohort)}%"></i></div>${pct(c.cohort)}</td>
    <td class="dif">${diff}</td>
    <td class="muted sm">${esc(detail)}</td>
  </tr>`;
}

export function render(b: Benchmark): string {
  const o = b.target;
  const body = !b.evaluable
    ? /**
       * The refusal is an answer, not an empty screen.
       *
       * Saying "unknown" with the reason is more useful than a dashboard of
       * zeros, and it is the difference between a tool you can believe and one
       * that always answers something.
       */
      `<section class="refuse">
        <h2>Cannot be evaluated</h2>
        <p>${MIN_PAIRS} comparable issuances are needed in the ${esc(o.vintage)} cohort and there
        are ${b.pairs.length}. With fewer, saying this issuance "departs from the market" would be
        a claim about ${b.pairs.length} documents.</p>
        <p class="muted">The right answer here is that it is unknown.</p>
      </section>`
    : `${
        b.targetSingleType
          ? `<section class="warn"><h2>This issuance is ${pct(o.dominantShare)} ${esc(o.dominantType ?? "")}</h2>
             <p>It is not a diversified conduit, so the comparison against the cohort will show
             guaranteed differences that mean nothing about how it was underwritten.</p></section>`
          : ""
      }
      <section>
        <h2>What this issuance bought</h2>
        <table class="c">
          <thead><tr>
            <th></th><th>this issuance</th><th>cohort</th><th>diff.</th><th></th>
          </tr></thead>
          <tbody>${b.composition.map(compositionRow).join("")}</tbody>
        </table>
        <p class="note">Each loan is worth <b>${pct(b.pointPerLoan, 1)}</b> of this pool
        (${o.typedPool} with a type), so a 9-point difference is
        ${Math.max(1, Math.round(0.09 / b.pointPerLoan))} loans.
        You have to move <b>${pct(b.distance)}</b> of the pool to reach the cohort's mix;
        drawing ${o.typedPool} loans at random from the universe of pairs, you would expect
        to move ${pct(b.nullDistance)}.</p>
      </section>

      <section>
        <h2>Terms</h2>
        <p class="lead">${
          b.metrics.filter((m) => m.value !== null).length === 0
            ? "No evaluable metrics."
            : `In line with the cohort: ` +
              b.metrics
                .filter((m) => m.value !== null)
                .map((m) => `${esc(m.spec.label)} ${esc(m.spec.fmt(m.value!))}`)
                .join(" · ")
        }</p>
        <p class="note">These six numbers track the same thing as the mix, more weakly.
        Across the cohort's 28 issuances, how many metrics fall outside the interquartile
        range correlates with how far the composition departs (rho = 0.59, t = 3.7):
        an issuance with a lot of hospitality has a different DSCR and debt yield <i>because</i>
        hotels are underwritten differently. The cause is the mix; the terms are its
        consequence. They go below because each metric on its own is a weak test of what
        the composition measures in one go.</p>
        <details>
          <summary>See the position of each metric</summary>
          <table class="m">
            <thead><tr>
              <th></th><th>this issuance</th><th>cohort (p25 · median · p75)</th><th></th><th>position</th>
            </tr></thead>
            <tbody>${b.metrics.map(metricRow).join("")}</tbody>
          </table>
          <p class="note">The position is <b>ordinal, not a percentile</b>: with ${b.pairs.length}
          pairs a percentile would have a resolution of ~${b.percentileResolution.toFixed(0)} points.</p>
        </details>
      </section>`;

  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(o.name)} — cohort benchmark</title>
<style>
  :root { --fg:#1a1a1a; --muted:#6b6b6b; --line:#e4e4e4; --bg:#fff;
          --box:#dfe7f3; --dot:#2b5fa8; --agr:#b8791a; --warn:#fff8e6; }
  * { box-sizing:border-box }
  body { margin:0; padding:40px 28px 64px; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width:920px; margin:0 auto }
  h1 { font-size:23px; margin:0 0 4px; letter-spacing:-.01em }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.06em;
       color:var(--muted); margin:0 0 12px; font-weight:600 }
  .sub { color:var(--muted); font-size:13.5px; margin:0 0 6px }
  .peers { color:var(--muted); font-size:13px; margin:0 0 32px; padding-bottom:24px;
           border-bottom:1px solid var(--line) }
  section { margin:0 0 40px }
  table { width:100%; border-collapse:collapse }
  thead th { font-size:11.5px; text-transform:uppercase; letter-spacing:.05em;
             color:var(--muted); font-weight:600; text-align:right;
             padding:0 10px 8px; border-bottom:1px solid var(--line) }
  thead th:first-child, tbody th { text-align:left }
  tbody th { font-weight:500; padding:11px 10px; white-space:nowrap }
  td { padding:11px 10px; text-align:right; border-top:1px solid var(--line);
       font-variant-numeric:tabular-nums }
  tbody th { border-top:1px solid var(--line) }
  .val { font-weight:600; font-size:16px }
  .coh { color:var(--muted); font-size:13.5px; white-space:nowrap }
  .viz { width:160px }
  .bar { position:relative; height:20px }
  .bar:before { content:""; position:absolute; left:0; right:0; top:9px; height:2px; background:var(--line) }
  .box { position:absolute; top:5px; height:10px; background:var(--box); border-radius:2px }
  .med { position:absolute; top:3px; width:1px; height:14px; background:#a9b6c9 }
  .dot { position:absolute; top:5px; width:10px; height:10px; margin-left:-5px;
         border-radius:50%; background:var(--dot) }
  .dot.agr { background:var(--agr) }
  .pos { white-space:nowrap; color:var(--muted) }
  .pos.ext { color:var(--dot); font-weight:600 }
  .pos.agr { color:var(--agr); font-weight:600 }
  .tag { font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; font-weight:600 }
  .nd th, .nd td { color:var(--muted) }
  .muted { color:var(--muted) }
  .sm { font-size:12.5px }
  .mini { white-space:nowrap; font-size:13.5px }
  .mb { display:inline-block; width:74px; height:7px; background:#f0f0f0;
        border-radius:4px; overflow:hidden; margin-right:8px; vertical-align:middle }
  .mb i { display:block; height:100%; background:var(--dot) }
  .mb.coh i { background:#b9c4d4 }
  .dif { font-weight:500 }
  tr.notable .dif { color:var(--agr); font-weight:700 }
  .note { font-size:13px; color:var(--muted); margin:14px 0 0; padding-left:10px;
          border-left:2px solid var(--line) }
  .verdict { font-size:15.5px; margin:0 0 18px; padding:12px 14px; border-radius:6px;
             background:#f4f6fa; border:1px solid #e2e8f2 }
  .verdict.sig { background:#f0f7f1; border-color:#d6e8d9 }
  .verdict.edge { background:#fdf6ec; border-color:#f0e2bc }
  .lead { font-size:15px; margin:0 0 10px; font-variant-numeric:tabular-nums }
  details { margin-top:14px }
  summary { cursor:pointer; font-size:13px; color:var(--muted); padding:6px 0 }
  .refuse, .warn { background:var(--warn); border:1px solid #f0e2bc;
                   border-radius:6px; padding:18px 20px }
  .refuse h2, .warn h2 { color:#8a6410; text-transform:none; font-size:15px;
                         letter-spacing:0; margin-bottom:6px }
  .refuse p, .warn p { margin:0 0 8px; font-size:14px }
  footer { margin-top:44px; padding-top:20px; border-top:1px solid var(--line);
           font-size:12.5px; color:var(--muted) }
  footer code { font-size:12px }
</style>
<main>
  <h1>${esc(o.name)}</h1>
  <p class="sub">${esc(o.filed.slice(0, 10))} · ${o.pool} loans${
    o.typedPool < o.pool
      ? `<span class="muted"> (${o.typedPool} with a property type — the mix is measured over those)</span>`
      : ""
  } · ${esc(o.vintage)} cohort</p>
  ${
    b.evaluable
      ? !b.robust
        ? /**
           * The two weightings disagree: we say so rather than picking one.
           *
           * Measured over 2026: by loan there are 13 issuances with a different
           * mix and by issuance 15, agreeing on 13. The aggregate is robust but
           * two issuances change sides, and one is BANK5 2026-5YR24 — which under
           * one weighting is "indistinguishable" and under the other
           * "different".
           *
           * Asserting either would be asserting more than we know.
           */
          `<p class="verdict edge">Mix is <b>borderline</b> — you have to move ${pct(b.distance)}
           of the pool to match the cohort, against ${pct(b.nullDistance)} expected by chance
           with ${o.typedPool} loans. Whether that counts as "different" depends on how the
           reference is weighted: counting every loan of the pairs gives p = ${b.pValue.toFixed(3)},
           and giving each issuance equal weight gives p = ${b.pValueByIssuance.toFixed(3)}.
           With the two on opposite sides of 5%, the honest answer is that it is on the edge.</p>`
        : `<p class="verdict ${b.pValue < 0.05 ? "sig" : ""}">${
            b.pValue < 0.05
              ? `Property mix <b>different from its cohort</b> — you have to move
                 ${pct(b.distance)} of the pool to match it, against ${pct(b.nullDistance)}
                 that would be expected by chance with ${o.typedPool} loans (p = ${b.pValue.toFixed(4)},
                 and the same under both weightings of the reference).`
              : `Property mix <b>indistinguishable from its cohort</b> — the distance of
                 ${pct(b.distance)} is within what sampling produces with ${o.typedPool}
                 loans (${pct(b.nullDistance)} expected, p = ${b.pValue.toFixed(2)}).`
          }</p>`
      : ""
  }
  <p class="peers">${b.pairs.length} comparable issuances${
    b.excluded.length > 0
      ? ` · ${b.excluded.length} excluded for being
         single-type: ${esc(b.excluded.map((e) => e.name.slice(0, 34)).join(", "))}`
      : ""
  }</p>
  ${body}
  <footer>
    Compared against the other issuances of the same year, not against history:
    between 2020 and 2024 the rate went from ~3.5% to ~7% and that drags DSCR and debt
    yield along by construction. A reference that pools vintages measures the cycle, not
    the issuance.
    <br><br>
    It compares the <b>pool median</b> against the distribution of the pairs' medians.
    Issuances of a single property type are excluded from the reference group: they are
    not diversified conduits.
    <br><br>
    Data from the FWP / Annex A filings published on SEC EDGAR. Generated by
    <code>npm run db:page</code>.
  </footer>
</main>
`;
}

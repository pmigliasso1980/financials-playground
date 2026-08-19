/**
 * The index: the issuances of a cohort, and which one genuinely departs.
 *
 *   npm run db:catalog
 *   npm run db:catalog -- --vintage 2025
 *
 * WHAT THIS PAGE RANKS BY, AND WHY THAT AND NOT SOMETHING ELSE
 *
 * Of everything the project measured, one single thing distinguishes issuances
 * above chance: the property mix. Over the 2026 cohort the catalogue counts 8 of
 * 25 against 1.3 expected by chance, and the test was verified by generating
 * issuances FROM the null before being used.
 *
 * THREE NUMBERS FOR THE SAME QUESTION, AND NONE OF THEM WAS WRONG
 *
 * "How many 2026 issuances have a different mix" has three answers in this repo:
 * 10, 13 and 8. It is not that two are mistaken — they are three different
 * quantities with the same name:
 *
 *   db:composition-signal uses ALL the issuances of the vintage as its reference,
 *   including single-type ones, and counts those significant at 5% under one
 *   weighting.
 *
 *   db:catalog excludes single-type deals from the reference —they are not
 *   conduits, and including them shifts the "market" mix towards their type— and
 *   additionally requires both weightings to agree. Those that disagree go to
 *   "borderline" instead of being counted.
 *
 * Each filter removes issuances, so the count falls. The aggregate does not
 * change sign: 8 or 13 against 1.3 expected is overwhelming in both versions.
 *
 * What IS an error is quoting one of the three without saying which, which is
 * what these comments used to do. The number that counts for the product is the
 * one the product computes, which is why the HTML prints it rather than having it
 * written in.
 *
 * The six term metrics are not ranked here. They track the same thing more weakly
 * (rho = 0.59 against the composition distance) because they are its consequence:
 * hotels are underwritten differently from apartments. Ranking by DSCR would be
 * ranking by a blurred view of the column that is already there.
 *
 * WHAT AN INDEX GETS WRONG BY DEFAULT
 *
 * A sorted list says "the first one is the most X", and at these pool sizes that
 * is false for neighbouring positions. Three decisions so the order does not lie:
 *
 *   It sorts by the EXCESS over chance (distance − null), not by raw distance.
 *   Sorting by raw distance would put small pools at the top, since they depart
 *   more by sampling and not by composition.
 *
 *   The bands are the message, not the position. "Different", "borderline" and
 *   "indistinguishable" get read; that one issuance is 3rd and another 6th does
 *   not, because it means nothing.
 *
 *   It prints how much distance ONE loan is worth in the smallest pool. Two
 *   issuances separated by less than that are not ordered: they are tied and the
 *   order was set by rounding.
 *
 * SINGLE-TYPE DEALS GO SEPARATELY, NOT AT THE TOP
 *
 * An issuance that is 100% hospitality departs from the cohort by definition, not
 * by how it was assembled. If it entered the same ranking it would take the top
 * places with a tautology. They get their own section, with no verdict.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { closePool, ping } from "./client.js";
import { computeBenchmark, loadCandidates, pct, type Benchmark } from "./cohortBenchmark.js";
import { esc, render } from "./pageRender.js";
import { corpusState, provenanceStamp } from "./provenance.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const args = process.argv.slice(2);
const iV = args.indexOf("--vintage");
const VINTAGE = iV === -1 ? String(new Date().getFullYear()) : args[iV + 1]!;

const dir = new URL("../out/", import.meta.url).pathname;
const slugOf = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

const candidates = await loadCandidates();
const cohort = candidates.filter((c) => c.vintage === VINTAGE);

if (cohort.length === 0) {
  console.log(`\n  No issuances in ${VINTAGE}.\n`);
  await closePool();
  process.exit(0);
}

await mkdir(dir, { recursive: true });

/** Everything is generated at once: the index cannot link to pages that do not exist. */
const cards: Array<{ b: Benchmark; slug: string }> = [];
for (const c of cohort) {
  const b = await computeBenchmark(c.name, candidates);
  if (!b) continue;
  const slug = slugOf(c.name);
  await writeFile(`${dir}${slug}.html`, render(b), "utf8");
  cards.push({ b, slug });
}

const state = await corpusState();
await closePool();

/**
 * Three groups that cannot be mixed in one table.
 *
 * Single-type: they depart by definition. Not evaluable: there are not enough
 * pairs and the answer is "unknown", which is different from "does not depart".
 */
const evaluable = cards.filter((f) => f.b.evaluable && !f.b.targetSingleType);
const singleType = cards.filter((f) => f.b.targetSingleType);
const notEvaluated = cards.filter((f) => !f.b.evaluable && !f.b.targetSingleType);

const excess = (b: Benchmark) => b.distance - b.nullDistance;
evaluable.sort((x, y) => excess(y.b) - excess(x.b));

type Band = "different" | "borderline" | "market";
const bandOf = (b: Benchmark): Band =>
  !b.robust ? "borderline" : b.pValue < 0.05 ? "different" : "market";

const different = evaluable.filter((f) => bandOf(f.b) === "different").length;
const borderline = evaluable.filter((f) => bandOf(f.b) === "borderline").length;
const expectedByChance = evaluable.length * 0.05;

/**
 * The resolution of the ordering, in the ranking's own units.
 *
 * `pointPerLoan` is how much of the composition one loan is worth. The smallest
 * pool sets the coarsest grain: two issuances separated by less than that are
 * tied.
 */
const grain = Math.max(...evaluable.map((f) => f.b.pointPerLoan), 0);

const LABEL: Record<Band, string> = {
  different: "different",
  borderline: "borderline",
  market: "market",
};

const excessBar = (b: Benchmark) => {
  const maxExc = Math.max(...evaluable.map((f) => excess(f.b)), 0.01);
  const w = Math.max(0, (excess(b) / maxExc) * 100);
  return `<div class="xb"><i style="width:${w.toFixed(1)}%"></i></div>`;
};

const row = (f: { b: Benchmark; slug: string }) => {
  const b = f.b;
  const o = b.target;
  const band = bandOf(b);
  /**
   * The type that departs most, not the largest one.
   *
   * "What is different about it" is the difference against the cohort; the
   * dominant type is already in almost all of them and does not distinguish. It
   * is omitted when the difference does not reach one loan: there is nothing to
   * name there.
   */
  const top = [...b.composition]
    .filter((c) => !c.belowResolution)
    .sort((x, y) => Math.abs(y.difference) - Math.abs(x.difference))[0];
  return `<tr class="b-${band}" data-exc="${excess(b).toFixed(5)}" data-pool="${o.typedPool}" data-name="${esc(o.name)}">
    <th><a href="${f.slug}.html">${esc(o.name)}</a></th>
    <td class="n">${o.typedPool}${
      o.typedPool < o.pool ? `<span class="muted"> / ${o.pool}</span>` : ""
    }</td>
    <td class="viz">${excessBar(b)}</td>
    <td class="n">${pct(b.distance)}<span class="muted"> vs ${pct(b.nullDistance)}</span></td>
    <td><span class="pill ${band}">${LABEL[band]}</span></td>
    <td class="muted sm">${
      top
        ? `${top.difference > 0 ? "+" : "−"}${pct(Math.abs(top.difference))} ${esc(top.type)}` +
          ` <span class="muted">(${top.loansOfDifference} loan${top.loansOfDifference === 1 ? "" : "s"})</span>`
        : "nothing above one loan"
    }</td>
  </tr>`;
};

const html = `<!doctype html>
<meta charset="utf-8">
<title>${esc(VINTAGE)} issuances — what each one bought</title>
<style>
  :root { --fg:#1a1a1a; --muted:#6b6b6b; --line:#e4e4e4; --bg:#fff;
          --dot:#2b5fa8; --agr:#b8791a; --ok:#2f7d43; }
  * { box-sizing:border-box }
  body { margin:0; padding:40px 28px 64px; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif }
  main { max-width:1040px; margin:0 auto }
  h1 { font-size:23px; margin:0 0 4px; letter-spacing:-.01em }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.06em;
       color:var(--muted); margin:36px 0 12px; font-weight:600 }
  .sub { color:var(--muted); font-size:13.5px; margin:0 0 20px }
  .verdict { font-size:15.5px; margin:0 0 10px; padding:12px 14px; border-radius:6px;
             background:#f0f7f1; border:1px solid #d6e8d9 }
  table { width:100%; border-collapse:collapse }
  thead th { font-size:11.5px; text-transform:uppercase; letter-spacing:.05em;
             color:var(--muted); font-weight:600; text-align:left;
             padding:0 10px 8px; border-bottom:1px solid var(--line) }
  thead th.s { cursor:pointer; user-select:none }
  thead th.s:hover { color:var(--fg) }
  thead th.n, td.n { text-align:right }
  tbody th { text-align:left; font-weight:500; padding:11px 10px; white-space:nowrap }
  td, tbody th { border-top:1px solid var(--line); padding:11px 10px;
                 font-variant-numeric:tabular-nums }
  a { color:var(--dot); text-decoration:none }
  a:hover { text-decoration:underline }
  .viz { width:150px }
  .xb { height:8px; background:#f0f0f0; border-radius:4px; overflow:hidden }
  .xb i { display:block; height:100%; background:#c3ccda }
  tr.b-different .xb i { background:var(--dot) }
  tr.b-borderline .xb i { background:var(--agr) }
  .pill { font-size:11.5px; text-transform:uppercase; letter-spacing:.04em;
          font-weight:600; padding:3px 8px; border-radius:20px;
          background:#f0f0f0; color:var(--muted); white-space:nowrap }
  .pill.different { background:#e8f1e9; color:var(--ok) }
  .pill.borderline { background:#fdf3e3; color:#8a6410 }
  .muted { color:var(--muted) }
  .sm { font-size:13px }
  .note { font-size:13px; color:var(--muted); margin:14px 0 0; padding-left:10px;
          border-left:2px solid var(--line) }
  footer { margin-top:44px; padding-top:20px; border-top:1px solid var(--line);
           font-size:12.5px; color:var(--muted) }
  footer code { font-size:12px }
</style>
<main>
  <h1>${esc(VINTAGE)} issuances</h1>
  <p class="sub">${cards.length} issuances harvested · ${evaluable.length} conduits comparable with each other</p>

  <p class="verdict"><b>${different} of ${evaluable.length}</b> have a property mix
  more different than chance produces, when by chance you would expect
  <b>${expectedByChance.toFixed(1)}</b>${borderline > 0 ? `, and ${borderline} are borderline` : ""}.
  That aggregate is solid; the verdict for a single issuance near the edge is not.</p>

  <table>
    <thead><tr>
      <th class="s" data-k="name">issuance</th>
      <th class="s n" data-k="pool">pool with type</th>
      <th class="s" data-k="exc" colspan="2">how far it departs · observed vs chance</th>
      <th></th>
      <th>what is different about it</th>
    </tr></thead>
    <tbody id="t">${evaluable.map(row).join("")}</tbody>
  </table>

  <p class="note">Sorted by the <b>excess over chance</b>, not by raw distance:
  a small pool departs more by sampling, and sorting by distance would put small
  pools at the top for being small. One loan is worth up to <b>${pct(grain, 1)}</b> of
  composition in the smallest pool of this cohort, so two issuances separated by less
  than that are tied and the order was set by rounding.</p>

  ${
    singleType.length > 0
      ? `<h2>Single-type — not part of the comparison</h2>
         <table><tbody>${singleType
           .map(
             (f) => `<tr><th><a href="${f.slug}.html">${esc(f.b.target.name)}</a></th>
               <td class="n">${f.b.target.typedPool}${
                 f.b.target.typedPool < f.b.target.pool
                   ? `<span class="muted"> / ${f.b.target.pool}</span>`
                   : ""
               }</td>
               <td class="muted sm">${pct(f.b.target.dominantShare)} ${esc(f.b.target.dominantType ?? "")}</td></tr>`,
           )
           .join("")}</tbody></table>
         <p class="note">An issuance of a single property type departs from the cohort
         by definition, not by how it was assembled. Putting it in the ranking would
         fill the top with a tautology.</p>`
      : ""
  }

  ${
    notEvaluated.length > 0
      ? `<h2>Not evaluated — not enough pairs</h2>
         <table><tbody>${notEvaluated
           .map(
             (f) => `<tr><th><a href="${f.slug}.html">${esc(f.b.target.name)}</a></th>
               <td class="muted sm">${f.b.pairs.length} comparables</td></tr>`,
           )
           .join("")}</tbody></table>
         <p class="note">"Unknown" is not the same as "does not depart", so these go
         separately instead of at the bottom of the table with a dash.</p>`
      : ""
  }

  <footer>
    The ordering uses the only thing the corpus showed distinguishes issuances above
    chance: the property mix. The terms —DSCR, LTV, debt yield— track the same thing
    more weakly (rho = 0.59) because they are its consequence, and they are on each
    issuance's own page.
    <br><br>
    "Borderline" means the verdict changes depending on whether the reference is
    weighted by loan or by issuance. When the two weightings fall on opposite sides of
    5%, we say that instead of picking one.
    <br><br>
    Data from the FWP / Annex A filings published on SEC EDGAR. Generated by
    <code>npm run db:catalog</code>. ${esc(provenanceStamp(state))}
  </footer>
</main>
<script>
  // Sorting with no dependencies. The default is by excess, which is the one that
  // makes sense.
  const tb = document.getElementById("t");
  let dir = -1, last = "exc";
  document.querySelectorAll("thead th.s").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      dir = k === last ? -dir : -1;
      last = k;
      const rows = [...tb.querySelectorAll("tr")];
      rows.sort((a, b) => {
        const x = a.dataset[k], y = b.dataset[k];
        const numeric = k !== "name";
        return (numeric ? (+y - +x) : y.localeCompare(x)) * (dir === -1 ? 1 : -1);
      });
      rows.forEach((f) => tb.appendChild(f));
    });
  });
</script>
`;

await writeFile(`${dir}index.html`, html, "utf8");

console.log(`\n${"═".repeat(78)}`);
console.log(`Index of the ${VINTAGE} cohort`);
console.log(`${"═".repeat(78)}\n`);
console.log(`  ${cards.length} pages + index in \x1b[1mout/index.html\x1b[0m`);
console.log(
  `  ${evaluable.length} comparable conduits · ${singleType.length} single-type · ${notEvaluated.length} not evaluated\n`,
);
console.log(`  issuance                             with type  excess    verdict`);
console.log(`  ${"─".repeat(70)}`);
for (const f of evaluable) {
  const band = bandOf(f.b);
  const color = band === "different" ? "\x1b[32m" : band === "borderline" ? "\x1b[33m" : "\x1b[90m";
  console.log(
    `  ${f.b.target.name.slice(0, 34).padEnd(36)} ` +
      `${String(f.b.target.typedPool).padStart(5)}${
        f.b.target.typedPool < f.b.target.pool
          ? `\x1b[90m/${f.b.target.pool}\x1b[0m`
          : "   "
      } ` +
      `${pct(excess(f.b), 1).padStart(6)}    ${color}${LABEL[band]}\x1b[0m`,
  );
}
console.log(
  `\n  \x1b[1m${different} of ${evaluable.length}\x1b[0m depart, against ${expectedByChance.toFixed(1)} expected by chance` +
    (borderline > 0 ? ` \x1b[33m(+${borderline} borderline)\x1b[0m` : ""),
);
console.log(
  `  \x1b[90mOne loan is worth up to ${pct(grain, 1)} of composition: below that the order` +
    ` is rounding.\x1b[0m`,
);
console.log(`\n\x1b[90m  ${provenanceStamp(state)}\x1b[0m\n`);

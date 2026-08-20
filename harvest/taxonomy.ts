/**
 * Generates the CRE taxonomy document.
 *
 *   npm run taxonomy              prints to the screen
 *   npm run taxonomy -- --write   writes docs/cre-taxonomy.md
 *
 * WHAT FOR
 *
 * The domain knowledge we have accumulated —that an Annex A publishes four
 * vintages of NOI, three LTV structures and two DSCR bases, and what happens if
 * they get confused— currently lives in regular expressions. That works for the
 * code but is unauditable for someone in the industry.
 *
 * This document exists so a CRE underwriter can read it and say "this is wrong"
 * or "you are missing such-and-such distinction", without opening a TypeScript
 * file. That review is the cheapest way to validate whether the normalisation
 * work is worth anything.
 */

import { writeFile } from "node:fs/promises";
import { METRIC_SPECS, type MetricKey } from "./normalize/columnMap.js";
import { DEFINITIONS, TAXONOMY_VERSION } from "./normalize/definitions.js";

const write = process.argv.includes("--write");
const OUT = new URL("../docs/cre-taxonomy.md", import.meta.url).pathname;

const lines: string[] = [];
const p = (s = "") => lines.push(s);

// ---------------------------------------------------------------------------

p(`# CRE taxonomy`);
p();
p(`> Version ${TAXONOMY_VERSION} · ${METRIC_SPECS.length} metrics`);
p();
p(
  `This document describes how we interpret the columns of a CMBS Annex A.`,
);
p(
  `It is meant for someone who underwrites deals to review and flag what is`,
);
p(`wrong or missing, without reading code.`);
p();
p(
  `**Why it exists.** The data is public: anyone can download the same SEC`,
);
p(
  `filings. What is not trivial is interpreting them. An Annex A publishes NOI`,
);
p(
  `across four vintages, LTV against three different denominators, and DSCR on`,
);
p(
  `two bases. Confusing them produces plausible, wrong numbers —the kind of`,
);
p(`error that does not stand out and contaminates everything derived from it.`);
p();

// --- incidentes ---------------------------------------------------------------

const incidents = Object.entries(DEFINITIONS).filter(([, d]) => d?.incident);

if (incidents.length > 0) {
  p(`## Errors that motivated these distinctions`);
  p();
  p(
    `Each was detected with real data. In every case the extracted value was`,
  );
  p(`correct and the label was wrong.`);
  p();

  for (const [key, def] of incidents) {
    p(`**${labelOf(key as MetricKey)}** — ${def!.incident}`);
    p();
  }
}

// --- metrics by family -----------------------------------------------------------

const families = new Map<string, MetricKey[]>();
for (const spec of METRIC_SPECS) {
  const family = DEFINITIONS[spec.key]?.family ?? "Other";
  const list = families.get(family);
  if (list) list.push(spec.key);
  else families.set(family, [spec.key]);
}

// Documented families first; "Other" last.
const ordered = [...families.entries()].sort((a, b) => {
  if (a[0] === "Other") return 1;
  if (b[0] === "Other") return -1;
  return 0;
});

p(`## Metrics`);
p();

for (const [family, keys] of ordered) {
  p(`### ${family}`);
  p();

  for (const key of keys) {
    const spec = METRIC_SPECS.find((s) => s.key === key)!;
    const def = DEFINITIONS[key];

    p(`#### ${spec.label}`);
    p();
    p(`\`${key}\` · ${unitLabel(spec.unit)} · ${spec.entity === "deal" ? "loan" : "property"} level`);
    p();

    if (def?.definition) {
      p(def.definition);
      p();
    } else {
      p(`*No documented definition.*`);
      p();
    }

    if (def?.disambiguation) {
      p(`**How to tell it apart.** ${def.disambiguation}`);
      p();
    }

    p(`<details><summary>Headers that capture it</summary>`);
    p();
    p("```");
    for (const pattern of spec.patterns) {
      p(`  ${describePattern(pattern)}`);
    }
    if (spec.exclude?.length) {
      p();
      p(`  se descarta si contiene:`);
      for (const pattern of spec.exclude) {
        p(`    ${describePattern(pattern)}`);
      }
    }
    p("```");
    p();
    p(`</details>`);
    p();
  }
}

// --- how to review it --------------------------------------------------------------

p(`## How to review this`);
p();
p(`The questions with the most value if you work in the industry:`);
p();
p(`1. Is any definition wrong?`);
p(`2. Is a distinction that matters missing? For example: is it worth separating`);
p(`   occupancy by asset type, or NOI adjusted for single tenants?`);
p(`3. Is any of these distinctions irrelevant in practice?`);
p(`4. Are there Annex A columns we do not capture and should?`);
p();
p(
  `To see which columns went unmapped in the current corpus: \`npm run db:stats\`.`,
);
p();

// ---------------------------------------------------------------------------

const doc = lines.join("\n");

if (write) {
  await writeFile(OUT, doc);
  console.log(`\n  → docs/cre-taxonomy.md`);
  console.log(`  ${METRIC_SPECS.length} metrics · version ${TAXONOMY_VERSION}`);
  const documented = METRIC_SPECS.filter((s) => DEFINITIONS[s.key]?.definition).length;
  console.log(
    `  ${documented} with a definition, ${METRIC_SPECS.length - documented} undocumented\n`,
  );
} else {
  console.log(doc);
}

// ---------------------------------------------------------------------------

function labelOf(key: MetricKey): string {
  return METRIC_SPECS.find((s) => s.key === key)?.label ?? key;
}

function unitLabel(unit: string): string {
  return (
    {
      currency: "currency",
      percent: "percent",
      ratio: "ratio",
      count: "count",
      years: "years",
      text: "text",
    }[unit] ?? unit
  );
}

/**
 * Translates a regular expression into something readable.
 *
 * It is not exact —a regex does not always have a natural reading— but it is
 * enough for someone without technical training to understand what is being
 */
function describePattern(pattern: RegExp): string {
  return pattern.source
    .replace(/\\b/g, "")
    .replace(/\\s\*/g, " ")
    .replace(/\\s\+/g, " ")
    .replace(/\.\*/g, " … ")
    .replace(/\\\./g, ".")
    .replace(/\\\//g, "/")
    .replace(/\\\$/g, "$")
    .replace(/\(\?:/g, "(")
    .replace(/\\w\+/g, "…")
    .replace(/\?/g, "")
    .replace(/\^|\$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

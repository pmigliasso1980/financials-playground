/**
 * Which corpus the project's verdicts were issued against.
 *
 *   npm run db:provenance
 *
 * Prints the state of the corpus, the thresholds with the sample each one was
 * justified against, and warns which ones are worth rereading because the corpus
 * has grown since.
 *
 * WHY IT IS A COMMAND AND NOT A COMMENT
 *
 * `db:power` said the sample could not detect the claimed effect; the corpus
 * grew and that verdict flipped without anyone rereading it, and a document went
 * on quoting the old version. A comment in the code does not warn you. This
 * does, and it costs one line to add to any routine.
 */

import { closePool, ping } from "./client.js";
import {
  corpusState,
  metricsWithoutBaseline,
  provenanceStamp,
  stalenessWarnings,
  THRESHOLDS,
} from "./provenance.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const e = await corpusState();
await closePool();

console.log(`\n${"═".repeat(78)}`);
console.log("Provenance of the verdicts");
console.log(`${"═".repeat(78)}\n`);
console.log(`  ${provenanceStamp(e)}\n`);

console.log(`  threshold                           value           justified with`);
console.log(`  ${"─".repeat(74)}`);
for (const t of THRESHOLDS) {
  const grew = (e.loans - t.loans) / Math.max(1, t.loans);
  const mark = /NO empirical basis/i.test(t.note)
    ? "\x1b[31m"
    : grew >= 0.25
      ? "\x1b[33m"
      : "\x1b[90m";
  console.log(
    `  ${`${t.script} · ${t.name}`.slice(0, 34).padEnd(36)}` +
      `${t.value.padEnd(16)}${mark}${t.loans.toLocaleString("en-US")} loans\x1b[0m` +
      (grew >= 0.25 ? ` \x1b[33m(+${(grew * 100).toFixed(0)}% since then)\x1b[0m` : ""),
  );
}

const stale = stalenessWarnings(e);
const unbased = metricsWithoutBaseline();

console.log(`\n${"─".repeat(78)}\n`);

if (stale.length === 0) {
  console.log(`  \x1b[32mNo threshold was justified against a notably smaller corpus.\x1b[0m`);
} else {
  console.log(
    `  \x1b[33m${stale.length} threshold(s) to reread — the corpus grew since they were set:\x1b[0m\n`,
  );
  for (const w of stale) console.log(`    ${w}`);
}

if (unbased.length > 0) {
  console.log(`\n  \x1b[31m${unbased.length} threshold(s) with NO empirical basis:\x1b[0m\n`);
  for (const w of unbased) console.log(`    ${w}`);
}

/**
 * The distinction this command exists to maintain.
 *
 * A threshold can be right and have an expired justification; those are two
 * different things. Confusing them would be the same error as always in a new
 * version: reading a flag as if it were a finding.
 */
console.log(
  `\n  \x1b[90mA warning here does not say the threshold is wrong. It says the justification\x1b[0m`,
);
console.log(
  `  \x1b[90mwas written against a different sample, and that rereading it costs less than\x1b[0m`,
);
console.log(`  \x1b[90mdiscovering three weeks later that a verdict has flipped.\x1b[0m\n`);

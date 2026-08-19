/**
 * Normalises the state to a two-letter code in what has already been harvested.
 *
 *   npm run db:fix-states -- --dry     # shows what it would do, touches nothing
 *   npm run db:fix-states              # applies it
 *
 * WHY A SCRIPT AND NOT A SQL MIGRATION
 *
 * The mapping lives in `harvest/normalize/states.ts` because the harvester needs
 * it at write time. Writing the same CASE by hand in a .sql file would mean
 * keeping two lists of fifty entries in sync, and this session has already shown
 * three times what happens with that: they diverge on the first correction made
 * to only one of them.
 *
 * Here the SQL is generated from the TypeScript table, so it cannot diverge.
 *
 * WHY WE DO NOT RE-HARVEST
 *
 * Re-harvesting 233 filings takes hours because of SEC's rate limit, and the
 * mapping is deterministic: applying it over what is stored gives exactly the
 * same result as downloading the documents again. The harvester already
 * normalises at write time, so this is a one-off for the old data.
 *
 * IT STARTS DRY
 *
 * `--dry` shows the before and after without writing. An UPDATE over 16% of the
 * corpus is worth looking at before running it.
 *
 * WHAT COUNTS AS "ALREADY FINE"
 *
 * Not `~ '^[A-Z]{2}$'` but "is in the list of codes", which is what `/comps`
 * actually asks. With the regex, a lowercase "ny" fell outside the fix by
 * looking valid, and so did an "XX".
 */

import { closePool, ping, query } from "./client.js";
import { sqlCase, STATE_CODES } from "../harvest/normalize/states.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const DRY = process.argv.includes("--dry");
const codes = [...STATE_CODES];

console.log(`\n${"═".repeat(78)}`);
console.log(`Normalise state to a two-letter code${DRY ? "  ·  DRY RUN" : ""}`);
console.log(`${"═".repeat(78)}\n`);

/**
 * What is going to be touched and what it will become, before touching it.
 *
 * The `becomes` column is the one that matters: if a value falls to NULL it is
 * because the table does not recognise it, and that has to be seen beforehand
 * rather than after.
 */
const { rows: preview } = await query<{ stored: string; becomes: string | null; n: string }>(
  `SELECT btrim(state) AS stored, ${sqlCase()} AS becomes, count(*)::text AS n
     FROM corpus.loans
    WHERE state IS NOT NULL AND NOT (btrim(state) = ANY($1))
    GROUP BY 1, 2
    ORDER BY count(*) DESC`,
  [codes],
);

if (preview.length === 0) {
  console.log(`  \x1b[32mThere are no states to normalise.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

const recoverable = preview.filter((r) => r.becomes !== null);
const lost = preview.filter((r) => r.becomes === null);
const nRecoverable = recoverable.reduce((t, r) => t + Number(r.n), 0);
const nLost = lost.reduce((t, r) => t + Number(r.n), 0);

console.log(`  stored value                  becomes        loans`);
console.log(`  ${"─".repeat(58)}`);
for (const r of preview.slice(0, 25)) {
  console.log(
    `  ${(r.stored || "(empty)").slice(0, 28).padEnd(30)} ` +
      `${(r.becomes ?? "—").padEnd(10)} ${String(r.n).padStart(9)}` +
      (r.becomes === null ? `  \x1b[90m← no mapping, stays invalid\x1b[0m` : ""),
  );
}
if (preview.length > 25) {
  console.log(`  \x1b[90m... and ${preview.length - 25} more values\x1b[0m`);
}

console.log(
  `\n  \x1b[32m${nRecoverable.toLocaleString("en-US")} loans become visible again\x1b[0m` +
    ` to /comps.`,
);
if (nLost > 0) {
  console.log(
    `  \x1b[90m${nLost.toLocaleString("en-US")} still have no state: the table does not recognise them and they are not guessed.\x1b[0m`,
  );
}

if (DRY) {
  console.log(`\n  \x1b[33mDry run: nothing was written.\x1b[0m Drop --dry to apply.\n`);
  await closePool();
  process.exit(0);
}

/**
 * The UPDATE only touches rows that will end up with a valid code.
 *
 * Without that `AND ... IS NOT NULL`, values the table does not recognise would
 * go from "New Yorkk" to NULL, and with that we would lose the only clue as to
 * why they failed.
 */
const { rowCount } = await query(
  `UPDATE corpus.loans
      SET state = ${sqlCase()}
    WHERE state IS NOT NULL
      AND NOT (btrim(state) = ANY($1))
      AND ${sqlCase()} IS NOT NULL`,
  [codes],
);

console.log(`\n  \x1b[1m${rowCount} rows updated.\x1b[0m`);
console.log(
  `  \x1b[90mRun \x1b[0mnpm run db:monitor\x1b[90m to confirm, and \x1b[0mnpm run api:scenarios` +
    `\x1b[90m to see whether any answer changed.\x1b[0m\n`,
);

await closePool();

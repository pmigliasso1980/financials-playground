/**
 * Why do 7 of the 2026 issuances carry no occupancy?
 *
 *   npm run harvest:occupancy
 *   npm run harvest:occupancy -- --broken 4 --healthy 2
 *
 * WHAT WE ALREADY KNOW, AND WHAT IS MISSING
 *
 * `db:benchmark --audit` closed the diagnosis from the data side: within the
 * issuances that do carry the column, all eight property types have occupancy
 * in 100% of loans, zero dispersion. It is not that the datum does not apply to
 * certain assets — it is the Annex A's format.
 *
 * What is missing is the concrete header we do not recognise. This probe looks
 * for it by running the SAME pipeline as `harvest:batch` over a broken issuance
 * and a healthy one, and putting the headers side by side.
 *
 * WHY `harvest:inspect` IS NOT ENOUGH
 *
 * That inspector works on already-captured fixtures, and these seven are not
 * among them. Capturing them first would be an extra step for a question that
 * is answered by looking at one row.
 *
 * IT WRITES NOTHING. It is diagnostic: download, look, report.
 *
 * THE CLUE THAT HAS TO BE EXPLAINED
 *
 * Six of the seven broken ones have occupancy in 1-6 loans, not in zero. A
 * pattern that does not match would give a clean zero. That there is a handful
 * suggests the correct column is not recognised and those few values come in
 * through ANOTHER column — probably one from a different block that matches by
 * accident.
 *
 * If that is true, the 688 values we currently treat as good include some that
 * are not occupancy, and the problem is not only one of coverage.
 */

import { fetchBuffer, preflight } from "./edgar/client.js";
import { findAnnexFilings } from "./edgar/discover.js";
import { extractTables } from "./parse/tables.js";
import {
  findHeaderRow,
  mapColumns,
  METRIC_SPECS,
  scoreHeader,
} from "./normalize/columnMap.js";
import { attachContinuationTables } from "./normalize/annexStructure.js";
import { closePool, ping, query } from "../db/client.js";

const args = process.argv.slice(2);
const flag = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : Number(args[i + 1] ?? def);
};
const N_BROKEN = flag("broken", 3);
const N_HEALTHY = flag("healthy", 2);

const health = await preflight();
if (!health.ok) {
  console.error(`\n✗ ${health.message}\n`);
  process.exit(1);
}
const db = await ping();
if (!db.ok) {
  console.error(`\n✗ ${db.message.split("\n").join("\n  ")}\n`);
  process.exit(1);
}

/**
 * The issuances come from the database, not from a hand-written list.
 *
 * It already happened to us in `harvest:history`: eight CIKs made up from
 * memory, all eight failed. Had I guessed two correctly, the pilot would have
 * run over those two without anyone noticing.
 */
const { rows: issuances } = await query<{
  cik: string; accession: string; name: string; pool: string; con_occ: string;
}>(
  `SELECT f.cik, f.accession, f.company_name AS name,
          count(l.id)::text AS pool,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM corpus.facts fa
             WHERE fa.loan_id = l.id AND fa.metric_key = 'occupancy'
               AND fa.value ~ '^-?[0-9.]+$'
          ))::text AS con_occ
     FROM corpus.filings f
     JOIN corpus.loans l ON l.accession = f.accession
    WHERE extract(year FROM f.filed_at) = extract(year FROM now())
    GROUP BY f.cik, f.accession, f.company_name
    ORDER BY count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM corpus.facts fa
             WHERE fa.loan_id = l.id AND fa.metric_key = 'occupancy'
               AND fa.value ~ '^-?[0-9.]+$'
          ))::numeric / count(l.id)`,
);
await closePool();

const coverage = (e: (typeof issuances)[number]) =>
  Number(e.con_occ) / Math.max(1, Number(e.pool));

const broken = issuances.filter((e) => coverage(e) < 0.5).slice(0, N_BROKEN);
const healthy = issuances.filter((e) => coverage(e) > 0.95).slice(-N_HEALTHY);

if (broken.length === 0) {
  console.log(`\n  No issuance with low occupancy coverage. Nothing to diagnose.\n`);
  process.exit(0);
}

/** The spec we are auditing, exactly as the mapping sees it. */
const SPEC = METRIC_SPECS.find((m) => m.key === "occupancy")!;

/** Deliberately broad: we also want to see what the mapping does NOT consider. */
const SOSPECHOSO = /occ|physic|lease|vacan|utiliz/i;

console.log(`\n${"═".repeat(78)}`);
console.log("Which occupancy header do we not recognise?");
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  Patrones actuales: ${SPEC.patterns.map((p) => p.source).join("  ·  ")}\x1b[0m`,
);
console.log(
  `\x1b[90m  Excluye: ${(SPEC.exclude ?? []).map((p) => p.source).join("  ·  ")}\x1b[0m\n`,
);

/**
 * Why a header did not reach occupancy.
 *
 * Three different outcomes that "does not match" conflates into one:
 *   · no pattern touches it        → a pattern is missing
 *   · an exclude kills it          → the exclude is too broad
 *   · it matches but loses the bid → another metric took it, and knowing which
 *                                    matters because that is where the
 *                                    mislabelled value is
 */
function whyNot(header: string, headers: string[]): string {
  const excl = (SPEC.exclude ?? []).find((r) => r.test(header));
  const hits = SPEC.patterns.find((r) => r.test(header));
  const score = scoreHeader(header, SPEC);
  const { matches } = mapColumns(headers);
  const assigned = matches.find((m) => m.header === header);

  if (assigned?.metric.key === "occupancy") return `\x1b[32mmaps to occupancy\x1b[0m`;
  if (excl) return `\x1b[31mkilled by the exclude /${excl.source}/\x1b[0m`;
  if (!hits) return `\x1b[33mno pattern touches it\x1b[0m`;
  if (assigned) {
    return `\x1b[31mtaken by ${assigned.metric.key}\x1b[0m \x1b[90m(occ: ${score.toFixed(2)})\x1b[0m`;
  }
  return `\x1b[33mmatches (${score.toFixed(2)}) but is not assigned\x1b[0m`;
}

async function look(e: (typeof issuances)[number], label: string) {
  const cov = coverage(e);
  console.log(`${"─".repeat(78)}`);
  console.log(
    `\x1b[1m${e.name.slice(0, 50)}\x1b[0m  \x1b[90m${label} · ${e.con_occ} of ${e.pool} (${(cov * 100).toFixed(0)}%)\x1b[0m`,
  );

  try {
    const picks = await findAnnexFilings(e.cik, { max: 1 });
    if (picks.length === 0) {
      console.log(`  \x1b[33mno Annex A in submissions\x1b[0m\n`);
      return;
    }
    const { filing } = picks[0]!;

    /**
     * `findAnnexFilings` returns the CIK's most recent one, which may not be
     * the same filing we harvested. If it differs we say so: comparing headers
     * from a different document would be exactly the kind of silent error this
     * project has already paid for twice.
     */
    if (filing.accession.replace(/-/g, "") !== e.accession.replace(/-/g, "")) {
      console.log(
        `  \x1b[33m⚠ the most recent Annex (${filing.accession}) is not the harvested one (${e.accession})\x1b[0m`,
      );
    }

    const buffer = await fetchBuffer(filing.documentUrl, { timeoutMs: 180_000 });
    const tables = extractTables(buffer, filing.documentName);
    const { tables: annexTables } = attachContinuationTables(tables, (rows) =>
      findHeaderRow(rows),
    );

    if (annexTables.length === 0) {
      console.log(`  \x1b[33mno recognisable Annex tables\x1b[0m\n`);
      return;
    }

    const vistos = new Set<string>();
    let found = 0;

    for (const t of annexTables) {
      const headers = (t.rows[t.headerRowIndex] ?? []).map((c) =>
        c === null || c === undefined ? "" : String(c),
      );
      for (const h of headers) {
        const cleaned = h.replace(/\s+/g, " ").trim();
        if (!cleaned || !SOSPECHOSO.test(cleaned) || vistos.has(cleaned)) continue;
        vistos.add(cleaned);
        found++;
        console.log(`  \x1b[36m"${cleaned.slice(0, 52)}"\x1b[0m`);
        console.log(`      ${whyNot(h, headers)}`);
      }
    }

    if (found === 0) {
      console.log(
        `  \x1b[31mNo header mentions occupancy anywhere in the Annex.\x1b[0m`,
      );
      console.log(
        `  \x1b[90mIf so, the datum is not in the document and no parser can fix it.\x1b[0m`,
      );
    }
    console.log();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  \x1b[31m${msg.slice(0, 60)}\x1b[0m\n`);
  }
}

for (const e of broken) await look(e, "BROKEN");
for (const e of healthy) await look(e, "sana");

console.log(`${"═".repeat(78)}`);
console.log(
  `\n  \x1b[90mThe header that appears in the healthy ones and is missing —or falls for\x1b[0m`,
);
console.log(
  `  \x1b[90manother reason— in the broken ones is the fix. If the broken ones have no\x1b[0m`,
);
console.log(
  `  \x1b[90moccupancy header at all, the datum does not exist in the document: the\x1b[0m`,
);
console.log(`  \x1b[90mmetric has declared partial coverage, not an open bug.\x1b[0m\n`);

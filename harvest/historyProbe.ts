/**
 * How many events does downloading the historical 10-D files buy?
 *
 *   npm run harvest:history                 # pilot over 8 trusts
 *   npm run harvest:history -- --trusts 20 --every 6
 *
 * THE QUESTION, AND WHY IT IS MEASURED BEFORE BEING PAID FOR
 *
 * Everything we have done rests on 168 events, and that is the corpus's real
 * constraint — not the 7,000 loans. Five hypotheses died for lack of power to
 * support four or five simultaneous controls.
 *
 * The 10-D lists the loans that are in special servicing TODAY. A loan that
 * transferred in 2022 and was resolved in 2023 is invisible: that is the stock
 * bias, documented from the start and never corrected.
 *
 * Downloading the history turns it into a flow. But that is ~1,500 documents
 * even sampling every six months, and before spending that it is worth knowing
 * how much it buys. It is the same rule as the noise floor before the effect:
 * measure whether the question is answerable before trying to answer it.
 *
 * WHAT THE PILOT MEASURES
 *
 * For a handful of trusts, it downloads reports every N months going back and
 * counts how many DISTINCT loans ever appeared in special servicing, against
 * how many appear in the most recent report.
 *
 * The ratio is what would multiply the whole corpus's events.
 *
 * HOW TO READ IT
 *
 *   ~1.2x   does not pay: 1,500 requests for 20% more events
 *   ~2x     doubtful, and depends on how much it costs in time
 *   ~3x     168 → ~500 events, and everything that died for power reopens
 *
 * IT WRITES NOTHING. It is a measurement of the prize, not a harvest.
 */

import { fetchText, preflight } from "./edgar/client.js";
import { findServicerReports } from "./edgar/servicer.js";
import { parseServicerReport } from "./parse/servicerReport.js";
import { closePool, ping, query } from "../db/client.js";

const args = process.argv.slice(2);
const flag = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : Number(args[i + 1] ?? def);
};

const EVERY_MONTHS = flag("every", 6);
const MAX_REPORTS = flag("reports", 10);

const nTrusts = flag("trusts", 8);

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
 * The trusts come from the corpus, not from a hand-written list.
 *
 * The first version had eight hardcoded CIKs "chosen by vintage, not by
 * result". The intent was right and the execution was not: all eight were made
 * up from memory and all eight failed. Had I guessed two correctly, the pilot
 * would have run over those two without anyone noticing.
 *
 * Taking them from `servicer_reports` guarantees two things: that they exist,
 * and that we already know their 10-D parses.
 *
 * THE ORDER IS DETERMINISTIC AND DOES NOT DEPEND ON THE RESULT
 *
 * The largest pools within each vintage are taken. It is a power criterion
 * —more loans, more possible events— fixed before looking at anything, and it
 * has nothing to do with how many transfers each one has.
 */
const { rows: TRUSTS } = await query<{ cik: string; name: string; vintage: number }>(
  `WITH by_vintage AS (
     SELECT f.cik, f.company_name AS name,
            extract(year FROM f.filed_at)::int AS vintage,
            count(l.id) AS pool,
            row_number() OVER (
              PARTITION BY extract(year FROM f.filed_at)
              ORDER BY count(l.id) DESC, f.accession
            ) AS rn
       FROM corpus.filings f
       JOIN corpus.servicer_reports sr ON sr.deal_accession = f.accession
       JOIN corpus.loans l ON l.accession = f.accession
      WHERE extract(year FROM f.filed_at) BETWEEN 2020 AND 2024
      GROUP BY f.cik, f.company_name, f.accession, f.filed_at
   )
   SELECT cik, name, vintage FROM by_vintage
    WHERE rn <= 2 ORDER BY vintage, name`,
);
await closePool();

if (TRUSTS.length === 0) {
  console.error(`\n✗ No trust with a registered report. Run db:performance.\n`);
  process.exit(1);
}

console.log(`\n${"═".repeat(78)}`);
console.log("How much does the history buy? — pilot, writes nothing");
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  One report every ${EVERY_MONTHS} months, up to ${MAX_REPORTS} per trust.\x1b[0m\n`,
);
console.log(
  `  trust                    reports    period        today   historical  ratio`,
);
console.log(`  ${"─".repeat(74)}`);

let totToday = 0;
let totHist = 0;
const byVintage = new Map<number, { today: number; hist: number }>();

for (const t of TRUSTS.slice(0, nTrusts)) {
  try {
    const reports = await findServicerReports(t.cik, {
      max: MAX_REPORTS,
      everyMonths: EVERY_MONTHS,
    });

    if (reports.length === 0) {
      console.log(`  ${t.name.slice(0, 24).padEnd(24)} \x1b[33msin 10-D\x1b[0m`);
      continue;
    }

    /**
     * A loan counts once even if it appears in several reports. The key is the
     * normalised Loan ID, the same one the corpus join uses.
     */
    const algunaVez = new Set<string>();
    let today = 0;
    let periodoViejo = "";
    let periodoNuevo = "";

    for (const [i, r] of reports.entries()) {
      const parsed = parseServicerReport(await fetchText(r.documentUrl));
      const withTransfer = new Set<string>();
      for (const d of parsed.delinquency) {
        if (d.transferDate) withTransfer.add(d.loanId);
      }
      for (const s of parsed.specialServicing) {
        if (s.transferDate) withTransfer.add(s.loanId);
      }

      // The first in the list is the most recent: it is what the corpus sees today.
      if (i === 0) {
        today = withTransfer.size;
        periodoNuevo = r.periodOfReport || r.filedAt;
      }
      periodoViejo = r.periodOfReport || r.filedAt;
      for (const id of withTransfer) algunaVez.add(id);
    }

    const hist = algunaVez.size;
    const ratio = today > 0 ? hist / today : hist > 0 ? Infinity : 1;
    totToday += today;
    totHist += hist;

    const a = byVintage.get(t.vintage) ?? { today: 0, hist: 0 };
    a.today += today;
    a.hist += hist;
    byVintage.set(t.vintage, a);

    console.log(
      `  ${t.name.slice(0, 24).padEnd(24)} ${String(reports.length).padStart(8)}   ` +
        `${periodoViejo.slice(0, 7)}→${periodoNuevo.slice(2, 7)}  ` +
        `${String(today).padStart(5)}  ${String(hist).padStart(9)}   ` +
        `${Number.isFinite(ratio) ? `${ratio.toFixed(2)}x` : "—"}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${t.name.slice(0, 24).padEnd(24)} \x1b[31m${msg.slice(0, 34)}\x1b[0m`);
  }
}

console.log(`\n${"─".repeat(78)}\n`);

if (totToday === 0) {
  console.log(`  \x1b[33mNo events in the recent reports. No basis for comparison.\x1b[0m\n`);
  process.exit(0);
}

const globalRatio = totHist / totToday;
console.log(
  `  \x1b[1mTotal: ${totToday} events today · ${totHist} ever · ${globalRatio.toFixed(2)}x\x1b[0m`,
);

console.log(`\n  By vintage — the control that this measures what we say it does:\n`);
for (const [vintage, a] of [...byVintage].sort()) {
  const r = a.today > 0 ? a.hist / a.today : 0;
  console.log(
    `    ${vintage}   ${String(a.today).padStart(3)} today · ${String(a.hist).padStart(3)} ever   ` +
      `${r ? `${r.toFixed(2)}x` : "—"}`,
  );
}

/**
 * The sense check: the old vintages should gain MORE than the young ones.
 *
 * A 2023 trust has had little time for a case to enter and be resolved, so its
 * history should add almost nothing. If the ratio comes out even across
 * vintages, what we are measuring is not the stock bias: it is something else —
 * parsing noise, or loans entering and leaving the block for another reason.
 */
const suma = (xs: Array<[number, { today: number; hist: number }]>) => ({
  today: xs.reduce((s, [, a]) => s + a.today, 0),
  hist: xs.reduce((s, [, a]) => s + a.hist, 0),
});
const viejas = suma([...byVintage].filter(([a]) => a <= 2021));
const young = suma([...byVintage].filter(([a]) => a >= 2023));

/**
 * The verdict is only issued if there is something to compare it against.
 *
 * The previous version computed the young vintages' ratio as
 * `hist / max(1, today)`. With zero events that gave 0.00 and the control fired
 * "consistent with stock bias" because 1.29 > 0 × 1.3 — it validated itself,
 * through a degenerate division.
 *
 * It is the same error as the dispersion ratio that returned 29,333,333x: a
 * guard against division by zero turned into a number that looks like it
 * measures something. A group with no events does not give a low ratio: it
 * gives no ratio.
 */
console.log(
  `\n  \x1b[90mViejas (≤2021): ${viejas.today} today · ${viejas.hist} alguna vez` +
    `   ·   young (≥2023): ${young.today} today · ${young.hist} ever\x1b[0m`,
);
if (viejas.today < 5 || young.today < 5) {
  console.log(
    `  \x1b[33mCannot be contrasted: a minimum of 5 events per group is needed.\x1b[0m`,
  );
} else {
  const rv = viejas.hist / viejas.today;
  const rj = young.hist / young.today;
  console.log(
    `  \x1b[90mratios ${rv.toFixed(2)}x contra ${rj.toFixed(2)}x\x1b[0m` +
      (rv > rj * 1.3
        ? `  \x1b[32m← consistent with stock bias\x1b[0m`
        : `  \x1b[31m← NOT stock bias: both gain evenly\x1b[0m`),
  );
}

/**
 * The effective window, which decides whether the ratio is readable.
 *
 * With `--reports 10` every 6 months you reach 54 months back: for a 2020 trust
 * that starts in 2022 and misses the COVID peak, when hospitality and retail
 * entered special servicing in large numbers. The ratio ends up a lower bound, and
 * biased precisely against the vintages that should gain most.
 */
const monthsReached = MAX_REPORTS * EVERY_MONTHS;
console.log(
  `\n  \x1b[90mWindow: ${monthsReached} months back (${MAX_REPORTS} reports × ${EVERY_MONTHS}).\x1b[0m` +
    (monthsReached < 72
      ? `  \x1b[33m← does not reach the 2020 issuance\x1b[0m`
      : ""),
);
console.log(
  `\n  \x1b[90mIf the global ratio were ~1.2x it does not pay: 1,500 requests for 20%\x1b[0m`,
);
console.log(
  `  \x1b[90mmore events. Near 3x the 168 would become ~500 and everything that died\x1b[0m`,
);
console.log(`  \x1b[90mfor lack of power reopens.\x1b[0m\n`);

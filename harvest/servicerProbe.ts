/**
 * Probe against real servicer reports.
 *
 *   npm run harvest:servicer -- 2016841
 *   npm run harvest:servicer -- 2016841 --months 3
 *
 * Downloads a trust's 10-D files, parses the EX-99.1 and shows what came out.
 * It writes nothing: it is for seeing whether the parser handles a format before
 * putting it into the pipeline.
 *
 * What matters in the output is not the loan count but three things:
 *
 *   - how many loans were left with no usable NOI and why,
 *   - what percentage comes from a full year versus extrapolated,
 *   - whether there are conflicts between tranches, which would indicate the
 *     Pros ID normalisation is joining loans that do not belong together.
 */

import { fetchText, preflight } from "./edgar/client.js";
import { findServicerReports } from "./edgar/servicer.js";
import {
  describeServicerHeaders,
  extractParties,
  mergeServicerReports,
  parseServicerReport,
} from "./parse/servicerReport.js";
import { extractFromHtml } from "./parse/tables.js";

const [, , cikArg, ...rest] = process.argv;

if (!cikArg) {
  console.error("\nUso: npm run harvest:servicer -- <cik> [--months N]\n");
  process.exit(1);
}

const monthsFlag = rest.indexOf("--months");
const months = monthsFlag === -1 ? 1 : Number(rest[monthsFlag + 1] ?? 1);

const health = await preflight();
if (!health.ok) {
  console.error(`\n✗ ${health.message}\n`);
  process.exit(1);
}

console.log(`\nLooking for 10-D filings for CIK ${cikArg}...`);

const reports = await findServicerReports(cikArg, { max: months });

if (reports.length === 0) {
  console.error(
    `\n✗ No 10-D with an identifiable EX-99.1.\n` +
      `  The trust may be very new, or the exhibit may have another name.\n`,
  );
  process.exit(1);
}

const collected: Array<{ label: string; loans: Awaited<ReturnType<typeof collect>> }> = [];

async function collect(url: string) {
  const html = await fetchText(url);
  return parseServicerReport(html).loans;
}

for (const report of reports) {
  console.log(`\n${"─".repeat(78)}`);
  console.log(`${report.companyName}`);
  console.log(
    `  ${report.accession} · filed ${report.filedAt} · period ${report.periodOfReport || "?"}`,
  );
  console.log(`  ${report.documentName} · ${(report.sizeBytes / 1024).toFixed(0)} KB`);

  const html = await fetchText(report.documentUrl);

  /**
   * `--headers` lists ALL the columns, not just the five the parser uses.
   *
   * The servicer report carries payment status, days in arrears and transfer to
   * special servicing, and we never looked at them because the parser was after
   * NOI. Seeing the real names is the step before deciding whether they can be
   * mapped — and it avoids inventing patterns against imagined headers.
   */
  if (process.argv.includes("--headers")) {
    const tables = extractFromHtml(html, { mergeHeaders: false, minRows: 2 });
    for (const t of describeServicerHeaders(tables)) {
      console.log(`\n  \x1b[1mfamily ${t.family}\x1b[0m · ${t.headers.length} columns`);
      t.headers.forEach((h, i) => {
        if (h) console.log(`    ${String(i).padStart(3)}  ${h}`);
      });

      /**
       * Three data rows below the header.
       *
       * "53 rows with no dates" has two causes: the servicer does not publish
       * the period, or the column index is shifted and we are reading something
       * else. The count does not separate them; seeing the cell does.
       *
       * Only for the NOI block, which is the one that discards rows.
       */
      /**
       * The specially serviced blocks too.
       *
       * The parser takes `transfer_date` ONLY from the delinquency block. But
       * the 10-D also carries "Specially Serviced Loan Detail", with its own
       * `Servicing Transfer Date` column — and a loan can be in special
       * servicing while paying on time, in which case it would appear there and
       * not among the delinquent.
       *
       * BANK 2021-BNK36 says "No delinquent loans this period" and we never
       * looked at whether its specially serviced block had rows. If it does, the
       * numerator of the whole analysis is systematically incomplete.
       */
      const esNoi = t.headers.some((h) => /noi\s*end\s*date/i.test(h));
      const isDelinquency = t.headers.some((h) => /months\s*delinquent/i.test(h));
      const esEspecial = t.headers.some((h) =>
        /servicing\s*transfer\s*date|special\s*servicing\s*comments|specially\s*serviced/i.test(h),
      );
      if (!esNoi && !isDelinquency && !esEspecial) continue;

      console.log(`    \x1b[90m── three data rows ──\x1b[0m`);
      for (let r = t.headerRow + 1; r <= t.headerRow + 3 && r < t.rows.length; r++) {
        const row = t.rows[r] ?? [];
        const cells = t.headers
          .map((h, i) => (h ? `[${i}] ${String(row[i] ?? "").trim() || "∅"}` : null))
          .filter(Boolean)
          .join("  ");
        console.log(`    \x1b[90m${cells.slice(0, 150)}\x1b[0m`);
      }
    }
    continue;
  }

  /**
   * `--noi-fiscal`: is "Most Recent Fiscal NOI" a twelve-month figure?
   *
   * BANK discards 53 of 65 rows for not publishing the NOI period, but the
   * `Most Recent Fiscal NOI` column carries a number in almost all of them. If
   * that column is a full year, the ~800 loans the corpus loses in the BANK
   * shelf are one mapping away.
   *
   * The test is NOT run on BANK, where there is nothing to contrast against. It
   * runs on the issuances that DO parse: there there is a dated window and both
   * columns at once, so we can ask whether they measure the same thing.
   *
   *   ratio ≈ 1   → fiscal measures the same period: substituting is clean
   *   consistent ratio ≠ 1 → fiscal is another year: recoverable, but it is
   *                          ANOTHER variable and has to be declared as such
   *   dispersed ratio → fiscal is not a full year and there is nothing to recover
   *
   * Four rows looked at by hand gave 0.98 / 1.09 / 1.09 / 1.04. That is not
   * evidence: it is the sample size I already got wrong today.
   */
  if (process.argv.includes("--noi-fiscal")) {
    const tables = extractFromHtml(html, { mergeHeaders: false, minRows: 2 });
    const num = (v: unknown) => {
      const s = String(v ?? "").replace(/[,$\s]/g, "");
      return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
    };
    const date = (v: unknown) => {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(v ?? "").trim());
      if (!m) return null;
      const yy = Number(m[3]);
      return new Date(yy < 100 ? 2000 + yy : yy, Number(m[1]) - 1, Number(m[2]));
    };

    for (const t of describeServicerHeaders(tables)) {
      const end = t.headers.findIndex((h) => /noi\s*end\s*date/i.test(h ?? ""));
      if (end < 3) continue;
      const [start, rec, fis] = [end - 1, end - 2, end - 3];
      if (!/fiscal/i.test(t.headers[fis] ?? "")) {
        console.log(
          `\n  \x1b[33mNOI block with an unexpected layout: [${fis}] = "${t.headers[fis]}"\x1b[0m`,
        );
        continue;
      }

      let fiscalOnly = 0;
      let both = 0;
      const ratios: number[] = [];
      const days: number[] = [];

      for (let r = t.headerRow + 1; r < t.rows.length; r++) {
        const f = t.rows[r] ?? [];
        const vf = num(f[fis]);
        const vr = num(f[rec]);
        const d0 = date(f[start]);
        const d1 = date(f[end]);

        if (vf && vf > 0 && (!vr || vr === 0 || !d0 || !d1)) fiscalOnly++;
        if (!vf || vf <= 0 || !vr || vr <= 0 || !d0 || !d1) continue;

        const span = (d1.getTime() - d0.getTime()) / 86_400_000;
        if (span < 60) continue;
        both++;
        days.push(span);
        ratios.push(vf / (vr * (365 / span)));
      }

      console.log(`\n  \x1b[1mfiscal vs period\x1b[0m`);
      console.log(
        `    ${both} rows with both columns · ${fiscalOnly} with fiscal but no period`,
      );
      if (both === 0) {
        console.log(`    \x1b[90mno comparable rows in this issuance\x1b[0m`);
        continue;
      }

      const orden = [...ratios].sort((a, b) => a - b);
      const q = (p: number) => orden[Math.min(orden.length - 1, Math.floor(p * orden.length))]!;
      const close = ratios.filter((x) => x > 0.9 && x < 1.1).length;
      const spanMed = [...days].sort((a, b) => a - b)[Math.floor(days.length / 2)]!;

      console.log(
        `    median window ${spanMed.toFixed(0)} days · ` +
          `fiscal/annualised ratio  p10 ${q(0.1).toFixed(2)}  median ${q(0.5).toFixed(2)}  p90 ${q(0.9).toFixed(2)}`,
      );
      console.log(
        `    within ±10%: ${close}/${both} \x1b[90m(${((close / both) * 100).toFixed(0)}%)\x1b[0m`,
      );
    }
    continue;
  }

  /**
   * `--parties`: who administers the trust, with the raw row alongside.
   *
   * It persists nothing. It is the step before storing the administrator:
   * looking at whether what the parser extracts matches what the document says,
   * across several trusts, before building an analysis on top.
   */
  if (process.argv.includes("--parties")) {
    const tables = extractFromHtml(html, { mergeHeaders: false, minRows: 1 });
    const partes = extractParties(tables);
    if (partes.length === 0) {
      console.log(`\n  \x1b[33mNo party found on the cover page\x1b[0m`);
    }
    for (const p of partes) {
      console.log(`\n  \x1b[1m${p.role}\x1b[0m  →  ${p.name}`);
      console.log(`    \x1b[90m${p.raw}\x1b[0m`);
    }
    continue;
  }

  const parsed = parseServicerReport(html);
  const d = parsed.diagnostics;

  /**
   * Delinquency, with its identity.
   *
   * `Months Delinquent` and `Paid Through Date` are the same fact by two routes:
   * the months of arrears have to be (period end − paid through) / 30.44.
   * Contrasting them is the only way to know whether the column says what we
   * think BEFORE building an analysis on top of it.
   *
   * In the Annex A this class of verification appeared after months. Here it is
   * before the first conclusion, which is the order that took a while to learn.
   */
  if (parsed.delinquency.length > 0) {
    const delinq = parsed.delinquency;
    const period = report.periodOfReport ? new Date(report.periodOfReport) : null;

    const inArrears = delinq.filter((x) => (x.monthsDelinquent ?? 0) > 0).length;
    const special = delinq.filter((x) => x.transferDate).length;
    const foreclosure = delinq.filter((x) => x.foreclosureDate || x.reoDate).length;

    console.log(
      `\n  \x1b[1mdelinquency\x1b[0m  ${delinq.length} rows · ` +
        `${inArrears} in arrears · ${special} in special servicing · ${foreclosure} in foreclosure/REO`,
    );

    /**
     * With few rows, show the raw datum instead of the count.
     *
     * "1 row with 0 arrears" has at least two causes —the table lists only
     * delinquent loans and there is one, or the column index is shifted— and the
     * count does not separate them. The values do.
     */
    for (const x of delinq.slice(0, 6)) {
      console.log(
        `    \x1b[90m${x.prosId.padEnd(8)} paid ${String(x.paidThrough ?? "—").padEnd(12)} ` +
          `months ${String(x.monthsDelinquent ?? "—").padStart(4)}  ` +
          `estado ${String(x.status ?? "—").slice(0, 14).padEnd(14)} ` +
          `transf ${String(x.transferDate ?? "—").padEnd(12)}\x1b[0m`,
      );
    }

    if (period) {
      let closing = 0;
      let comparable = 0;
      const deviations: string[] = [];

      for (const x of delinq) {
        if (x.monthsDelinquent === null || !x.paidThrough) continue;
        const days = (period.getTime() - new Date(x.paidThrough).getTime()) / 86_400_000;
        const expected = Math.max(0, Math.floor(days / 30.44));
        comparable++;
        if (Math.abs(expected - x.monthsDelinquent) <= 1) closing++;
        else if (deviations.length < 3) {
          deviations.push(
            `${x.prosId}: publishes ${x.monthsDelinquent}, paid through ${x.paidThrough} → ${expected}`,
          );
        }
      }

      if (comparable > 0) {
        const share = closing / comparable;
        const color = share >= 0.95 ? "\x1b[32m" : share >= 0.8 ? "\x1b[33m" : "\x1b[31m";
        console.log(
          `  identity months ≈ (period − paid through)/30:  ${color}${(share * 100).toFixed(0)}%\x1b[0m ` +
            `of ${comparable}`,
        );
        for (const dv of deviations) console.log(`    \x1b[90m${dv}\x1b[0m`);
      }
    }
  } else {
    /**
     * Zero delinquent loans has three causes and until now all three said "the
     * table was not found". With that message I treated as confirmed a parsing
     * bug that may not exist: an issuance with no delinquent loans produces the
     * same output.
     */
    const dd = parsed.diagnostics;
    if (dd.delinquencyTables === 0) {
      console.log(
        `\n  \x1b[33mdelinquency: the locator did NOT find the block\x1b[0m ` +
          `\x1b[90m(${dd.tablesScanned} tablas) — es formato\x1b[0m`,
      );
    } else if (dd.delinquencyDataRows === 0) {
      console.log(
        `\n  \x1b[90mmorosidad: bloque ubicado (${dd.delinquencyTables} tabla/s), ` +
          `no data rows — the issuance has no delinquent loans\x1b[0m`,
      );
    } else {
      console.log(
        `\n  \x1b[31mdelinquency: ${dd.delinquencyDataRows} data rows and none survived` +
          ` (${dd.delinquencyDropped} discarded) — it is the filter, not the format\x1b[0m`,
      );
    }
  }

  collected.push({ label: report.periodOfReport || report.filedAt, loans: parsed.loans });

  console.log(
    `\n  tables ${d.tablesMatched}/${d.tablesScanned} · rows ${d.rowsFound} · ` +
      `loans ${parsed.loans.length}`,
  );

  const dropped = d.droppedNoDates + d.droppedShortPeriod + d.droppedNoProsId;
  if (dropped > 0) {
    console.log(`  discarded: ${dropped}`);
    if (d.droppedNoDates > 0) {
      console.log(`    ${String(d.droppedNoDates).padStart(4)} with no NOI dates (not reported)`);
    }
    if (d.droppedShortPeriod > 0) {
      console.log(`    ${String(d.droppedShortPeriod).padStart(4)} with too short a period`);
    }
    if (d.droppedNoProsId > 0) {
      console.log(`    ${String(d.droppedNoProsId).padStart(4)} with no recognisable Pros ID`);
    }
  }

  const fullYear = parsed.loans.filter((l) => l.isFullYear).length;
  console.log(
    `  full year: ${fullYear}/${parsed.loans.length} ` +
      `\x1b[90m(${(d.fullYearShare * 100).toFixed(0)}%)\x1b[0m`,
  );

  const withTranches = parsed.loans.filter((l) => l.tranches > 1).length;
  if (withTranches > 0) {
    console.log(
      `  pari passu: ${withTranches} loan(s) with collapsed tranches ` +
        `\x1b[90m(${d.rowsFound - parsed.loans.length} extra rows if not deduplicated)\x1b[0m`,
    );
  }

  if (parsed.loans.length > 0) {
    console.log(`\n  First loans:`);
    console.log(`    loan       annualised NOI   period               days  tranches`);
    for (const l of parsed.loans.slice(0, 8)) {
      const money = l.annualizedNoi.toLocaleString("en-US", { maximumFractionDigits: 0 });
      console.log(
        `    ${l.loanId.padEnd(6)} ${money.padStart(16)}   ` +
          `${l.noiStart} a ${l.noiEnd}  ${String(l.periodDays).padStart(4)}  ` +
          `${String(l.tranches).padStart(4)}${l.isFullYear ? "" : "  \x1b[90mextrapolado\x1b[0m"}`,
      );
    }
    if (parsed.loans.length > 8) {
      console.log(`    \x1b[90m... and ${parsed.loans.length - 8} more\x1b[0m`);
    }
  }

  for (const issue of parsed.issues) {
    console.log(`\n  \x1b[33m⚠ ${issue}\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// Combinado
// ---------------------------------------------------------------------------

/**
 * The selection always runs, even with a single report.
 *
 * This used to sit behind `collected.length > 1` and the single-report path
 * showed the raw loans —extrapolated ones included— without applying the
 * full-year policy. That is: the route we are going to use in production was
 * precisely the one that skipped the filter.
 */
{
  const merged = mergeServicerReports(collected);
  const fullYear = merged.loans.filter((l) => l.isFullYear).length;

  console.log(`\n${"═".repeat(78)}`);
// With --headers nothing is parsed, so there is nothing to combine.
if (
  process.argv.includes("--headers") ||
  process.argv.includes("--noi-fiscal") ||
  process.argv.includes("--parties")
) process.exit(0);

  console.log(collected.length > 1 ? `Combining ${collected.length} reports` : "Selection");
  console.log(`${"═".repeat(78)}\n`);

  if (collected.length > 1) {
    console.log(`  period        loans       full year      new`);
    for (const r of merged.perReport) {
      console.log(
        `  ${r.label.padEnd(12)} ${String(r.loans).padStart(9)} ${String(r.fullYear).padStart(14)} ` +
          `${String(r.newLoans).padStart(8)}`,
      );
    }

    const bestSingle = Math.max(...merged.perReport.map((r) => r.loans));
    const bestSingleFY = Math.max(...merged.perReport.map((r) => r.fullYear));

    console.log(`\n  combinado    ${String(merged.loans.length).padStart(9)} ${String(fullYear).padStart(14)}`);
    console.log(
      `\n  \x1b[32mCoverage: ${bestSingle} → ${merged.loans.length} loans\x1b[0m ` +
        `\x1b[90m(+${merged.loans.length - bestSingle})\x1b[0m`,
    );
    console.log(
      `  \x1b[32mFull year: ${bestSingleFY} → ${fullYear}\x1b[0m ` +
        `\x1b[90m(+${fullYear - bestSingleFY})\x1b[0m`,
    );

    const bestMonth = merged.perReport.reduce((a, b) => (b.fullYear > a.fullYear ? b : a));
    if (bestMonth.fullYear >= fullYear * 0.9) {
      console.log(
        `\n  \x1b[33mA single report is enough:\x1b[0m ${bestMonth.label} carries ${bestMonth.fullYear} full years`,
      );
      console.log(
        `  of the ${fullYear} in the combined set. Downloading six months per trust does not pay.`,
      );
    }
  } else {
    const r = merged.perReport[0]!;
    console.log(`  report from ${r.label}: ${r.loans} loans with NOI, ${r.fullYear} full-year`);
    console.log(
      `\n  \x1b[90mWithout a second report there is no cross-check. To verify that\x1b[0m`,
    );
    console.log(`  \x1b[90mthis month is not lying:  npm run harvest:servicer -- ${cikArg} --months 6\x1b[0m`);
  }

  if (merged.conflicts.length > 0) {
    console.log(`\n  \x1b[31mCross-check: ${merged.conflicts.length} loan(s) incompatible between reports\x1b[0m\n`);
    console.log(`    loan    chosen         from         other          from        ratio`);
    for (const c of merged.conflicts.slice(0, 6)) {
      const f = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
      console.log(
        `    ${c.loanId.padEnd(6)} ${f(c.chosen).padStart(12)} ${String(c.chosenDays).padStart(4)}d  ` +
          `${f(c.other).padStart(12)} ${String(c.otherDays).padStart(4)}d   ${c.ratio.toFixed(1)}x`,
      );
    }
    console.log(
      `\n    \x1b[90mThe usual suspect is the extrapolated one: a partial period that\x1b[0m`,
    );
    console.log(
      `    \x1b[90mwas not partial, or a half year with a non-recurring item inside.\x1b[0m`,
    );
  } else if (collected.length > 1) {
    console.log(`\n  \x1b[32mCross-check with no conflicts\x1b[0m \x1b[90m(no loan differs >50% between months)\x1b[0m`);
  }

  if (merged.excludedExtrapolated.length > 0) {
    console.log(
      `\n  \x1b[90mExcluded for having no full-year measurement: ` +
        `${merged.excludedExtrapolated.length} loan(s) (${merged.excludedExtrapolated.join(", ")})\x1b[0m`,
    );
  }
  console.log(
    `\n  \x1b[1mUsable: ${merged.loans.length}\x1b[0m \x1b[90m— only measured full-year NOI, no extrapolation.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mPeriods are not averaged: for each loan a single observation is chosen.\x1b[0m\n`,
  );
}

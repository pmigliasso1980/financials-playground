/**
 * Diagnóstico de los trusts que no se pudieron cosechar.
 *
 *   npm run harvest:diagnose -- --cik 2109197,2138709,2145996
 *   npm run harvest:diagnose -- --failed
 *
 * Con `--failed` toma los CIKs que aparecieron en la búsqueda pero no están en
 * el corpus, o sea los que fallaron en el último lote.
 *
 * PARA QUÉ
 *
 * En una corrida de 100 trusts fallaron 29 con "sin Annex A identificable". Eso
 * puede significar dos cosas muy distintas:
 *
 *   a) el deal genuinamente no publica un Annex A tabular
 *   b) lo publica con un nombre que nuestros patrones no reconocen
 *
 * La diferencia importa: (a) es un límite del universo, (b) es trabajo pendiente
 * y un tercio del corpus. Este comando muestra los documentos grandes de cada
 * trust fallido para poder distinguirlas de un vistazo.
 */

import { EdgarError } from "./edgar/client.js";
import { findCmbsTrusts, listRecentFilings, scoreAnnexFiling } from "./edgar/discover.js";
import { closePool, ping, query } from "../db/client.js";

const args = process.argv.slice(2);
const cikArg = args.includes("--cik") ? args[args.indexOf("--cik") + 1] : null;
const useFailed = args.includes("--failed");

let ciks: string[] = [];

if (cikArg) {
  ciks = cikArg.split(",").map((c) => c.trim()).filter(Boolean);
} else if (useFailed) {
  const health = await ping();
  if (!health.ok) {
    console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
    process.exit(1);
  }
  const { rows } = await query<{ cik: string }>("SELECT DISTINCT cik FROM corpus.filings");
  const inCorpus = new Set(rows.map((r) => r.cik));

  console.log("\nBuscando trusts para comparar con el corpus...");
  const found = new Map<string, string>();
  for (const q of [
    '"Commercial Mortgage Trust"',
    '"Mortgage Trust" "ANNEX A-1"',
    '"Commercial Mortgage Pass-Through Certificates"',
  ]) {
    for (const y of [2026, 2025, 2024]) {
      try {
        const trusts = await findCmbsTrusts({
          query: q, limit: 100,
          dateFrom: `${y}-01-01`, dateTo: `${y}-12-31`,
        });
        for (const t of trusts) if (!found.has(t.cik)) found.set(t.cik, t.name);
      } catch { /* seguir */ }
    }
  }
  ciks = [...found.keys()].filter((c) => !inCorpus.has(c));
  console.log(`  ${found.size} encontrados · ${ciks.length} fuera del corpus\n`);
} else {
  console.log(`
Diagnóstico de trusts sin Annex A identificable.

  npm run harvest:diagnose -- --cik 2109197,2138709
  npm run harvest:diagnose -- --failed
`);
  process.exit(0);
}

if (ciks.length === 0) {
  console.log("  Nada que diagnosticar.\n");
  await closePool();
  process.exit(0);
}

// ---------------------------------------------------------------------------

interface Finding {
  cik: string;
  company: string;
  /** El mejor candidato según el scoring actual. */
  best: { document: string; description: string; size: number; score: number } | null;
  /** Documentos grandes que podrían ser el Annex y no llegan al umbral. */
  candidates: Array<{ document: string; description: string; size: number; score: number }>;
  /** Si no hay ningún documento grande, el deal probablemente no publica Annex. */
  hasLargeDocuments: boolean;
}

const findings: Finding[] = [];

for (const [i, cik] of ciks.entries()) {
  process.stdout.write(`\r  analizando ${i + 1}/${ciks.length}...`);

  try {
    const filings = await listRecentFilings(cik, { limit: 60 });
    if (filings.length === 0) continue;

    const company = "";
    const scored = filings
      .filter((f) => /^(FWP|424B[0-9]?|424H)$/i.test(f.form))
      .map((f) => ({
        document: f.document,
        description: f.description,
        size: f.sizeBytes,
        score: scoreAnnexFiling({
          form: f.form,
          documentName: f.document,
          documentDescription: f.description,
          sizeBytes: f.sizeBytes,
        }),
      }))
      .sort((a, b) => b.score - a.score || b.size - a.size);

    const best = scored.find((s) => s.score >= 0.5) ?? null;
    const large = scored.filter((s) => s.size > 1_000_000 && s.score < 0.5);

    findings.push({
      cik,
      company,
      best,
      candidates: large.slice(0, 4),
      hasLargeDocuments: large.length > 0,
    });
  } catch (err) {
    const reason = err instanceof EdgarError ? `EDGAR ${err.status}` : String(err).slice(0, 40);
    findings.push({ cik, company: `(${reason})`, best: null, candidates: [], hasLargeDocuments: false });
  }
}

process.stdout.write("\r" + " ".repeat(40) + "\r");

// ---------------------------------------------------------------------------

const nowResolved = findings.filter((f) => f.best);
const withCandidates = findings.filter((f) => !f.best && f.hasLargeDocuments);
const genuinelyEmpty = findings.filter((f) => !f.best && !f.hasLargeDocuments);

console.log(`\n${"═".repeat(76)}`);
console.log(`Diagnóstico · ${findings.length} trusts`);
console.log(`${"═".repeat(76)}\n`);

if (nowResolved.length > 0) {
  console.log(
    `\x1b[32m${nowResolved.length} ya se resuelven\x1b[0m con el scoring actual — recosechá con harvest:batch\n`,
  );
  for (const f of nowResolved.slice(0, 10)) {
    console.log(
      `  cik ${f.cik.padEnd(9)} ${f.best!.document.padEnd(30)} ${fmtBytes(f.best!.size).padStart(9)}  score ${f.best!.score.toFixed(2)}`,
    );
  }
  if (nowResolved.length > 10) console.log(`  \x1b[90m… y ${nowResolved.length - 10} más\x1b[0m`);
  console.log();
}

if (withCandidates.length > 0) {
  console.log(
    `\x1b[33m${withCandidates.length} tienen documentos grandes sin reconocer\x1b[0m — probablemente sea formato, no ausencia\n`,
  );
  for (const f of withCandidates.slice(0, 15)) {
    console.log(`  cik ${f.cik}`);
    for (const c of f.candidates) {
      console.log(
        `      ${c.document.padEnd(32)} ${fmtBytes(c.size).padStart(9)}  score ${c.score.toFixed(2)}` +
          (c.description && c.description !== "FWP" ? `  \x1b[90m(${c.description})\x1b[0m` : ""),
      );
    }
  }
  if (withCandidates.length > 15) console.log(`\n  \x1b[90m… y ${withCandidates.length - 15} más\x1b[0m`);

  // Los sufijos repetidos revelan la convención de nombres de cada emisor.
  const suffixes = new Map<string, number>();
  for (const f of withCandidates) {
    for (const c of f.candidates) {
      const m = /[-_]([a-z0-9]+)\.[a-z]+$/.exec(c.document.toLowerCase());
      if (m?.[1]) suffixes.set(m[1], (suffixes.get(m[1]) ?? 0) + 1);
    }
  }
  const top = [...suffixes].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length > 0) {
    console.log(`\n  Sufijos más frecuentes entre los no reconocidos:`);
    for (const [suffix, count] of top) {
      console.log(`    ${String(count).padStart(3)}×  …-${suffix}`);
    }
    console.log(
      `\n  \x1b[90mSi alguno corresponde al Annex A, agregalo a scoreAnnexFiling()\x1b[0m`,
    );
    console.log(`  \x1b[90men harvest/edgar/discover.ts y volvé a correr el lote.\x1b[0m`);
  }
  console.log();
}

if (genuinelyEmpty.length > 0) {
  console.log(
    `\x1b[90m${genuinelyEmpty.length} sin documentos grandes\x1b[0m — probablemente no publican Annex A tabular\n`,
  );
  console.log(`  ${genuinelyEmpty.map((f) => f.cik).join(", ")}\n`);
}

console.log(`${"─".repeat(76)}`);
console.log(
  `\n  \x1b[90mLos del segundo grupo son trabajo pendiente; los del tercero, límite del universo.\x1b[0m\n`,
);

await closePool();

function fmtBytes(n: number): string {
  if (n > 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n > 1000) return `${Math.round(n / 1000)} KB`;
  return `${n} B`;
}

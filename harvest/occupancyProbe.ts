/**
 * ¿Por qué 7 emisiones de 2026 no traen ocupación?
 *
 *   npm run harvest:occupancy
 *   npm run harvest:occupancy -- --rotas 4 --sanas 2
 *
 * QUÉ YA SABEMOS, Y QUÉ FALTA
 *
 * `db:benchmark --auditoria` dejó el diagnóstico cerrado por el lado de los
 * datos: dentro de las emisiones que traen la columna, los ocho tipos de
 * propiedad tienen ocupación en el 100% de los préstamos, dispersión cero. No
 * es que el dato no aplique a ciertos activos — es formato del Annex A.
 *
 * Lo que falta es el encabezado concreto que no reconocemos. Esta sonda lo
 * busca corriendo el MISMO pipeline que `harvest:batch` sobre una emisión rota
 * y una sana, y poniendo los encabezados uno al lado del otro.
 *
 * POR QUÉ NO ALCANZA CON `harvest:inspect`
 *
 * Ese inspector trabaja sobre fixtures ya capturados, y estas siete no están
 * entre ellos. Capturarlas primero sería un paso de más para una pregunta que
 * se contesta mirando una fila.
 *
 * NO ESCRIBE NADA. Es diagnóstico: baja, mira y reporta.
 *
 * LA PISTA QUE HAY QUE EXPLICAR
 *
 * Seis de las siete rotas tienen ocupación en 1-6 préstamos, no en cero. Un
 * patrón que no matchea daría cero limpio. Que haya un puñado sugiere que la
 * columna correcta no se reconoce y esos pocos valores entran por OTRA columna
 * — probablemente una de un bloque distinto que sí matchea por casualidad.
 *
 * Si eso es cierto, los 688 valores que hoy tenemos por buenos incluyen algunos
 * que no son ocupación, y el problema no es solo de cobertura.
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
const N_ROTAS = flag("rotas", 3);
const N_SANAS = flag("sanas", 2);

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
 * Las emisiones salen de la base, no de una lista escrita a mano.
 *
 * Ya nos pasó en `harvest:history`: ocho CIKs inventados de memoria, los ocho
 * fallaron. Si hubiera acertado dos, el piloto habría corrido sobre esos dos
 * sin que nadie lo notara.
 */
const { rows: emisiones } = await query<{
  cik: string; accession: string; nombre: string; pool: string; con_occ: string;
}>(
  `SELECT f.cik, f.accession, f.company_name AS nombre,
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

const cobertura = (e: (typeof emisiones)[number]) =>
  Number(e.con_occ) / Math.max(1, Number(e.pool));

const rotas = emisiones.filter((e) => cobertura(e) < 0.5).slice(0, N_ROTAS);
const sanas = emisiones.filter((e) => cobertura(e) > 0.95).slice(-N_SANAS);

if (rotas.length === 0) {
  console.log(`\n  Ninguna emisión con cobertura de ocupación baja. Nada que diagnosticar.\n`);
  process.exit(0);
}

/** La especificación que estamos auditando, tal como la ve el mapeo. */
const SPEC = METRIC_SPECS.find((m) => m.key === "occupancy")!;

/** Amplio a propósito: queremos ver también lo que el mapeo NO considera. */
const SOSPECHOSO = /occ|physic|lease|vacan|utiliz/i;

console.log(`\n${"═".repeat(78)}`);
console.log("¿Qué encabezado de ocupación no reconocemos?");
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  Patrones actuales: ${SPEC.patterns.map((p) => p.source).join("  ·  ")}\x1b[0m`,
);
console.log(
  `\x1b[90m  Excluye: ${(SPEC.exclude ?? []).map((p) => p.source).join("  ·  ")}\x1b[0m\n`,
);

/**
 * Por qué un encabezado no llegó a ocupación.
 *
 * Tres desenlaces distintos que "no matchea" confunde en uno:
 *   · ningún patrón lo toca         → falta un patrón
 *   · un exclude lo mata            → el exclude es demasiado ancho
 *   · matchea pero pierde la puja   → otra métrica se lo llevó, y saber cuál
 *                                     importa porque ahí está el valor mal
 *                                     etiquetado
 */
function porQue(header: string, headers: string[]): string {
  const excl = (SPEC.exclude ?? []).find((r) => r.test(header));
  const pega = SPEC.patterns.find((r) => r.test(header));
  const score = scoreHeader(header, SPEC);
  const { matches } = mapColumns(headers);
  const asignado = matches.find((m) => m.header === header);

  if (asignado?.metric.key === "occupancy") return `\x1b[32mmapea a occupancy\x1b[0m`;
  if (excl) return `\x1b[31mlo mata el exclude /${excl.source}/\x1b[0m`;
  if (!pega) return `\x1b[33mningún patrón lo toca\x1b[0m`;
  if (asignado) {
    return `\x1b[31mse lo lleva ${asignado.metric.key}\x1b[0m \x1b[90m(occ: ${score.toFixed(2)})\x1b[0m`;
  }
  return `\x1b[33mmatchea (${score.toFixed(2)}) pero no se asigna\x1b[0m`;
}

async function mirar(e: (typeof emisiones)[number], etiqueta: string) {
  const cob = cobertura(e);
  console.log(`${"─".repeat(78)}`);
  console.log(
    `\x1b[1m${e.nombre.slice(0, 50)}\x1b[0m  \x1b[90m${etiqueta} · ${e.con_occ} de ${e.pool} (${(cob * 100).toFixed(0)}%)\x1b[0m`,
  );

  try {
    const picks = await findAnnexFilings(e.cik, { max: 1 });
    if (picks.length === 0) {
      console.log(`  \x1b[33msin Annex A en submissions\x1b[0m\n`);
      return;
    }
    const { filing } = picks[0]!;

    /**
     * `findAnnexFilings` devuelve el más reciente del CIK, que puede no ser el
     * mismo filing que cosechamos. Si difiere, lo decimos: comparar encabezados
     * de otro documento sería exactamente el tipo de error silencioso que este
     * proyecto ya pagó dos veces.
     */
    if (filing.accession.replace(/-/g, "") !== e.accession.replace(/-/g, "")) {
      console.log(
        `  \x1b[33m⚠ el Annex más reciente (${filing.accession}) no es el cosechado (${e.accession})\x1b[0m`,
      );
    }

    const buffer = await fetchBuffer(filing.documentUrl, { timeoutMs: 180_000 });
    const tables = extractTables(buffer, filing.documentName);
    const { tables: annexTables } = attachContinuationTables(tables, (rows) =>
      findHeaderRow(rows),
    );

    if (annexTables.length === 0) {
      console.log(`  \x1b[33msin tablas de Annex reconocibles\x1b[0m\n`);
      return;
    }

    const vistos = new Set<string>();
    let encontrados = 0;

    for (const t of annexTables) {
      const headers = (t.rows[t.headerRowIndex] ?? []).map((c) =>
        c === null || c === undefined ? "" : String(c),
      );
      for (const h of headers) {
        const limpio = h.replace(/\s+/g, " ").trim();
        if (!limpio || !SOSPECHOSO.test(limpio) || vistos.has(limpio)) continue;
        vistos.add(limpio);
        encontrados++;
        console.log(`  \x1b[36m"${limpio.slice(0, 52)}"\x1b[0m`);
        console.log(`      ${porQue(h, headers)}`);
      }
    }

    if (encontrados === 0) {
      console.log(
        `  \x1b[31mNingún encabezado menciona ocupación en todo el Annex.\x1b[0m`,
      );
      console.log(
        `  \x1b[90mSi es así, el dato no está en el documento y no hay parser que lo arregle.\x1b[0m`,
      );
    }
    console.log();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  \x1b[31m${msg.slice(0, 60)}\x1b[0m\n`);
  }
}

for (const e of rotas) await mirar(e, "ROTA");
for (const e of sanas) await mirar(e, "sana");

console.log(`${"═".repeat(78)}`);
console.log(
  `\n  \x1b[90mEl encabezado que aparece en las sanas y falta —o cae por otra razón— en\x1b[0m`,
);
console.log(
  `  \x1b[90mlas rotas es el arreglo. Si en las rotas no hay ningún encabezado de\x1b[0m`,
);
console.log(
  `  \x1b[90mocupación, el dato no existe en el documento: la métrica queda con\x1b[0m`,
);
console.log(`  \x1b[90mcobertura parcial declarada, no con un bug abierto.\x1b[0m\n`);

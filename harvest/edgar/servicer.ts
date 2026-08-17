/**
 * Descubrimiento de reportes del servicer (10-D) en EDGAR.
 *
 * QUÉ ES ESTO Y POR QUÉ IMPORTA
 *
 * Todo lo que cosechamos hasta ahora sale del Annex A, que es una foto al cierre:
 * dice qué prometió el suscriptor. Nunca dice qué pasó después. Con eso se puede
 * medir cuánto se despegó la suscripción del histórico, pero no si estuvo
 * equivocada.
 *
 * El 10-D es el reporte periódico que los trusts de CMBS presentan todos los
 * meses. Su EX-99.1 es el informe del certificate administrator, y adentro trae
 * una tabla llamada "Mortgage Loan Detail (Part 2)" con NOI a nivel préstamo
 * posterior al cierre. Eso es lo que mide Griffin.
 *
 * LO QUE SE VIO EN EL DATO REAL
 *
 * Benchmark 2024-V7 (CIK 2016841), 10-D de julio 2026, EX-99.1:
 *
 *   | Pros ID | Most Recent Fiscal NOI | Most Recent NOI | NOI Start | NOI End |
 *   | 1A-1    |          21,466,533.53 |    6,590,191.56 | 01/01/26  | 03/31/26 |
 *   | 4A-2    |          12,379,213.40 |   12,854,060.24 | 04/01/25  | 03/31/26 |
 *   | 5       |           5,065,434.64 |            0.00 |    --     |    --    |
 *
 * Cuatro trampas, todas visibles en esas tres filas:
 *
 *   1. "Most Recent NOI" NO está anualizado. La fila 1A-1 cubre un trimestre
 *      (01/01 a 31/03) y la 4A-2 cubre doce meses. Sin mirar las fechas, comparar
 *      esos dos números es comparar un trimestre contra un año.
 *
 *   2. 0.00 con fechas "--" significa NO REPORTADO, no NOI cero. Tomarlo como
 *      cero hunde cualquier promedio. Es el mismo error que las columnas "N/A"
 *      del Annex A.
 *
 *   3. Los pari passu se repiten. 1A-1, 1A-4 y 1A-5 son tramos del mismo
 *      préstamo y traen el NOI de la propiedad entera, repetido. Sumar sin
 *      deduplicar cuenta la misma propiedad tres veces —de hecho el total de
 *      "Fiscal NOI" del reporte da 438M contra un trust de 821M, que sería un
 *      debt yield del 53% si uno se lo creyera.
 *
 *   4. "Most Recent Fiscal NOI" no tiene columna de fecha propia. No se sabe qué
 *      ejercicio cubre. Por eso preferimos "Most Recent NOI", que sí viene
 *      fechado, aunque haya que anualizarlo.
 *
 * El "Pros ID" es el número de préstamo del prospecto, o sea el Loan ID del
 * Annex A con un sufijo de tramo. Esa es la llave de join que hace posible todo
 * esto.
 *
 * FORMATO
 *
 * Los dos trusts que inspeccionamos —Benchmark 2024-V7 y BANK5 2024-5YR5— usan
 * la misma plantilla de Computershare, 27 páginas, con "Mortgage Loan Detail
 * (Part 2)" en la página 16. No asumimos que sea universal: igual que con el
 * Annex A, va a haber familias de formato. Por eso la tabla se localiza por
 * contenido de encabezado y no por posición.
 */

import { fetchJson, type FetchOptions } from "./client.js";
import { archiveBase } from "./discover.js";

const SUBMISSIONS = "https://data.sec.gov/submissions";

export interface ServicerReportRef {
  cik: string;
  accession: string;
  companyName: string;
  /** Fecha de presentación del 10-D. */
  filedAt: string;
  /** Período que reporta (distribution date). */
  periodOfReport: string;
  /** Documento EX-99.1 con el informe del servicer. */
  documentName: string;
  documentUrl: string;
  sizeBytes: number;
}

interface SubmissionsResponse {
  name?: string;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      form?: string[];
      filingDate?: string[];
      reportDate?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
      size?: number[];
    };
  };
}

/** Listado de archivos de un filing, para ubicar el exhibit. */
interface DirectoryListing {
  directory?: {
    item?: Array<{ name?: string; size?: string; type?: string }>;
  };
}

/**
 * Puntúa un archivo del filing como candidato a informe del servicer.
 *
 * El nombre es la señal primaria, igual que con el Annex A. Los filers usan
 * "ex991", "ex-99_1" y "ex99-1" indistintamente.
 */
export function scoreServicerExhibit(f: { name: string; sizeBytes: number }): number {
  const name = f.name.toLowerCase();

  if (!/\.(htm|html|txt)$/.test(name)) return 0;
  // El documento principal del 10-D es la carátula, no el informe.
  if (/_10-?d[-_.]/.test(name)) return 0;

  let score = 0;
  if (/ex-?99[._-]?1(?![0-9])/.test(name)) score += 0.6;
  else if (/ex-?99/.test(name)) score += 0.4;
  else if (/exh?[-_]?99/.test(name)) score += 0.35;

  if (score === 0) return 0;

  // Un informe mensual completo pesa decenas de KB. Los certificados de
  // cumplimiento que también van como EX-99 pesan poco.
  if (f.sizeBytes > 200_000) score += 0.3;
  else if (f.sizeBytes > 40_000) score += 0.2;
  else if (f.sizeBytes < 8_000) score -= 0.3;

  return Math.max(0, Math.min(1, score));
}

/**
 * Encuentra los 10-D de un trust y ubica el EX-99.1 de cada uno.
 *
 * La API de submissions da el 10-D pero no sus exhibits, así que hay que pedir
 * el índice de cada filing. Para no gastar una request por mes de vida del
 * trust, `pickMonths` selecciona primero y recién después se resuelven los
 * exhibits de los elegidos.
 */
export async function findServicerReports(
  cik: string,
  opts: {
    /** Solo filings presentados desde esta fecha (YYYY-MM-DD). */
    since?: string;
    /** Cuántos reportes resolver. Default 1. */
    max?: number;
    /**
     * Meses de preferencia (1-12), en orden. Los filings cuyo período caiga en
     * el primero de la lista se resuelven antes que los demás.
     *
     * Esto sale del dato, no de una intuición. Sobre Benchmark 2024-V7 medimos
     * cuántos préstamos traen NOI de año completo según el mes del informe:
     *
     *   febrero  8 · marzo 12 · ABRIL 21 · mayo 0 · junio 1 · julio 2
     *
     * El motivo es el ciclo contable: los prestatarios entregan el estado
     * operativo anual entre 90 y 120 días después de cerrar el ejercicio, así
     * que en abril está consolidado. En mayo el servicer blanquea los campos
     * para arrancar el ciclo nuevo —34 filas, ninguna con fechas— y de ahí en
     * adelante solo hay parciales del año en curso.
     *
     * Bajar seis meses por trust no compensa: abril solo ya trae 21 de los 22
     * años completos que da combinar todo.
     */
    preferMonths?: number[];
    minScore?: number;
    fetchOpts?: FetchOptions;
  } = {},
): Promise<ServicerReportRef[]> {
  const max = opts.max ?? 1;
  const preferMonths = opts.preferMonths ?? [4, 3, 5, 2];
  const minScore = opts.minScore ?? 0.5;
  const padded = String(Number(cik)).padStart(10, "0");

  const data = await fetchJson<SubmissionsResponse>(
    `${SUBMISSIONS}/CIK${padded}.json`,
    opts.fetchOpts,
  );

  const recent = data.filings?.recent;
  if (!recent?.accessionNumber) return [];

  const companyName = data.name ?? "(desconocido)";
  const candidates: Array<{
    accession: string; filedAt: string; periodOfReport: string;
  }> = [];

  for (let i = 0; i < recent.accessionNumber.length; i++) {
    // 10-D/A son correcciones; se aceptan porque suelen reemplazar datos malos.
    if (!/^10-D/.test(recent.form?.[i] ?? "")) continue;

    const filedAt = recent.filingDate?.[i] ?? "";
    if (opts.since && filedAt < opts.since) continue;

    candidates.push({
      accession: recent.accessionNumber[i]!,
      filedAt,
      periodOfReport: recent.reportDate?.[i] ?? "",
    });
  }

  /**
   * Orden: primero por preferencia de mes, después el más reciente.
   *
   * Un informe de abril de este año vale más que uno de abril del anterior, y
   * los dos valen más que cualquier julio.
   */
  const monthRank = (periodOrFiled: string): number => {
    const m = Number(periodOrFiled.slice(5, 7));
    const idx = preferMonths.indexOf(m);
    return idx === -1 ? preferMonths.length : idx;
  };

  candidates.sort((a, b) => {
    const ra = monthRank(a.periodOfReport || a.filedAt);
    const rb = monthRank(b.periodOfReport || b.filedAt);
    if (ra !== rb) return ra - rb;
    return b.filedAt.localeCompare(a.filedAt);
  });

  const picks: ServicerReportRef[] = [];
  for (const c of candidates) {
    if (picks.length >= max) break;

    const base = archiveBase(cik, c.accession);
    let listing: DirectoryListing;
    try {
      listing = await fetchJson<DirectoryListing>(`${base}/index.json`, opts.fetchOpts);
    } catch {
      continue;
    }

    const items = listing.directory?.item ?? [];
    let best: { name: string; sizeBytes: number; score: number } | null = null;
    for (const item of items) {
      const name = item.name ?? "";
      const sizeBytes = Number(item.size ?? 0);
      const score = scoreServicerExhibit({ name, sizeBytes });
      if (score >= minScore && (!best || score > best.score)) {
        best = { name, sizeBytes, score };
      }
    }

    if (!best) continue;

    picks.push({
      cik: String(Number(cik)),
      accession: c.accession,
      companyName,
      filedAt: c.filedAt,
      periodOfReport: c.periodOfReport,
      documentName: best.name,
      documentUrl: `${base}/${best.name}`,
      sizeBytes: best.sizeBytes,
    });
  }

  return picks;
}

/**
 * Normaliza un "Pros ID" del servicer al Loan ID del Annex A.
 *
 *   "1A-1"      → "1"     (tramo pari passu del préstamo 1)
 *   "14A-3-C1"  → "14"
 *   "20A-1-3"   → "20"
 *   "27"        → "27"
 *
 * El Annex A numera préstamos con enteros; el servicer les agrega el sufijo del
 * tramo. Como los tramos del mismo préstamo reportan el NOI de la propiedad
 * entera repetido, quedarse con el entero inicial además deduplica.
 */
export function normalizeProsId(prosId: string): string | null {
  const m = /^\s*(\d+)/.exec(prosId);
  return m ? m[1]! : null;
}

/** True si el Pros ID trae sufijo de tramo (o sea, hay pari passu). */
export function hasTrancheSuffix(prosId: string): boolean {
  return /^\s*\d+\s*[A-Za-z-]/.test(prosId);
}

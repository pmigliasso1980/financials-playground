/**
 * Descubrimiento de Annex A en EDGAR.
 *
 * CÓMO SE LLEGÓ A ESTE DISEÑO
 *
 * La primera versión buscaba adjuntos .xlsx dentro del prospecto, porque los
 * filings de CMBS de los 2000 publicaban el Annex A como planilla Excel.
 * Contra filings modernos eso devuelve cero: hoy el Annex A es un **filing FWP
 * propio** cuyo documento principal es un .htm de varios MB con tablas.
 *
 * Ejemplo real (Wells Fargo Commercial Mortgage Trust 2025-C64, CIK 2053102):
 *
 *   accession 0001539497-25-000290
 *   form      FWP
 *   documento n4801_x5-annexa1.htm
 *   descripción "ANNEX A-1"
 *   tamaño    4.088.848 bytes
 *
 * Los otros FWP del mismo deal pesan entre 8 KB y 25 KB. El tamaño es la señal
 * más confiable, porque el nombre y la descripción varían entre emisores.
 *
 * Por eso el descubrimiento va por la API de submissions (data.sec.gov), que
 * devuelve forma, documento, descripción y tamaño de cada filing — todo lo que
 * hace falta para elegir, sin bajar nada.
 */

import { fetchJson, type FetchOptions } from "./client.js";

const SUBMISSIONS = "https://data.sec.gov/submissions";
const FTS = "https://efts.sec.gov/LATEST/search-index";

export interface FilingRef {
  cik: string;
  accession: string;
  companyName: string;
  formType: string;
  filedAt: string;
  /** Documento principal del filing. */
  documentName: string;
  documentDescription: string;
  sizeBytes: number;
  /** URL directa al documento. */
  documentUrl: string;
  baseUrl: string;
}

export function archiveBase(cik: string, accession: string): string {
  const bare = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}`;
}

// ---------------------------------------------------------------------------
// Paso 1: encontrar trusts de CMBS
// ---------------------------------------------------------------------------

interface FtsResponse {
  hits?: {
    hits?: Array<{
      _id?: string;
      _source?: { ciks?: string[]; display_names?: string[] };
    }>;
  };
}

/**
 * Busca CIKs de trusts de CMBS por texto completo.
 *
 * Devuelve CIKs únicos, no filings: el filing correcto se elige después con la
 * API de submissions, que da mucha más información.
 */
export async function findCmbsTrusts(opts: {
  query?: string;
  limit?: number;
  /** Ventana de fechas, para llegar a emisiones más viejas. */
  dateFrom?: string;
  dateTo?: string;
  fetchOpts?: FetchOptions;
} = {}): Promise<Array<{ cik: string; name: string }>> {
  const query = opts.query ?? '"Commercial Mortgage Trust"';
  const limit = opts.limit ?? 10;

  const seen = new Map<string, string>();

  /**
   * La búsqueda de EDGAR devuelve 10 resultados por página. Para juntar
   * decenas de trusts hay que paginar con `from`.
   *
   * El tope de 100 no es arbitrario: EDGAR corta ahí para una misma consulta.
   * Para ir más lejos hay que variar la consulta o la ventana de fechas, que es
   * lo que hace el comando de lote.
   */
  const MAX_OFFSET = 100;
  const PAGE = 10;

  for (let from = 0; from < MAX_OFFSET && seen.size < limit; from += PAGE) {
    const params = new URLSearchParams({ q: query, forms: "FWP" });
    if (from > 0) params.set("from", String(from));
    if (opts.dateFrom) params.set("startdt", opts.dateFrom);
    if (opts.dateTo) params.set("enddt", opts.dateTo);

    let data: FtsResponse;
    try {
      data = await fetchJson<FtsResponse>(`${FTS}?${params.toString()}`, opts.fetchOpts);
    } catch (err) {
      /**
       * Una página que falla a mitad de camino no invalida las anteriores: nos
       * quedamos con lo que juntamos. Pero si falla la PRIMERA, no hay nada, y
       * devolver una lista vacía convierte un rechazo de la SEC en algo
       * indistinguible de "no existen trusts".
       *
       * Eso pasó de verdad: después de varias corridas seguidas del lote, EDGAR
       * empezó a rechazar y el batch reportó "Se encontraron 0 de 100", que
       * manda a revisar la consulta cuando el problema es el rate limit. Un
       * fallo que se ve igual que una ausencia es el peor tipo de fallo, y es
       * el mismo error que ya nos costó iteraciones del lado de los datos.
       */
      if (seen.size === 0) {
        /**
         * El error se propaga tal cual, sin agregarle diagnóstico.
         *
         * La primera versión de esto adjuntaba un párrafo explicando el límite
         * de pedidos de la SEC, porque era mi hipótesis. La causa real era otra
         * —faltaba SEC_USER_AGENT— y el mensaje verdadero quedó sepultado bajo
         * mi conjetura, repetida quince veces.
         *
         * Un error que ya se explica solo no necesita ayuda. Adivinar la causa
         * en el mensaje es peor que no decir nada: manda a buscar donde no está.
         */
        throw err;
      }
      break;
    }

    const hits = data.hits?.hits ?? [];
    if (hits.length === 0) break;

    const before = seen.size;
    for (const hit of hits) {
      const cik = hit._source?.ciks?.[0];
      if (!cik) continue;
      const normalized = String(Number(cik));
      if (!seen.has(normalized)) {
        seen.set(normalized, hit._source?.display_names?.[0] ?? "(desconocido)");
      }
      if (seen.size >= limit) break;
    }

    // Si una página entera no aportó CIKs nuevos, seguir no va a cambiar nada:
    // los filings restantes son del mismo puñado de emisores.
    if (seen.size === before) break;
  }

  return [...seen].map(([cik, name]) => ({ cik, name }));
}

// ---------------------------------------------------------------------------
// Paso 2: elegir el Annex A entre los filings de un trust
// ---------------------------------------------------------------------------

interface SubmissionsResponse {
  cik?: string;
  name?: string;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      form?: string[];
      size?: number[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
    };
  };
}

/**
 * Puntúa un filing como candidato a Annex A.
 *
 * PESOS DERIVADOS DE DATOS REALES
 *
 * Se compararon tres familias de emisores en EDGAR (agosto 2026):
 *
 *   Wells Fargo 2025-C64   n4801_x5-annexa1.htm   "ANNEX A-1"                 4,1 MB
 *   Benchmark 2026-B42     n5676_x3-annexa.htm    "FWP"                       8,9 MB
 *   BANK5 2026-5YR20       n5543_x4-annexa1.htm   "FREE WRITING PROSPECTUS"  15,8 MB
 *
 * Conclusiones:
 *
 *   - El NOMBRE es la única señal confiable: los tres traen "annexa", con o sin
 *     dígito. Por eso pesa más que todo lo demás.
 *   - La DESCRIPCIÓN es ruido: tres valores distintos para el mismo documento.
 *     Suma si dice "annex", pero no se puede depender de ella.
 *   - El TAMAÑO no discrimina por sí solo. Los term sheets del mismo deal pesan
 *     6-8 MB, así que un umbral de tamaño los dejaría pasar. Sirve nada más
 *     para descartar los FWP chicos (15-30 KB) de pricing y announcements.
 */
export function scoreAnnexFiling(f: {
  form: string;
  documentName: string;
  documentDescription: string;
  sizeBytes: number;
}): number {
  // El Annex A se publica como FWP o dentro del prospecto.
  if (!/^(FWP|424B[0-9]?|424H)$/i.test(f.form)) return 0;

  const name = f.documentName.toLowerCase();
  const desc = f.documentDescription.toLowerCase();

  let score = 0;

  /**
   * Señal primaria: el nombre del archivo.
   *
   * Los emisores usan tres familias de abreviatura, descubiertas revisando 107
   * trusts reales:
   *
   *   annexa1, annexa    → la forma completa
   *   anxa1, anxa, anx1  → "annex" abreviado a "anx"
   *   a1                 → solo el número de anexo
   *
   * Sin las dos últimas se perdían 17 de 36 trusts.
   */
  if (/annex[-_]?a/.test(name)) score += 0.55;
  else if (/anx\s*a?-?\d?/.test(name)) score += 0.5;
  else if (/annex/.test(name)) score += 0.3;
  /**
   * "a1" a secas es la señal más débil, así que el patrón es estricto:
   * separador, "a", dígito opcional, y fin de nombre antes de la extensión.
   * Así no se confunde con los "xa" de pricing y launch del mismo deal, que
   * además pesan 15-25 KB.
   */
  else if (/[-_]a-?1?(?=\.[a-z]+$)/.test(name)) score += 0.45;

  // Señal secundaria: la descripción. Cuando está, confirma.
  if (/annex\s*_?-?a/.test(desc)) score += 0.2;
  else if (/annex/.test(desc)) score += 0.1;

  // Filtro de tamaño: descarta los FWP chicos, no promueve a los grandes.
  if (f.sizeBytes > 500_000) score += 0.2;
  else if (f.sizeBytes < 100_000) score -= 0.4;

  return Math.min(Math.max(score, 0), 1);
}

/** Un Annex A de 15 MB es normal; más que eso conviene avisar. */
export const LARGE_DOCUMENT_WARN_BYTES = 20_000_000;

export interface AnnexPick {
  filing: FilingRef;
  score: number;
  alternatives: Array<{ document: string; description: string; size: number; score: number }>;
}

/**
 * Busca el Annex A entre los filings recientes de un trust.
 * Devuelve todos los candidatos que superen el umbral, del mejor al peor.
 */
/**
 * Puntúa un prospecto como respaldo.
 *
 * Algunos emisores no publican el Annex A como filing propio: lo incluyen como
 * sección del prospecto (424B2 o 424H), documentos de 15-22 MB. En una revisión
 * de 36 trusts fallidos, 11 estaban en esta situación.
 *
 * Vale intentarlo porque el parser es agnóstico al formato: busca tablas cuyos
 * encabezados mapeen a métricas conocidas, y esas tablas están adentro del
 * prospecto igual. El costo es descargar y parsear un documento cinco veces más
 * grande, así que solo se usa cuando no hay un Annex dedicado.
 */
export function scoreProspectusFallback(f: {
  form: string;
  documentName: string;
  sizeBytes: number;
}): number {
  if (!/^(424B[0-9]?|424H)$/i.test(f.form)) return 0;
  // Un prospecto con el pool completo no baja de varios MB.
  if (f.sizeBytes < 5_000_000) return 0;
  // El preliminar (424H) suele traer el mismo anexo que el final y pesa igual;
  // preferimos el final por ser el definitivo.
  return /424b/i.test(f.form) ? 0.4 : 0.35;
}

export async function findAnnexFilings(
  cik: string,
  opts: {
    minScore?: number;
    max?: number;
    /** Permite caer al prospecto si no hay Annex dedicado. Default true. */
    allowProspectusFallback?: boolean;
    fetchOpts?: FetchOptions;
  } = {},
): Promise<AnnexPick[]> {
  const minScore = opts.minScore ?? 0.5;
  const padded = String(Number(cik)).padStart(10, "0");

  const data = await fetchJson<SubmissionsResponse>(
    `${SUBMISSIONS}/CIK${padded}.json`,
    opts.fetchOpts,
  );

  const recent = data.filings?.recent;
  if (!recent?.accessionNumber) return [];

  const companyName = data.name ?? "(desconocido)";
  const n = recent.accessionNumber.length;

  const scored: Array<{ filing: FilingRef; score: number }> = [];

  for (let i = 0; i < n; i++) {
    const accession = recent.accessionNumber[i]!;
    const form = recent.form?.[i] ?? "";
    const documentName = recent.primaryDocument?.[i] ?? "";
    const documentDescription = recent.primaryDocDescription?.[i] ?? "";
    const sizeBytes = recent.size?.[i] ?? 0;

    const score = scoreAnnexFiling({ form, documentName, documentDescription, sizeBytes });
    if (score <= 0) continue;

    const base = archiveBase(cik, accession);
    scored.push({
      score,
      filing: {
        cik: String(Number(cik)),
        accession,
        companyName,
        formType: form,
        filedAt: recent.filingDate?.[i] ?? "",
        documentName,
        documentDescription,
        sizeBytes,
        documentUrl: `${base}/${documentName}`,
        baseUrl: base,
      },
    });
  }

  scored.sort((a, b) => b.score - a.score);

  let picks = scored.filter((s) => s.score >= minScore).slice(0, opts.max ?? 3);

  // Sin Annex dedicado, probamos con el prospecto: el anexo suele estar adentro.
  if (picks.length === 0 && opts.allowProspectusFallback !== false) {
    const fallbacks: Array<{ filing: FilingRef; score: number }> = [];

    for (let i = 0; i < n; i++) {
      const form = recent.form?.[i] ?? "";
      const documentName = recent.primaryDocument?.[i] ?? "";
      const sizeBytes = recent.size?.[i] ?? 0;

      const score = scoreProspectusFallback({ form, documentName, sizeBytes });
      if (score <= 0) continue;

      const accession = recent.accessionNumber[i]!;
      const base = archiveBase(cik, accession);
      fallbacks.push({
        score,
        filing: {
          cik: String(Number(cik)),
          accession,
          companyName,
          formType: form,
          filedAt: recent.filingDate?.[i] ?? "",
          documentName,
          documentDescription: recent.primaryDocDescription?.[i] ?? "",
          sizeBytes,
          documentUrl: `${base}/${documentName}`,
          baseUrl: base,
        },
      });
    }

    fallbacks.sort((a, b) => b.score - a.score || b.filing.sizeBytes - a.filing.sizeBytes);
    picks = fallbacks.slice(0, 1);
  }

  return picks.map((p) => ({
    filing: p.filing,
    score: p.score,
    alternatives: scored
      .filter((s) => s.filing.accession !== p.filing.accession)
      .slice(0, 4)
      .map((s) => ({
        document: s.filing.documentName,
        description: s.filing.documentDescription,
        size: s.filing.sizeBytes,
        score: Number(s.score.toFixed(2)),
      })),
  }));
}

/** Lista los filings de un trust, para inspección manual cuando algo no cierra. */
export async function listRecentFilings(
  cik: string,
  opts: { limit?: number; fetchOpts?: FetchOptions } = {},
): Promise<Array<{
  accession: string; form: string; filedAt: string;
  document: string; description: string; sizeBytes: number; score: number;
}>> {
  const padded = String(Number(cik)).padStart(10, "0");
  const data = await fetchJson<SubmissionsResponse>(
    `${SUBMISSIONS}/CIK${padded}.json`,
    opts.fetchOpts,
  );

  const recent = data.filings?.recent;
  if (!recent?.accessionNumber) return [];

  const rows = recent.accessionNumber.map((accession, i) => {
    const form = recent.form?.[i] ?? "";
    const document = recent.primaryDocument?.[i] ?? "";
    const description = recent.primaryDocDescription?.[i] ?? "";
    const sizeBytes = recent.size?.[i] ?? 0;
    return {
      accession,
      form,
      filedAt: recent.filingDate?.[i] ?? "",
      document,
      description,
      sizeBytes,
      score: Number(scoreAnnexFiling({ form, documentName: document, documentDescription: description, sizeBytes }).toFixed(2)),
    };
  });

  return rows.slice(0, opts.limit ?? 40);
}

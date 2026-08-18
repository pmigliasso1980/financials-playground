/**
 * Comparables: la única pregunta que el corpus le puede contestar a un broker.
 *
 * "Tengo una propiedad de este tipo, en este estado, de este tamaño. ¿Qué
 * términos consiguieron préstamos parecidos?"
 *
 * Es lógica de dominio pura, sin HTTP, para que se pueda probar y para que el
 * servidor sea solo transporte.
 *
 * LAS TRES REGLAS QUE VIENEN DEL TRABAJO ANTERIOR
 *
 * 1. Se niega antes que inventar. Con menos de cinco comparables no hay rango que
 *    dar, y devolver una mediana de tres préstamos es peor que no contestar:
 *    parece una respuesta.
 *
 * 2. Cada número trae su base. La cobertura no es la misma para todas las
 *    métricas —puede haber 31 comparables y solo 22 con debt yield— así que cada
 *    distribución dice sobre cuántos se calculó, no sobre cuántos hay.
 *
 * 3. Toda respuesta trae procedencia y el límite del canal. Este corpus es SOLO
 *    conduit CMBS: no hay bancos, agencias, deuda puente ni compañías de vida. Un
 *    broker que compara contra esto compara contra un canal, y si la respuesta no
 *    lo dice, miente por omisión.
 */

import { query } from "../db/client.js";
import { estadoCorpus, estampa } from "../db/procedencia.js";

/** Fijado antes de ver ningún resultado. */
export const MIN_COMPARABLES = 5;
export const BANDA_DEFECTO = 0.5;
export const MESES_DEFECTO = 18;

export const TIPOS = [
  "Multifamily", "Retail", "Office", "Industrial",
  "Self Storage", "Hospitality", "Mixed Use", "Manufactured",
] as const;
export type Tipo = (typeof TIPOS)[number];

const CANON = `CASE
    WHEN l.property_type ~* 'multifamily|cooperative|garden|low rise|mid rise|student' THEN 'Multifamily'
    WHEN l.property_type ~* 'retail|anchored|single tenant' THEN 'Retail'
    WHEN l.property_type ~* 'office|cbd|suburban|medical' THEN 'Office'
    WHEN l.property_type ~* 'industrial|warehouse|flex' THEN 'Industrial'
    WHEN l.property_type ~* 'storage' THEN 'Self Storage'
    WHEN l.property_type ~* 'hospitality|hotel|service|extended stay' THEN 'Hospitality'
    WHEN l.property_type ~* 'mixed' THEN 'Mixed Use'
    WHEN l.property_type ~* 'manufactured' THEN 'Manufactured'
    ELSE 'Otro'
  END`;

export interface Criterios {
  estado: string;
  tipo: Tipo;
  monto: number;
  /** Ancho de la banda de tamaño. 0,5 = ±50%. */
  banda?: number;
  /** Ventana hacia atrás desde hoy. */
  meses?: number;
  /** Opcional: el LTV que pide el cliente, para ubicarlo en la distribución. */
  ltvObjetivo?: number;
}

export interface Distribucion {
  metrica: string;
  etiqueta: string;
  /** Sobre cuántos comparables se calculó: NO es el total de comparables. */
  base: number;
  p25: number;
  p50: number;
  p75: number;
}

export interface Comparable {
  loanId: number;
  emision: string;
  fecha: string;
  propiedad: string | null;
  ciudad: string | null;
  monto: number;
  accession: string;
  /**
   * DOS URLS, LAS DOS LEÍDAS DE LA BASE Y NINGUNA CONSTRUIDA DE MEMORIA.
   *
   * `documento` es exactamente el archivo que el harvester descargó y parseó —la
   * columna `file_url` de `corpus.filings`—, así que abre el Annex A del que
   * salieron estos números y no una búsqueda parecida.
   *
   * `indice` es la página del filing en EDGAR, armada con cik + accession, para
   * cuando alguien quiere ver el resto de los documentos de esa emisión.
   *
   * La primera versión de esto era una URL de búsqueda de EDGAR que escribí de
   * memoria, con los parámetros vacíos y `action` repetido dos veces: no llevaba a
   * ninguna parte. El dato correcto estaba en la base desde el principio.
   */
  documento: string;
  indice: string;
}

export type Respuesta =
  | {
      suficiente: false;
      encontrados: number;
      minimo: number;
      /** Qué pasaría si se afloja cada criterio, para que decida quien pregunta. */
      siAmplias: Array<{ criterio: string; encontrados: number }>;
      criterios: Criterios;
      corpus: { estampa: string; canal: string };
    }
  | {
      suficiente: true;
      encontrados: number;
      distribuciones: Distribucion[];
      objetivo: { ltv: number; alcanzaron: number; de: number } | null;
      muestra: Comparable[];
      criterios: Criterios;
      corpus: { estampa: string; canal: string };
    };

/**
 * La página del filing en EDGAR: cik + accession sin guiones + accession con
 * guiones. Es la única parte que se arma con una regla en vez de leerse, y por eso
 * el smoke la verifica contra un accession real.
 */
export function indiceEdgar(cik: string, accession: string): string {
  const limpio = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${limpio}/${accession}-index.htm`;
}

const CANAL =
  "Solo conduit CMBS de SEC EDGAR. No incluye bancos, agencias, deuda puente ni " +
  "compañías de seguros de vida.";

/** El WHERE compartido: si cambia acá, cambia en el conteo y en el detalle. */
function filtro(c: Criterios) {
  const banda = c.banda ?? BANDA_DEFECTO;
  const meses = c.meses ?? MESES_DEFECTO;
  return {
    sql: `nullif(btrim(l.state), '') = $1
          AND ${CANON} = $2
          AND am.value::numeric BETWEEN $3 AND $4
          AND f.filed_at >= now() - ($5 || ' months')::interval`,
    params: [
      c.estado.toUpperCase(),
      c.tipo,
      c.monto * (1 - banda),
      c.monto * (1 + banda),
      String(meses),
    ] as unknown[],
  };
}

const DESDE = `FROM corpus.loans l
   JOIN corpus.filings f ON f.accession = l.accession
   JOIN corpus.facts am ON am.loan_id = l.id AND am.metric_key = 'loan_amount'
                       AND am.value ~ '^[0-9.]+$' AND am.value::numeric > 0`;

async function contar(c: Criterios): Promise<number> {
  const { sql, params } = filtro(c);
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n ${DESDE} WHERE ${sql}`,
    params,
  );
  return Number(rows[0]!.n);
}

const METRICAS: Array<{ key: string; etiqueta: string; max: number }> = [
  { key: "ltv", etiqueta: "LTV", max: 2 },
  { key: "dscr", etiqueta: "DSCR", max: 20 },
  { key: "debt_yield", etiqueta: "Debt yield", max: 2 },
  { key: "interest_rate", etiqueta: "Tasa", max: 1 },
];

export async function buscarComparables(c: Criterios): Promise<Respuesta> {
  const estado = await estadoCorpus();
  const corpus = { estampa: estampa(estado), canal: CANAL };
  const encontrados = await contar(c);

  if (encontrados < MIN_COMPARABLES) {
    /**
     * No alcanza con decir que no. Se afloja un criterio por vez y se reporta el
     * conteo, para que quien pregunta decida qué está dispuesto a soltar en vez
     * de recibir un "no hay datos" sin salida.
     */
    const siAmplias = [
      { criterio: "±100% de monto en vez de ±50%", n: await contar({ ...c, banda: 1 }) },
      { criterio: "últimos 36 meses en vez de 18", n: await contar({ ...c, meses: 36 }) },
      {
        criterio: "todo el país en vez de un estado",
        n: await (async () => {
          const banda = c.banda ?? BANDA_DEFECTO;
          const meses = c.meses ?? MESES_DEFECTO;
          const { rows } = await query<{ n: string }>(
            `SELECT count(*)::text AS n ${DESDE}
              WHERE ${CANON} = $1
                AND am.value::numeric BETWEEN $2 AND $3
                AND f.filed_at >= now() - ($4 || ' months')::interval`,
            [c.tipo, c.monto * (1 - banda), c.monto * (1 + banda), String(meses)],
          );
          return Number(rows[0]!.n);
        })(),
      },
    ];
    return {
      suficiente: false,
      encontrados,
      minimo: MIN_COMPARABLES,
      siAmplias: siAmplias.map((s) => ({ criterio: s.criterio, encontrados: s.n })),
      criterios: c,
      corpus,
    };
  }

  const { sql, params } = filtro(c);

  /**
   * Una consulta por métrica: cada una tiene su propia cobertura, y calcularlas
   * juntas obligaría a un FILTER por métrica que oscurece de dónde sale cada base.
   */
  const distribuciones: Distribucion[] = [];
  for (const m of METRICAS) {
    const { rows } = await query<{ base: string; p25: string; p50: string; p75: string }>(
      `SELECT count(*)::text AS base,
              percentile_cont(0.25) WITHIN GROUP (ORDER BY v.value::numeric)::text AS p25,
              percentile_cont(0.50) WITHIN GROUP (ORDER BY v.value::numeric)::text AS p50,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY v.value::numeric)::text AS p75
         ${DESDE}
         JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = $${params.length + 1}
                            AND v.value ~ '^[0-9.]+$'
                            AND v.value::numeric > 0 AND v.value::numeric < $${params.length + 2}
        WHERE ${sql}`,
      [...params, m.key, m.max],
    );
    const r = rows[0]!;
    if (Number(r.base) === 0) continue;
    distribuciones.push({
      metrica: m.key,
      etiqueta: m.etiqueta,
      base: Number(r.base),
      p25: Number(r.p25),
      p50: Number(r.p50),
      p75: Number(r.p75),
    });
  }

  /** Dónde cae lo que pide el cliente dentro de lo que el canal efectivamente dio. */
  let objetivo: { ltv: number; alcanzaron: number; de: number } | null = null;
  if (c.ltvObjetivo != null) {
    const { rows } = await query<{ alcanzaron: string; de: string }>(
      `SELECT count(*) FILTER (WHERE v.value::numeric >= $${params.length + 1})::text AS alcanzaron,
              count(*)::text AS de
         ${DESDE}
         JOIN corpus.facts v ON v.loan_id = l.id AND v.metric_key = 'ltv'
                            AND v.value ~ '^[0-9.]+$'
                            AND v.value::numeric > 0 AND v.value::numeric <= 2
        WHERE ${sql}`,
      [...params, c.ltvObjetivo],
    );
    objetivo = {
      ltv: c.ltvObjetivo,
      alcanzaron: Number(rows[0]!.alcanzaron),
      de: Number(rows[0]!.de),
    };
  }

  /**
   * La muestra va con el accession de EDGAR. Un comparable que no se puede abrir
   * es un número que hay que creer; con el documento atrás, se verifica.
   */
  const { rows: muestra } = await query<{
    id: string; emision: string; fecha: string; propiedad: string | null;
    ciudad: string | null; monto: string; accession: string;
    cik: string; file_url: string;
  }>(
    `SELECT l.id::text, f.company_name AS emision, f.filed_at::text AS fecha,
            l.property_name AS propiedad, l.city AS ciudad,
            am.value AS monto, l.accession, f.cik, f.file_url
       ${DESDE}
      WHERE ${sql}
      ORDER BY f.filed_at DESC, am.value::numeric DESC
      LIMIT 25`,
    params,
  );

  return {
    suficiente: true,
    encontrados,
    distribuciones,
    objetivo,
    muestra: muestra.map((r) => ({
      loanId: Number(r.id),
      emision: r.emision,
      fecha: r.fecha.slice(0, 10),
      propiedad: r.propiedad,
      ciudad: r.ciudad,
      monto: Number(r.monto),
      accession: r.accession,
      documento: r.file_url,
      indice: indiceEdgar(r.cik, r.accession),
    })),
    criterios: c,
    corpus,
  };
}

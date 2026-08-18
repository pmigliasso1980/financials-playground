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
 * 1. Se niega antes que inventar. Bajo el mínimo no hay rango que dar, y devolver
 *    una mediana de tres préstamos es peor que no contestar: parece una respuesta.
 *
 *    Pero antes de negarse abre el radio: estado, después la división censal,
 *    después todo el país. Se para en el PRIMER peldaño que alcanza, no en el que
 *    más devuelve, porque un comparable de otro estado es peor que uno propio y el
 *    radio se abre solo lo necesario.
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

/**
 * REVISADO CON DATOS, Y ESO SE DECLARA.
 *
 * Estaba en 5, fijado antes de ver nada. La corrida de `api:casos` mostró por qué
 * quedaba corto: multifamily en Georgia devolvió 6 comparables y un rango de LTV
 * de 65,4% a 69,1%. Un intercuartil construido con seis puntos son dos o tres
 * préstamos, y ese rango proyecta una precisión que no tiene.
 *
 * Se sube a 10. No es que 5 estuviera "mal" —era una cuenta a priori razonable—
 * sino que ahora hay evidencia de en qué se equivocaba, y eso vale más que la
 * pureza de no tocarlo.
 */
export const MIN_COMPARABLES = 10;
export const BANDA_DEFECTO = 0.5;
export const MESES_DEFECTO = 18;

export const TIPOS = [
  "Multifamily", "Retail", "Office", "Industrial",
  "Self Storage", "Hospitality", "Mixed Use", "Manufactured",
] as const;
export type Tipo = (typeof TIPOS)[number];

/**
 * LAS NUEVE DIVISIONES CENSALES, Y POR QUÉ NO LAS CUATRO REGIONES.
 *
 * `api:casos` dejó a la vista que el filtro por estado es el que rompe el
 * producto: industrial en Nueva Jersey encontró 4 comparables y 53 en todo el
 * país. No falta información, está en el estado de al lado — y un broker de NJ
 * mira comparables de Pensilvania y Nueva York sin dudarlo.
 *
 * Las cuatro regiones grandes (Noreste, Medio Oeste, Sur, Oeste) son demasiado
 * gruesas: meten Florida con Virginia Occidental y California con Alaska. Las
 * nueve divisiones agrupan mercados que de verdad se comparan entre sí.
 *
 * No es una taxonomía nuestra: es la del Census Bureau, la misma que usan los
 * informes de mercado del sector. Inventar nuestras propias regiones sería una
 * decisión arbitraria más para justificar.
 */
export const DIVISIONES: Record<string, { nombre: string; estados: string[] }> = {
  new_england: { nombre: "Nueva Inglaterra", estados: ["CT", "ME", "MA", "NH", "RI", "VT"] },
  mid_atlantic: { nombre: "Atlántico Medio", estados: ["NJ", "NY", "PA"] },
  e_north_central: { nombre: "Centro Noreste", estados: ["IL", "IN", "MI", "OH", "WI"] },
  w_north_central: { nombre: "Centro Noroeste", estados: ["IA", "KS", "MN", "MO", "NE", "ND", "SD"] },
  south_atlantic: { nombre: "Atlántico Sur", estados: ["DE", "DC", "FL", "GA", "MD", "NC", "SC", "VA", "WV"] },
  e_south_central: { nombre: "Centro Sureste", estados: ["AL", "KY", "MS", "TN"] },
  w_south_central: { nombre: "Centro Suroeste", estados: ["AR", "LA", "OK", "TX"] },
  mountain: { nombre: "Montañas", estados: ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY"] },
  pacific: { nombre: "Pacífico", estados: ["AK", "CA", "HI", "OR", "WA"] },
};

export function divisionDe(estado: string): { nombre: string; estados: string[] } | null {
  const e = estado.toUpperCase();
  for (const d of Object.values(DIVISIONES)) if (d.estados.includes(e)) return d;
  return null;
}

/** Hasta dónde hubo que abrir el radio para juntar comparables suficientes. */
export type Alcance = "estado" | "region" | "pais";

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

/** Un peldaño de la escalera geográfica, con cuántos hay en ese radio. */
export interface Peldano {
  alcance: Alcance;
  etiqueta: string;
  encontrados: number;
}

export type Respuesta =
  | {
      suficiente: false;
      encontrados: number;
      minimo: number;
      /** La escalera completa, para que se vea que se intentó abrir el radio. */
      escalera: Peldano[];
      /** Qué pasaría si se afloja cada criterio, para que decida quien pregunta. */
      siAmplias: Array<{ criterio: string; encontrados: number }>;
      criterios: Criterios;
      corpus: { estampa: string; canal: string };
    }
  | {
      suficiente: true;
      encontrados: number;
      /**
       * Qué radio se terminó usando. Va en la respuesta porque cambia lo que el
       * número significa: "31 en Texas" y "31 en el Centro Suroeste" no son la
       * misma afirmación, y el que pregunta tiene que poder distinguirlas.
       */
      alcance: Alcance;
      alcanceEtiqueta: string;
      escalera: Peldano[];
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

/**
 * El WHERE compartido, parametrizado por ámbito geográfico.
 *
 * `estados = null` significa todo el país. Si esto cambia acá, cambia en el
 * conteo, en las distribuciones y en la muestra a la vez — que es el motivo de que
 * exista una sola función y no tres consultas parecidas.
 */
function filtro(c: Criterios, estados: string[] | null) {
  const banda = c.banda ?? BANDA_DEFECTO;
  const meses = c.meses ?? MESES_DEFECTO;
  const params: unknown[] = [
    c.tipo,
    c.monto * (1 - banda),
    c.monto * (1 + banda),
    String(meses),
  ];
  let sql = `${CANON} = $1
          AND am.value::numeric BETWEEN $2 AND $3
          AND f.filed_at >= now() - ($4 || ' months')::interval`;
  if (estados) {
    params.push(estados);
    sql += `\n          AND nullif(btrim(l.state), '') = ANY($${params.length})`;
  }
  return { sql, params };
}

const DESDE = `FROM corpus.loans l
   JOIN corpus.filings f ON f.accession = l.accession
   JOIN corpus.facts am ON am.loan_id = l.id AND am.metric_key = 'loan_amount'
                       AND am.value ~ '^[0-9.]+$' AND am.value::numeric > 0`;

async function contar(c: Criterios, estados: string[] | null): Promise<number> {
  const { sql, params } = filtro(c, estados);
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
  const div = divisionDe(c.estado);

  /**
   * LA ESCALERA: estado, después región, después país.
   *
   * Se para en el PRIMER peldaño que llega al mínimo, no en el que más devuelve.
   * Un comparable de otro estado es peor que uno del mismo estado, así que el
   * radio se abre solo lo necesario y nunca por gusto.
   *
   * Los tres peldaños se cuentan igual —también los que no se usaron— porque
   * "4 en NJ, 19 en el Atlántico Medio" le dice al que pregunta de dónde salió
   * su respuesta y qué tan lejos hubo que ir a buscarla.
   */
  const peldanos: Array<{ alcance: Alcance; etiqueta: string; estados: string[] | null }> = [
    { alcance: "estado", etiqueta: c.estado.toUpperCase(), estados: [c.estado.toUpperCase()] },
    ...(div ? [{ alcance: "region" as const, etiqueta: div.nombre, estados: div.estados }] : []),
    { alcance: "pais", etiqueta: "todo el país", estados: null },
  ];

  const escalera: Peldano[] = [];
  let elegido: (typeof peldanos)[number] | null = null;
  for (const p of peldanos) {
    const n = await contar(c, p.estados);
    escalera.push({ alcance: p.alcance, etiqueta: p.etiqueta, encontrados: n });
    if (!elegido && n >= MIN_COMPARABLES) elegido = p;
  }

  if (!elegido) {
    /**
     * Ni abriendo a todo el país alcanza. Recién ahí se ofrecen los otros dos
     * ejes —tamaño y ventana— porque aflojarlos cambia qué es un comparable, y
     * eso es una decisión de quien pregunta y no nuestra.
     */
    return {
      suficiente: false,
      encontrados: escalera[0]!.encontrados,
      minimo: MIN_COMPARABLES,
      escalera,
      siAmplias: [
        { criterio: "±100% de monto en vez de ±50%", encontrados: await contar({ ...c, banda: 1 }, null) },
        { criterio: "últimos 36 meses en vez de 18", encontrados: await contar({ ...c, meses: 36 }, null) },
      ],
      criterios: c,
      corpus,
    };
  }

  const ambito = elegido.estados;
  const encontrados = escalera.find((e) => e.alcance === elegido!.alcance)!.encontrados;
  const { sql, params } = filtro(c, ambito);

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
      metrica: m.key, etiqueta: m.etiqueta, base: Number(r.base),
      p25: Number(r.p25), p50: Number(r.p50), p75: Number(r.p75),
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
   * La muestra va con el documento de EDGAR. Un comparable que no se puede abrir
   * es un número que hay que creer; con el filing atrás, se verifica.
   */
  const { rows: muestra } = await query<{
    id: string; emision: string; fecha: string; propiedad: string | null;
    ciudad: string | null; estado: string | null; monto: string; accession: string;
    cik: string; file_url: string;
  }>(
    `SELECT l.id::text, f.company_name AS emision, f.filed_at::text AS fecha,
            l.property_name AS propiedad, l.city AS ciudad, l.state AS estado,
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
    alcance: elegido.alcance,
    alcanceEtiqueta: elegido.etiqueta,
    escalera,
    distribuciones,
    objetivo,
    muestra: muestra.map((r) => ({
      loanId: Number(r.id), emision: r.emision, fecha: r.fecha.slice(0, 10),
      propiedad: r.propiedad,
      ciudad: r.ciudad && r.estado ? `${r.ciudad}, ${r.estado}` : r.ciudad,
      monto: Number(r.monto), accession: r.accession,
      documento: r.file_url, indice: indiceEdgar(r.cik, r.accession),
    })),
    criterios: c,
    corpus,
  };
}

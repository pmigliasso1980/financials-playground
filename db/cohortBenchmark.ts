/**
 * El cálculo del benchmark contra la cohorte, sin formato.
 *
 * POR QUÉ ES UN MÓDULO Y NO PARTE DEL SCRIPT
 *
 * `db:benchmark` imprime en la terminal y `db:page` genera un HTML. Si cada uno
 * consultara la base por su cuenta habría dos implementaciones de la misma
 * comparación, y esta sesión ya mostró cómo termina eso: la ocupación tuvo dos
 * definiciones conviviendo —una exigía diez préstamos, la otra uno— y se
 * contradecían en la misma pantalla sin que nadie lo notara.
 *
 * Acá viven los números. Los consumidores solo eligen cómo mostrarlos.
 *
 * LAS DECISIONES METODOLÓGICAS VIVEN ACÁ TAMBIÉN
 *
 * Umbral de pares, exclusión de mono-tipo, mínimo de préstamos por métrica: son
 * decisiones sobre qué se puede afirmar, no sobre presentación. Si estuvieran
 * duplicadas en cada consumidor, dos vistas del mismo deal podrían dar
 * respuestas distintas.
 */

import { query } from "./client.js";

/** Fijados antes de ver ningún dato. */
export const MIN_PARES = 15;
export const CONCENTRACION_TIPO = 0.8;
export const MIN_PARA_METRICA = 10;

export const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

export interface MetricaSpec {
  key: string;
  etiqueta: string;
  min: number;
  max: number;
  fmt: (v: number) => string;
  /** Hacia dónde es "más agresivo": informa cómo leer la posición. */
  agresivo: "alto" | "bajo";
}

export const METRICAS: MetricaSpec[] = [
  { key: "ltv", etiqueta: "LTV", min: 0.01, max: 2, fmt: (v) => pct(v, 1), agresivo: "alto" },
  { key: "dscr", etiqueta: "DSCR", min: 0.1, max: 20, fmt: (v) => v.toFixed(2), agresivo: "bajo" },
  { key: "debt_yield", etiqueta: "Debt yield", min: 0.01, max: 1, fmt: (v) => pct(v, 1), agresivo: "bajo" },
  { key: "interest_rate", etiqueta: "Tasa", min: 0.001, max: 0.2, fmt: (v) => pct(v, 2), agresivo: "alto" },
  { key: "loan_amount", etiqueta: "Saldo", min: 1e5, max: 1e10, fmt: (v) => `${(v / 1e6).toFixed(1)}M`, agresivo: "alto" },
  { key: "occupancy", etiqueta: "Ocupación", min: 0.1, max: 1.01, fmt: (v) => pct(v, 1), agresivo: "bajo" },
];

export interface Emision {
  accession: string;
  nombre: string;
  anada: string;
  filed: string;
  pool: number;
  tipoDominante: string | null;
  shareDominante: number;
}

export interface MetricaResultado {
  spec: MetricaSpec;
  /** null cuando la emisión no tiene suficientes préstamos con el dato. */
  valor: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  rank: number | null;
  total: number | null;
  /** true si está entre las tres primeras o últimas de la cohorte. */
  extremo: boolean;
  /** true si el extremo apunta hacia el lado más agresivo. */
  agresivo: boolean;
  /** Por qué no hay número, cuando no hay. */
  sinDato: "emision" | "pares" | null;
  paresConDato: number;
}

export interface Composicion {
  tipo: string;
  propio: number;
  cohorte: number;
  diferencia: number;
  /** Cuántos préstamos de ESTA emisión explican la diferencia. */
  prestamos: number;
}

export interface Benchmark {
  objetivo: Emision;
  pares: Emision[];
  excluidas: Emision[];
  /** false cuando no alcanzan los pares: la respuesta correcta es "no se sabe". */
  evaluable: boolean;
  /** true si la propia emisión es mono-tipo y la comparación no aplica. */
  objetivoMonoTipo: boolean;
  metricas: MetricaResultado[];
  composicion: Composicion[];
  /** Cuánto del pool vale un préstamo: la resolución real de la composición. */
  puntoPorPrestamo: number;
  /** Resolución en puntos que tendría un percentil con estos pares. */
  resolucionPercentil: number;
}

/**
 * Las emisiones disponibles, con lo necesario para decidir quién entra a la
 * cohorte de referencia.
 *
 * El pool se cuenta APARTE de los tipos. La primera versión unía `corpus.loans`
 * con el CTE de tipos —una fila por (emisión, tipo)— y cada préstamo se contaba
 * una vez por tipo presente: BANK5 2026-5YR24 salió con 315 préstamos en vez de
 * 35. Un fan-out de join no rompe nada visiblemente, así que se evita por
 * construcción y no por atención.
 */
export async function cargarCandidatas(): Promise<Emision[]> {
  const { rows } = await query<{
    accession: string; nombre: string; anada: string; filed: string;
    pool: string; tipo_dominante: string | null; share_dominante: string | null;
  }>(
    `WITH pools AS (
       SELECT accession, count(*) AS pool FROM corpus.loans GROUP BY accession
     ),
     tipos AS (
       SELECT l.accession, l.property_type AS tipo, count(*) AS n,
              row_number() OVER (PARTITION BY l.accession ORDER BY count(*) DESC) AS rn,
              sum(count(*)) OVER (PARTITION BY l.accession) AS total
         FROM corpus.loans l
        WHERE l.property_type IS NOT NULL
        GROUP BY l.accession, l.property_type
     ),
     dominante AS (
       SELECT accession, tipo, (n::numeric / nullif(total, 0)) AS share
         FROM tipos WHERE rn = 1
     )
     SELECT f.accession, f.company_name AS nombre,
            extract(year FROM f.filed_at)::int::text AS anada,
            f.filed_at::text AS filed,
            p.pool::text,
            d.tipo AS tipo_dominante,
            d.share::text AS share_dominante
       FROM corpus.filings f
       JOIN pools p ON p.accession = f.accession
       LEFT JOIN dominante d ON d.accession = f.accession
      WHERE f.filed_at IS NOT NULL
      ORDER BY f.filed_at DESC`,
  );

  return rows.map((r) => ({
    accession: r.accession,
    nombre: r.nombre,
    anada: r.anada,
    filed: r.filed,
    pool: Number(r.pool),
    tipoDominante: r.tipo_dominante,
    shareDominante: Number(r.share_dominante ?? 0),
  }));
}

/**
 * Calcula el benchmark de una emisión contra su cohorte.
 *
 * Devuelve `null` solo si no se encuentra la emisión. Que no haya pares
 * suficientes NO es un error: es una respuesta, y viaja en `evaluable`.
 */
export async function calcularBenchmark(
  busqueda: string | null,
  candidatas?: Emision[],
): Promise<Benchmark | null> {
  const todas = candidatas ?? (await cargarCandidatas());
  const objetivo = busqueda
    ? todas.find((c) => c.nombre.toLowerCase().includes(busqueda.toLowerCase()))
    : todas[0];
  if (!objetivo) return null;

  /**
   * El grupo de referencia: las OTRAS emisiones del mismo año, sin las
   * mono-tipo.
   *
   * Excluirse a sí misma es obvio y fácil de olvidar: con 28 emisiones,
   * incluirse corre la posición casi cuatro puntos.
   */
  const mismaAnada = todas.filter(
    (c) => c.anada === objetivo.anada && c.accession !== objetivo.accession,
  );
  const pares = mismaAnada.filter((c) => c.shareDominante <= CONCENTRACION_TIPO);
  const excluidas = mismaAnada.filter((c) => c.shareDominante > CONCENTRACION_TIPO);

  const base: Omit<Benchmark, "metricas" | "composicion"> = {
    objetivo,
    pares,
    excluidas,
    evaluable: pares.length >= MIN_PARES,
    objetivoMonoTipo: objetivo.shareDominante > CONCENTRACION_TIPO,
    puntoPorPrestamo: 1 / Math.max(1, objetivo.pool),
    resolucionPercentil: 100 / (pares.length + 1),
  };

  if (!base.evaluable) return { ...base, metricas: [], composicion: [] };

  const accessions = [objetivo.accession, ...pares.map((p) => p.accession)];
  const metricas: MetricaResultado[] = [];

  for (const spec of METRICAS) {
    const { rows } = await query<{ accession: string; mediana: string }>(
      `SELECT l.accession,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY fa.value::numeric)::text AS mediana
         FROM corpus.facts fa
         JOIN corpus.loans l ON l.id = fa.loan_id
        WHERE fa.metric_key = $1
          AND fa.value ~ '^-?[0-9.]+$'
          AND fa.value::numeric BETWEEN ${spec.min} AND ${spec.max}
          AND l.accession = ANY($2)
        GROUP BY l.accession
       HAVING count(*) >= ${MIN_PARA_METRICA}`,
      [spec.key, accessions],
    );

    const propio = rows.find((r) => r.accession === objetivo.accession);
    const otros = rows
      .filter((r) => r.accession !== objetivo.accession)
      .map((r) => Number(r.mediana))
      .sort((a, b) => a - b);

    if (!propio || otros.length < MIN_PARES) {
      metricas.push({
        spec, valor: null, p25: null, p50: null, p75: null, rank: null, total: null,
        extremo: false, agresivo: false,
        sinDato: !propio ? "emision" : "pares",
        paresConDato: otros.length,
      });
      continue;
    }

    const v = Number(propio.mediana);
    const q = (p: number) => otros[Math.min(otros.length - 1, Math.floor(p * otros.length))]!;
    const rank = otros.filter((x) => x < v).length + 1;
    const total = otros.length + 1;
    const extremo = rank <= 3 || rank >= total - 2;

    metricas.push({
      spec, valor: v,
      p25: q(0.25), p50: q(0.5), p75: q(0.75),
      rank, total, extremo,
      agresivo:
        (spec.agresivo === "alto" && rank >= total - 2) ||
        (spec.agresivo === "bajo" && rank <= 3),
      sinDato: null,
      paresConDato: otros.length,
    });
  }

  /**
   * La composición, con las categorías canonizadas.
   *
   * El Annex A publica tanto la taxonomía general como la detallada. Se
   * normaliza a las categorías gruesas porque son las que tienen suficientes
   * préstamos por celda para que un porcentaje signifique algo.
   */
  const { rows: mezcla } = await query<{ tipo: string; propio: string; cohorte: string }>(
    `WITH canon AS (
       SELECT l.accession,
              CASE
                WHEN l.property_type ~* 'multifamily|cooperative|garden|low rise|mid rise|student' THEN 'Multifamily'
                WHEN l.property_type ~* 'retail|anchored|single tenant' THEN 'Retail'
                WHEN l.property_type ~* 'office|cbd|suburban|medical' THEN 'Office'
                WHEN l.property_type ~* 'industrial|warehouse|flex' THEN 'Industrial'
                WHEN l.property_type ~* 'storage' THEN 'Self Storage'
                WHEN l.property_type ~* 'hospitality|hotel|service|extended stay' THEN 'Hospitality'
                WHEN l.property_type ~* 'mixed' THEN 'Mixed Use'
                WHEN l.property_type ~* 'manufactured' THEN 'Manufactured'
                ELSE 'Otro'
              END AS tipo
         FROM corpus.loans l
        WHERE l.property_type IS NOT NULL AND l.accession = ANY($1)
     ),
     totales AS (
       SELECT count(*) FILTER (WHERE accession = $2) AS n_propio,
              count(*) FILTER (WHERE accession <> $2) AS n_cohorte
         FROM canon
     )
     SELECT c.tipo,
            (count(*) FILTER (WHERE c.accession = $2)::numeric
              / nullif(t.n_propio, 0))::text AS propio,
            (count(*) FILTER (WHERE c.accession <> $2)::numeric
              / nullif(t.n_cohorte, 0))::text AS cohorte
       FROM canon c CROSS JOIN totales t
      GROUP BY c.tipo, t.n_propio, t.n_cohorte
      ORDER BY count(*) FILTER (WHERE c.accession = $2) DESC`,
    [accessions, objetivo.accession],
  );

  const composicion: Composicion[] = mezcla
    .map((r) => {
      const propio = Number(r.propio ?? 0);
      const cohorte = Number(r.cohorte ?? 0);
      return {
        tipo: r.tipo,
        propio,
        cohorte,
        diferencia: propio - cohorte,
        prestamos: Math.round(propio * objetivo.pool),
      };
    })
    // Un tipo ausente en esta emisión y marginal en la cohorte no informa nada.
    .filter((r) => r.propio > 0 || r.cohorte >= 0.02);

  return { ...base, metricas, composicion };
}

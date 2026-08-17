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
  /** true si la diferencia es menor a un préstamo: no es una diferencia. */
  bajoResolucion: boolean;
  /** Cuántos préstamos de esta emisión son de este tipo. */
  prestamos: number;
  /** Cuántos préstamos explican la DIFERENCIA contra la cohorte. */
  prestamosDif: number;
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
  /**
   * Cuánto se aparta la mezcla de propiedades, y si eso supera al azar.
   *
   * Medido con `db:composition-signal` sobre la cohorte 2026: 13 de 25 conduits
   * se apartan más que el azar, contra 1,25 esperadas. El test se verificó antes
   * de usarlo generando emisiones DESDE la nula: encontró 2 de 28, contra 1,4
   * esperadas.
   *
   * Ese 13 NO es el que muestra `db:catalog`, que da 8. Son referencias distintas
   * —el catálogo excluye las mono-tipo del pool y exige que las dos ponderaciones
   * coincidan— y el detalle está en el encabezado de `catalog.ts`. Una versión
   * anterior de este comentario decía "10", que no es ninguno de los dos.
   *
   * Las seis métricas rastrean lo mismo más débilmente —rho = 0,59 entre cuántas
   * se apartan y cuánto se aparta la mezcla— porque la composición causa el
   * desvío: los hoteles se suscriben distinto que los departamentos.
   *
   * (Una versión anterior de este comentario decía que las métricas eran
   * "indistinguibles de la nula, z = 0,00". Ese test comparaba cada emisión
   * contra el rango intercuartil de las otras del mismo conjunto, donde la tasa
   * marginal es 50% por intercambiabilidad exista o no señal: no tenía potencia.)
   */
  distancia: number;
  distanciaNulo: number;
  pValor: number;
  /**
   * El mismo cálculo con la referencia ponderada por EMISIÓN en vez de por
   * préstamo, y si las dos coinciden.
   *
   * Medido: sobre 2026, por préstamo salen 13 emisiones significativas y por
   * emisión 15, coincidiendo en 13. El agregado es robusto —las dos cifras son
   * abrumadoras contra 1,4 esperadas— pero dos emisiones cambian de lado, y una
   * es BANK5 2026-5YR24.
   *
   * O sea que el veredicto por emisión NO es robusto en los casos al filo. Una
   * página que dice "distinta" o "indistinguible" según una ponderación elegida
   * sin pensarla afirma más de lo que sabe, así que cuando las dos discrepan se
   * dice eso en vez de elegir una.
   */
  pValorPorEmision: number;
  /** true si las dos ponderaciones dan el mismo veredicto al 5%. */
  robusto: boolean;
}

/** Variación total: la mitad de la suma de diferencias absolutas. */
const tv = (a: number[], b: number[]) =>
  0.5 * a.reduce((x, v, i) => x + Math.abs(v - b[i]!), 0);

/**
 * Generador con semilla: un p-valor que cambia entre corridas no se puede citar.
 */
function rng(semilla: number) {
  let s = semilla >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const SIMULACIONES = 4000;

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

  const base: Omit<Benchmark, "metricas" | "composicion" | "distancia" | "distanciaNulo" | "pValor" | "pValorPorEmision" | "robusto"> = {
    objetivo,
    pares,
    excluidas,
    evaluable: pares.length >= MIN_PARES,
    objetivoMonoTipo: objetivo.shareDominante > CONCENTRACION_TIPO,
    puntoPorPrestamo: 1 / Math.max(1, objetivo.pool),
    resolucionPercentil: 100 / (pares.length + 1),
  };

  if (!base.evaluable) {
    return {
      ...base, metricas: [], composicion: [],
      distancia: 0, distanciaNulo: 0, pValor: 1, pValorPorEmision: 1, robusto: true,
    };
  }

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
  /**
   * La composición de CADA par, para poder ponderar por emisión.
   *
   * La query de abajo devuelve el agregado ponderado por préstamo; esta devuelve
   * el vector de cada emisión por separado, que es lo que hace falta para
   * promediarlos con peso igual.
   */
  const { rows: porPar } = await query<{ accession: string; tipo: string; share: string }>(
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
                ELSE 'Sin clasificar'
              END AS tipo
         FROM corpus.loans l
        WHERE l.property_type IS NOT NULL AND l.accession = ANY($1)
     ),
     tot AS (SELECT accession, count(*) AS n FROM canon GROUP BY accession)
     SELECT c.accession, c.tipo,
            (count(*)::numeric / nullif(t.n, 0))::text AS share
       FROM canon c JOIN tot t ON t.accession = c.accession
      GROUP BY c.accession, c.tipo, t.n`,
    [accessions],
  );
  const composicionDe = new Map<string, Map<string, number>>();
  for (const r of porPar) {
    const m = composicionDe.get(r.accession) ?? new Map<string, number>();
    m.set(r.tipo, Number(r.share));
    composicionDe.set(r.accession, m);
  }

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
                ELSE 'Sin clasificar'
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
      const diferencia = propio - cohorte;
      /**
       * Una diferencia menor a un préstamo no es una diferencia.
       *
       * Con 35 préstamos cada uno vale 2,9 puntos, así que 0,4 puntos son 0,14
       * préstamos: no existe una emisión que difiera en eso. Se mostraba como
       * "+0%", que parece un error de cálculo y en realidad era una diferencia
       * por debajo de la resolución del pool.
       */
      const punto = 1 / Math.max(1, objetivo.pool);
      return {
        tipo: r.tipo,
        propio,
        cohorte,
        diferencia,
        bajoResolucion: Math.abs(diferencia) < punto,
        prestamos: Math.round(propio * objetivo.pool),
        /** Cuántos préstamos explican la diferencia, que no es lo mismo que `prestamos`. */
        prestamosDif: Math.round(Math.abs(diferencia) / punto),
      };
    })
    // Un tipo ausente en esta emisión y marginal en la cohorte no informa nada.
    .filter((r) => r.propio > 0 || r.cohorte >= 0.02);

  /**
   * ¿Se aparta la mezcla más de lo que produce el azar?
   *
   * El nulo descuenta el tamaño del pool, que es la parte que importa: 15
   * préstamos se desvían de la mezcla promedio por muestreo mucho más que 70.
   * Sin eso, las emisiones chicas parecerían siempre las más distintas.
   *
   * La referencia son los `pares` —las mismas que usa todo lo demás en esta
   * página— y no la cohorte entera. Incluir las mono-tipo correría la mezcla de
   * referencia hacia multifamily y haría que todos los conduits parecieran
   * apartarse en la misma dirección.
   */
  const conMezcla = composicion.filter((c) => c.propio > 0 || c.cohorte > 0);
  const pVec = conMezcla.map((c) => c.propio);
  const qVec = conMezcla.map((c) => c.cohorte);
  const distancia = tv(pVec, qVec);

  const acum: number[] = [];
  qVec.reduce((x, v) => (acum.push(x + v), x + v), 0);
  const rand = rng(0xc0ffee);
  const sim: number[] = [];
  for (let b = 0; b < SIMULACIONES; b++) {
    const c = new Array(qVec.length).fill(0);
    for (let k = 0; k < objetivo.pool; k++) {
      const u = rand();
      let i = acum.findIndex((a) => u < a);
      if (i < 0) i = qVec.length - 1;
      c[i]++;
    }
    sim.push(tv(c.map((x) => x / objetivo.pool), qVec));
  }
  sim.sort((a, b) => a - b);

  /**
   * La misma medición con la referencia ponderada por emisión.
   *
   * El nulo se resimula: cambiar la referencia cambia también qué distancias
   * produce el azar, así que reusar el anterior compararía contra el nulo
   * equivocado.
   */
  const qEmision = conMezcla.map((_, i) => {
    const suma = pares.reduce((x, par) => {
      const t = conMezcla[i]!.tipo;
      const propioPar = composicionDe.get(par.accession)?.get(t) ?? 0;
      return x + propioPar;
    }, 0);
    return suma / Math.max(1, pares.length);
  });
  const dEmision = tv(pVec, qEmision);

  const acumE: number[] = [];
  qEmision.reduce((x, v) => (acumE.push(x + v), x + v), 0);
  const randE = rng(0xc0ffee);
  const simE: number[] = [];
  for (let b = 0; b < SIMULACIONES; b++) {
    const c = new Array(qEmision.length).fill(0);
    for (let k = 0; k < objetivo.pool; k++) {
      const u = randE();
      let i = acumE.findIndex((a) => u < a);
      if (i < 0) i = qEmision.length - 1;
      c[i]++;
    }
    simE.push(tv(c.map((x) => x / objetivo.pool), qEmision));
  }
  const pValor = sim.filter((x) => x >= distancia).length / sim.length;
  const pValorPorEmision = simE.filter((x) => x >= dEmision).length / simE.length;

  return {
    ...base,
    metricas,
    composicion,
    distancia,
    distanciaNulo: sim[Math.floor(sim.length / 2)]!,
    pValor,
    pValorPorEmision,
    robusto: pValor < 0.05 === pValorPorEmision < 0.05,
  };
}

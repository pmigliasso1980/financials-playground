/**
 * Cuánto se aparta una mezcla de su referencia, y cuánto se apartaría por azar.
 *
 * POR QUÉ ESTE MÓDULO EXISTE
 *
 * El mismo cálculo estaba escrito dos veces —en `compositionSignal.ts` y en
 * `cohortBenchmark.ts`— con la misma distancia, la misma semilla y el mismo
 * número de simulaciones. Copias idénticas, no variantes.
 *
 * Y produjeron números distintos para la misma pregunta: 13 emisiones con mezcla
 * distinta en un lado y 8 en el otro. La diferencia no estaba en el cálculo sino
 * en QUÉ SE LE PASA —qué emisiones forman la referencia y cuáles se cuentan— pero
 * con dos implementaciones eso no se podía ver: había que leer las dos y
 * compararlas a mano, que es lo que nadie hace.
 *
 * Con una sola función, la diferencia entre los dos conteos queda donde tiene que
 * estar: en los argumentos de la llamada, visible en una línea.
 *
 * QUÉ MIDE, EN CRIOLLO
 *
 * La distancia es variación total —la mitad de la suma de las diferencias
 * absolutas— y se lee directo: 0,20 significa que hay que mover el 20% del pool
 * para llegar a la mezcla de referencia.
 *
 * EL NULO DESCUENTA EL TAMAÑO DEL POOL, QUE ES LA PARTE QUE IMPORTA
 *
 * Un pool de 15 préstamos se aparta de la mezcla promedio por puro muestreo mucho
 * más que uno de 70. Comparar distancias crudas premiaría a las emisiones chicas
 * por ser chicas. Así que el nulo es explícito: si estos n préstamos se hubieran
 * sacado al azar de la referencia, ¿qué distancia esperaríamos?
 */

/** Variación total entre dos vectores de proporciones. */
export const tv = (a: number[], b: number[]) =>
  0.5 * a.reduce((s, x, i) => s + Math.abs(x - b[i]!), 0);

/**
 * Generador con semilla, para que la misma corrida dé el mismo resultado.
 *
 * Un p-valor que cambia entre corridas no se puede citar, y el proyecto ya usa
 * semilla fija en los bootstrap por la misma razón.
 */
export function rng(semilla: number) {
  let s = semilla >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const SIMULACIONES = 4000;
export const SEMILLA = 0xc0ffee;

export interface Aparte {
  /** Cuánto hay que mover del pool para llegar a la referencia. */
  distancia: number;
  /** La mediana de lo que produce el azar con este tamaño de pool. */
  nulo: number;
  /**
   * Cola derecha empírica, sin corrección.
   *
   * Puede dar exactamente 0 cuando ninguna de las 4.000 réplicas alcanza la
   * observada. Eso NO significa "imposible por azar": significa "menos de 1 en
   * 4.000", y quien lo imprima debería decir `< 0,0003` en vez de `0,0000`.
   */
  p: number;
}

/**
 * @param p      composición de la emisión, como proporciones que suman 1
 * @param q      composición de la referencia, en el mismo orden de categorías
 * @param pool   cuántos préstamos tiene la emisión — define el ruido del nulo
 */
export function aparte(p: number[], q: number[], pool: number): Aparte {
  const distancia = tv(p, q);

  // Acumulada de q, para muestrear la multinomial.
  const acum: number[] = [];
  q.reduce((x, v) => (acum.push(x + v), x + v), 0);

  const rand = rng(SEMILLA);
  const sim: number[] = [];
  for (let b = 0; b < SIMULACIONES; b++) {
    const c = new Array(q.length).fill(0);
    for (let k = 0; k < pool; k++) {
      const u = rand();
      let i = acum.findIndex((a) => u < a);
      if (i < 0) i = q.length - 1;
      c[i]++;
    }
    sim.push(tv(c.map((x) => x / Math.max(1, pool)), q));
  }
  sim.sort((a, b) => a - b);

  return {
    distancia,
    nulo: sim[Math.floor(sim.length / 2)]!,
    p: sim.filter((x) => x >= distancia).length / sim.length,
  };
}

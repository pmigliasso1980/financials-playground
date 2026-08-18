/**
 * ¿La composición de propiedades distingue emisiones, o es ruido de pool chico?
 *
 *   npm run db:composition-signal
 *   npm run db:composition-signal -- --anada 2025
 *
 * POR QUÉ ESTA PREGUNTA, Y POR QUÉ AHORA
 *
 * `db:page --todas` mostró que la tabla de métricas no distingue nada: 84 de 168
 * mediciones fuera del rango intercuartil, exactamente el 50% que predice el
 * azar, z = 0,00. Ninguna de las seis métricas se aparta.
 *
 * La conclusión tentadora es "entonces lo que informa es la composición". Pero
 * eso no se midió, y dar vuelta la página apoyándose en la mitad no verificada
 * de una disyunción es el atajo que esta sesión ya cobró varias veces.
 *
 * EL NULO TIENE QUE DESCONTAR EL TAMAÑO DEL POOL
 *
 * Un pool de 15 préstamos se aparta de la mezcla promedio por puro muestreo
 * mucho más que uno de 70. Comparar la distancia cruda entre emisiones premiaría
 * a las chicas por ser chicas.
 *
 * Así que el nulo es explícito: si los préstamos de esta emisión se hubieran
 * sacado al azar del universo de la cohorte, ¿qué distancia esperaríamos? Se
 * simula con multinomial de n extracciones sobre las proporciones de la cohorte,
 * y la distancia observada se compara contra esa distribución.
 *
 * La distancia es variación total —la mitad de la suma de las diferencias
 * absolutas— que se lee directo: 0,20 significa que hay que mover el 20% del
 * pool para llegar a la mezcla de la cohorte.
 *
 * QUÉ RESPONDE Y QUÉ NO
 *
 * Responde si la mezcla es más distinta de lo que el azar produce. No responde
 * si esa distinción le importa a alguien: una emisión puede diferir de forma
 * medible e irrelevante.
 */

import { closePool, ping, query } from "../db/client.js";
import { pct } from "../db/cohortBenchmark.js";
import { aparte, SIMULACIONES, tv } from "../db/compositionDistance.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const args = process.argv.slice(2);
const iA = args.indexOf("--anada");
const ANADA = iA === -1 ? String(new Date().getFullYear()) : args[iA + 1]!;

/** Fijado antes de mirar. Las simulaciones y la semilla viven en el módulo. */
const ALFA = 0.05;


/** Las categorías gruesas, las mismas que usa el benchmark. */
const CANON = `CASE
    WHEN l.property_type ~* 'multifamily|cooperative|garden|low rise|mid rise|student' THEN 'Multifamily'
    WHEN l.property_type ~* 'retail|anchored|single tenant' THEN 'Retail'
    WHEN l.property_type ~* 'office|cbd|suburban|medical' THEN 'Office'
    WHEN l.property_type ~* 'industrial|warehouse|flex' THEN 'Industrial'
    WHEN l.property_type ~* 'storage' THEN 'Self Storage'
    WHEN l.property_type ~* 'hospitality|hotel|service|extended stay' THEN 'Hospitality'
    WHEN l.property_type ~* 'mixed' THEN 'Mixed Use'
    WHEN l.property_type ~* 'manufactured' THEN 'Manufactured'
    ELSE 'Sin clasificar'
  END`;

const { rows } = await query<{ accession: string; nombre: string; tipo: string; n: string }>(
  `SELECT l.accession, f.company_name AS nombre, ${CANON} AS tipo, count(*)::text AS n
     FROM corpus.loans l
     JOIN corpus.filings f ON f.accession = l.accession
    WHERE l.property_type IS NOT NULL
      AND extract(year FROM f.filed_at) = $1
    GROUP BY l.accession, f.company_name, ${CANON}`,
  [Number(ANADA)],
);
await closePool();

if (rows.length === 0) {
  console.log(`\n  Sin emisiones en ${ANADA}.\n`);
  process.exit(0);
}

const tipos = [...new Set(rows.map((r) => r.tipo))].sort();
const porEmision = new Map<string, { nombre: string; conteo: Map<string, number>; total: number }>();
for (const r of rows) {
  const e = porEmision.get(r.accession) ?? { nombre: r.nombre, conteo: new Map(), total: 0 };
  e.conteo.set(r.tipo, Number(r.n));
  e.total += Number(r.n);
  porEmision.set(r.accession, e);
}

console.log(`\n${"═".repeat(78)}`);
console.log(`¿Distingue la composición? — cohorte ${ANADA}`);
console.log(`${"═".repeat(78)}\n`);
console.log(
  `\x1b[90m  Nulo: los préstamos de la emisión sacados al azar del resto de la cohorte.\x1b[0m`,
);
console.log(
  `\x1b[90m  Distancia = variación total. 0,20 = hay que mover el 20% del pool.\x1b[0m\n`,
);
console.log(`  emisión                            pool   distancia   nulo p50   p-valor`);
console.log(`  ${"─".repeat(74)}`);

let significativas = 0;
const detalle: Array<{ nombre: string; d: number; p: number; pool: number }> = [];
/**
 * LA PONDERACIÓN DE LA REFERENCIA, QUE ELEGÍ SIN PENSARLA.
 *
 * La mezcla de la cohorte se calcula juntando TODOS los préstamos de los pares:
 * está ponderada por préstamo. Con 2026 al doble de su piso de concentración,
 * BANK 2026-BNK52 (70) y Benchmark 2026-B42 (62) aportan el 14% de esos
 * préstamos entre las dos, así que la "mezcla de mercado" es en buena medida la
 * mezcla de esas dos emisiones.
 *
 * La alternativa es ponderar por emisión: promediar los vectores de composición
 * de cada par, con cada emisión pesando igual. Ninguna de las dos es obviamente
 * correcta —depende de si "el mercado" es un conjunto de préstamos o de deals—
 * pero la conclusión del producto no debería depender de cuál elegí sin pensar.
 *
 * Se computan las dos y se comparan los conjuntos de emisiones significativas.
 */
const porEmisionSig = new Set<string>();
const porPrestamoSig = new Set<string>();

for (const [accession, e] of porEmision) {
  /**
   * La referencia excluye a la propia emisión.
   *
   * Incluirla achica la distancia justamente en las emisiones grandes, que son
   * las que más pesan en el promedio: el sesgo iría en contra de encontrar señal
   * donde más datos hay.
   */
  const resto = new Map<string, number>();
  let totalResto = 0;
  for (const [acc, o] of porEmision) {
    if (acc === accession) continue;
    for (const [t, n] of o.conteo) resto.set(t, (resto.get(t) ?? 0) + n);
    totalResto += o.total;
  }

  const q = tipos.map((t) => (resto.get(t) ?? 0) / Math.max(1, totalResto));
  const p = tipos.map((t) => (e.conteo.get(t) ?? 0) / Math.max(1, e.total));
  const dObs = tv(p, q);

  /** La misma referencia, con cada emisión pesando igual en vez de por préstamo. */
  const otras = [...porEmision].filter(([acc]) => acc !== accession);
  const qEmision = tipos.map((t) => {
    const suma = otras.reduce(
      (x, [, o]) => x + (o.conteo.get(t) ?? 0) / Math.max(1, o.total),
      0,
    );
    return suma / Math.max(1, otras.length);
  });
  const dEmision = tv(p, qEmision);

  const porPrestamo = aparte(p, q, e.total);
  const nuloP50 = porPrestamo.nulo;
  const pVal = porPrestamo.p;
  if (pVal < ALFA) {
    significativas++;
    porPrestamoSig.add(e.nombre);
  }

  /**
   * El nulo se resimula adentro de `aparte`: cambiar la referencia cambia también
   * qué distancias produce el azar.
   */
  if (aparte(p, qEmision, e.total).p < ALFA) porEmisionSig.add(e.nombre);
  detalle.push({ nombre: e.nombre, d: dObs, p: pVal, pool: e.total });

  const marca = pVal < ALFA ? "\x1b[32m" : "\x1b[90m";
  console.log(
    `  ${e.nombre.slice(0, 32).padEnd(34)} ${String(e.total).padStart(4)}   ` +
      `${dObs.toFixed(3).padStart(9)}   ${nuloP50.toFixed(3).padStart(8)}   ` +
      `${marca}${pVal < 1 / SIMULACIONES ? `<${(1 / SIMULACIONES).toFixed(4)}` : pVal.toFixed(4)}\x1b[0m`,
  );
}

console.log(`\n${"─".repeat(78)}\n`);

const n = porEmision.size;
const esperadas = n * ALFA;
console.log(
  `  \x1b[1m${significativas} de ${n} emisiones con mezcla más distinta que el azar (p < ${ALFA})\x1b[0m`,
);
console.log(
  `  \x1b[90mPor azar se esperarían ${esperadas.toFixed(1)} con ${n} pruebas al ${pct(ALFA)}.\x1b[0m`,
);

/**
 * El contraste que decide, y no es "hay significativas".
 *
 * Con 28 pruebas al 5% se esperan 1,4 falsos positivos. Encontrar 2 no dice
 * nada; encontrar 20 sí. La comparación es contra ese esperado, no contra cero —
 * el mismo error que cometí al leer el 50% de la tabla de métricas como señal.
 */
console.log(
  significativas > esperadas * 3
    ? `\n  \x1b[32mLa composición distingue.\x1b[0m ${significativas} contra ${esperadas.toFixed(1)} esperadas por azar es\n` +
        `  una diferencia que el muestreo no explica: la mezcla de propiedades es\n` +
        `  información sobre la emisión y merece el lugar principal de la página.`
    : `\n  \x1b[31mLa composición tampoco distingue.\x1b[0m ${significativas} contra ${esperadas.toFixed(1)} esperadas está\n` +
        `  dentro de lo que producen ${n} pruebas al ${pct(ALFA)}. Si ni las métricas ni la mezcla\n` +
        `  separan una emisión de su cohorte, la comparación contra la cohorte no es un\n` +
        `  producto, y la pregunta a hacerle a estos datos es otra.`,
);

/**
 * ¿Depende la conclusión de la ponderación que elegí sin pensarla?
 *
 * Si los dos conjuntos coinciden, la decisión no importaba y queda descartada.
 * Si difieren, el hallazgo que sostiene la página depende de una elección
 * arbitraria y hay que justificarla o reportar las dos.
 */
const soloPrestamo = [...porPrestamoSig].filter((x) => !porEmisionSig.has(x));
const soloEmision = [...porEmisionSig].filter((x) => !porPrestamoSig.has(x));

console.log(`\n${"─".repeat(78)}\n`);
console.log(`  \x1b[1mPonderación de la referencia: por préstamo contra por emisión\x1b[0m\n`);
console.log(
  `    por préstamo (lo que usa la página)   ${porPrestamoSig.size} significativas`,
);
console.log(`    por emisión (cada deal pesa igual)   ${porEmisionSig.size} significativas`);
console.log(
  `    \x1b[90mcoinciden en ${[...porPrestamoSig].filter((x) => porEmisionSig.has(x)).length}\x1b[0m`,
);
if (soloPrestamo.length === 0 && soloEmision.length === 0) {
  console.log(
    `\n    \x1b[32mMismo conjunto.\x1b[0m La ponderación no cambia la conclusión y la decisión\n` +
      `    queda descartada como fuente de duda.`,
  );
} else {
  console.log(
    `\n    \x1b[33mDifieren.\x1b[0m El hallazgo depende de una elección que hice sin pensarla.`,
  );
  for (const x of soloPrestamo) console.log(`      \x1b[90msolo por préstamo: ${x}\x1b[0m`);
  for (const x of soloEmision) console.log(`      \x1b[90msolo por emisión:  ${x}\x1b[0m`);
}

const top = [...detalle].sort((a, b) => a.p - b.p || b.d - a.d).slice(0, 5);
console.log(`\n  Las cinco más distintas:\n`);
for (const t of top) {
  console.log(
    `    ${t.nombre.slice(0, 36).padEnd(38)} d = ${t.d.toFixed(3)}  p = ${t.p.toFixed(4)}  ` +
      `\x1b[90m${t.pool} préstamos\x1b[0m`,
  );
}
console.log();

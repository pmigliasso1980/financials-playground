/**
 * Por qué dos scripts cuentan distinto la misma cosa.
 *
 *   npm run db:reconcile
 *   npm run db:reconcile -- --anada 2025
 *
 * EL PROBLEMA
 *
 * "Cuántas emisiones de 2026 tienen una mezcla más distinta que el azar" tiene dos
 * respuestas en este repo: `db:composition-signal` cuenta 13 y `db:catalog` cuenta
 * 8. Un comentario viejo decía 10, que no era ninguno de los dos.
 *
 * Ninguno está mal. Son definiciones distintas con el mismo nombre, y la
 * hipótesis era que las diferencias fueran dos: la referencia incluye o no a las
 * mono-tipo, y el catálogo además exige que las dos ponderaciones coincidan.
 *
 * PERO UNA HIPÓTESIS NO ES UNA EXPLICACIÓN
 *
 * Suponer la descomposición y no verificarla es exactamente lo que esta sesión ya
 * cobró varias veces. Así que se aplica un filtro por vez y se cuenta:
 *
 *   A  referencia = todas las emisiones · se cuentan todas          (composition-signal)
 *   B  referencia sin mono-tipo · se cuentan todas
 *   C  referencia sin mono-tipo · se cuentan solo los conduits
 *   D  C + las dos ponderaciones de acuerdo                         (catalog)
 *
 * Si A → D no cierra pasando por B y C, hay una diferencia que nadie identificó y
 * el script lo dice en vez de dejar el hueco.
 *
 * QUÉ DIO, Y DÓNDE ME EQUIVOQUÉ AL PREDECIRLO
 *
 * La descomposición cierra exacto: A = 13 y D = 8, los mismos números que imprimen
 * los dos scripts. Pero el reparto no es el que supuse.
 *
 *   13 → 11   sacar las mono-tipo de la REFERENCIA. Y no solo resta: saca tres y
 *             agrega una. Quitar del promedio a tres emisiones cargadas de
 *             multifamily corre la mezcla "de mercado" y BMO 2026-5C15 pasa a
 *             apartarse cuando antes no.
 *   11 →  8   contar solo los conduits. Son exactamente las tres mono-tipo, que
 *             se apartaban por definición.
 *    8 →  8   la robustez no saca ninguna.
 *
 * Yo había dicho que las dos causas eran la referencia y la robustez. La robustez
 * aporta CERO: las emisiones donde las dos ponderaciones discrepan no eran
 * significativas por préstamo, así que nunca entraban al conteo. La segunda causa
 * real era el universo de conteo, que estaba en el texto de la tarea y no en lo que
 * dije. Una descomposición que cierra es la única forma de descubrir eso.
 *
 * LO QUE YA APARECIÓ HACIÉNDOLO
 *
 * Una tercera diferencia, que era un defecto y no un parámetro: `cohortBenchmark`
 * usaba la MISMA lista para mostrar la tabla y para calcular la distancia, y esa
 * lista filtra los tipos ausentes en la emisión y marginales en la cohorte. Con
 * eso el vector de referencia sumaba 0,985 en vez de 1, la distancia quedaba
 * subestimada, y el 1,5% de masa sobrante se le asignaba a la última categoría del
 * orden SQL. Sobre un caso sintético son 0,75 puntos de distancia — chico, pero
 * sistemático y en una sola dirección.
 *
 * Y UNA CUARTA, QUE ESTABA IMPRESA Y NADIE LEYÓ
 *
 * Las columnas `pool` de los dos scripts no coinciden: BMO 2026-C15 sale con 14 en
 * uno y 15 en el otro, BANK5 2026-5YR20 con 36 y 37. `cargarCandidatas` contaba
 * TODOS los préstamos y la composición se mide solo sobre los que tienen tipo de
 * propiedad — los 17 préstamos sin tipo de la tarea #37, repartidos en 15
 * emisiones.
 *
 * El nulo se simulaba entonces sacando 15 préstamos al azar cuando la mezcla se
 * había medido sobre 14. Más extracciones es menos dispersión en el nulo, así que
 * el p-valor salía más chico de lo que corresponde: sesgo hacia "distinta", en el
 * estadístico que encabeza el producto. Medido sobre un caso sintético, p pasa de
 * 0,745 a 0,703.
 *
 * Las dos están arregladas. La lección no es el tamaño de ninguna de las dos: es
 * que las dos aparecieron al exigir que dos números cerraran, y ninguna se veía
 * mirando un resultado que ya parecía razonable.
 */

import { closePool, ping, query } from "./client.js";
import { aparte } from "./compositionDistance.js";
import { CONCENTRACION_TIPO, pct } from "./cohortBenchmark.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const args = process.argv.slice(2);
const iA = args.indexOf("--anada");
const ANADA = iA === -1 ? String(new Date().getFullYear()) : args[iA + 1]!;
const ALFA = 0.05;

/** El mismo CASE que usan los dos scripts. Si diverge, la comparación no vale. */
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
interface Em { nombre: string; conteo: Map<string, number>; total: number }
const ems = new Map<string, Em>();
for (const r of rows) {
  const e = ems.get(r.accession) ?? { nombre: r.nombre, conteo: new Map(), total: 0 };
  e.conteo.set(r.tipo, Number(r.n));
  e.total += Number(r.n);
  ems.set(r.accession, e);
}

/** Mono-tipo con el mismo umbral que el benchmark: 80% en un solo tipo. */
const esMono = (e: Em) =>
  Math.max(...[...e.conteo.values()]) / Math.max(1, e.total) >= CONCENTRACION_TIPO;

const vecP = (e: Em) => tipos.map((t) => (e.conteo.get(t) ?? 0) / Math.max(1, e.total));

/** Referencia por préstamo: se juntan todos los préstamos de las emisiones dadas. */
function refPorPrestamo(otras: Em[]) {
  const acc = new Map<string, number>();
  let total = 0;
  for (const o of otras) {
    for (const [t, n] of o.conteo) acc.set(t, (acc.get(t) ?? 0) + n);
    total += o.total;
  }
  return tipos.map((t) => (acc.get(t) ?? 0) / Math.max(1, total));
}

/** Referencia por emisión: cada deal pesa igual. */
const refPorEmision = (otras: Em[]) =>
  tipos.map((t) => {
    const s = otras.reduce((x, o) => x + (o.conteo.get(t) ?? 0) / Math.max(1, o.total), 0);
    return s / Math.max(1, otras.length);
  });

/**
 * Un paso de la descomposición: qué emisiones dan significativo con esta
 * referencia y este universo de conteo.
 */
function paso(refSinMono: boolean, contarSoloConduits: boolean, exigirRobusto: boolean) {
  const sig = new Set<string>();
  for (const [acc, e] of ems) {
    if (contarSoloConduits && esMono(e)) continue;
    const otras = [...ems]
      .filter(([a]) => a !== acc)
      .map(([, o]) => o)
      .filter((o) => !refSinMono || !esMono(o));
    const p = vecP(e);
    const pPre = aparte(p, refPorPrestamo(otras), e.total).p;
    if (pPre >= ALFA) continue;
    if (exigirRobusto) {
      const pEm = aparte(p, refPorEmision(otras), e.total).p;
      if (pEm >= ALFA !== (pPre >= ALFA)) continue;
    }
    sig.add(e.nombre);
  }
  return sig;
}

const universo = (soloConduits: boolean) =>
  [...ems.values()].filter((e) => !soloConduits || !esMono(e)).length;

const A = paso(false, false, false);
const B = paso(true, false, false);
const C = paso(true, true, false);
const D = paso(true, true, true);

console.log(`\n${"═".repeat(78)}`);
console.log(`Por qué 13 y 8 son el mismo dato — cohorte ${ANADA}`);
console.log(`${"═".repeat(78)}\n`);
console.log(
  `  ${ems.size} emisiones · ${[...ems.values()].filter(esMono).length} mono-tipo ` +
    `(≥ ${pct(CONCENTRACION_TIPO)} en un tipo)\n`,
);
console.log(`  paso                                            de          cuenta   cambio`);
console.log(`  ${"─".repeat(74)}`);

const filas: Array<{ et: string; s: Set<string>; n: number }> = [
  { et: "A  ref = todas · cuenta todas", s: A, n: universo(false) },
  { et: "B  ref sin mono-tipo", s: B, n: universo(false) },
  { et: "C  + cuenta solo conduits", s: C, n: universo(true) },
  { et: "D  + ponderaciones de acuerdo", s: D, n: universo(true) },
];
let prev: Set<string> | null = null;
for (const f of filas) {
  const d = prev === null ? "" : `${f.s.size - prev.size >= 0 ? "+" : ""}${f.s.size - prev.size}`;
  console.log(
    `  ${f.et.padEnd(46)} ${String(f.n).padStart(3)}      ${String(f.s.size).padStart(6)}   ${d.padStart(6)}`,
  );
  if (prev) {
    for (const x of [...prev].filter((v) => !f.s.has(v))) {
      console.log(`  \x1b[90m    − ${x.slice(0, 50)}\x1b[0m`);
    }
    for (const x of [...f.s].filter((v) => !prev!.has(v))) {
      console.log(`  \x1b[90m    + ${x.slice(0, 50)}\x1b[0m`);
    }
  }
  prev = f.s;
}

console.log(
  `\n  \x1b[90mA es la definición de db:composition-signal. D es la de db:catalog.\x1b[0m`,
);
console.log(
  `  \x1b[90mSi los conteos que imprimen esos dos scripts no coinciden con A y D,\x1b[0m`,
);
console.log(
  `  \x1b[90mqueda una diferencia sin identificar y esta descomposición no cierra.\x1b[0m`,
);
console.log(
  `\n  \x1b[1mCorré los dos y compará:\x1b[0m npm run db:composition-signal · npm run db:catalog\n`,
);

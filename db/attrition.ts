/**
 * Qué se lleva cada control, y si lo que se lleva es distinto de lo que deja.
 *
 *   npm run db:attrition
 *
 * DE DÓNDE SALE ESTA PREGUNTA
 *
 * Al correr `db:seller` con el estrato completo, UBS AG (177 préstamos) y SGFC
 * (160) se cayeron de la tabla: son los dos más chicos que llegaban al umbral de
 * 150. No es casualidad. Cada control descarta los préstamos que no tienen el
 * dato, así que el filtro muerde proporcionalmente más a quien está cerca del
 * borde, y la lista de originadores evaluables se corre hacia los grandes justo
 * cuando se agregan controles.
 *
 * Esa era la preocupación anotada. Pero al escribir el script apareció una peor.
 *
 * DOS SELECCIONES, Y LA SEGUNDA ES LA QUE IMPORTA
 *
 *   ENTRE originadores: quién entra a la tabla. Si los excluidos tienen tasas
 *   distintas, el conteo de "cuántos se apartan" está condicionado a sobrevivir
 *   el filtro. Es un problema de interpretación del conteo.
 *
 *   DENTRO de cada originador: qué préstamos suyos sobreviven. Si los que no
 *   tienen DSCR, LTV, saldo o subtipo son sistemáticamente peores o mejores, el
 *   SIR de CADA UNO está calculado sobre una submuestra sesgada. Es un problema
 *   con el número, no con su lectura.
 *
 * Y ya hay un indicio de la segunda: la submuestra de LMF con estrato completo
 * es más rica en eventos que su pool total —13,8% contra 11,2%—. Eso puede ser
 * ruido con 32 eventos, o puede ser que la falta de dato acompañe al desempeño.
 *
 * EL NULO DEPENDE DE DÓNDE VIVE LA FALTA DE DATO, ASÍ QUE ESO VA PRIMERO
 *
 * Si un filing no publica DSCR, no lo publica para ninguno de sus préstamos. En
 * ese caso "los préstamos sin dato" son "los préstamos de ciertas emisiones", y
 * comparar sus tasas compara emisiones —añadas, mezclas de activo, emisoras— no
 * préstamos. Permutar la etiqueta entre préstamos ahí no tiene ninguna potencia:
 * es la misma trampa de intercambiabilidad que ya apareció con el test del 50%.
 *
 * Entonces el orden está forzado: medir si la falta de dato es de la emisión o
 * del préstamo, y recién con eso elegir contra qué nulo comparar. El script corre
 * los dos y dice cuál es el informativo.
 *
 * CALIBRACIÓN, CORRIDA ANTES DE MIRAR EL CORPUS
 *
 * Cuarenta corridas sintéticas de 200 emisiones × 35 préstamos por escenario:
 *
 *   falta al azar dentro de la emisión, sin efecto    →  4/40 falsos positivos
 *   efecto real de 4 pp, falta a nivel préstamo       → 40/40 detectados
 *   falta todo-o-nada por emisión, sin efecto         →  0/40, avisa 40/40
 *   falta todo-o-nada por emisión, CON efecto de 4 pp →  0/40, avisa 40/40
 *
 * La última fila es la que importa: el nulo A es CIEGO a un efecto real de 4 pp
 * cuando la falta de dato es del documento. Un test ciego que no avisa es peor
 * que no tenerlo, así que el aviso es parte del test y no un adorno.
 *
 * La primera versión del diagnóstico no avisaba en ese caso: medía la dispersión
 * alrededor de cero en vez de alrededor de la media del nulo, así que con todas
 * las réplicas iguales a la observada imprimía "3,84 pp" —el tamaño del efecto—
 * y se leía como un nulo sano.
 */

import { closePool, ping, query } from "./client.js";
import { estadoCorpus, estampa } from "./procedencia.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** El mismo que usa db:seller. Si cambia allá, este análisis deja de aplicar. */
const MIN_POOL = 150;
const REPLICAS = 2000;

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

/** Semilla fija: un p-valor que cambia entre corridas no se puede citar. */
function rng(semilla: number) {
  let s = semilla >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Los mismos filtros de valor que `db:seller`, carácter por carácter.
 *
 * Si acá el DSCR se aceptara con otro rango, este script mediría la atrición de
 * un filtro que no es el que corre en el análisis, y el resultado no diría nada
 * sobre los SIR que se publican.
 */
const { rows } = await query<{
  accession: string; vendedor: string | null; evento: string;
  dscr: string; ltv: string; saldo: string; subtipo: string;
}>(
  `WITH base AS (
     SELECT l.id, l.accession, nullif(btrim(l.loan_seller), '') AS vendedor,
            (d.transfer_date IS NOT NULL)::int AS evento
       FROM corpus.loans l
       JOIN corpus.filings f ON f.accession = l.accession
       LEFT JOIN corpus.delinquency d ON d.loan_id = l.id
      WHERE f.accession IN (SELECT deal_accession FROM corpus.servicer_reports
                             WHERE deal_accession IS NOT NULL)
   )
   SELECT b.accession, b.vendedor, b.evento::text,
          (ds.value IS NOT NULL)::int::text AS dscr,
          (lt.value IS NOT NULL)::int::text AS ltv,
          (am.value IS NOT NULL)::int::text AS saldo,
          (nullif(btrim(sb.value), '') IS NOT NULL)::int::text AS subtipo
     FROM base b
     LEFT JOIN corpus.facts ds ON ds.loan_id = b.id AND ds.metric_key = 'dscr'
                              AND ds.value ~ '^[0-9.]+$' AND ds.value::numeric < 20
     LEFT JOIN corpus.facts lt ON lt.loan_id = b.id AND lt.metric_key = 'ltv'
                              AND lt.value ~ '^[0-9.]+$' AND lt.value::numeric <= 2
     LEFT JOIN corpus.facts am ON am.loan_id = b.id AND am.metric_key = 'loan_amount'
                              AND am.value ~ '^[0-9.]+$'
     LEFT JOIN corpus.facts sb ON sb.loan_id = b.id
                              AND sb.metric_key = 'property_type_detailed'
    WHERE b.vendedor IS NOT NULL`,
);

const estado = await estadoCorpus();
await closePool();

interface Prestamo {
  accession: string; vendedor: string; evento: number;
  dscr: boolean; ltv: boolean; saldo: boolean; subtipo: boolean;
}
const prestamos: Prestamo[] = rows.map((r) => ({
  accession: r.accession,
  vendedor: r.vendedor!,
  evento: Number(r.evento),
  dscr: r.dscr === "1",
  ltv: r.ltv === "1",
  saldo: r.saldo === "1",
  subtipo: r.subtipo === "1",
}));

console.log(`\n${"═".repeat(78)}`);
console.log("Qué se lleva cada control");
console.log(`${"═".repeat(78)}`);

// ---------------------------------------------------------------------------
// 1. ¿La falta de dato es de la emisión o del préstamo?
// ---------------------------------------------------------------------------

const METRICAS = [
  { k: "dscr" as const, etiqueta: "DSCR" },
  { k: "ltv" as const, etiqueta: "LTV" },
  { k: "saldo" as const, etiqueta: "saldo" },
  { k: "subtipo" as const, etiqueta: "subtipo" },
];

const porEmision = new Map<string, Prestamo[]>();
for (const p of prestamos) {
  const xs = porEmision.get(p.accession) ?? [];
  xs.push(p);
  porEmision.set(p.accession, xs);
}

console.log(`\n${"─".repeat(78)}`);
console.log("¿La falta de dato es de la emisión o del préstamo?");
console.log(`${"─".repeat(78)}\n`);
console.log(`  métrica     emisiones    todo    nada    parcial     préstamos sin dato`);
console.log(`  ${"─".repeat(70)}`);

/**
 * "Parcial" es la única columna que da lugar a un test dentro de la emisión. Si
 * casi todas las emisiones son todo-o-nada, la falta de dato es una propiedad
 * del documento y no del préstamo.
 */
const parcialPorMetrica = new Map<string, number>();
for (const m of METRICAS) {
  let todo = 0, nada = 0, parcial = 0, sinDato = 0;
  for (const [, xs] of porEmision) {
    const con = xs.filter((p) => p[m.k]).length;
    if (con === xs.length) todo++;
    else if (con === 0) nada++;
    else parcial++;
    sinDato += xs.length - con;
  }
  parcialPorMetrica.set(m.k, parcial / porEmision.size);
  console.log(
    `  ${m.etiqueta.padEnd(11)} ${String(porEmision.size).padStart(9)} ${String(todo).padStart(7)} ` +
      `${String(nada).padStart(7)} ${String(parcial).padStart(10)}     ${String(sinDato).padStart(6)}` +
      `  \x1b[90m(${pct(sinDato / prestamos.length)})\x1b[0m`,
  );
}

const completo = (p: Prestamo) => p.dscr && p.ltv && p.saldo && p.subtipo;
let emParcial = 0;
for (const [, xs] of porEmision) {
  const c = xs.filter(completo).length;
  if (c > 0 && c < xs.length) emParcial++;
}
const shareParcial = emParcial / porEmision.size;

console.log(
  `\n  Con el estrato completo: \x1b[1m${emParcial} de ${porEmision.size}\x1b[0m emisiones ` +
    `(${pct(shareParcial)}) quedan partidas.`,
);
console.log(
  `  \x1b[90mLas otras son todo-o-nada: sus préstamos entran o salen en bloque.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 2. La cascada
// ---------------------------------------------------------------------------

const PASOS: Array<{ etiqueta: string; f: (p: Prestamo) => boolean }> = [
  { etiqueta: "sin controles", f: () => true },
  { etiqueta: "+ DSCR", f: (p) => p.dscr },
  { etiqueta: "+ LTV", f: (p) => p.dscr && p.ltv },
  { etiqueta: "+ saldo", f: (p) => p.dscr && p.ltv && p.saldo },
  { etiqueta: "+ subtipo", f: completo },
];

console.log(`\n${"─".repeat(78)}`);
console.log(`Cascada: qué queda en cada paso (originadores con pool ≥ ${MIN_POOL})`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  control          préstamos   eventos     tasa   originadores   quiénes salen`);
console.log(`  ${"─".repeat(74)}`);

const evaluables = (f: (p: Prestamo) => boolean) => {
  const conteo = new Map<string, number>();
  for (const p of prestamos) if (f(p)) conteo.set(p.vendedor, (conteo.get(p.vendedor) ?? 0) + 1);
  return new Set([...conteo].filter(([, n]) => n >= MIN_POOL).map(([v]) => v));
};

let previos: Set<string> | null = null;
for (const paso of PASOS) {
  const xs = prestamos.filter(paso.f);
  const ev = xs.reduce((t, p) => t + p.evento, 0);
  const ahora = evaluables(paso.f);
  const salen = previos ? [...previos].filter((v) => !ahora.has(v)) : [];
  previos = ahora;
  console.log(
    `  ${paso.etiqueta.padEnd(16)} ${String(xs.length).padStart(9)} ${String(ev).padStart(9)} ` +
      `${pct(ev / xs.length).padStart(8)} ${String(ahora.size).padStart(14)}   ` +
      `\x1b[90m${salen.length === 0 ? "—" : salen.join(", ")}\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// 3. ¿Los que se caen son distintos de los que quedan?
// ---------------------------------------------------------------------------

const quedan = prestamos.filter(completo);
const caen = prestamos.filter((p) => !completo(p));
const tasaQuedan = quedan.reduce((t, p) => t + p.evento, 0) / Math.max(1, quedan.length);
const tasaCaen = caen.reduce((t, p) => t + p.evento, 0) / Math.max(1, caen.length);
const dObs = tasaQuedan - tasaCaen;

console.log(`\n${"═".repeat(78)}`);
console.log("¿Los préstamos que sobreviven al estrato son distintos de los que no?");
console.log(`${"═".repeat(78)}\n`);
console.log(
  `  quedan:  ${String(quedan.length).padStart(5)} préstamos   ` +
    `${String(quedan.reduce((t, p) => t + p.evento, 0)).padStart(4)} eventos   ${pct(tasaQuedan, 2).padStart(7)}`,
);
console.log(
  `  se caen: ${String(caen.length).padStart(5)} préstamos   ` +
    `${String(caen.reduce((t, p) => t + p.evento, 0)).padStart(4)} eventos   ${pct(tasaCaen, 2).padStart(7)}`,
);
console.log(`  \x1b[1mdiferencia: ${(dObs * 100).toFixed(2)} pp\x1b[0m`);

/**
 * NULO A: permutar la etiqueta DENTRO de cada emisión.
 *
 * Pregunta: dado el documento, ¿la falta de dato acompaña al evento? Solo puede
 * responder sobre las emisiones partidas — en las todo-o-nada no hay nada que
 * permutar, y esos préstamos entran a la diferencia observada sin poder entrar
 * al nulo. Por eso se reporta aparte cuánto de la diferencia vive ahí.
 */
function permutarDentro(semilla: number): number {
  const rand = rng(semilla);
  let sq = 0, nq = 0, sc = 0, nc = 0;
  for (const [, xs] of porEmision) {
    const k = xs.filter(completo).length;
    const idx = xs.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    for (let i = 0; i < idx.length; i++) {
      const p = xs[idx[i]!]!;
      if (i < k) { sq += p.evento; nq++; } else { sc += p.evento; nc++; }
    }
  }
  return sq / Math.max(1, nq) - sc / Math.max(1, nc);
}

/**
 * NULO B: permutar a nivel EMISIÓN.
 *
 * Si la falta de dato es del documento, la pregunta correcta es otra: ¿las
 * emisiones que publican el estrato completo tienen tasas distintas de las que
 * no? Se reasigna al azar qué emisiones son completas, conservando cuántas hay,
 * y se recalcula la diferencia agrupada.
 *
 * Este nulo no dice nada sobre préstamos. Dice si el conjunto de documentos que
 * sobrevive al filtro se parece al que no.
 */
const emisiones = [...porEmision.entries()].map(([acc, xs]) => ({
  acc,
  n: xs.length,
  ev: xs.reduce((t, p) => t + p.evento, 0),
  completos: xs.filter(completo).length,
}));
/**
 * La observada del nulo B se mide en la unidad que el nulo permuta: emisiones
 * enteras. Compararla contra la diferencia préstamo a préstamo sería comparar el
 * estadístico contra la distribución de otro — el permutado incluye TODOS los
 * préstamos de una emisión completa, y la observada préstamo a préstamo no.
 */
const esCompleta = (e: { n: number; completos: number }) => e.completos > e.n / 2;
const nCompletas = emisiones.filter(esCompleta).length;
const agr = (f: (e: (typeof emisiones)[number]) => boolean) => {
  const xs = emisiones.filter(f);
  const n = xs.reduce((t, e) => t + e.n, 0);
  return n === 0 ? 0 : xs.reduce((t, e) => t + e.ev, 0) / n;
};
const dObsEmision = agr(esCompleta) - agr((e) => !esCompleta(e));

function permutarEntre(semilla: number): number {
  const rand = rng(semilla);
  const idx = emisiones.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  let sq = 0, nq = 0, sc = 0, nc = 0;
  for (let i = 0; i < idx.length; i++) {
    const e = emisiones[idx[i]!]!;
    if (i < nCompletas) { sq += e.ev; nq += e.n; } else { sc += e.ev; nc += e.n; }
  }
  return sq / Math.max(1, nq) - sc / Math.max(1, nc);
}

function pValor(obs: number, sim: number[]): number {
  const extremos = sim.filter((d) => Math.abs(d) >= Math.abs(obs)).length;
  return (extremos + 1) / (sim.length + 1);
}

/**
 * LA DISPERSIÓN VA ALREDEDOR DE LA MEDIA DEL NULO, NO DE CERO.
 *
 * La primera versión usaba la raíz del promedio de cuadrados, que es la
 * dispersión alrededor de cero. Cuando el nulo es degenerado —todas las réplicas
 * devuelven la observada porque no hay nada que permutar— esa cuenta no da cero:
 * da el tamaño del efecto. La calibración lo mostró con datos sintéticos: con
 * falta de dato todo-o-nada y un efecto real de 4 pp, imprimía "3,84 pp" y no
 * disparaba ninguna advertencia. El diagnóstico tapaba justo el caso que existe
 * para detectar.
 *
 * Así que se miden dos cosas distintas: cuánto se mueve el nulo alrededor de sí
 * mismo, y qué porción de las réplicas es literalmente idéntica a la observada.
 * La segunda es la que detecta la degeneración.
 */
function resumen(obs: number, sim: number[]) {
  const media = sim.reduce((t, d) => t + d, 0) / sim.length;
  const sd = Math.sqrt(sim.reduce((t, d) => t + (d - media) ** 2, 0) / sim.length);
  const inmoviles = sim.filter((d) => Math.abs(d - obs) < 1e-12).length / sim.length;
  return { p: pValor(obs, sim), sd, inmoviles };
}

const simA: number[] = [];
const simB: number[] = [];
for (let i = 0; i < REPLICAS; i++) {
  simA.push(permutarDentro(0x5eed + i));
  simB.push(permutarEntre(0xbeef + i));
}
const rA = resumen(dObs, simA);
const rB = resumen(dObsEmision, simB);

console.log(
  `\n  \x1b[90mNulo A — permutando dentro de cada emisión (¿la falta acompaña al evento?)\x1b[0m`,
);
console.log(
  `    p = ${rA.p.toFixed(4)}   \x1b[90mdispersión del nulo: ${(rA.sd * 100).toFixed(2)} pp · ` +
    `${pct(rA.inmoviles, 0)} de las réplicas no se movieron\x1b[0m` +
    (rA.inmoviles > 0.5
      ? `\n    \x1b[31m← SIN POTENCIA: la mayoría de las emisiones no tiene qué permutar.\x1b[0m` +
        `\n    \x1b[31m  Este p-valor no distingue "no hay efecto" de "no se puede ver".\x1b[0m`
      : ""),
);
console.log(
  `\n  \x1b[90mNulo B — permutando qué emisiones son completas (¿son otros documentos?)\x1b[0m`,
);
console.log(
  `    \x1b[90mdiferencia entre emisiones: ${(dObsEmision * 100).toFixed(2)} pp\x1b[0m`,
);
console.log(
  `    p = ${rB.p.toFixed(4)}   \x1b[90mdispersión del nulo: ${(rB.sd * 100).toFixed(2)} pp\x1b[0m`,
);

console.log(
  `\n  \x1b[90mCuál leer lo decide la primera tabla: si las emisiones son todo-o-nada, el\x1b[0m`,
);
console.log(
  `  \x1b[90mnulo A no tiene qué permutar y su p-valor no significa nada. ` +
    `Hoy quedan partidas ${pct(shareParcial, 0)}.\x1b[0m`,
);

// ---------------------------------------------------------------------------
// 4. Por originador: ¿a quién le cambia la tasa al filtrarse?
// ---------------------------------------------------------------------------

const porVendedor = new Map<string, Prestamo[]>();
for (const p of prestamos) {
  const xs = porVendedor.get(p.vendedor) ?? [];
  xs.push(p);
  porVendedor.set(p.vendedor, xs);
}

console.log(`\n${"═".repeat(78)}`);
console.log("Por originador: la tasa antes y después del filtro");
console.log(`${"═".repeat(78)}\n`);
console.log(`  vendedor         pool   tasa cruda    quedan   tasa filtrada    cambio`);
console.log(`  ${"─".repeat(72)}`);

const filas = [...porVendedor]
  .filter(([, xs]) => xs.length >= MIN_POOL)
  .map(([v, xs]) => {
    const q = xs.filter(completo);
    const tc = xs.reduce((t, p) => t + p.evento, 0) / xs.length;
    const tf = q.length === 0 ? null : q.reduce((t, p) => t + p.evento, 0) / q.length;
    return { v, n: xs.length, q: q.length, tc, tf };
  })
  .sort((a, b) => (b.tf === null ? -1 : a.tf === null ? 1 : b.tf - b.tc - (a.tf - a.tc)));

for (const f of filas) {
  const cambio = f.tf === null ? null : f.tf - f.tc;
  const sale = f.q < MIN_POOL;
  console.log(
    `  ${f.v.slice(0, 16).padEnd(17)} ${String(f.n).padStart(4)} ${pct(f.tc).padStart(11)}   ` +
      `${String(f.q).padStart(6)} ${(f.tf === null ? "—" : pct(f.tf)).padStart(14)}   ` +
      `${cambio === null ? "" : `${cambio > 0 ? "+" : ""}${(cambio * 100).toFixed(1)} pp`.padStart(8)}` +
      (sale ? `  \x1b[33m← sale de la tabla\x1b[0m` : ""),
  );
}

/**
 * El cambio de tasa por originador NO se puede leer de a uno.
 *
 * Con doce originadores mirando cuál se movió más, el máximo de doce diferencias
 * ruidosas siempre parece grande. Lo que sí se puede leer es si los cambios están
 * centrados en cero o corridos: si el filtro fuera ciego al evento, subir y bajar
 * deberían repartirse parejo.
 */
const cambios = filas.filter((f) => f.tf !== null).map((f) => f.tf! - f.tc);
const suben = cambios.filter((c) => c > 0).length;
console.log(
  `\n  \x1b[90mSuben ${suben} de ${cambios.length}. Si el filtro fuera ciego al evento se esperaría\x1b[0m`,
);
console.log(
  `  \x1b[90mla mitad. Ninguna fila individual significa nada: el máximo de ${cambios.length} diferencias\x1b[0m`,
);
console.log(`  \x1b[90mruidosas siempre parece grande.\x1b[0m`);

console.log(`\n\x1b[90m  ${estampa(estado)}\x1b[0m\n`);

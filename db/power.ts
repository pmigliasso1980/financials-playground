/**
 * ¿Qué efecto puede detectar esta muestra, y cuál nunca pudo?
 *
 *   npm run db:power
 *
 * POR QUÉ EXISTE ESTE ARCHIVO
 *
 * Tres hipótesis murieron en este proyecto: "la oficina se suscribe más
 * agresivo", "multifamily rompe la banda de LTV", y "el crecimiento del NOI
 * entregado se derrumbó entre 2021 y 2024". Cero sobrevivieron.
 *
 * Tres de tres empieza a no ser mala suerte. La explicación más económica no es
 * que el mercado sea aburrido: es que le estamos pidiendo al dato una precisión
 * que no tiene, y que cada "hallazgo" era ruido con forma de patrón.
 *
 * Esto es comprobable. La mediana del crecimiento de NOI de una añada se calcula
 * sobre 89 a 157 préstamos, y el crecimiento de NOI de una propiedad individual
 * tiene una dispersión enorme —un inquilino que se va mueve el número treinta
 * puntos—. Si el intervalo de confianza de esa mediana mide ±3 puntos, entonces
 * ninguna diferencia menor a ~8 puntos entre dos añadas es distinguible del azar,
 * y las tres hipótesis estaban muertas antes de formularse.
 *
 * QUÉ HACE
 *
 * Bootstrap: remuestrea con reemplazo cada añada 2.000 veces y mide cómo se
 * mueve la mediana. El ancho de esa distribución es el ruido de muestreo, y no
 * depende de ningún supuesto sobre la forma de la distribución —que es
 * exactamente lo que necesitamos, porque estas colas no son normales—.
 *
 * De ahí salen dos números que valen más que cualquier hallazgo:
 *
 *   IC 95%   el rango donde está la mediana verdadera de esa añada
 *   MDE      la diferencia mínima entre dos añadas que podríamos detectar
 *
 * El MDE es el que decide el futuro del proyecto. Si es mayor que los efectos
 * que buscamos, no hay que buscar más fuerte: hay que cambiar de variable de
 * resultado o de pregunta.
 *
 * POR QUÉ LA SEMILLA ES FIJA
 *
 * Un verificador que devuelve un número distinto en cada corrida no sirve para
 * verificar. Con semilla fija, dos corridas sobre el mismo corpus dan lo mismo y
 * cualquier cambio en el resultado viene del dato, no del azar.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Mismo estrato que `db:bias`, por la misma razón: neutraliza el sesgo de tamaño. */
const BANDA_MIN = 10_000_000;
const BANDA_MAX = 30_000_000;
const RESAMPLES = 2000;
const MIN_N = 30;
const SEED = 20260815;

/**
 * El efecto que el hallazgo muerto afirmaba, para tenerlo como vara.
 *
 * El titular decía que el crecimiento entregado cayó de 11,5% a 1,0%: 10,5
 * puntos. Si el MDE resulta mayor que eso, la muestra nunca pudo sostener esa
 * afirmación —ni siquiera si hubiera sido cierta—.
 */
const EFECTO_AFIRMADO = 0.105;

const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

/** Generador con semilla: mismo corpus, mismo resultado, siempre. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = n >> 1;
  return n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Distribución de la mediana bajo remuestreo.
 *
 * Cada réplica toma n valores CON REEMPLAZO de la misma muestra y calcula su
 * mediana. La dispersión de esas 2.000 medianas es cuánto se movería el número
 * si hubiéramos sorteado otros préstamos — que es justo lo que queremos saber.
 */
function bootstrapMedian(
  values: number[],
  rng: () => number,
): { lo: number; hi: number; se: number } {
  const n = values.length;
  const medians = new Float64Array(RESAMPLES);
  const buf = new Float64Array(n);

  for (let r = 0; r < RESAMPLES; r++) {
    for (let i = 0; i < n; i++) buf[i] = values[Math.floor(rng() * n)]!;
    const sorted = Array.from(buf).sort((a, b) => a - b);
    medians[r] = median(sorted);
  }

  const ms = Array.from(medians).sort((a, b) => a - b);
  const mean = ms.reduce((a, b) => a + b, 0) / RESAMPLES;
  const varianza = ms.reduce((a, b) => a + (b - mean) ** 2, 0) / (RESAMPLES - 1);

  return {
    lo: ms[Math.floor(0.025 * RESAMPLES)]!,
    hi: ms[Math.floor(0.975 * RESAMPLES)]!,
    se: Math.sqrt(varianza),
  };
}

console.log(`\n${"═".repeat(78)}`);
console.log("Piso de ruido — qué efecto puede detectar esta muestra");
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  Bootstrap de ${RESAMPLES.toLocaleString("en-US")} réplicas, semilla fija, banda ${BANDA_MIN / 1e6}M-${BANDA_MAX / 1e6}M.\x1b[0m`,
);
console.log(
  `\x1b[90m  La banda es la misma que db:bias: neutraliza el sesgo de tamaño.\x1b[0m\n`,
);

const { rows } = await query<{ anada: string; valores: number[] }>(
  `SELECT extract(year FROM originated_at)::int::text AS anada,
          array_agg(growth_delivered) AS valores
     FROM corpus.underwriting_outcomes
    WHERE days_after_origination >= 0
      AND is_full_year
      AND growth_delivered IS NOT NULL
      AND loan_amount_senior BETWEEN ${BANDA_MIN} AND ${BANDA_MAX}
    GROUP BY 1
   HAVING count(*) >= ${MIN_N}
    ORDER BY 1`,
);

if (rows.length < 2) {
  console.log(
    `  \x1b[33mMenos de dos añadas con n ≥ ${MIN_N}. Corré db:performance primero.\x1b[0m\n`,
  );
  await closePool();
  process.exit(0);
}

const rng = makeRng(SEED);

interface Anada {
  anada: string;
  n: number;
  mediana: number;
  lo: number;
  hi: number;
  se: number;
}

const anadas: Anada[] = [];

console.log(`  añada    n    mediana        IC 95%              ancho`);
console.log(`  ${"─".repeat(62)}`);

for (const r of rows) {
  const values = r.valores.map(Number).filter(Number.isFinite);
  if (values.length < MIN_N) continue;

  const { lo, hi, se } = bootstrapMedian(values, rng);
  const sorted = [...values].sort((a, b) => a - b);
  const med = median(sorted);

  anadas.push({ anada: r.anada, n: values.length, mediana: med, lo, hi, se });
  console.log(
    `  ${r.anada}   ${String(values.length).padStart(3)}    ${pct(med).padStart(6)}    ` +
      `[${pct(lo).padStart(6)} , ${pct(hi).padStart(6)}]      ${pct(hi - lo).padStart(6)}`,
  );
}

/**
 * La diferencia mínima detectable entre dos añadas.
 *
 * El error estándar de una DIFERENCIA de dos medianas independientes es la raíz
 * de la suma de sus varianzas. Con 95% de confianza hace falta que la diferencia
 * supere 1,96 de esos errores para no ser atribuible al azar.
 *
 * Se usa el error estándar mediano entre añadas, no el mejor ni el peor: el
 * mejor sería vender la muestra más favorable y el peor sería castigarla por su
 * añada más pobre.
 */
const ses = anadas.map((a) => a.se).sort((a, b) => a - b);
const seTipico = median(ses);
const mde = 1.96 * Math.sqrt(2) * seTipico;

console.log(`\n${"─".repeat(78)}`);
console.log("Qué se puede detectar");
console.log(`${"─".repeat(78)}\n`);

console.log(`  Error estándar típico de una mediana anual:  ${pct(seTipico, 2)}`);
console.log(`  Diferencia mínima detectable entre dos añadas: \x1b[1m${pct(mde)}\x1b[0m`);
console.log(`  Efecto que afirmaba el hallazgo muerto:        ${pct(EFECTO_AFIRMADO)}\n`);

/**
 * Cuántos préstamos harían falta.
 *
 * El error estándar cae con la raíz de n, así que para detectar un efecto k
 * veces más chico hace falta k² veces más muestra. Es el número que decide si
 * "buscar más fuentes" es una estrategia o una ilusión.
 */
const nTipico = median(anadas.map((a) => a.n).sort((a, b) => a - b));
const objetivo = 0.05;
const factor = (mde / objetivo) ** 2;

if (mde >= EFECTO_AFIRMADO) {
  console.log(`  \x1b[31mLA MUESTRA NUNCA PUDO SOSTENER EL HALLAZGO.\x1b[0m`);
  console.log(
    `  \x1b[90mEl efecto afirmado es más chico que el ruido de muestreo. Aunque el\x1b[0m`,
  );
  console.log(
    `  \x1b[90mderrumbe hubiera sido real, no habríamos podido distinguirlo del azar.\x1b[0m\n`,
  );
} else {
  console.log(`  \x1b[33mEl efecto afirmado supera el piso de ruido.\x1b[0m`);
  console.log(
    `  \x1b[90mLa muestra podía detectarlo en principio; que no aparezca al\x1b[0m`,
  );
  console.log(`  \x1b[90mestratificar es evidencia de que no está.\x1b[0m\n`);
}

/** Pares de añadas cuyos intervalos NO se pisan: las únicas diferencias reales. */
const distinguibles: string[] = [];
for (let i = 0; i < anadas.length; i++) {
  for (let j = i + 1; j < anadas.length; j++) {
    const a = anadas[i]!;
    const b = anadas[j]!;
    if (a.hi < b.lo || b.hi < a.lo) {
      distinguibles.push(`${a.anada} vs ${b.anada}`);
    }
  }
}

const pares = (anadas.length * (anadas.length - 1)) / 2;
console.log(
  `  Pares de añadas con intervalos que NO se pisan: ${distinguibles.length} de ${pares}`,
);
if (distinguibles.length > 0) {
  console.log(`  \x1b[90m${distinguibles.join(" · ")}\x1b[0m`);
} else {
  console.log(
    `  \x1b[90mNinguno. Todas las añadas son estadísticamente indistinguibles\x1b[0m`,
  );
  console.log(`  \x1b[90mentre sí con esta muestra.\x1b[0m`);
}

console.log(`\n${"─".repeat(78)}`);
console.log("Qué haría falta");
console.log(`${"─".repeat(78)}\n`);
console.log(
  `  Para detectar un efecto de ${pct(objetivo, 0)} harían falta ~${Math.round(factor)}x más préstamos`,
);
console.log(
  `  por añada: de ${Math.round(nTipico)} a ~${Math.round(nTipico * factor).toLocaleString("en-US")}.\n`,
);
console.log(
  `  \x1b[90mEl corpus tiene 8.935 préstamos y solo ~2.200 con desempeño. Llegar a\x1b[0m`,
);
console.log(
  `  \x1b[90mese número por añada no es cuestión de cosechar más trusts: no existen\x1b[0m`,
);
console.log(`  \x1b[90mtantas emisiones CMBS por año.\x1b[0m\n`);
console.log(
  `  \x1b[90mLa salida no es más muestra sobre la misma variable. Es una variable de\x1b[0m`,
);
console.log(
  `  \x1b[90mresultado menos ruidosa —morosidad es binaria y está en los mismos 10-D\x1b[0m`,
);
console.log(`  \x1b[90mque ya bajamos— o preguntas transversales, donde el n está en los miles.\x1b[0m\n`);

await closePool();

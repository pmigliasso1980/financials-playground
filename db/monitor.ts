/**
 * El monitor: lo que antes te pedía correr a mano, corriendo solo.
 *
 *   npm run db:monitor
 *
 * QUÉ REEMPLAZA
 *
 * Durante toda la construcción del corpus hubo un ciclo manual: correr un script
 * de diagnóstico, pegar la salida, leerla entre dos. Eso servía para DESCUBRIR
 * —cada corrida hacía una pregunta nueva— pero es la peor forma posible de
 * VIGILAR, porque depende de que alguien se acuerde.
 *
 * Las preguntas ya están decididas. Lo que queda es que alguien las haga todos los
 * días sin que se le pida, y avise solo cuando algo cambió.
 *
 * LA REGLA QUE HACE QUE UN MONITOR SE LEA
 *
 * **Solo imprime lo que cambió.** Un monitor que reporta todo cada vez enseña a
 * ignorarlo, y a las dos semanas nadie lo mira. Si el corpus está igual, esto son
 * tres líneas.
 *
 * COMPARA CONTRA LA CORRIDA ANTERIOR, NO CONTRA UMBRALES INVENTADOS
 *
 * "La cobertura de DSCR es 78%" no dice nada sin referencia: puede ser lo normal
 * de este corpus o una caída de veinte puntos. Lo que importa es el cambio, así
 * que cada corrida guarda su foto en `out/salud.json` y la siguiente compara.
 *
 * La primera corrida no puede alertar de nada —no hay contra qué— y lo dice en vez
 * de fingir que todo está bien.
 *
 * SALE CON CÓDIGO 1 SI HAY ALGO QUE MIRAR
 *
 * Para que sirva en cron: `npm run db:monitor || mandar-mail`. Un monitor que
 * siempre sale con 0 es un log.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { closePool, ping, query } from "./client.js";
import { estadoCorpus, estampa } from "./procedencia.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Cuánto puede caer una cobertura antes de que sea noticia. */
const CAIDA_ALERTA = 0.02;

const ARCHIVO = new URL("../out/salud.json", import.meta.url).pathname;
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

interface Foto {
  fecha: string;
  taxonomia: string;
  prestamos: number;
  emisiones: number;
  cobertura: Record<string, number>;
  sinTipo: number;
  headersSinMapear: string[];
}

/**
 * Las métricas que el producto usa. Si la cobertura de una de estas cae, `/comps`
 * empieza a contestar con menos base sin que nada lo diga.
 */
const CLAVE = ["loan_amount", "dscr", "ltv", "debt_yield", "interest_rate"];

/**
 * EL CAMPO QUE NUNCA AUDITAMOS.
 *
 * `/comps` filtra por cuatro campos: estado, tipo, monto y fecha. De los cuatro,
 * tres pasaron por una revisión —el tipo tiene su propio diagnóstico, el monto y
 * las métricas tienen cobertura vigilada— y el estado nunca.
 *
 * La sospecha llegó por el costado: industrial en California da 9 comparables y el
 * Pacífico entero también 9. Oregón, Washington, Alaska y Hawái no aportan ninguno
 * en dieciocho meses. Seattle y Portland son mercados industriales de verdad, así
 * que o es real, o el estado está mal escrito en algunos documentos y esos
 * préstamos no entran a ninguna consulta.
 *
 * Un estado inválido no es como una cobertura que cae: es un defecto lo tenga o no
 * la corrida anterior, así que se reporta SIEMPRE y no solo cuando cambia.
 */
async function estadosInvalidos() {
  const { rows } = await query<{ valor: string; n: string }>(
    `SELECT coalesce(nullif(btrim(state), ''), '(vacío)') AS valor, count(*)::text AS n
       FROM corpus.loans
      WHERE state IS NULL OR btrim(state) !~ '^[A-Za-z]{2}$'
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 12`,
  );
  return rows.map((r) => ({ valor: r.valor, n: Number(r.n) }));
}

async function tomarFoto(): Promise<Foto> {
  const e = await estadoCorpus();

  const { rows: cob } = await query<{ metrica: string; n: string }>(
    `SELECT metric_key AS metrica, count(DISTINCT loan_id)::text AS n
       FROM corpus.facts
      WHERE metric_key = ANY($1) AND value ~ '^[0-9.]+$'
      GROUP BY 1`,
    [CLAVE],
  );
  const cobertura: Record<string, number> = {};
  for (const r of cob) cobertura[r.metrica] = Number(r.n) / Math.max(1, e.prestamos);

  const { rows: st } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM corpus.loans WHERE property_type IS NULL`,
  );

  /**
   * Los encabezados sin mapear son la cola de trabajo del parser: si aparece uno
   * nuevo, un emisor cambió su formato y estamos perdiendo una columna.
   */
  const { rows: hs } = await query<{ header: string }>(
    `SELECT header FROM corpus.unmapped_headers ORDER BY filings DESC LIMIT 400`,
  );

  return {
    fecha: new Date().toISOString(),
    taxonomia: e.taxonomia,
    prestamos: e.prestamos,
    emisiones: e.emisiones,
    cobertura,
    sinTipo: Number(st[0]!.n),
    headersSinMapear: hs.map((r) => r.header),
  };
}

const hoy = await tomarFoto();
const invalidos = await estadosInvalidos();

/**
 * Los estados con menos préstamos de los que su mercado haría esperar. No es una
 * alerta —puede ser real— pero es el dato que hace falta para decidir si una
 * región vacía es del mercado o del parser.
 */
const { rows: porEstado } = await query<{ estado: string; n: string }>(
  `SELECT btrim(state) AS estado, count(*)::text AS n
     FROM corpus.loans
    WHERE btrim(state) ~ '^[A-Za-z]{2}$'
    GROUP BY 1 ORDER BY count(*) DESC`,
);
const estado = await estadoCorpus();
await closePool();

let anterior: Foto | null = null;
try {
  anterior = JSON.parse(await readFile(ARCHIVO, "utf8")) as Foto;
} catch {
  anterior = null;
}

const alertas: string[] = [];
const notas: string[] = [];

/**
 * Esta no necesita comparación: más de una versión de taxonomía conviviendo
 * significa que parte del corpus se cosechó con otro mapeo, y cualquier consulta
 * que cruce las dos mezcla criterios distintos.
 */
if (estado.versiones > 1) {
  alertas.push(
    `${estado.versiones} versiones de taxonomía conviven en el corpus: parte quedó sin recosechar`,
  );
}

if (!anterior) {
  notas.push("Primera corrida: no hay foto anterior contra la cual comparar.");
} else {
  if (hoy.taxonomia !== anterior.taxonomia) {
    notas.push(`Taxonomía: ${anterior.taxonomia} → ${hoy.taxonomia} (los números pueden moverse)`);
  }

  const dPrestamos = hoy.prestamos - anterior.prestamos;
  if (dPrestamos !== 0) {
    notas.push(
      `Préstamos: ${anterior.prestamos.toLocaleString("en-US")} → ${hoy.prestamos.toLocaleString("en-US")}` +
        ` (${dPrestamos > 0 ? "+" : ""}${dPrestamos.toLocaleString("en-US")})`,
    );
  }

  for (const m of CLAVE) {
    const antes = anterior.cobertura[m] ?? 0;
    const ahora = hoy.cobertura[m] ?? 0;
    if (antes - ahora >= CAIDA_ALERTA) {
      alertas.push(
        `Cobertura de ${m} cayó de ${pct(antes)} a ${pct(ahora)} — /comps contesta con menos base`,
      );
    }
  }

  /**
   * El agujero de tipo se mide en porción, no en cantidad: si el corpus crece un
   * 20% es normal que suban los préstamos sin tipo, y eso no es una regresión.
   */
  const antesShare = anterior.sinTipo / Math.max(1, anterior.prestamos);
  const ahoraShare = hoy.sinTipo / Math.max(1, hoy.prestamos);
  if (ahoraShare - antesShare >= 0.005) {
    alertas.push(
      `Préstamos sin tipo de propiedad: ${pct(antesShare, 2)} → ${pct(ahoraShare, 2)}` +
        ` (${anterior.sinTipo} → ${hoy.sinTipo})`,
    );
  }

  const nuevos = hoy.headersSinMapear.filter((h) => !anterior!.headersSinMapear.includes(h));
  if (nuevos.length > 0) {
    alertas.push(
      `${nuevos.length} encabezado(s) sin mapear que antes no estaban — un emisor cambió de formato:\n` +
        nuevos.slice(0, 6).map((h) => `      · ${h.slice(0, 70)}`).join("\n"),
    );
  }
}

if (invalidos.length > 0) {
  const total = invalidos.reduce((t, i) => t + i.n, 0);
  alertas.push(
    `${total} préstamos con estado inválido o vacío — no entran a ninguna consulta de /comps:\n` +
      invalidos.map((i) => `      "${i.valor}" × ${i.n}`).join("\n"),
  );
}

await mkdir(new URL("../out/", import.meta.url).pathname, { recursive: true });
await writeFile(ARCHIVO, JSON.stringify(hoy, null, 2), "utf8");

// ---------------------------------------------------------------------------

console.log(`\n  ${estampa(estado)}`);
console.log(
  `  \x1b[90m${porEstado.length} estados con código válido · ` +
    `los cinco con más préstamos: ${porEstado.slice(0, 5).map((e) => `${e.estado} ${e.n}`).join(" · ")}\x1b[0m`,
);
/**
 * Los estados con mercado real y pocos préstamos son la pista de un hueco de
 * cosecha. Se listan sin alarma: puede ser el mercado y puede ser el parser.
 */
const GRANDES = ["CA", "TX", "NY", "FL", "IL", "PA", "OH", "GA", "NC", "MI", "NJ", "VA", "WA", "AZ", "MA"];
const cuantos = (g: string) => Number(porEstado.find((e) => e.estado === g)?.n ?? 0);
const flacos = GRANDES.filter((g) => cuantos(g) < 30);
if (flacos.length > 0) {
  console.log(
    `  \x1b[90mestados grandes con menos de 30 préstamos: ` +
      `${flacos.map((f) => `${f} (${cuantos(f)})`).join(" · ")}\x1b[0m`,
  );
}

if (alertas.length === 0 && notas.length === 0) {
  console.log(`\n  \x1b[32mSin cambios.\x1b[0m\n`);
  process.exit(0);
}

for (const n of notas) console.log(`\n  \x1b[90m· ${n}\x1b[0m`);

if (alertas.length > 0) {
  console.log(`\n  \x1b[31m${alertas.length} cosa(s) para mirar:\x1b[0m\n`);
  for (const a of alertas) console.log(`  \x1b[33m→ ${a}\x1b[0m`);
  console.log(
    `\n  \x1b[90mDiagnóstico del agujero de tipo:  npm run db:type-gap\x1b[0m`,
  );
  console.log(`  \x1b[90mCobertura por métrica:            npm run db:coverage\x1b[0m\n`);
  process.exit(1);
}

console.log();
process.exit(0);

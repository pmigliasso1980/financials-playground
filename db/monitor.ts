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

await mkdir(new URL("../out/", import.meta.url).pathname, { recursive: true });
await writeFile(ARCHIVO, JSON.stringify(hoy, null, 2), "utf8");

// ---------------------------------------------------------------------------

console.log(`\n  ${estampa(estado)}`);

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

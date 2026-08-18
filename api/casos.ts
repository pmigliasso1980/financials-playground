/**
 * Los casos de uso, corridos contra el corpus real.
 *
 *   npm run api:casos
 *
 * POR QUÉ ESTO Y NO "ESPERAR A QUE UN BROKER LO USE"
 *
 * No hay broker. Decir "esperemos feedback" era una forma elegante de no decidir:
 * los usuarios somos nosotros hasta que haya otro, y podemos ejercitar el producto
 * hoy con escenarios que sabemos que existen en el mercado.
 *
 * NO ES UN TEST
 *
 * No afirma que un resultado sea correcto. Corre doce situaciones reales y muestra
 * qué contesta el producto en cada una, para que la pregunta "¿esto sirve?" se
 * mire con datos en vez de discutirse.
 *
 * El número que importa es cuántos de los doce el corpus puede responder. Si son
 * dos, hay un producto muy angosto. Si son diez, hay algo.
 *
 * LOS ESCENARIOS SE ELIGIERON PARA QUE FALLE
 *
 * La tentación sería poner doce casos de multifamily en Texas y celebrar. Están
 * elegidos al revés: mercados secundarios, tipos difíciles, montos chicos y
 * grandes. Si el producto solo funciona en el centro de la distribución, quiero
 * que se vea acá y no cuando alguien lo pruebe.
 *
 * Y UNA NEGATIVA TAMBIÉN ES UN CASO DE USO
 *
 * Que no haya comparables conduit para un préstamo de 4 millones en un mercado
 * chico NO es una falla del producto: es la respuesta. Significa "esto no es un
 * deal conduit, buscá un banco o una agencia". Los casos marcados con ← esperado
 * son ésos: si devolvieran un rango, ahí sí habría un problema.
 *
 * UNA EXPECTATIVA MÍA QUE ESTABA MAL
 *
 * La primera versión marcaba "Retail OH 4M" como negativa esperada, con el
 * argumento de que un préstamo chico en un mercado secundario no es conduit. Pero
 * la corrida mostró 24 comparables a nivel nacional: no era un problema de canal,
 * era el mismo problema de geografía que Nueva Jersey.
 *
 * O sea que puse una expectativa en el test y la expectativa era falsa. Con la
 * escalera geográfica ese caso debería contestarse, así que deja de estar marcado.
 *
 * Y DESPUÉS LA ESCALERA SE PASÓ DE LARGO
 *
 * Con el escalón nacional automático, los doce casos pasaron a contestarse y las
 * negativas cayeron a CERO. Parecía un triunfo: era que el producto había perdido
 * la capacidad de decir que no, porque el país siempre tiene diez préstamos de
 * cualquier tipo.
 *
 * El radio automático ahora llega hasta la región. Wyoming vuelve a ser un vacío
 * esperado — y con `nacional: true` se puede pedir la respuesta nacional a
 * propósito, que es otra afirmación.
 */

import { buscarComparables, type Criterios, type Tipo } from "./comps.js";
import { closePool, ping } from "../db/client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

interface Caso {
  quien: string;
  decide: string;
  criterios: Criterios;
  /** true si esperamos que NO haya comparables y eso esté bien. */
  esperaVacio?: boolean;
}

const CASOS: Caso[] = [
  {
    quien: "Broker · refinanciación",
    decide: "si el 70% de LTV que pide el cliente es realista",
    criterios: { estado: "GA", tipo: "Multifamily", monto: 28_000_000, ltvObjetivo: 0.7 },
  },
  {
    quien: "Broker · mercado grande",
    decide: "qué tasa esperar en el corredor más líquido del país",
    criterios: { estado: "TX", tipo: "Multifamily", monto: 15_000_000 },
  },
  {
    quien: "Broker · oficinas",
    decide: "si todavía hay apetito conduit para oficinas y a qué apalancamiento",
    criterios: { estado: "NY", tipo: "Office", monto: 45_000_000, ltvObjetivo: 0.6 },
  },
  {
    quien: "Broker · industrial",
    decide: "el debt yield al que están saliendo los galpones",
    criterios: { estado: "CA", tipo: "Industrial", monto: 30_000_000 },
  },
  {
    quien: "Broker · hotelería",
    decide: "si conviene ir a conduit o a deuda puente",
    criterios: { estado: "FL", tipo: "Hospitality", monto: 22_000_000 },
  },
  {
    quien: "Broker · retail",
    decide: "qué DSCR le van a exigir a un centro comercial",
    criterios: { estado: "FL", tipo: "Retail", monto: 12_000_000 },
  },
  {
    quien: "Prestamista · control de pricing",
    decide: "si su cotización está en mercado antes de mandarla",
    criterios: { estado: "NJ", tipo: "Industrial", monto: 25_000_000, ltvObjetivo: 0.65 },
  },
  {
    quien: "Inversor · cuánta deuda consigo",
    decide: "el apalancamiento máximo realista para modelar la compra",
    criterios: { estado: "NY", tipo: "Multifamily", monto: 60_000_000, ltvObjetivo: 0.75 },
  },
  {
    quien: "Broker · self storage",
    decide: "si un tipo de nicho tiene mercado conduit",
    criterios: { estado: "AZ", tipo: "Self Storage", monto: 8_000_000 },
  },
  {
    quien: "Broker · mixed use",
    decide: "cómo se financia un uso mixto en un mercado intermedio",
    criterios: { estado: "IL", tipo: "Mixed Use", monto: 20_000_000 },
  },
  {
    /** El caso donde la negativa ES la respuesta. */
    quien: "Broker · deal chico",
    decide: "si un préstamo de 4M en un mercado secundario es conduit",
    criterios: { estado: "OH", tipo: "Retail", monto: 4_000_000 },
  },
  {
    quien: "Broker · tipo raro en mercado chico",
    decide: "si vale la pena siquiera llamar a un originador conduit",
    criterios: { estado: "WY", tipo: "Manufactured", monto: 6_000_000 },
    esperaVacio: true,
  },
];

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const fmt: Record<string, (v: number) => string> = {
  ltv: pct, debt_yield: pct, interest_rate: pct, dscr: (v) => `${v.toFixed(2)}x`,
};

console.log(`\n${"═".repeat(78)}`);
console.log("Casos de uso, contra el corpus real");
console.log(`${"═".repeat(78)}`);

let respondidos = 0;
let vaciosEsperados = 0;
let vaciosProblema = 0;

for (const caso of CASOS) {
  const c = caso.criterios;
  const r = await buscarComparables(c);

  console.log(`\n${"─".repeat(78)}`);
  console.log(
    `  \x1b[1m${caso.quien}\x1b[0m — ${c.tipo} · ${c.estado} · ` +
      `${(c.monto / 1e6).toFixed(0)}M USD`,
  );
  console.log(`  \x1b[90mDecide: ${caso.decide}\x1b[0m\n`);

  if (!r.suficiente) {
    if (caso.esperaVacio) {
      vaciosEsperados++;
      console.log(
        `  \x1b[32m${r.encontrados} comparables — "esto no es un deal conduit"\x1b[0m` +
          `  \x1b[90m← respuesta esperada y útil\x1b[0m`,
      );
    } else {
      vaciosProblema++;
      console.log(
        `  \x1b[31m${r.encontrados} comparables — el producto no puede contestar\x1b[0m`,
      );
    }
    for (const p of r.escalera) {
      console.log(`    \x1b[90m${p.etiqueta} → ${p.encontrados}\x1b[0m`);
    }
    for (const s of r.siAmplias) {
      console.log(`    \x1b[90m${s.criterio} → ${s.encontrados}\x1b[0m`);
    }
    continue;
  }

  respondidos++;
  console.log(
    `  \x1b[1m${r.encontrados} comparables\x1b[0m en ` +
      `${r.alcance === "estado" ? "" : "\x1b[33m"}${r.alcanceEtiqueta}\x1b[0m` +
      (r.alcance === "estado"
        ? ""
        : `  \x1b[90m(${r.escalera[0]!.etiqueta} solo: ${r.escalera[0]!.encontrados})\x1b[0m`),
  );
  for (const m of r.distribuciones) {
    const f = fmt[m.metrica] ?? ((v: number) => v.toFixed(2));
    console.log(
      `    ${m.etiqueta.padEnd(12)} ${f(m.p50).padStart(8)}   ` +
        `\x1b[90m${f(m.p25)} – ${f(m.p75)}  ·  sobre ${m.base}\x1b[0m`,
    );
  }
  if (r.objetivo) {
    const share = r.objetivo.alcanzaron / Math.max(1, r.objetivo.de);
    console.log(
      `    \x1b[${share < 0.25 ? "33" : "32"}m→ ${r.objetivo.alcanzaron} de ${r.objetivo.de} ` +
        `llegaron a ${pct(r.objetivo.ltv)} de LTV${
          share < 0.25 ? " — revisar la expectativa" : " — está en mercado"
        }\x1b[0m`,
    );
  }
}

await closePool();

console.log(`\n${"═".repeat(78)}`);
console.log(
  `  \x1b[1m${respondidos} de ${CASOS.length}\x1b[0m casos respondidos con un rango.`,
);
console.log(
  `  \x1b[90m${vaciosEsperados} negativas esperadas (la negativa era la respuesta).\x1b[0m`,
);
if (vaciosProblema > 0) {
  console.log(
    `  \x1b[31m${vaciosProblema} casos que el producto debería contestar y no puede.\x1b[0m`,
  );
}
console.log(
  `\n  \x1b[90mEsto no verifica que los números sean correctos: muestra qué contesta el\x1b[0m`,
);
console.log(
  `  \x1b[90mproducto para que la pregunta "¿sirve?" se mire con datos.\x1b[0m\n`,
);

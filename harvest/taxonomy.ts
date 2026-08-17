/**
 * Genera el documento de la taxonomía CRE.
 *
 *   npm run taxonomy              imprime en pantalla
 *   npm run taxonomy -- --write   escribe docs/taxonomia-cre.md
 *
 * PARA QUÉ
 *
 * El conocimiento de dominio que acumulamos —que un Annex A publica cuatro
 * añadas de NOI, tres estructuras de LTV y dos bases de DSCR, y qué pasa si se
 * confunden— vive hoy en expresiones regulares. Eso funciona para el código
 * pero es inauditable para alguien del rubro.
 *
 * Este documento existe para que un suscriptor de CRE pueda leerlo, decir "esto
 * está mal" o "les falta tal distinción", sin abrir un archivo de TypeScript.
 * Esa revisión es la forma más barata de validar si el trabajo de normalización
 * vale algo.
 */

import { writeFile } from "node:fs/promises";
import { METRIC_SPECS, type MetricKey } from "./normalize/columnMap.js";
import { DEFINITIONS, TAXONOMY_VERSION } from "./normalize/definitions.js";

const write = process.argv.includes("--write");
const OUT = new URL("../docs/taxonomia-cre.md", import.meta.url).pathname;

const lines: string[] = [];
const p = (s = "") => lines.push(s);

// ---------------------------------------------------------------------------

p(`# Taxonomía CRE`);
p();
p(`> Versión ${TAXONOMY_VERSION} · ${METRIC_SPECS.length} métricas`);
p();
p(
  `Este documento describe cómo interpretamos las columnas de un Annex A de CMBS.`,
);
p(
  `Está pensado para que alguien que suscribe deals pueda revisarlo y marcar qué`,
);
p(`está mal o qué falta, sin leer código.`);
p();
p(
  `**Por qué existe.** Los datos son públicos: cualquiera puede bajar los mismos`,
);
p(
  `filings de SEC. Lo que no es trivial es interpretarlos. Un Annex A publica el`,
);
p(
  `NOI en cuatro añadas, el LTV contra tres denominadores distintos y el DSCR`,
);
p(
  `sobre dos bases. Confundirlos produce números plausibles y equivocados —el`,
);
p(`tipo de error que no salta a la vista y contamina todo lo que se derive.`);
p();

// --- incidentes ---------------------------------------------------------------

const incidents = Object.entries(DEFINITIONS).filter(([, d]) => d?.incident);

if (incidents.length > 0) {
  p(`## Errores que motivaron estas distinciones`);
  p();
  p(
    `Cada uno se detectó con datos reales. En todos los casos el valor extraído`,
  );
  p(`era correcto y la etiqueta estaba mal.`);
  p();

  for (const [key, def] of incidents) {
    p(`**${labelOf(key as MetricKey)}** — ${def!.incident}`);
    p();
  }
}

// --- métricas por familia --------------------------------------------------------

const families = new Map<string, MetricKey[]>();
for (const spec of METRIC_SPECS) {
  const family = DEFINITIONS[spec.key]?.family ?? "Otras";
  const list = families.get(family);
  if (list) list.push(spec.key);
  else families.set(family, [spec.key]);
}

// Las familias documentadas primero; "Otras" al final.
const ordered = [...families.entries()].sort((a, b) => {
  if (a[0] === "Otras") return 1;
  if (b[0] === "Otras") return -1;
  return 0;
});

p(`## Métricas`);
p();

for (const [family, keys] of ordered) {
  p(`### ${family}`);
  p();

  for (const key of keys) {
    const spec = METRIC_SPECS.find((s) => s.key === key)!;
    const def = DEFINITIONS[key];

    p(`#### ${spec.label}`);
    p();
    p(`\`${key}\` · ${unitLabel(spec.unit)} · nivel ${spec.entity === "deal" ? "préstamo" : "propiedad"}`);
    p();

    if (def?.definition) {
      p(def.definition);
      p();
    } else {
      p(`*Sin definición documentada.*`);
      p();
    }

    if (def?.disambiguation) {
      p(`**Cómo se distingue.** ${def.disambiguation}`);
      p();
    }

    p(`<details><summary>Encabezados que la capturan</summary>`);
    p();
    p("```");
    for (const pattern of spec.patterns) {
      p(`  ${describePattern(pattern)}`);
    }
    if (spec.exclude?.length) {
      p();
      p(`  se descarta si contiene:`);
      for (const pattern of spec.exclude) {
        p(`    ${describePattern(pattern)}`);
      }
    }
    p("```");
    p();
    p(`</details>`);
    p();
  }
}

// --- cómo revisarlo ----------------------------------------------------------------

p(`## Cómo revisar esto`);
p();
p(`Las preguntas que más valor tienen si trabajás en el rubro:`);
p();
p(`1. ¿Alguna definición está mal?`);
p(`2. ¿Falta alguna distinción que importe? Por ejemplo: ¿conviene separar`);
p(`   ocupación por tipo de activo, o el NOI ajustado por inquilinos únicos?`);
p(`3. ¿Alguna de estas distinciones es irrelevante en la práctica?`);
p(`4. ¿Hay columnas del Annex A que no capturamos y deberíamos?`);
p();
p(
  `Para ver qué columnas quedaron sin mapear en el corpus actual: \`npm run db:stats\`.`,
);
p();

// ---------------------------------------------------------------------------

const doc = lines.join("\n");

if (write) {
  await writeFile(OUT, doc);
  console.log(`\n  → docs/taxonomia-cre.md`);
  console.log(`  ${METRIC_SPECS.length} métricas · versión ${TAXONOMY_VERSION}`);
  const documented = METRIC_SPECS.filter((s) => DEFINITIONS[s.key]?.definition).length;
  console.log(
    `  ${documented} con definición, ${METRIC_SPECS.length - documented} sin documentar\n`,
  );
} else {
  console.log(doc);
}

// ---------------------------------------------------------------------------

function labelOf(key: MetricKey): string {
  return METRIC_SPECS.find((s) => s.key === key)?.label ?? key;
}

function unitLabel(unit: string): string {
  return (
    {
      currency: "moneda",
      percent: "porcentaje",
      ratio: "ratio",
      count: "conteo",
      years: "año",
      text: "texto",
    }[unit] ?? unit
  );
}

/**
 * Traduce una expresión regular a algo legible.
 *
 * No es exacto —una regex no siempre tiene una lectura natural— pero alcanza
 * para que alguien sin formación técnica entienda qué se está buscando.
 */
function describePattern(pattern: RegExp): string {
  return pattern.source
    .replace(/\\b/g, "")
    .replace(/\\s\*/g, " ")
    .replace(/\\s\+/g, " ")
    .replace(/\.\*/g, " … ")
    .replace(/\\\./g, ".")
    .replace(/\\\//g, "/")
    .replace(/\\\$/g, "$")
    .replace(/\(\?:/g, "(")
    .replace(/\\w\+/g, "…")
    .replace(/\?/g, "")
    .replace(/\^|\$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

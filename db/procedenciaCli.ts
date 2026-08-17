/**
 * Contra qué corpus están emitidos los veredictos del proyecto.
 *
 *   npm run db:procedencia
 *
 * Imprime el estado del corpus, los umbrales con la muestra contra la que se
 * justificó cada uno, y avisa cuáles conviene releer porque el corpus creció
 * desde entonces.
 *
 * POR QUÉ ES UN COMANDO Y NO UN COMENTARIO
 *
 * `db:power` decía que la muestra no podía detectar el efecto afirmado; el corpus
 * creció y ese veredicto se dio vuelta sin que nadie lo releyera, y un documento
 * siguió citando la versión vieja. Un comentario en el código no avisa. Esto sí,
 * y cuesta una línea agregarlo a cualquier rutina.
 */

import { closePool, ping } from "./client.js";
import { avisosDeCaducidad, estadoCorpus, estampa, sinReferencia, UMBRALES } from "./procedencia.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const e = await estadoCorpus();
await closePool();

console.log(`\n${"═".repeat(78)}`);
console.log("Procedencia de los veredictos");
console.log(`${"═".repeat(78)}\n`);
console.log(`  ${estampa(e)}\n`);

console.log(`  umbral                              valor           justificado con`);
console.log(`  ${"─".repeat(74)}`);
for (const u of UMBRALES) {
  const crecio = (e.prestamos - u.prestamos) / Math.max(1, u.prestamos);
  const marca = /SIN referencia/i.test(u.nota) ? "\x1b[31m" : crecio >= 0.25 ? "\x1b[33m" : "\x1b[90m";
  console.log(
    `  ${`${u.script} · ${u.nombre}`.slice(0, 34).padEnd(36)}` +
      `${u.valor.padEnd(16)}${marca}${u.prestamos.toLocaleString("en-US")} préstamos\x1b[0m` +
      (crecio >= 0.25 ? ` \x1b[33m(+${(crecio * 100).toFixed(0)}% desde entonces)\x1b[0m` : ""),
  );
}

const caducos = avisosDeCaducidad(e);
const sinRef = sinReferencia();

console.log(`\n${"─".repeat(78)}\n`);

if (caducos.length === 0) {
  console.log(`  \x1b[32mNingún umbral se justificó contra un corpus notablemente más chico.\x1b[0m`);
} else {
  console.log(`  \x1b[33m${caducos.length} umbral(es) para releer — el corpus creció desde que se fijaron:\x1b[0m\n`);
  for (const a of caducos) console.log(`    ${a}`);
}

if (sinRef.length > 0) {
  console.log(`\n  \x1b[31m${sinRef.length} umbral(es) SIN referencia empírica:\x1b[0m\n`);
  for (const a of sinRef) console.log(`    ${a}`);
}

/**
 * La distinción que este comando existe para mantener.
 *
 * Un umbral puede estar bien y haber caducado su justificación; son dos cosas.
 * Confundirlas sería el mismo error de todo el día en versión nueva: leer una
 * marca como si fuera un hallazgo.
 */
console.log(
  `\n  \x1b[90mUn aviso acá no dice que el umbral esté mal. Dice que la justificación se\x1b[0m`,
);
console.log(
  `  \x1b[90mescribió contra otra muestra, y que releerla cuesta menos que descubrir\x1b[0m`,
);
console.log(`  \x1b[90mtres semanas después que un veredicto se dio vuelta.\x1b[0m\n`);

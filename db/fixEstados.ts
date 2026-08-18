/**
 * Normaliza el estado a código de dos letras en lo ya cosechado.
 *
 *   npm run db:fix-estados -- --dry     # muestra qué haría, no toca nada
 *   npm run db:fix-estados              # aplica
 *
 * POR QUÉ UN SCRIPT Y NO UNA MIGRACIÓN SQL
 *
 * El mapeo vive en `harvest/normalize/estados.ts` porque el harvester lo necesita
 * al escribir. Escribir el mismo CASE a mano en un archivo .sql sería mantener dos
 * listas de cincuenta entradas sincronizadas, y esta sesión ya mostró tres veces qué
 * pasa con eso: divergen en la primera corrección que se hace en una sola.
 *
 * Acá el SQL se genera desde la tabla de TypeScript, así que no puede divergir.
 *
 * POR QUÉ NO SE RECOSECHA
 *
 * Recosechar 233 filings tarda horas por el límite de velocidad de SEC, y el mapeo
 * es determinista: aplicarlo sobre lo guardado da exactamente lo mismo que volver a
 * bajar los documentos. El harvester ya normaliza al escribir, así que esto es por
 * única vez para lo viejo.
 *
 * EMPIEZA EN SECO
 *
 * `--dry` muestra el antes y el después sin escribir. Un UPDATE sobre el 16% del
 * corpus se mira antes de correrlo.
 *
 * QUÉ CUENTA COMO "YA ESTÁ BIEN"
 *
 * No `~ '^[A-Z]{2}$'` sino "está en la lista de códigos", que es lo que `/comps`
 * pregunta de verdad. Con la regex, un "ny" en minúscula quedaba fuera del arreglo
 * por parecer válido, y un "XX" también.
 */

import { closePool, ping, query } from "./client.js";
import { casoSql, CODIGOS } from "../harvest/normalize/estados.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const SECO = process.argv.includes("--dry");

console.log(`\n${"═".repeat(78)}`);
console.log(`Normalizar estado a código de dos letras${SECO ? "  ·  EN SECO" : ""}`);
console.log(`${"═".repeat(78)}\n`);

/**
 * Qué se va a tocar y en qué se va a convertir, antes de tocarlo.
 *
 * La columna `queda` es la que importa: si un valor cae en NULL es porque la tabla
 * no lo reconoce, y eso hay que verlo antes y no después.
 */
const { rows: previa } = await query<{ crudo: string; queda: string | null; n: string }>(
  `SELECT btrim(state) AS crudo, ${casoSql()} AS queda, count(*)::text AS n
     FROM corpus.loans
    WHERE state IS NOT NULL AND NOT (btrim(state) = ANY($1))
    GROUP BY 1, 2
    ORDER BY count(*) DESC`,
  [[...CODIGOS]],
);

if (previa.length === 0) {
  console.log(`  \x1b[32mNo hay estados para normalizar.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

const recuperables = previa.filter((r) => r.queda !== null);
const perdidos = previa.filter((r) => r.queda === null);
const nRec = recuperables.reduce((t, r) => t + Number(r.n), 0);
const nPer = perdidos.reduce((t, r) => t + Number(r.n), 0);

console.log(`  valor guardado                queda      préstamos`);
console.log(`  ${"─".repeat(58)}`);
for (const r of previa.slice(0, 25)) {
  console.log(
    `  ${(r.crudo || "(vacío)").slice(0, 28).padEnd(30)} ` +
      `${(r.queda ?? "—").padEnd(10)} ${String(r.n).padStart(9)}` +
      (r.queda === null ? `  \x1b[90m← sin mapeo, queda inválido\x1b[0m` : ""),
  );
}
if (previa.length > 25) console.log(`  \x1b[90m... y ${previa.length - 25} valores más\x1b[0m`);

console.log(
  `\n  \x1b[32m${nRec.toLocaleString("en-US")} préstamos vuelven a ser visibles\x1b[0m` +
    ` para /comps.`,
);
if (nPer > 0) {
  console.log(
    `  \x1b[90m${nPer.toLocaleString("en-US")} siguen sin estado: la tabla no los reconoce y no se adivinan.\x1b[0m`,
  );
}

if (SECO) {
  console.log(`\n  \x1b[33mEn seco: no se escribió nada.\x1b[0m Sacá --dry para aplicar.\n`);
  await closePool();
  process.exit(0);
}

/**
 * El UPDATE solo toca las filas que van a quedar con un código válido.
 *
 * Sin ese `AND ... IS NOT NULL`, los valores que la tabla no reconoce pasarían de
 * "New Yorkk" a NULL, y con eso se perdería la única pista de por qué fallaron.
 */
const { rowCount } = await query(
  `UPDATE corpus.loans
      SET state = ${casoSql()}
    WHERE state IS NOT NULL
      AND NOT (btrim(state) = ANY($1))
      AND ${casoSql()} IS NOT NULL`,
  [[...CODIGOS]],
);

console.log(`\n  \x1b[1m${rowCount} filas actualizadas.\x1b[0m`);
console.log(
  `  \x1b[90mCorré \x1b[0mnpm run db:monitor\x1b[90m para confirmar, y \x1b[0mnpm run api:casos` +
    `\x1b[90m para ver si cambió alguna respuesta.\x1b[0m\n`,
);

await closePool();

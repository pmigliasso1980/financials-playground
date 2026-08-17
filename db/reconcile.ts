/**
 * Qué columna sin mapear vale lo que la aritmética dice que falta.
 *
 *   npm run db:reconcile
 *
 * EL PROBLEMA QUE RESUELVE
 *
 * Cuando el debt yield no cierra, ya sabemos cuánto tendría que valer el saldo:
 * si el emisor publica 13,7% y el NOI es 97.102.547, el denominador tiene que
 * ser 708.777.715. El LTV lo confirma por otro camino —tasación × LTV da
 * 709.200.000, 0,06% de diferencia— así que el número no es una estimación.
 *
 * Lo que faltaba era saber de qué columna sacarlo. Eso se venía haciendo a mano:
 * mirar la lista de ochenta y siete encabezados sin mapear y elegir el que
 * sonara mejor. Durante la sesión que motivó este archivo hice tres predicciones
 * de ese tipo y acerté una; cada una costó una recosecha de diez minutos.
 *
 * Con `corpus.unmapped_cells` la pregunta deja de ser interpretativa: qué celda
 * de ESTA MISMA FILA vale 708.777.715. Es una comparación numérica.
 *
 * DOS HIPÓTESIS, NO UNA
 *
 * Un saldo que falta puede faltar de dos maneras distintas, y conviene no
 * mezclarlas porque el arreglo es distinto:
 *
 *   REEMPLAZO   la celda vale el sénior entero → `loan_amount` apunta a la
 *               columna equivocada y hay que moverlo
 *   COMPLEMENTO la celda vale (sénior − loan_amount) → `loan_amount` está bien
 *               y lo que falta es el pari passu que se le suma
 *
 * Tysons Corner es del segundo tipo: los 2.460.000 que guardamos son de verdad
 * la rebanada de este trust, y lo que falta son los 706 millones del companion.
 * Mapear `loan_amount` a la columna del sénior lo "arreglaría" rompiendo el
 * significado de la métrica.
 *
 * QUÉ NO HACE ESTE ARCHIVO
 *
 * No cambia nada. Propone. La prueba de una propuesta es agregarle el patrón a
 * `columnMap.ts`, recosechar y ver si las identidades suben —sobre el corpus
 * entero, no sobre las emisiones que motivaron el cambio—. Esa distinción no es
 * teórica: un patrón que agregué para arreglar 144 préstamos rompió 13 en una
 * emisión que ya cerraba, y el neto positivo lo habría tapado.
 */

import { closePool, ping, query } from "./client.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Cuán cerca tiene que estar la celda del valor implícito para contar. */
const TOLERANCE = 0.01;
/** Debajo de esto una coincidencia es ruido: hay muchos números chicos. */
const MIN_MAGNITUDE = 100_000;

const money = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v.toLocaleString("en-US");

const fact = (alias: string, key: string) =>
  `LEFT JOIN corpus.facts ${alias} ON ${alias}.loan_id = l.id ` +
  `AND ${alias}.metric_key = '${key}' AND ${alias}.value ~ '^-?[0-9.]+$'`;

const SENIOR =
  "coalesce(sen.value::numeric, amt.value::numeric + coalesce(npp.value::numeric, 0))";
const JOINS =
  `${fact("dy", "debt_yield")} ${fact("noi", "noi_underwritten")} ` +
  `${fact("amt", "loan_amount")} ${fact("npp", "balance_pari_passu_non_trust")} ` +
  `${fact("sen", "balance_senior_total")}`;

console.log(`\n${"═".repeat(78)}`);
console.log("Reconciliador — qué columna vale lo que falta");
console.log(`${"═".repeat(78)}`);

const { rows: haveCells } = await query<{ n: string }>(
  "SELECT count(*)::text AS n FROM corpus.unmapped_cells",
);
if (Number(haveCells[0]?.n ?? 0) === 0) {
  console.log(
    `\n  \x1b[33mNo hay celdas sin mapear guardadas.\x1b[0m\n` +
      `  \x1b[90mCorré la migración y recosechá:\x1b[0m\n\n` +
      `    npm run db:migrate\n` +
      `    npm run harvest:batch -- --limit 300 --years 7 --refresh-stale\n`,
  );
  await closePool();
  process.exit(0);
}

console.log(
  `\n\x1b[90m  ${Number(haveCells[0]!.n).toLocaleString("en-US")} celdas numéricas de columnas sin mapear.\x1b[0m`,
);
console.log(
  `\x1b[90m  Para cada préstamo cuyo debt yield no cierra, el saldo implícito es\x1b[0m`,
);
console.log(`\x1b[90m  NOI / debt yield publicado. Buscamos qué celda vale eso.\x1b[0m\n`);

/**
 * Los préstamos que fallan, con su saldo implícito y el faltante.
 *
 * `implicito` es el denominador que haría cerrar la cuenta; `faltante` es lo que
 * habría que sumarle al saldo que ya tenemos para llegar ahí. Cada uno se busca
 * por separado porque distinguen reemplazo de complemento.
 */
const FAILING = `
  SELECT l.id AS loan_id,
         (noi.value::numeric / NULLIF(dy.value::numeric, 0)) AS implicito,
         (noi.value::numeric / NULLIF(dy.value::numeric, 0)) - ${SENIOR} AS faltante
    FROM corpus.loans l
    ${JOINS}
   WHERE dy.value IS NOT NULL AND noi.value IS NOT NULL AND amt.value IS NOT NULL
     AND amt.value::numeric <> 0 AND dy.value::numeric <> 0
     AND abs((noi.value::numeric / NULLIF(${SENIOR}, 0))
             / NULLIF(dy.value::numeric, 0) - 1) > ${TOLERANCE}
`;

interface Candidate {
  header: string;
  loans: string;
  filings: string;
  ejemplo_valor: string;
  ejemplo_implicito: string;
}

async function candidatesFor(
  columna: "implicito" | "faltante",
): Promise<Candidate[]> {
  const { rows } = await query<Candidate>(
    `WITH fallan AS (${FAILING})
     SELECT uc.header,
            count(DISTINCT uc.loan_id)::text     AS loans,
            count(DISTINCT l.accession)::text    AS filings,
            max(uc.value_num)::text              AS ejemplo_valor,
            max(f.${columna})::text              AS ejemplo_implicito
       FROM fallan f
       JOIN corpus.unmapped_cells uc ON uc.loan_id = f.loan_id
       JOIN corpus.loans l ON l.id = f.loan_id
      WHERE f.${columna} > ${MIN_MAGNITUDE}
        AND abs(uc.value_num / NULLIF(f.${columna}, 0) - 1) <= ${TOLERANCE}
      GROUP BY uc.header
      ORDER BY count(DISTINCT uc.loan_id) DESC
      LIMIT 10`,
  );
  return rows;
}

const bloques: Array<{ titulo: string; nota: string; col: "implicito" | "faltante" }> = [
  {
    titulo: "REEMPLAZO — la celda vale el sénior entero",
    nota: "loan_amount apunta a la columna equivocada. Mover el mapeo.",
    col: "implicito",
  },
  {
    titulo: "COMPLEMENTO — la celda vale lo que le falta al saldo",
    nota: "loan_amount está bien; falta el pari passu que se le suma.",
    col: "faltante",
  },
];

let algunaPropuesta = false;

for (const b of bloques) {
  const rows = await candidatesFor(b.col);
  console.log(`${"─".repeat(78)}`);
  console.log(b.titulo);
  console.log(`${"─".repeat(78)}`);
  console.log(`\x1b[90m  ${b.nota}\x1b[0m\n`);

  if (rows.length === 0) {
    console.log(`  \x1b[90mNinguna columna sin mapear coincide.\x1b[0m\n`);
    continue;
  }

  algunaPropuesta = true;
  for (const r of rows) {
    console.log(
      `  ${String(r.loans).padStart(4)} préstamos · ${String(r.filings).padStart(2)} emisiones  \x1b[1m${r.header}\x1b[0m`,
    );
    console.log(
      `       \x1b[90mej.: la celda vale ${money(Number(r.ejemplo_valor))} y hacía falta ${money(Number(r.ejemplo_implicito))}\x1b[0m`,
    );
  }
  console.log();
}

console.log(`${"─".repeat(78)}`);
if (algunaPropuesta) {
  console.log(
    `\n  \x1b[90mCada línea es una propuesta de mapeo derivada de la aritmética, no del\x1b[0m`,
  );
  console.log(
    `  \x1b[90mnombre del encabezado. La prueba es agregar el patrón, recosechar y\x1b[0m`,
  );
  console.log(
    `  \x1b[90mcorrer db:identities — mirando el total del corpus, no las emisiones\x1b[0m`,
  );
  console.log(`  \x1b[90mque motivaron el cambio.\x1b[0m\n`);
} else {
  console.log(
    `\n  \x1b[33mNingún saldo implícito coincide con una celda sin mapear.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mEl número que falta no está impreso en esa fila del Annex A: puede\x1b[0m`,
  );
  console.log(
    `  \x1b[90mvenir de otra tabla del documento, o el emisor no lo publica.\x1b[0m\n`,
  );
}

await closePool();

/**
 * Las filas de propiedad, normalizadas.
 *
 * QUÉ SON
 *
 * Un Annex A trae una fila por préstamo y una por cada propiedad que lo garantiza.
 * `keepLoanRows` separa las segundas para que un portfolio de veinte propiedades no
 * entre como veinte préstamos —ese filtro está bien y no se toca—, pero hasta ahora
 * las contaba y las tiraba.
 *
 * Medido sobre los tres fixtures: 138 descartadas, 138 con estado, ciudad y nombre
 * no vacíos. Direcciones reales, no residuo.
 *
 * POR QUÉ REUSA `rowsToObservations` EN VEZ DE MAPEAR DE NUEVO
 *
 * Las filas de propiedad tienen los MISMOS encabezados que las de préstamo: son la
 * misma tabla. Escribir un segundo mapeo de columnas acá sería mantener dos
 * implementaciones de la misma decisión, y esta sesión ya mostró tres veces qué
 * pasa con eso: divergen en la primera corrección que se hace en una sola.
 *
 * Así que se arma una tabla sintética —el encabezado original más las filas de
 * propiedad— y se la pasa por el normalizador de siempre. La normalización del
 * estado, el descarte de marcadores de ausencia y el parseo de valores vienen
 * gratis y no pueden divergir.
 *
 * CÓMO SE ATA CADA PROPIEDAD A SU PRÉSTAMO
 *
 * Por la numeración del emisor: `3.01` y `3.02` garantizan al préstamo `3`.
 * Verificado sobre los tres fixtures, 138 de 138 atan. Si alguna no ata, entra
 * igual con `loanRef: null` y queda contada en vez de perdida — un emisor que
 * numere distinto tiene que aparecer en el monitor, no desaparecer.
 */

import { rowsToObservations, type SourceRef } from "./toObservations.js";

export interface HarvestedPropertyRow {
  /** Índice de la fila en el Annex A original, no en la tabla sintética. */
  rowIndex: number;
  /** Lo que publica el emisor: "3.01". */
  propertyRef: string | null;
  /** La parte entera, "3", que es la que ata al préstamo. */
  loanRef: string | null;
  propertyName: string | null;
  address: string | null;
  city: string | null;
  /** Ya normalizado a código de dos letras por el normalizador compartido. */
  state: string | null;
  zip: string | null;
  propertyType: string | null;
}

/** La numeración de propiedad del emisor: 3.01, 12.04, a veces 3.1. */
const REF_PROPIEDAD = /^\d+\.\d+$/;

/**
 * Qué columna trae la numeración `3.01`, buscada por su FORMA y no por el mapeo.
 *
 * POR QUÉ NO SE USA `loan_id` DEL MAPA DE COLUMNAS
 *
 * Lo intenté y falla en Benchmark 2020-B16: el mapa asigna `loan_id` a la columna
 * "Loan No.", pero la numeración de las propiedades vive en otra columna llamada
 * "ID", que en las filas de préstamo está vacía. El resultado fue 49 propiedades
 * sin atar a ningún préstamo, en silencio.
 *
 * El mapa de columnas está afinado para las filas de préstamo, que son las que
 * mira. Las de propiedad llenan otras celdas, así que heredar sus decisiones es
 * heredar una respuesta a otra pregunta.
 *
 * La forma, en cambio, es inconfundible y no depende del emisor: es la única
 * columna donde casi todas las filas dicen "entero punto entero". Se elige la que
 * más filas satisface y se exige mayoría; si ninguna llega, se devuelve null y las
 * propiedades entran sin atar —contadas, no perdidas—.
 */
function columnaDeRef(filas: unknown[][]): number | null {
  if (filas.length === 0) return null;
  const ancho = Math.max(...filas.map((r) => r.length));
  let mejor = -1;
  let mejorN = 0;
  for (let c = 0; c < ancho; c++) {
    let n = 0;
    for (const f of filas) if (REF_PROPIEDAD.test(String(f[c] ?? "").trim())) n++;
    if (n > mejorN) { mejorN = n; mejor = c; }
  }
  return mejorN > filas.length / 2 ? mejor : null;
}

/** `3.01` → `{ propertyRef: "3.01", loanRef: "3" }`. */
function partirId(crudo: unknown): { propertyRef: string | null; loanRef: string | null } {
  const raw = String(crudo ?? "").trim();
  if (!raw) return { propertyRef: null, loanRef: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { propertyRef: raw, loanRef: null };
  return { propertyRef: raw, loanRef: String(Math.trunc(n)) };
}

export function toProperties(
  headerRows: unknown[][],
  headerRowIndex: number,
  dropped: Array<{ rowIndex: number; row: unknown[] }>,
  source: SourceRef,
): HarvestedPropertyRow[] {
  if (dropped.length === 0) return [];

  /**
   * El encabezado original más las filas de propiedad. Mismo ancho, mismos
   * encabezados, misma fila de headers: para el normalizador es la tabla de
   * siempre con otras filas de datos.
   */
  const sintetica = [...headerRows.slice(0, headerRowIndex + 1), ...dropped.map((d) => d.row)];
  const r = rowsToObservations(sintetica, headerRowIndex, source);
  const colRef = columnaDeRef(dropped.map((d) => d.row));

  const salida: HarvestedPropertyRow[] = [];
  for (const p of r.properties) {
    /**
     * `row_index` es el índice DENTRO de las filas de datos, empezando en cero.
     *
     * La primera versión le restaba `headerRowIndex + 1` creyendo que venía
     * referido a la tabla entera. Con eso la primera propiedad de cada fixture caía
     * en `dropped[-1]` y desaparecía, y todas las demás quedaban con el índice de
     * la propiedad anterior: no perdía datos a la vista, los ataba a la fila
     * equivocada. Se notó porque los tres fixtures perdían exactamente uno.
     *
     * La traducción importa porque `row_index` es la clave estable entre
     * recosechas: si se corre, dos cosechas del mismo documento producen filas
     * distintas.
     */
    const original = dropped[p.row_index];
    if (!original) continue;

    const { propertyRef, loanRef } = partirId(
      colRef === null ? null : original.row[colRef],
    );

    salida.push({
      rowIndex: original.rowIndex,
      propertyRef,
      loanRef,
      propertyName: p.label.property_name,
      address: p.label.address,
      city: p.label.city,
      state: p.label.state,
      zip: p.observations.find((o) => o.metric_key === "zip")?.value ?? null,
      propertyType: p.label.property_type,
    });
  }
  return salida;
}

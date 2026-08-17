/**
 * Estructura real de un Annex A.
 *
 * Descubierto inspeccionando Wells Fargo 2025-C64 en EDGAR. Dos cosas que la
 * versión sintética no tenía y que rompen el modelado si se ignoran:
 *
 * 1. EL ANNEX A VIENE PARTIDO EN BLOQUES HORIZONTALES
 *
 *    No es una tabla: son varias, cada una con las mismas columnas clave
 *    (Loan ID, Flag, Property Name) más un conjunto distinto de datos.
 *
 *      bloque 1: Loan ID | Flag | Property Name | Tipo | Año | Unidades | Balance | Tasa
 *      bloque 2: Loan ID | Flag | Property Name | EGI  | Gastos | NOI | DSCR | Debt Yield
 *
 *    Quedarse con una sola pierde la mitad de las métricas. Hay que unirlas
 *    por Loan ID.
 *
 * 2. HAY FILAS DE PRÉSTAMO Y FILAS DE PROPIEDAD
 *
 *      3.00  Loan      Soho Grand & The Roxy Hotel   2 propiedades
 *      3.01  Property  Soho Grand Hotel
 *      3.02  Property  Roxy Hotel
 *
 *    Un préstamo sobre varias propiedades genera una fila por cada una. Tratar
 *    cada fila como un deal independiente triplica el portfolio y suma dos
 *    veces el mismo balance.
 *
 * PENDIENTE (no MVP): hoy conservamos las filas de préstamo y descartamos las
 * de propiedad. Lo correcto sería modelar el préstamo como deal con N
 * properties colgando, que es exactamente lo que el store ya soporta.
 */

import { mapColumns, type MetricKey } from "./columnMap.js";

export interface AnnexTable {
  name: string;
  rows: unknown[][];
  headerRowIndex: number;
}

/** Encuentra el índice de columna de una métrica dentro de una tabla. */
function columnOf(headers: string[], key: MetricKey): number | null {
  const { matches } = mapColumns(headers);
  return matches.find((m) => m.metric.key === key)?.columnIndex ?? null;
}

function headersOf(table: AnnexTable): string[] {
  return (table.rows[table.headerRowIndex] ?? []).map((c) =>
    c === null || c === undefined ? "" : String(c),
  );
}

// ---------------------------------------------------------------------------
// Filas de préstamo vs. filas de propiedad
// ---------------------------------------------------------------------------

export type RowKind = "loan" | "property" | "unknown";

export function classifyRow(value: unknown): RowKind {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "loan") return "loan";
  if (s === "property") return "property";
  return "unknown";
}

export interface FlagFilterResult {
  rows: unknown[][];
  loanRows: number;
  propertyRows: number;
  /** true si la tabla tenía columna de flag; si no, se devolvió todo sin tocar. */
  hadFlagColumn: boolean;
}

/**
 * Deja solo las filas de préstamo.
 *
 * Si la tabla no tiene columna de flag —Annex A viejos, o emisores que no la
 * publican— devuelve todo sin cambios. Preferimos datos de más a datos
 * silenciosamente perdidos.
 */
export function keepLoanRows(rows: unknown[][], headerRowIndex: number): FlagFilterResult {
  const headers = (rows[headerRowIndex] ?? []).map((c) =>
    c === null || c === undefined ? "" : String(c),
  );
  const flagCol = columnOf(headers, "loan_property_flag");

  if (flagCol === null) {
    // Sin columna de flag, el propio Loan ID distingue préstamos de propiedades.
    return keepLoanRowsByLoanId(rows, headerRowIndex, headers);
  }

  const header = rows.slice(0, headerRowIndex + 1);
  const data = rows.slice(headerRowIndex + 1);

  let loanRows = 0;
  let propertyRows = 0;
  const kept: unknown[][] = [];

  for (const row of data) {
    const kind = classifyRow(row?.[flagCol]);
    if (kind === "property") {
      propertyRows++;
      continue;
    }
    if (kind === "loan") loanRows++;
    kept.push(row);
  }

  return { rows: [...header, ...kept], loanRows, propertyRows, hadFlagColumn: true };
}

/**
 * Distingue préstamos de propiedades usando la numeración del Loan ID.
 *
 * DESCUBIERTO REVISANDO LA INTEGRIDAD DEL CORPUS
 *
 * La columna "Loan / Property Flag" solo se mapea en el 79% de los filings. En
 * el resto, `keepLoanRows` conservaba todas las filas y cada propiedad de un
 * portfolio entraba como un préstamo: BANK5 2026-5YR23 aparecía con 173
 * préstamos cuando tiene 33.
 *
 * El síntoma fue aritmético: 173 IDs distintos con un máximo de 33. Eso solo
 * ocurre si los identificadores son decimales.
 *
 * La convención es consistente entre emisores:
 *
 *   3.00  ← el préstamo
 *   3.01  ← primera propiedad que lo garantiza
 *   3.02  ← segunda
 *
 * Así que la parte decimal alcanza para filtrar. Los filings que numeran con
 * enteros (1, 2, 3) pasan todos, que es el comportamiento correcto: ahí no hay
 * filas de propiedad.
 */
function keepLoanRowsByLoanId(
  rows: unknown[][],
  headerRowIndex: number,
  headers: string[],
): FlagFilterResult {
  const loanIdCol = columnOf(headers, "loan_id");
  const header = rows.slice(0, headerRowIndex + 1);
  const data = rows.slice(headerRowIndex + 1);

  if (loanIdCol === null) {
    // Sin flag ni Loan ID no hay forma de distinguir: preferimos datos de más a
    // datos silenciosamente perdidos.
    return { rows, loanRows: data.length, propertyRows: 0, hadFlagColumn: false };
  }

  let loanRows = 0;
  let propertyRows = 0;
  const kept: unknown[][] = [];

  for (const row of data) {
    const raw = String(row?.[loanIdCol] ?? "").trim();
    const n = Number(raw);

    if (!raw || !Number.isFinite(n)) {
      // Sin ID legible no podemos clasificarla; la conservamos.
      kept.push(row);
      continue;
    }

    // Tolerancia por ruido de punto flotante: 3.00 puede llegar como 2.9999999.
    const fractional = Math.abs(n - Math.round(n));
    if (fractional > 0.001) {
      propertyRows++;
      continue;
    }

    loanRows++;
    kept.push(row);
  }

  return {
    rows: [...header, ...kept],
    loanRows,
    propertyRows,
    // Se filtró, aunque no por la columna de flag.
    hadFlagColumn: propertyRows > 0,
  };
}

// ---------------------------------------------------------------------------
// Unión de bloques horizontales
// ---------------------------------------------------------------------------

export interface JoinResult {
  rows: unknown[][];
  headerRowIndex: number;
  tablesJoined: number;
  /** Nombres de las tablas que se unieron. */
  sources: string[];
  /** Tablas descartadas por no tener Loan ID. */
  skipped: string[];
  /** Cuántos grupos de páginas se apilaron antes de unir. */
  stackedGroups?: number;
}

/**
 * Adopta las tablas de continuación, que no repiten el encabezado.
 *
 * DESCUBIERTO CON DATOS REALES, SEGUNDA VUELTA
 *
 * El Annex A de Wells Fargo tiene 126 tablas, pero solo 18 con encabezados
 * reconocibles. Las otras 108 son continuaciones: la primera página de cada
 * bloque trae los encabezados y las siguientes solo filas de datos.
 *
 * Al filtrar por "tiene encabezados" se descartaban esas 108 tablas y con ellas
 * la mayor parte del pool. La primera corrida real devolvía 7 préstamos.
 *
 * La heurística para adoptarlas: misma cantidad de columnas que la última tabla
 * con encabezado, y aparecer después en el documento. El ancho de columna es
 * una firma bastante confiable porque cada bloque tiene su propio conjunto.
 *
 * Ante la duda no se adopta: sumar filas al bloque equivocado desalinea los
 * datos, que es peor que perderlos.
 */
export function attachContinuationTables(
  allTables: Array<{ name: string; rows: unknown[][] }>,
  detectHeader: (rows: unknown[][]) => { rowIndex: number; matchCount: number } | null,
): { tables: AnnexTable[]; adopted: number; orphans: number; rejected: number } {
  const result: AnnexTable[] = [];
  let current: AnnexTable | null = null;
  let currentWidth = 0;
  /** Columna de Loan ID del bloque actual, si la tiene. */
  let currentLoanIdCol: number | null = null;
  /** Último Loan ID visto, para verificar que la continuación siga la serie. */
  let lastLoanId = -Infinity;
  let adopted = 0;
  let orphans = 0;
  let rejected = 0;

  const widthOf = (rows: unknown[][]) => {
    // Ancho representativo: la moda de las filas de datos, no el máximo, que
    // se distorsiona con filas de separación o notas al pie.
    const counts = new Map<number, number>();
    for (const row of rows) {
      const w = row.filter((c) => c !== null && c !== undefined).length;
      if (w > 0) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    let best = 0;
    let bestCount = 0;
    for (const [w, c] of counts) {
      if (c > bestCount) {
        best = w;
        bestCount = c;
      }
    }
    return best;
  };

  for (const table of allTables) {
    const header = detectHeader(table.rows);

    if (header) {
      current = { name: table.name, rows: table.rows, headerRowIndex: header.rowIndex };
      currentWidth = widthOf(table.rows.slice(header.rowIndex + 1));

      const headers = (table.rows[header.rowIndex] ?? []).map((c) =>
        c === null || c === undefined ? "" : String(c),
      );
      currentLoanIdCol = columnOf(headers, "loan_id");
      lastLoanId = maxLoanId(table.rows.slice(header.rowIndex + 1), currentLoanIdCol);

      result.push(current);
      continue;
    }

    if (!current) {
      orphans++;
      continue;
    }

    const width = widthOf(table.rows);
    // Tolerancia de una columna: las filas reales a veces traen una celda de
    // más o de menos por el colspan de los bordes.
    const widthOk = currentWidth > 0 && Math.abs(width - currentWidth) <= 1;

    if (!widthOk) {
      orphans++;
      continue;
    }

    /**
     * El ancho no alcanza como validación.
     *
     * Dos bloques distintos del mismo Annex A pueden tener la misma cantidad de
     * columnas, y adoptar el equivocado pega filas con los datos corridos: el
     * encabezado dice "Interest Rate %" pero los valores vienen de otra columna.
     *
     * Pasó con datos reales. En BANK 2026-BNK52 aparecieron tasas de 480% —que
     * en realidad eran plazos de amortización de 480 meses— y el filing devolvió
     * 165 préstamos cuando un pool típico tiene entre 25 y 50.
     *
     * Cuando el bloque tiene columna de Loan ID, exigimos que la continuación
     * traiga IDs que sigan la serie. Es una verificación barata y difícil de
     * pasar por casualidad.
     */
    if (currentLoanIdCol !== null) {
      const ids = loanIdsOf(table.rows, currentLoanIdCol);

      if (ids.length === 0) {
        // Sin IDs reconocibles en la posición esperada, no es continuación.
        rejected++;
        continue;
      }

      const minId = Math.min(...ids);
      // Los Annex A numeran los préstamos de forma creciente. Una continuación
      // legítima empieza donde terminó la página anterior; si arranca por
      // debajo, es otro bloque que vuelve a empezar desde el préstamo 1.
      if (Number.isFinite(lastLoanId) && minId <= lastLoanId) {
        rejected++;
        continue;
      }

      lastLoanId = Math.max(lastLoanId, ...ids);
    }

    current.rows.push(...table.rows);
    adopted++;
  }

  return { tables: result, adopted, orphans, rejected };
}

/** Loan IDs numéricos de una columna. "3.00" y "3" son el mismo préstamo. */
function loanIdsOf(rows: unknown[][], col: number): number[] {
  const ids: number[] = [];
  for (const row of rows) {
    const raw = String(row?.[col] ?? "").trim();
    if (!raw) continue;
    const n = Number(raw);
    // Los IDs de préstamo son números chicos y positivos; un balance o una
    // tasa en esa posición delata que la tabla no es continuación.
    if (Number.isFinite(n) && n > 0 && n < 10_000) ids.push(n);
  }
  return ids;
}

function maxLoanId(rows: unknown[][], col: number | null): number {
  if (col === null) return -Infinity;
  const ids = loanIdsOf(rows, col);
  return ids.length > 0 ? Math.max(...ids) : -Infinity;
}

/**
 * Apila verticalmente las tablas que son páginas del mismo bloque.
 *
 * DESCUBIERTO CON DATOS REALES
 *
 * Un Annex A no tiene una tabla por bloque de columnas: tiene una por PÁGINA.
 * El documento de Wells Fargo 2025-C64 trae 126 tablas para unos 40 préstamos,
 * porque cada bloque de columnas se repite página tras página con los mismos
 * encabezados y distintas filas.
 *
 * Sin este paso, cada página se toma como un bloque de columnas diferente y la
 * unión horizontal las cruza por Loan ID, quedándose solo con los préstamos que
 * aparecen en la primera página de todos los bloques. En la primera corrida
 * real eso dio 7 préstamos de un pool que tiene muchos más.
 *
 * La regla: encabezados iguales → misma tabla lógica, apilar. Encabezados
 * distintos → bloques de columnas distintos, unir horizontalmente después.
 */
export function stackPagedTables(tables: AnnexTable[]): {
  tables: AnnexTable[];
  groups: number;
} {
  const groups = new Map<string, AnnexTable[]>();

  for (const table of tables) {
    const key = headersOf(table)
      .map((h) => h.replace(/\s+/g, " ").trim().toLowerCase())
      .filter(Boolean)
      .join("|");
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(table);
    else groups.set(key, [table]);
  }

  const stacked: AnnexTable[] = [];

  for (const [, pages] of groups) {
    const first = pages[0]!;
    if (pages.length === 1) {
      stacked.push(first);
      continue;
    }

    const header = first.rows.slice(0, first.headerRowIndex + 1);
    const data: unknown[][] = [];
    for (const page of pages) {
      data.push(...page.rows.slice(page.headerRowIndex + 1));
    }

    stacked.push({
      name: `${first.name}+${pages.length - 1}`,
      rows: [...header, ...data],
      headerRowIndex: first.headerRowIndex,
    });
  }

  return { tables: stacked, groups: stacked.length };
}

/**
 * Une los bloques horizontales del Annex A por Loan ID.
 *
 * Toma la tabla con más métricas como base y le pega las columnas de las demás
 * que compartan Loan ID. Las columnas repetidas (Flag, Property Name) se
 * agregan una sola vez.
 *
 * Si ninguna tabla tiene Loan ID, devuelve la mejor sola: sin clave no hay
 * forma confiable de unir, y unir por posición sería inventar datos.
 */
export function joinAnnexTables(rawTables: AnnexTable[]): JoinResult | null {
  if (rawTables.length === 0) return null;

  // Primero apilamos las páginas del mismo bloque; recién después unimos
  // bloques distintos por Loan ID.
  const { tables, groups: stackedGroups } = stackPagedTables(rawTables);
  if (tables.length === 0) return null;

  const withKey = tables
    .map((table) => {
      const headers = headersOf(table);
      return { table, headers, loanIdCol: columnOf(headers, "loan_id") };
    })
    .filter((t) => t.table.rows.length > t.table.headerRowIndex + 1);

  if (withKey.length === 0) return null;

  const joinable = withKey.filter((t) => t.loanIdCol !== null);

  // Sin clave común: la mejor tabla sola.
  if (joinable.length < 2) {
    const best = withKey
      .map((t) => ({ ...t, score: mapColumns(t.headers).matches.length }))
      .sort((a, b) => b.score - a.score)[0]!;
    return {
      rows: best.table.rows,
      headerRowIndex: best.table.headerRowIndex,
      tablesJoined: 1,
      sources: [best.table.name],
      skipped: withKey.filter((t) => t !== best).map((t) => t.table.name),
      stackedGroups,
    };
  }

  const scored = joinable
    .map((t) => ({ ...t, score: mapColumns(t.headers).matches.length }))
    .sort((a, b) => b.score - a.score);

  const base = scored[0]!;
  const baseHeaders = [...base.headers];
  const baseData = base.table.rows.slice(base.table.headerRowIndex + 1);

  // Indexamos las filas base por Loan ID.
  const byLoanId = new Map<string, unknown[]>();
  for (const row of baseData) {
    const id = normalizeLoanId(row?.[base.loanIdCol!]);
    if (id) byLoanId.set(id, row);
  }

  const seenHeaders = new Set(baseHeaders.map((h) => h.trim().toLowerCase()).filter(Boolean));
  const sources = [base.table.name];
  const skipped: string[] = [];

  for (const other of scored.slice(1)) {
    const otherData = other.table.rows.slice(other.table.headerRowIndex + 1);

    // Qué columnas aporta que la base no tenga.
    const newCols = other.headers
      .map((h, i) => ({ header: h, index: i }))
      .filter((c) => {
        const key = c.header.trim().toLowerCase();
        return key && !seenHeaders.has(key);
      });

    if (newCols.length === 0) {
      skipped.push(other.table.name);
      continue;
    }

    // Verificamos que las claves se solapen antes de unir.
    let overlap = 0;
    for (const row of otherData) {
      const id = normalizeLoanId(row?.[other.loanIdCol!]);
      if (id && byLoanId.has(id)) overlap++;
    }
    if (overlap < Math.min(baseData.length, otherData.length) * 0.5) {
      skipped.push(other.table.name);
      continue;
    }

    const offset = baseHeaders.length;
    for (const c of newCols) {
      baseHeaders.push(c.header);
      seenHeaders.add(c.header.trim().toLowerCase());
    }

    for (const row of otherData) {
      const id = normalizeLoanId(row?.[other.loanIdCol!]);
      if (!id) continue;
      const target = byLoanId.get(id);
      if (!target) continue;
      newCols.forEach((c, j) => {
        target[offset + j] = row[c.index] ?? null;
      });
    }

    sources.push(other.table.name);
  }

  return {
    rows: [baseHeaders, ...baseData],
    headerRowIndex: 0,
    tablesJoined: sources.length,
    sources,
    skipped,
    stackedGroups,
  };
}

/** "3.00" y "3" son el mismo préstamo. */
function normalizeLoanId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n)) return String(n);
  return s.toLowerCase();
}

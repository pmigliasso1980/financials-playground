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
  /**
   * Las filas de propiedad, que hasta ahora se contaban y se tiraban.
   *
   * POR QUÉ AHORA SE DEVUELVEN
   *
   * Cada una trae el nombre, la dirección, la ciudad y el estado de UNA propiedad
   * que garantiza el préstamo. Medido sobre los tres fixtures: 138 filas
   * descartadas, 138 con estado no vacío. No es residuo, es el dato.
   *
   * Tirarlas dejaba 585 préstamos sin ningún estado —los que garantizan
   * propiedades en más de uno— invisibles para toda consulta de /comps. Y también
   * perdía las direcciones de los multi-propiedad que SÍ tienen estado guardado.
   *
   * Se devuelven crudas y con su índice de fila original. Quien las quiera las
   * normaliza; quien no, sigue leyendo `rows` como antes.
   */
  droppedPropertyRows: Array<{ rowIndex: number; row: unknown[] }>;
  /** true si la tabla tenía columna de flag; si no, se devolvió todo sin tocar. */
  hadFlagColumn: boolean;
  /** Filas descartadas por no ser préstamos: sin nombre de propiedad ni saldo. */
  phantomRows: number;
}

/**
 * Máximo de filas que el filtro estructural puede descartar antes de abstenerse.
 *
 * Si supera esto, lo más probable es que las columnas de nombre y saldo no estén
 * donde creemos —no que el 20% del pool sean filas fantasma— y borrar medio
 * Annex A en silencio es peor que dejar entrar unas filas de más.
 */
const MAX_PHANTOM_SHARE = 0.15;

/**
 * Descarta las filas que no son préstamos.
 *
 * POR QUÉ NO ALCANZA CON EL FILTRO DE FLAG NI CON EL DE LOAN ID
 *
 * Los dos anteriores separan préstamos de propiedades. Ninguno detecta una fila
 * que no es ninguna de las dos cosas: en el Annex A conduit, la primera fila
 * después del encabezado suele numerar las columnas (1, 2, 3...) y entraba como
 * préstamo. Aparecían 7 en la cohorte 2026, con `property_type = "2"` — el
 * número de columna leído como tipo de propiedad.
 *
 * POR QUÉ ESTRUCTURAL Y NO POR CANTIDAD DE OBSERVATIONS
 *
 * `rowsToObservations` ya descarta filas con menos de 3 observations, y las 7
 * fantasma tenían exactamente 3. Subir ese umbral no sirve: sobre las 9.751
 * filas del corpus la distribución es continua desde 3 —hay filas en 3, 4, 5,
 * 6, 7, 9 y 10— así que cualquier corte por conteo elimina préstamos reales. El
 * hueco que parecía existir era un artefacto de mirar 28 emisiones de 233.
 *
 * Un préstamo tiene nombre de propiedad o tiene saldo. Una fila sin ninguno de
 * los dos no es un préstamo, tenga 3 observations o 30.
 */
function dropPhantomRows(
  data: unknown[][],
  headers: string[],
): { kept: unknown[][]; dropped: number } {
  const nameCol = columnOf(headers, "property_name");
  const amountCol = columnOf(headers, "loan_amount");

  // Sin ninguna de las dos columnas no hay con qué decidir: se conserva todo.
  if (nameCol === null && amountCol === null) return { kept: data, dropped: 0 };

  const tiene = (row: unknown[], col: number | null, conDigito: boolean) => {
    if (col === null) return false;
    const v = String(row?.[col] ?? "").trim();
    if (!v) return false;
    return conDigito ? /\d/.test(v) : true;
  };

  /**
   * SEGUNDO CRITERIO, SIN UMBRALES: una fila sin una sola letra no es un préstamo.
   *
   * El primero —nombre vacío y saldo vacío— no alcanzaba. La fila que numera las
   * columnas trae un número en CADA celda, así que la de nombre no está vacía:
   * tiene "5", el número de esa columna. En la base aparecía con nombre vacío
   * porque aguas abajo un nombre puramente numérico se rechaza al guardarlo, y
   * eso me hizo creer que la celda venía vacía del documento.
   *
   * Peor: el test que escribí primero usaba la forma correcta —números en todas
   * las columnas—, falló, y en vez de arreglar el filtro ajusté el test para que
   * coincidiera con lo que el filtro hacía. Test verde, bug vivo. Las dos filas
   * de BMO 2026-5C15 sobrevivieron a la recosecha y lo dejaron a la vista.
   *
   * Un préstamo del Annex A tiene nombre de propiedad, tipo, ciudad, estado:
   * texto en varias columnas. Una fila de numeración es todo dígitos. No hace
   * falta elegir ningún número para distinguirlas.
   */
  const sinLetras = (row: unknown[]) =>
    !row?.some((c) => /[a-zA-Z]/.test(String(c ?? "")));

  const kept: unknown[][] = [];
  const fantasma: unknown[][] = [];
  for (const row of data) {
    const pareceLoan = tiene(row, nameCol, false) || tiene(row, amountCol, true);
    if (pareceLoan && !sinLetras(row)) kept.push(row);
    else fantasma.push(row);
  }

  if (data.length > 0 && fantasma.length / data.length > MAX_PHANTOM_SHARE) {
    // Demasiadas: la hipótesis sobre las columnas es la que está mal.
    return { kept: data, dropped: 0 };
  }
  return { kept, dropped: fantasma.length };
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

  /**
   * El filtro estructural va ANTES de clasificar, no después.
   *
   * La primera versión restaba las fantasma de `loanRows`, pero una fila que no
   * es un préstamo tampoco tiene la columna de flag cargada, así que nunca se
   * había contado: el descuento restaba algo que no estaba sumado y devolvía un
   * conteo bajo por uno.
   *
   * Filtrando primero, `loanRows` cuenta lo que quedó y no hay que corregirlo.
   */
  const limpio = dropPhantomRows(data, headers);

  let loanRows = 0;
  let propertyRows = 0;
  const kept: unknown[][] = [];
  const droppedPropertyRows: FlagFilterResult["droppedPropertyRows"] = [];

  for (const [i, row] of limpio.kept.entries()) {
    const kind = classifyRow(row?.[flagCol]);
    if (kind === "property") {
      propertyRows++;
      droppedPropertyRows.push({ rowIndex: headerRowIndex + 1 + i, row });
      continue;
    }
    if (kind === "loan") loanRows++;
    kept.push(row);
  }

  return {
    rows: [...header, ...kept],
    loanRows,
    propertyRows,
    droppedPropertyRows,
    hadFlagColumn: true,
    phantomRows: limpio.dropped,
  };
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
    // Sin flag ni Loan ID no hay forma de distinguir préstamo de propiedad,
    // pero el filtro estructural sigue valiendo: una fila sin nombre ni saldo no
    // es ninguna de las dos.
    const limpio = dropPhantomRows(data, headers);
    return {
      rows: [...rows.slice(0, headerRowIndex + 1), ...limpio.kept],
      loanRows: data.length - limpio.dropped,
      propertyRows: 0,
      droppedPropertyRows: [],
      hadFlagColumn: false,
      phantomRows: limpio.dropped,
    };
  }

  const limpio = dropPhantomRows(data, headers);

  let loanRows = 0;
  let propertyRows = 0;
  const kept: unknown[][] = [];
  const droppedPropertyRows: FlagFilterResult["droppedPropertyRows"] = [];

  for (const [i, row] of limpio.kept.entries()) {
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
      droppedPropertyRows.push({ rowIndex: headerRowIndex + 1 + i, row });
      continue;
    }

    loanRows++;
    kept.push(row);
  }

  return {
    rows: [...header, ...kept],
    loanRows,
    propertyRows,
    droppedPropertyRows,
    // Se filtró, aunque no por la columna de flag.
    hadFlagColumn: propertyRows > 0,
    phantomRows: limpio.dropped,
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

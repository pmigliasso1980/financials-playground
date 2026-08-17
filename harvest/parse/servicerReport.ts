/**
 * Parser del informe mensual del servicer (EX-99.1 del 10-D).
 *
 * QUÉ EXTRAE
 *
 * La tabla con NOI a nivel préstamo posterior al cierre, que según el
 * administrador se llama "Mortgage Loan Detail (Part 2)" o "NOI Detail". El
 * resto del documento —waterfall de certificados, prepagos, préstamos en
 * servicio especial— es información de bonos, no de propiedades.
 *
 * Las familias de plantilla y sus diferencias están documentadas junto a
 * `SCHEMAS`, más abajo. La resumida: no alcanza con buscar un nombre de sección
 * ni un nombre de columna fijo, porque dos administradores usan la etiqueta
 * "Loan ID" para cosas distintas.
 *
 * DECISIONES QUE PARECEN DETALLES Y NO LO SON
 *
 * 1. Preferimos "Most Recent NOI" sobre "Most Recent Fiscal NOI".
 *
 *    El fiscal viene sin fecha: no se sabe qué ejercicio cubre, y comparar
 *    contra el NOI suscrito sin saber el período es comparar cualquier cosa. El
 *    "Most Recent" trae NOI Start Date y NOI End Date, así que se puede fechar y
 *    anualizar. Guardamos ambos, pero el que entra a los cálculos es el fechado.
 *
 * 2. Un NOI sin fechas no existe, aunque traiga un número.
 *
 *    Las filas sin reportar vienen como "0.00" con fechas "--". Si uno lee la
 *    columna sin mirar las fechas, esos ceros entran como NOI cero y hunden
 *    cualquier promedio. Acá un valor sin par de fechas válidas se descarta,
 *    punto. Es el mismo error que los "N/A" del Annex A, que ya nos costó una
 *    iteración entera.
 *
 * 3. Anualizar tiene un piso.
 *
 *    Los períodos van de un trimestre a doce meses. Multiplicar un trimestre por
 *    cuatro asume que el año es plano, lo cual es falso en hotelería y discutible
 *    en todo lo demás. Anualizamos igual porque tirar los trimestres perdería
 *    demasiada muestra, pero cada fila queda marcada con sus días reales para
 *    poder filtrar después. `MIN_PERIOD_DAYS` descarta lo que es demasiado corto
 *    para significar algo.
 *
 * 4. Los tramos pari passu se deduplican.
 *
 *    1A-1, 1A-4 y 1A-5 son pedazos del mismo préstamo y cada uno reporta el NOI
 *    de la propiedad entera. Sin deduplicar, esa propiedad pesa el triple. El
 *    Pros ID normalizado al entero inicial resuelve las dos cosas a la vez:
 *    identifica el préstamo del Annex A y colapsa los tramos.
 *
 *    Si dos tramos del mismo préstamo reportan NOI distintos, eso es una
 *    anomalía real y queda registrada en vez de resolverse en silencio.
 */

import { extractFromHtml, type ExtractedTable } from "./tables.js";
import { normalizeProsId } from "../edgar/servicer.js";

/** Período mínimo para que un NOI anualizado signifique algo. */
export const MIN_PERIOD_DAYS = 80;

/** Período que consideramos "año completo" y no necesita extrapolación. */
export const FULL_YEAR_MIN_DAYS = 300;

export interface ServicerLoanRow {
  /** Tal como viene en el informe: "1A-1", "14A-3-C1", "27". */
  prosId: string;
  /** Loan ID del Annex A: el entero inicial del Pros ID. */
  loanId: string | null;
  /** Último ejercicio fiscal cerrado. Sin fecha propia: solo referencia. */
  fiscalNoi: number | null;
  /** NOI del período fechado. Crudo, sin anualizar. */
  recentNoi: number | null;
  noiStart: string | null;
  noiEnd: string | null;
  periodDays: number | null;
  /** recentNoi llevado a base anual. Null si el período es muy corto. */
  annualizedNoi: number | null;
  /** True si el período ya cubría un año: el valor no se extrapoló. */
  isFullYear: boolean;
  sourceTable: string;
}

export interface ServicerLoanFact {
  loanId: string;
  annualizedNoi: number;
  noiStart: string;
  noiEnd: string;
  periodDays: number;
  isFullYear: boolean;
  /** Cuántos tramos reportaron este préstamo. */
  tranches: number;
}

/**
 * Estado de pago de un préstamo, del bloque "Delinquency Loan Detail".
 *
 * POR QUÉ ESTA VARIABLE Y NO EL NOI
 *
 * El crecimiento del NOI es un cociente entre dos números con colas gordas: su
 * mediana anual tiene un error estándar de 2,4 puntos y ninguna añada del corpus
 * es distinguible de otra (ver `db:power`). La morosidad no: es un conteo, y con
 * ~400 préstamos por añada el piso de ruido baja a ~3 puntos porcentuales, sobre
 * tasas que se mueven entre 1% y 10%.
 *
 * DOS COLUMNAS PARA EL MISMO HECHO
 *
 * `Months Delinquent` y `Paid Through Date` dicen lo mismo por caminos
 * distintos: los meses de atraso tienen que ser aproximadamente
 * (fin del período − paid through) / 30. Se guardan las dos justamente para
 * poder contrastarlas, igual que las identidades del Annex A. Es la verificación
 * que allá descubrimos tarde y acá está disponible desde el principio.
 *
 * La escalera de severidad —transferencia a special servicing, ejecución, REO—
 * da más resolución que un binario y no depende de cómo cada administrador
 * codifique `Mortgage Loan Status`, que sí es propietario.
 */
export interface ServicerDelinquencyRow {
  prosId: string;
  loanId: string;
  paidThrough: string | null;
  monthsDelinquent: number | null;
  status: string | null;
  transferDate: string | null;
  foreclosureDate: string | null;
  reoDate: string | null;
}

/**
 * El bloque "Specially Serviced Loan Detail", que no es el de morosidad.
 *
 * POR QUÉ EXISTE ESTA INTERFAZ
 *
 * El parser sacaba `transfer_date` únicamente del bloque de morosos. Pero un
 * préstamo puede estar en special servicing PAGANDO AL DÍA, y entonces no
 * aparece entre los morosos: aparece acá.
 *
 * BANK 2021-BNK36 dice "No delinquent loans this period" en el bloque de
 * morosidad, y en este bloque tiene al Pros ID 71 —multifamily en Illinois,
 * transferido el 12/02/2025—. El pipeline lo contaba como cero eventos.
 *
 * Eso no era un error aleatorio: si un shelf tiene préstamos que entran a
 * special servicing antes de dejar de pagar y otro no, la diferencia entre sus
 * tasas mide qué bloque llenó cada administrador. Ocho ataques al denominador,
 * a la composición y a los administradores no lo habrían encontrado nunca,
 * porque el problema estaba en una tabla que el parser no leía.
 */
export interface ServicerSpecialRow {
  prosId: string;
  loanId: string;
  transferDate: string | null;
  resolutionCode: string | null;
  propertyType: string | null;
  state: string | null;
}

export interface ServicerParseResult {
  delinquency: ServicerDelinquencyRow[];
  /** Préstamos en special servicing, estén o no atrasados. */
  specialServicing: ServicerSpecialRow[];
  rows: ServicerLoanRow[];
  /** Un registro por préstamo, ya deduplicado. */
  loans: ServicerLoanFact[];
  diagnostics: {
    tablesScanned: number;
    tablesMatched: number;
    /** Familias de plantilla reconocidas en el documento. */
    families: string[];
    rowsFound: number;
    /** Filas con número pero sin fechas: no reportadas. */
    droppedNoDates: number;
    /** Filas con período por debajo del piso. */
    droppedShortPeriod: number;
    /** Filas sin Pros ID reconocible. */
    droppedNoProsId: number;
    /** Préstamos cuyos tramos reportaron NOI distintos. */
    trancheConflicts: Array<{ loanId: string; values: number[] }>;
    fullYearShare: number;

    /**
     * Tres causas distintas producen cero filas de morosidad, y hasta ahora las
     * tres salían con el mismo mensaje: "no se encontró la tabla en este
     * formato". Eso me hizo dar por confirmado un bug de parseo que puede no
     * existir —una emisión sin morosos produce exactamente la misma salida—.
     *
     *   delinquencyTables = 0  → el localizador no ubicó el bloque: es formato
     *   filas de datos = 0     → el bloque está pero solo tiene encabezado:
     *                            la emisión no tiene morosos
     *   descartadas > 0        → había filas y los filtros se las comieron
     *
     * Es el mismo error que el código ya documenta para el bloque de NOI.
     * Volvió a pasar en el bloque de al lado.
     */
    delinquencyTables: number;
    delinquencyDataRows: number;
    delinquencyDropped: number;
    /**
     * Los primeros identificadores descartados, crudos.
     *
     * "12 emisiones descartaron todo" no dice si lo descartado era prosa —el
     * aviso "No delinquent loans this period", las leyendas de códigos— o
     * préstamos morosos que el filtro se comió. Verifiqué UNA a mano y era
     * prosa; de ahí concluí sobre once más sin mirarlas.
     *
     * El valor crudo es lo único que distingue las dos cosas, y es lo que en
     * cada vuelta de hoy terminó delatando al instrumento.
     */
    delinquencyDroppedSamples: string[];

    /** Mismo desglose para el bloque de especialmente administrados. */
    specialTables: number;
    specialDataRows: number;
    /**
     * Préstamos que aparecen en special servicing y NO entre los morosos.
     *
     * Es la medida directa de lo que el parser perdía antes: si este número es
     * cero en todos los documentos, el bloque nuevo no aportaba nada; si es
     * grande y desparejo entre shelves, era la explicación de la brecha.
     */
    specialSoloAqui: number;
  };
  issues: string[];
}

// ---------------------------------------------------------------------------
// Ubicación de la tabla y de sus columnas
// ---------------------------------------------------------------------------

interface ColumnIndex {
  prosId: number;
  fiscalNoi: number;
  recentNoi: number;
  noiStart: number;
  noiEnd: number;
  headerRow: number;
  /** Qué familia de plantilla se reconoció. */
  family: string;
}

const norm = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim();

/**
 * FAMILIAS DE PLANTILLA
 *
 * Igual que con el Annex A, no hay un formato: hay familias por administrador.
 * Las dos que encontramos publican el mismo dato con nombres y ubicaciones
 * distintas, y una de ellas tiene una trampa que rompe todo en silencio.
 *
 * Computershare — sección "Mortgage Loan Detail (Part 2)":
 *
 *   | Pros ID | Most Recent Fiscal NOI | Most Recent NOI | NOI Start | NOI End |
 *
 * Citigroup — sección propia "NOI Detail":
 *
 *   | Loan ID   | OMCR | ... | Preceding Fiscal Year NOI | Most Recent NOI |
 *   | 328061001 |   1  | ...
 *
 * LA TRAMPA: en Citigroup la columna llamada "Loan ID" es el identificador
 * interno del servicer —328061001— y el número del prospecto está en "OMCR".
 * Está invertido respecto de Computershare, donde la columna de prospecto se
 * llama justamente "Pros ID". Anclar en el nombre "Loan ID" haría un join que
 * no matchea nada, y peor: lo haría sin error, devolviendo cero coincidencias
 * como si el trust simplemente no reportara.
 *
 * Por eso el ancla es una lista de patrones por familia y no un nombre fijo.
 */
interface HeaderSchema {
  family: string;
  /** Columna que contiene el número de préstamo del prospecto. */
  anchor: RegExp;
  /** NOI del ejercicio anterior cerrado. Opcional: no todas las familias lo traen. */
  fiscal?: RegExp;
  recent: RegExp;
  recentExclude?: RegExp;
  start: RegExp;
  end: RegExp;
}

const SCHEMAS: HeaderSchema[] = [
  {
    family: "computershare",
    anchor: /^pros\s*id$/i,
    fiscal: /most\s*recent\s*fiscal\s*noi/i,
    recent: /most\s*recent\s*noi/i,
    recentExclude: /fiscal|date/i,
    start: /noi\s*start/i,
    end: /noi\s*end/i,
  },
  {
    family: "citigroup",
    anchor: /^omcr$/i,
    fiscal: /preceding\s*fiscal\s*year\s*noi/i,
    recent: /most\s*recent\s*noi/i,
    recentExclude: /fiscal|preceding|date/i,
    // "Most Recent Financial As of Start Date" / "... Asof End Date" —
    // el filer escribe "As of" y "Asof" en la misma tabla.
    start: /most\s*recent\s*financial\s*as\s*of\s*start\s*date/i,
    end: /most\s*recent\s*financial\s*as\s*of\s*end\s*date/i,
  },
];

/**
 * La tabla de morosidad, identificada por "Months Delinquent".
 *
 * "Paid Through Date" sola no alcanza como ancla: aparece también en el bloque
 * de detalle del préstamo (Part 1). La combinación con "Months Delinquent" es
 * única en el documento.
 */
interface DelinquencyIndex {
  prosId: number; loanId: number; paidThrough: number; months: number;
  status: number; transfer: number; foreclosure: number; reo: number;
  headerRow: number;
}

function locateDelinquency(rows: unknown[][]): DelinquencyIndex | null {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const prosId = row.findIndex((c) => /^pros\s*id$/i.test(norm(c)));
    if (prosId === -1) continue;

    const width = Math.max(...rows.slice(Math.max(0, r - 2), r + 1).map((x) => x.length));
    const merged: string[] = [];
    for (let col = 0; col < width; col++) {
      const parts: string[] = [];
      for (let back = 2; back >= 0; back--) {
        const text = norm(rows[r - back]?.[col]);
        if (text && !parts.includes(text)) parts.push(text);
      }
      merged.push(parts.join(" "));
    }

    const at = (re: RegExp) => merged.findIndex((h) => re.test(h));
    const months = at(/months\s*delinquent/i);
    if (months === -1) continue;

    const paidThrough = at(/paid\s*through\s*date/i);
    if (paidThrough === -1) continue;

    return {
      prosId,
      loanId: at(/^loan\s*id$/i),
      paidThrough,
      months,
      status: at(/mortgage\s*loan\s*status/i),
      transfer: at(/servicing\s*transfer\s*date/i),
      foreclosure: at(/foreclosure\s*date/i),
      reo: at(/^reo\s*date$/i),
      headerRow: r,
    };
  }
  return null;
}

/**
 * El bloque de especialmente administrados, que comparte columnas con el de
 * morosidad y no es el mismo.
 *
 * Los dos tienen `Servicing Transfer Date` y `Resolution Strategy Code`. Lo que
 * los separa es que el de morosidad trae `Months Delinquent` y este no, y que
 * este trae `Special Servicing Comments`. Anclar solo en la fecha de
 * transferencia haría que el parser leyera dos veces la misma tabla y contara
 * cada moroso doble.
 */
interface SpecialIndex {
  prosId: number; loanId: number; transfer: number;
  resolution: number; propertyType: number; state: number;
  headerRow: number;
}

function locateSpecialServicing(rows: unknown[][]): SpecialIndex | null {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const prosId = row.findIndex((c) => /^pros\s*id$/i.test(norm(c)));
    if (prosId === -1) continue;

    const width = Math.max(...rows.slice(Math.max(0, r - 2), r + 1).map((x) => x.length));
    const merged: string[] = [];
    for (let col = 0; col < width; col++) {
      const parts: string[] = [];
      for (let back = 2; back >= 0; back--) {
        const text = norm(rows[r - back]?.[col]);
        if (text && !parts.includes(text)) parts.push(text);
      }
      merged.push(parts.join(" "));
    }

    const at = (re: RegExp) => merged.findIndex((h) => re.test(h));

    // Si trae meses de atraso es el bloque de morosidad, no este.
    if (at(/months\s*delinquent/i) !== -1) continue;

    const transfer = at(/servicing\s*transfer\s*date/i);
    if (transfer === -1) continue;

    return {
      prosId,
      loanId: at(/^loan\s*id$/i),
      transfer,
      resolution: at(/resolution\s*strategy/i),
      propertyType: at(/property\s*type/i),
      state: at(/^state$/i),
      headerRow: r,
    };
  }
  return null;
}

/**
 * Resuelve el encabezado anclándose en la celda "Pros ID".
 *
 * No se puede asumir que el encabezado esté arriba de todo: la tabla arranca con
 * el título de sección y filas en blanco. Y viene partido en tres filas, con las
 * palabras repartidas de forma que ninguna se entiende sola —"Most Recent"
 * arriba, "Fiscal NOI" abajo—. Por eso se fusionan las dos filas previas a la de
 * "Pros ID" columna por columna.
 */
function locateColumns(rows: unknown[][]): ColumnIndex | null {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;

    for (const schema of SCHEMAS) {
      const anchorCol = row.findIndex((c) => schema.anchor.test(norm(c)));
      if (anchorCol === -1) continue;

      const width = Math.max(...rows.slice(Math.max(0, r - 2), r + 1).map((x) => x.length));
      const merged: string[] = [];
      for (let col = 0; col < width; col++) {
        const parts: string[] = [];
        for (let back = 2; back >= 0; back--) {
          const src = rows[r - back];
          if (!src) continue;
          const text = norm(src[col]);
          // Evita repetir el mismo token cuando la fila superior lo arrastra.
          if (text && !parts.includes(text)) parts.push(text);
        }
        merged.push(parts.join(" "));
      }

      const find = (re: RegExp | undefined, exclude?: RegExp): number =>
        re === undefined ? -1 : merged.findIndex((h) => re.test(h) && !(exclude && exclude.test(h)));

      // "Most Recent NOI" también matchea dentro de "Most Recent Fiscal NOI",
      // así que el genérico excluye explícitamente al específico.
      const fiscalNoi = find(schema.fiscal);
      const recentNoi = find(schema.recent, schema.recentExclude);
      const noiStart = find(schema.start);
      const noiEnd = find(schema.end);

      if (recentNoi === -1 || noiStart === -1 || noiEnd === -1) continue;

      return {
        prosId: anchorCol,
        fiscalNoi,
        recentNoi,
        noiStart,
        noiEnd,
        headerRow: r,
        family: schema.family,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parseo de valores
// ---------------------------------------------------------------------------

/** "21,466,533.53" → 21466533.53 · "--" → null · "(1,234)" → -1234 */
export function parseMoney(raw: unknown): number | null {
  const s = norm(raw);
  // "Not Available" lo usa Citigroup donde Computershare pone "--".
  if (!s || /^(-{1,2}|—|n\/?a|nap|nav|not\s+(available|applicable))$/i.test(s)) return null;

  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * "03/31/26" → "2026-03-31".
 *
 * Los informes usan año de dos dígitos. El pivote en 70 es la convención
 * habitual; para CMBS no hay ambigüedad real porque no existen reportes
 * anteriores a los 90.
 */
export function parseShortDate(raw: unknown): string | null {
  const s = norm(raw);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!m) return null;

  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (m[3]!.length === 2) year += year < 70 ? 2000 : 1900;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Rechaza fechas imposibles tipo 02/31.
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== day) return null;

  return iso;
}

function daysBetween(startIso: string, endIso: string): number {
  const a = Date.parse(`${startIso}T00:00:00Z`);
  const b = Date.parse(`${endIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

// ---------------------------------------------------------------------------
// Parser principal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Combinación de varios meses
// ---------------------------------------------------------------------------

/**
 * Un solo informe no alcanza, y la razón es del negocio, no del parser.
 *
 * Los prestatarios mandan el estado operativo anual entre 90 y 120 días después
 * de cerrar el ejercicio. Eso hace que el mismo préstamo aparezca distinto según
 * cuándo se mire:
 *
 *   informe de julio 2026 → NOI del trimestre 01/01 a 31/03 (hay que extrapolar)
 *   informe de mayo 2026  → NOI del año 2025 completo (no hay que tocar nada)
 *
 * Y no todos reportan al mismo tiempo: en un informe cualquiera hay préstamos
 * con fechas y préstamos con "--", y no son siempre los mismos. Mirando varios
 * meses se recupera cobertura y se consiguen más períodos completos.
 *
 * El criterio de selección, en orden: primero año completo, después período más
 * largo, y a igualdad el que termina más tarde. Nunca se promedian períodos
 * distintos —eso mezclaría un trimestre con un año.
 */
export interface MergeConflict {
  loanId: string;
  /** Valor elegido y su origen. */
  chosen: number;
  chosenLabel: string;
  chosenDays: number;
  /** Valor discrepante de otro informe. */
  other: number;
  otherLabel: string;
  otherDays: number;
  /** Cociente entre ambos, siempre ≥ 1. */
  ratio: number;
}

/** A partir de acá dos observaciones del mismo préstamo no pueden ser ambas ciertas. */
export const CONFLICT_RATIO = 1.5;

/**
 * Por qué la extrapolación quedó prohibida por defecto.
 *
 * El control cruzado sobre Benchmark 2024-V7 encontró cuatro préstamos con
 * observaciones incompatibles, y los cuatro tienen un período parcial de un
 * lado:
 *
 *   loan  elegido          contra           ratio
 *   2     19,9M   365 días  11,7M   90 días  1.7x
 *   4     12,9M   365 días  53,1M  181 días  4.1x
 *   8      3,1M   365 días   5,4M   90 días  1.8x
 *   17    24,6M   181 días  11,1M   90 días  2.2x
 *
 * Los tres primeros tienen un año completo que arbitra. El 17 no: los dos
 * valores son extrapolados y difieren 2.2x, así que no hay forma de saber cuál
 * es. Ese caso es el que decide la política —cuando no hay ancla, elegir es
 * inventar.
 *
 * Con el informe de abril el 78% de los préstamos trae año completo medido. Es
 * preferible perder el 22% restante que meter ruido de esa magnitud en una
 * medición que después vamos a comparar contra un paper.
 */
export function mergeServicerReports(
  reports: Array<{ label: string; loans: ServicerLoanFact[] }>,
  opts: { requireFullYear?: boolean } = {},
): {
  loans: Array<ServicerLoanFact & { sourceLabel: string }>;
  perReport: Array<{ label: string; loans: number; fullYear: number; newLoans: number }>;
  /** Mismo préstamo con NOI incompatibles entre informes. */
  conflicts: MergeConflict[];
  /** Préstamos que quedaron afuera por no tener ninguna medición de año completo. */
  excludedExtrapolated: string[];
} {
  const requireFullYear = opts.requireFullYear ?? true;
  const best = new Map<string, ServicerLoanFact & { sourceLabel: string }>();
  const seen = new Map<string, Array<ServicerLoanFact & { sourceLabel: string }>>();
  const perReport: Array<{ label: string; loans: number; fullYear: number; newLoans: number }> = [];

  for (const report of reports) {
    let newLoans = 0;

    for (const loan of report.loans) {
      const tagged = { ...loan, sourceLabel: report.label };
      const history = seen.get(loan.loanId) ?? [];
      history.push(tagged);
      seen.set(loan.loanId, history);

      const current = best.get(loan.loanId);
      if (!current) {
        best.set(loan.loanId, tagged);
        newLoans++;
        continue;
      }

      const better =
        (loan.isFullYear && !current.isFullYear) ||
        (loan.isFullYear === current.isFullYear && loan.periodDays > current.periodDays) ||
        (loan.isFullYear === current.isFullYear &&
          loan.periodDays === current.periodDays &&
          loan.noiEnd > current.noiEnd);

      if (better) best.set(loan.loanId, tagged);
    }

    perReport.push({
      label: report.label,
      loans: report.loans.length,
      fullYear: report.loans.filter((l) => l.isFullYear).length,
      newLoans,
    });
  }

  /**
   * Control cruzado entre informes.
   *
   * El mismo préstamo aparece mes tras mes. Si dos observaciones anualizadas
   * difieren en más de 50%, alguna está mal —y la sospechosa habitual es la
   * extrapolada: un período parcial que en realidad no lo era, o un semestre con
   * un ingreso no recurrente adentro.
   *
   * Esto apareció con datos reales. Benchmark 2024-V7, préstamo 4: el informe de
   * abril daba 53,1M anualizando un semestre, y el de julio daba 12,9M sobre
   * doce meses medidos. Sobre un trust de 821M el primero implicaría un debt
   * yield absurdo. La lección no es descartar la extrapolación en general, sino
   * no creerle cuando hay una medición de año completo que la contradice.
   */
  const conflicts: MergeConflict[] = [];
  for (const [loanId, history] of seen) {
    const chosen = best.get(loanId)!;
    for (const other of history) {
      if (other.sourceLabel === chosen.sourceLabel) continue;
      const hi = Math.max(chosen.annualizedNoi, other.annualizedNoi);
      const lo = Math.min(chosen.annualizedNoi, other.annualizedNoi);
      if (lo <= 0) continue;
      const ratio = hi / lo;
      if (ratio < CONFLICT_RATIO) continue;

      conflicts.push({
        loanId,
        chosen: chosen.annualizedNoi,
        chosenLabel: chosen.sourceLabel,
        chosenDays: chosen.periodDays,
        other: other.annualizedNoi,
        otherLabel: other.sourceLabel,
        otherDays: other.periodDays,
        ratio,
      });
      break;
    }
  }

  let loans = [...best.values()].sort((a, b) => Number(a.loanId) - Number(b.loanId));

  const excludedExtrapolated: string[] = [];
  if (requireFullYear) {
    const kept: typeof loans = [];
    for (const loan of loans) {
      if (loan.isFullYear) kept.push(loan);
      else excludedExtrapolated.push(loan.loanId);
    }
    loans = kept;
  }

  return { loans, perReport, conflicts, excludedExtrapolated };
}

/** Filas de cierre de página que no son datos. */
function isFooterRow(row: unknown[]): boolean {
  const first = norm(row[0]);
  if (/^totals?$/i.test(first)) return true;
  const joined = row.map(norm).join(" ");
  return /computershare|all rights reserved|page \d+ of \d+/i.test(joined);
}

/**
 * Los encabezados de las tablas que el parser reconoce, tal como están escritos.
 *
 * POR QUÉ EXISTE
 *
 * `locateColumns` busca cinco columnas —Pros ID, NOI, fechas— y descarta el
 * resto sin mirarlo. Un informe del servicer trae bastante más: estado de pago,
 * días de atraso, transferencia a special servicing, watchlist. Nunca las
 * listamos porque el parser no las necesitaba.
 *
 * Esa es la misma trampa que ya nos costó dos veces en el Annex A: buscar lo que
 * esperás encontrar te deja ciego a lo que hay. Antes de escribir un parser para
 * morosidad hay que ver cómo se llaman esas columnas en cada familia de
 * administrador, no adivinarlo.
 *
 * Devuelve el encabezado fusionado —las tres filas que el formato parte— para
 * cada tabla reconocida.
 */
export function describeServicerHeaders(
  tables: ExtractedTable[],
): Array<{ family: string; headerRow: number; headers: string[]; rows: unknown[][] }> {
  const out: Array<{
    family: string; headerRow: number; headers: string[]; rows: unknown[][];
  }> = [];

  for (const table of tables) {
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r]!;
      const schema = SCHEMAS.find((sc) => row.some((c) => sc.anchor.test(norm(c))));
      if (!schema) continue;

      const width = Math.max(
        ...table.rows.slice(Math.max(0, r - 2), r + 1).map((x) => x.length),
      );
      const headers: string[] = [];
      for (let col = 0; col < width; col++) {
        const parts: string[] = [];
        for (let back = 2; back >= 0; back--) {
          const src = table.rows[r - back];
          if (!src) continue;
          const text = norm(src[col]);
          if (text && !parts.includes(text)) parts.push(text);
        }
        headers.push(parts.join(" "));
      }

      // Se devuelven las filas de ESTA tabla: sin eso, quien quiera mirar los
      // valores tiene que adivinar de qué tabla salieron los encabezados.
      out.push({ family: schema.family, headerRow: r, headers, rows: table.rows });
      break;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Las partes del trust, de la carátula
// ---------------------------------------------------------------------------

/**
 * Quién administra el trust, según la primera página del 10-D.
 *
 * POR QUÉ IMPORTA
 *
 * El SIR por emisora dice que BANK transfiere a special servicing 4 veces menos
 * que BBCMS, ajustado por añada y perfil de apalancamiento. Eso sobrevivió cinco
 * ataques. Pero el SIR correlaciona 0,73 con la cobertura del NOI, y ya sabemos
 * que esa correlación NO puede ser causal: el numerador sale de la tabla de
 * morosidad, que pega al 97,7% y no depende del NOI.
 *
 * Una correlación real sin mecanismo necesita una causa común, y hay una a la
 * vista: el administrador maestro arma LAS DOS tablas. Si un administrador
 * publica el NOI sin período y además lista menos préstamos como morosos, las
 * dos cosas se mueven juntas sin causarse.
 *
 * Si es eso, "BANK suscribe mejor" es en realidad "Trimont reporta distinto", y
 * el hallazgo cambia de sujeto.
 *
 * POR QUÉ ESTA FUNCIÓN NO ADIVINA
 *
 * Devuelve también la fila cruda de donde sacó cada valor. Hoy construí cuatro
 * veces sobre un layout imaginado y las cuatro salió mal; el valor crudo al lado
 * del valor parseado es lo único que dejó verlo.
 */
export interface TrustParty {
  rol: string;
  nombre: string;
  /** La fila del documento de donde salió, para poder desconfiar del parseo. */
  crudo: string;
}

const ROLES: Array<[string, RegExp]> = [
  ["master servicer", /^master\s*servicer\b/i],
  ["special servicer", /^special\s*servicer\b/i],
  ["certificate administrator", /^certificate\s*administrator\b/i],
  ["trustee", /^trustee\b/i],
];

/**
 * Un nombre de administrador es el de una persona jurídica.
 *
 * Sin este filtro, `"Return Date"` entró como administrador maestro de una
 * emisión de BMO: una etiqueta de rol que aparece en una tabla que no es la
 * carátula, con la celda de al lado tomada como nombre. Es el mismo bicho que
 * `"Trustee Fee" → "Fee"`.
 *
 * Preferir un candidato con forma societaria es más robusto que seguir
 * agregando exclusiones de a una, porque no depende de anticipar qué texto
 * espurio va a aparecer en el próximo formato.
 */
const FORMA_SOCIETARIA =
  /\b(LLC|L\.L\.C|N\.A\.?|National Association|Bank|Banc|Inc\.?|Incorporated|Company|Corp\.?|Corporation|Services|Servicing|Trust Co|LP|L\.P|Ltd|Advisors|Management|Capital)\b/i;

/**
 * Midland aparecía como cinco cadenas distintas —"a Division of PNC Bank,
 * National Association", ", N.A.", " N.A.", y a secas— que son la misma
 * entidad. Cualquier tasa por administrador calculada sobre eso sale partida en
 * cinco celdas de n chico, que es exactamente cómo se fabrica un resultado que
 * parece ruido.
 *
 * El canónico se aplica al escribir, no al consultar: si vive en el SQL, la
 * próxima consulta que alguien escriba no lo tiene.
 */
export function canonicalParty(nombre: string | null): string | null {
  if (!nombre) return null;
  const s = nombre.trim();
  if (/midland/i.test(s)) return "Midland Loan Services";
  if (/keybank/i.test(s)) return "KeyBank N.A.";
  if (/trimont/i.test(s)) return "Trimont LLC";
  if (/wells\s*fargo/i.test(s)) return "Wells Fargo Bank, N.A.";
  if (/computershare/i.test(s)) return "Computershare Trust Company, N.A.";
  if (/rialto/i.test(s)) return "Rialto Capital Advisors, LLC";
  if (/k-?star/i.test(s)) return "K-Star Asset Management LLC";
  if (/argentic/i.test(s)) return "Argentic Services Company LP";
  if (/lnr/i.test(s)) return "LNR Partners, LLC";
  if (/situs/i.test(s)) return "Situs Holdings, LLC";
  if (/greystone/i.test(s)) return "Greystone Servicing Company LLC";
  return s.replace(/[,\s]+$/, "");
}

export function extractParties(tables: ExtractedTable[]): TrustParty[] {
  const out: TrustParty[] = [];
  const vistos = new Set<string>();

  for (const table of tables) {
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r]!;
      for (let c = 0; c < row.length; c++) {
        const etiqueta = norm(row[c]);
        if (!etiqueta) continue;

        /**
         * "Trustee Fee | 290.00" en la tabla de shortfalls hacía que el rol
         * `trustee` saliera con nombre "Fee". El `\b` del patrón no alcanza:
         * hay filas contables cuya etiqueta arranca con el nombre del rol.
         */
        if (/\b(fee|advance|reimburs|expense)/i.test(etiqueta)) continue;

        const hit = ROLES.find(([, re]) => re.test(etiqueta));
        if (!hit) continue;
        const [rol] = hit;
        if (vistos.has(rol)) continue;

        /**
         * El valor puede estar en la misma celda ("Master Servicer / Trimont
         * LLC"), a la derecha, o en la fila de abajo. Se prueban en ese orden y
         * se descarta lo que claramente no es un nombre: correos, teléfonos y
         * la propia etiqueta repetida.
         */
        const candidatos: string[] = [];
        const resto = etiqueta.replace(ROLES.find(([n]) => n === rol)![1], "").trim();
        if (resto) candidatos.push(resto);
        for (let k = c + 1; k < row.length; k++) candidatos.push(norm(row[k]));
        const abajo = table.rows[r + 1];
        if (abajo) candidatos.push(norm(abajo[c]));

        const limpios = candidatos
          .map((s) => s.replace(/^[\/:\-–\s]+/, "").trim())
          .filter(
            (s) =>
              s.length > 2 &&
              !/@|https?:|^\(?\d{3}\)?[\s.-]?\d{3}/.test(s) &&
              !ROLES.some(([, re]) => re.test(s)),
          );

        /**
         * Con forma societaria primero. Si ninguno la tiene, NO se cae al
         * primer candidato: se deja el rol sin resolver. Un `(sin dato)` es una
         * ausencia visible; `"Return Date"` es una respuesta falsa que se cuela
         * en la tabla cruzada y la hace ver más limpia de lo que está.
         */
        const nombre = limpios.find((s) => FORMA_SOCIETARIA.test(s));
        if (!nombre) continue;
        vistos.add(rol);
        out.push({
          rol,
          nombre: (canonicalParty(nombre) ?? nombre).slice(0, 80),
          crudo: row.map((x) => norm(x)).filter(Boolean).join(" | ").slice(0, 120),
        });
      }
    }
  }

  return out;
}

export function parseServicerReport(html: string): ServicerParseResult {
  const tables = extractFromHtml(html, { mergeHeaders: false, minRows: 2 });
  return parseServicerTables(tables);
}

export function parseServicerTables(tables: ExtractedTable[]): ServicerParseResult {
  const rows: ServicerLoanRow[] = [];
  const issues: string[] = [];

  let tablesMatched = 0;
  const families = new Set<string>();
  let droppedNoDates = 0;
  let droppedShortPeriod = 0;
  let droppedNoProsId = 0;

  /**
   * La tabla de morosidad se recorre en la misma pasada.
   *
   * Es un bloque distinto del de NOI —no comparte columnas ni fila de
   * encabezado— así que no se puede resolver con el mismo localizador. Se une
   * después por Pros ID, igual que se unen los bloques horizontales del Annex A.
   */
  const delinquency: ServicerDelinquencyRow[] = [];
  let delinquencyTables = 0;
  let delinquencyDataRows = 0;
  let delinquencyDropped = 0;
  const delinquencyDroppedSamples: string[] = [];
  const sample = (raw: string) => {
    if (delinquencyDroppedSamples.length < 3) {
      delinquencyDroppedSamples.push(raw.slice(0, 60));
    }
  };
  for (const table of tables) {
    const del = locateDelinquency(table.rows);
    if (!del) continue;
    delinquencyTables++;

    for (let r = del.headerRow + 1; r < table.rows.length; r++) {
      const row = table.rows[r]!;
      if (isFooterRow(row)) continue;

      const prosId = norm(row[del.prosId]);
      if (!prosId) continue;
      delinquencyDataRows++;

      /**
       * Las notas al pie entran por la puerta del identificador.
       *
       * La columna se titula "Mortgage Loan Status¹" y al final de la tabla el
       * documento explica el superíndice con una fila que arranca en "1". Esa
       * fila tiene un número en la primera celda, así que `normalizeProsId` la
       * acepta y aparece como un préstamo.
       *
       * En Benchmark 2024-V7 era la ÚNICA fila: el deal no tiene morosos y el
       * parser reportaba uno. Un conteo lo daba por sano; el valor crudo
       * —"1 Mortgage Loan Status"— lo delató.
       *
       * Un Pros ID es un número con a lo sumo un sufijo corto de tramo (12A,
       * 5-B). Dos letras seguidas son prosa.
       */
      if (/[a-z]{2,}/i.test(prosId)) {
        delinquencyDropped++;
        sample(prosId);
        continue;
      }

      const loanId = normalizeProsId(prosId);
      if (!loanId) {
        delinquencyDropped++;
        sample(prosId);
        continue;
      }

      const cell = (i: number) => (i === -1 ? null : norm(row[i]) || null);
      const months = parseMoney(row[del.months]);

      delinquency.push({
        prosId,
        loanId,
        paidThrough: parseShortDate(row[del.paidThrough]),
        monthsDelinquent: months,
        status: cell(del.status),
        transferDate: del.transfer === -1 ? null : parseShortDate(row[del.transfer]),
        foreclosureDate:
          del.foreclosure === -1 ? null : parseShortDate(row[del.foreclosure]),
        reoDate: del.reo === -1 ? null : parseShortDate(row[del.reo]),
      });
    }
  }

  /**
   * Segunda pasada: los especialmente administrados.
   *
   * Va después del bloque de morosidad a propósito, porque necesita saber qué
   * préstamos ya se contaron ahí para poder reportar cuántos aparecen SOLO acá
   * —que es la medida de lo que el parser perdía—.
   */
  const specialServicing: ServicerSpecialRow[] = [];
  let specialTables = 0;
  let specialDataRows = 0;
  let specialSoloAqui = 0;
  const yaMorosos = new Set(delinquency.map((d) => d.loanId));

  for (const table of tables) {
    const esp = locateSpecialServicing(table.rows);
    if (!esp) continue;
    specialTables++;

    for (let r = esp.headerRow + 1; r < table.rows.length; r++) {
      const row = table.rows[r]!;
      if (isFooterRow(row)) continue;

      const prosId = norm(row[esp.prosId]);
      if (!prosId) continue;
      specialDataRows++;

      // Mismo guard que en morosidad: dos letras seguidas es prosa, no un ID.
      if (/[a-z]{2,}/i.test(prosId)) continue;
      const loanId = normalizeProsId(prosId);
      if (!loanId) continue;

      const cell = (i: number) => (i === -1 ? null : norm(row[i]) || null);
      const transferDate =
        esp.transfer === -1 ? null : parseShortDate(row[esp.transfer]);

      /**
       * Sin fecha de transferencia la fila no aporta el evento que buscamos.
       * Puede ser una fila de continuación o un préstamo ya resuelto.
       */
      if (!transferDate) continue;

      if (!yaMorosos.has(loanId)) specialSoloAqui++;

      specialServicing.push({
        prosId,
        loanId,
        transferDate,
        resolutionCode: cell(esp.resolution),
        propertyType: cell(esp.propertyType),
        state: cell(esp.state),
      });
    }
  }

  for (const table of tables) {
    const cols = locateColumns(table.rows);
    if (!cols) continue;
    tablesMatched++;
    families.add(cols.family);

    for (let r = cols.headerRow + 1; r < table.rows.length; r++) {
      const row = table.rows[r]!;
      if (isFooterRow(row)) continue;

      const prosId = norm(row[cols.prosId]);
      if (!prosId) continue;

      const loanId = normalizeProsId(prosId);
      if (!loanId) {
        droppedNoProsId++;
        continue;
      }

      const fiscalNoi = cols.fiscalNoi === -1 ? null : parseMoney(row[cols.fiscalNoi]);
      const recentNoiRaw = parseMoney(row[cols.recentNoi]);
      const noiStart = parseShortDate(row[cols.noiStart]);
      const noiEnd = parseShortDate(row[cols.noiEnd]);

      let periodDays: number | null = null;
      let annualizedNoi: number | null = null;
      let isFullYear = false;

      // Un valor sin par de fechas es "no reportado", no un NOI de cero.
      if (recentNoiRaw !== null && noiStart && noiEnd) {
        periodDays = daysBetween(noiStart, noiEnd);
        if (periodDays >= MIN_PERIOD_DAYS) {
          isFullYear = periodDays >= FULL_YEAR_MIN_DAYS;
          annualizedNoi = isFullYear ? recentNoiRaw : (recentNoiRaw * 365) / periodDays;
        } else {
          droppedShortPeriod++;
        }
      } else if (recentNoiRaw !== null) {
        droppedNoDates++;
      }

      rows.push({
        prosId,
        loanId,
        fiscalNoi,
        recentNoi: recentNoiRaw,
        noiStart,
        noiEnd,
        periodDays,
        annualizedNoi,
        isFullYear,
        sourceTable: table.name,
      });
    }
  }

  // --- deduplicación de tramos -------------------------------------------

  const byLoan = new Map<string, ServicerLoanRow[]>();
  for (const row of rows) {
    if (!row.loanId || row.annualizedNoi === null) continue;
    const list = byLoan.get(row.loanId) ?? [];
    list.push(row);
    byLoan.set(row.loanId, list);
  }

  const loans: ServicerLoanFact[] = [];
  const trancheConflicts: Array<{ loanId: string; values: number[] }> = [];

  for (const [loanId, group] of byLoan) {
    const distinct = [...new Set(group.map((g) => Math.round(g.annualizedNoi!)))];
    if (distinct.length > 1) {
      // Los tramos de un mismo préstamo deberían traer el NOI de la misma
      // propiedad. Que difieran significa que la normalización del Pros ID unió
      // préstamos que no van juntos, o que el servicer reportó inconsistente.
      trancheConflicts.push({ loanId, values: distinct });
      continue;
    }

    // Ante empate se prefiere el período más largo: menos extrapolación.
    const best = group.reduce((a, b) => ((b.periodDays ?? 0) > (a.periodDays ?? 0) ? b : a));
    loans.push({
      loanId,
      annualizedNoi: best.annualizedNoi!,
      noiStart: best.noiStart!,
      noiEnd: best.noiEnd!,
      periodDays: best.periodDays!,
      isFullYear: best.isFullYear,
      tranches: group.length,
    });
  }

  loans.sort((a, b) => Number(a.loanId) - Number(b.loanId));

  const fullYear = loans.filter((l) => l.isFullYear).length;
  const fullYearShare = loans.length ? fullYear / loans.length : 0;

  if (tablesMatched === 0) {
    issues.push(
      'No se encontró la tabla "Mortgage Loan Detail (Part 2)". ' +
        "Puede ser otra familia de formato: revisá el documento a mano.",
    );
  }
  if (loans.length === 0 && tablesMatched > 0) {
    issues.push(
      `Se ubicó la tabla pero ningún préstamo quedó con NOI utilizable ` +
        `(${droppedNoDates} sin fechas, ${droppedShortPeriod} con período corto).`,
    );
  }
  if (trancheConflicts.length > 0) {
    issues.push(
      `${trancheConflicts.length} préstamo(s) con tramos que reportan NOI distintos: ` +
        trancheConflicts.slice(0, 3).map((c) => c.loanId).join(", "),
    );
  }
  /**
   * Que la mayoría venga extrapolada no es un defecto del parser sino del mes
   * elegido: un informe de julio reporta el trimestre en curso, y uno de marzo
   * o abril suele traer el ejercicio anterior completo. Si este aviso aparece
   * seguido, la solución es cambiar qué filing se cosecha, no tolerar la
   * extrapolación.
   */
  if (loans.length > 0 && fullYearShare < 0.5) {
    issues.push(
      `Solo ${(fullYearShare * 100).toFixed(0)}% de los préstamos trae un año completo. ` +
        "El resto se anualizó desde períodos parciales: probá un filing de otro mes.",
    );
  }

  return {
    delinquency,
    specialServicing,
    rows,
    loans,
    diagnostics: {
      tablesScanned: tables.length,
      tablesMatched,
      families: [...families],
      rowsFound: rows.length,
      droppedNoDates,
      droppedShortPeriod,
      droppedNoProsId,
      delinquencyTables,
      delinquencyDataRows,
      delinquencyDropped,
      delinquencyDroppedSamples,
      specialTables,
      specialDataRows,
      specialSoloAqui,
      trancheConflicts,
      fullYearShare,
    },
    issues,
  };
}

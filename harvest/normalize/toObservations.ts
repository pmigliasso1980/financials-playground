/**
 * Convierte filas del Annex A en observations de nuestro modelo.
 *
 * Cada celda con dato se vuelve una observation con su provenance completa:
 * qué filing, qué archivo, qué fila, qué columna, y con qué header original.
 * Eso es lo que permite después contestar "¿de dónde salió este número?".
 *
 * Confidence: el Annex A es un documento regulatorio auditado, así que la
 * confianza base es alta. Baja cuando el header fue ambiguo (score bajo en el
 * mapeo) o cuando el valor tuvo que ser inferido.
 */

import {
  looksLikeAggregateRow,
  mapColumns,
  parseValue,
  type ColumnMatch,
  type MetricKey,
} from "./columnMap.js";
import { normalizarEstado } from "./estados.js";

export interface SourceRef {
  /** CIK del emisor. */
  cik: string;
  accession: string;
  companyName: string;
  formType: string;
  filedAt: string;
  /** Nombre del archivo Annex A dentro del filing. */
  fileName: string;
  fileUrl: string;
}

export interface HarvestedObservation {
  /** Identificador estable derivado del filing + fila + métrica. */
  id: string;
  metric_key: MetricKey;
  metric_label: string;
  unit: string;
  entity_type: "deal" | "property";
  /** Índice de la fila dentro del Annex A, 0-based sobre las filas de datos. */
  row_index: number;
  value: string;
  /** El texto crudo de la celda, antes de parsear. */
  raw_value: string;
  confidence: number;
  /** Header original de la columna — clave para auditar el mapeo. */
  source_header: string;
  source_column_index: number;
  source: SourceRef;
}

/**
 * Una celda de una columna que el mapeo no supo interpretar.
 *
 * POR QUÉ GUARDAR LO QUE NO ENTENDEMOS
 *
 * Cuando una identidad no cierra, la aritmética ya dice cuánto tendría que valer
 * el número que falta: si el debt yield publicado es 13,7% y el NOI 97,1M, el
 * saldo tiene que ser 708.777.715. Lo que faltaba era saber de qué columna
 * sacarlo, y eso lo venía haciendo un humano leyendo ochenta y siete
 * encabezados y adivinando cuál podía ser.
 *
 * Con la celda guardada la pregunta es una comparación: qué columna de ESTA
 * MISMA FILA vale 708.777.715. La respuesta no es una hipótesis sobre lo que el
 * encabezado quiere decir, es una coincidencia numérica.
 *
 * Solo se guardan las celdas que parsean como número. El resto —fechas,
 * descripciones, notas al pie— no sirve para reconciliar y multiplicaría la
 * tabla por tres.
 */
export interface UnmappedCell {
  header: string;
  columnIndex: number;
  raw: string;
  /** Solo si la celda parsea como número; si no, la celda no se guarda. */
  value: number;
}

/** Solo el tipo: se borra al compilar, así que el ciclo con toProperties no existe en runtime. */
import type { HarvestedPropertyRow } from "./toProperties.js";

export interface HarvestedProperty {
  /** Clave estable: accession + índice de fila. */
  key: string;
  row_index: number;
  observations: HarvestedObservation[];
  /** Celdas numéricas de columnas sin mapear, para el reconciliador. */
  unmappedCells: UnmappedCell[];
  /** Atajo a los campos de texto, para poder listar sin recorrer observations. */
  label: {
    property_name: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    property_type: string | null;
    loan_seller: string | null;
  };
}

export interface HarvestResult {
  source: SourceRef;
  headerRowIndex: number;
  columnsMapped: Array<{ header: string; metric: MetricKey; score: number }>;
  columnsUnmapped: string[];
  properties: HarvestedProperty[];
  /**
   * Las filas de propiedad normalizadas, que antes se descartaban.
   *
   * Lo llena quien cosecha —`toProperties` necesita las filas crudas y acá ya no
   * están— así que es opcional: un llamador que no lo complete sigue andando.
   */
  propertyRows?: HarvestedPropertyRow[];
  stats: {
    dataRows: number;
    propertiesKept: number;
    observations: number;
    /** Filas descartadas por no tener ningún dato útil. */
    rowsSkipped: number;
    /**
     * Filas de propiedad descartadas ANTES de llegar acá, por `keepLoanRows`.
     *
     * Lo llena quien cosecha, porque el filtro corre antes de esta función y desde
     * acá el dato ya no existe. Va en stats igual porque es la única forma de saber
     * cuánta geografía estamos tirando sin volver a bajar los documentos.
     *
     * Opcional: las 233 emisiones ya cosechadas no lo tienen.
     */
    propertyRowsDropped?: number;
    coverageByMetric: Record<string, number>;
  };
}

/**
 * Reinterpreta `Number of Units` según `Unit of Measure`.
 *
 * DESCUBIERTO CON DATOS REALES
 *
 * Un Annex A no tiene columnas separadas para unidades y superficie: tiene una
 * sola, `Number of Units`, más `Unit of Measure` que dice qué se está contando.
 *
 *   Ventana Residences   193      Units
 *   TheWit Chicago       310      Rooms
 *   Portfolio industrial 425,000  SF     ← esto NO son 425.000 unidades
 *
 * Sin este paso, un galpón entra al Index como una propiedad de 425.000
 * unidades. `checkSanity` lo detectaba —"4 propiedades con >5000 unidades"—
 * pero el diagnóstico apuntaba al mapeo de columnas, que estaba bien: el
 * problema era semántico.
 *
 * Rooms, Keys, Pads y Beds sí son unidades contables y se dejan como están; el
 * `unit_of_measure` queda guardado aparte para que un analista sepa qué son.
 */
const AREA_MEASURES = /^(sf|sq\.?\s*ft\.?|square\s*feet|nra|gla|acres?)$/i;

/**
 * El número de una celda cruda, o null si no es un número.
 *
 * Deliberadamente NO usa `parseValue`: esa función interpreta según la unidad de
 * la métrica —convierte porcentajes a fracción, quita el sufijo "x" de los
 * ratios— y acá no hay métrica, justamente. Queremos la magnitud tal como está
 * impresa, para poder compararla contra un valor implícito.
 *
 * Rechaza los números con espacio interno por la misma razón que `parseValue`:
 * "48 5%" en Benchmark 2020-B16 puede ser 48,5 o 485 y repararlo sería adivinar.
 */
function numericCell(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "" || s.length > 32) return null;

  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[$,()%\s\u00a0]/g, (m) =>
    m === "$" || m === "," || m === "(" || m === ")" || m === "%" ? "" : m,
  );
  if (/\d[\s\u00a0]+\d/.test(cleaned)) return null;

  const bare = cleaned.replace(/[\s\u00a0]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(bare)) return null;

  const n = Number(bare);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

function routeByUnitOfMeasure(observations: HarvestedObservation[]): void {
  const measure = observations.find((o) => o.metric_key === "unit_of_measure");
  if (!measure || !AREA_MEASURES.test(measure.value.trim())) return;

  const unitsIdx = observations.findIndex((o) => o.metric_key === "units");
  if (unitsIdx === -1) return;

  const hasOwnSquareFeet = observations.some((o) => o.metric_key === "square_feet");

  if (hasOwnSquareFeet) {
    /**
     * El Annex trae además columnas de superficie propias.
     *
     * Acá NO alcanza con "no tocar nada": el valor sigue guardado como `units`,
     * y una propiedad con 425.000 unidades contamina cualquier comparación.
     * Como ya tenemos la superficie de una columna dedicada, lo correcto es
     * descartar este valor en vez de duplicarlo.
     *
     * Fue el último aviso que quedaba en pie con datos reales: 11 de 32
     * préstamos del pool de Wells Fargo.
     */
    observations.splice(unitsIdx, 1);
    return;
  }

  // Sin columna de superficie dedicada: este valor ES la superficie.
  const units = observations[unitsIdx]!;
  units.metric_key = "square_feet";
  units.metric_label = "Square Feet";
  units.unit = "count";
  units.id = units.id.replace(/:units$/, ":square_feet");
}

/**
 * Confidence base de una observation.
 *
 * El Annex A es información regulatoria, así que arrancamos alto. Lo que baja
 * la confianza no es la fuente sino nuestra interpretación: si el header
 * matcheó flojo, puede que hayamos mapeado la columna equivocada.
 */
function confidenceFor(match: ColumnMatch): number {
  const base = 0.95;
  // score 1.0 → sin penalidad; score 0.6 → -0.12
  const penalty = (1 - match.score) * 0.3;
  return Number(Math.max(base - penalty, 0.5).toFixed(3));
}

export function rowsToObservations(
  rows: unknown[][],
  headerRowIndex: number,
  source: SourceRef,
  opts: { minObservationsPerRow?: number } = {},
): HarvestResult {
  const minPerRow = opts.minObservationsPerRow ?? 3;

  const headers = (rows[headerRowIndex] ?? []).map((c) =>
    c === null || c === undefined ? "" : String(c),
  );
  const { matches, unmapped } = mapColumns(headers);

  const dataRows = rows.slice(headerRowIndex + 1);
  const properties: HarvestedProperty[] = [];
  const coverage: Record<string, number> = {};
  let rowsSkipped = 0;
  let totalObs = 0;

  dataRows.forEach((row, i) => {
    const observations: HarvestedObservation[] = [];

    for (const match of matches) {
      const raw = row?.[match.columnIndex];
      const value = parseValue(raw, match.metric.unit);
      if (value === null) continue;

      observations.push({
        id: `${source.accession}:${i}:${match.metric.key}`,
        metric_key: match.metric.key,
        metric_label: match.metric.label,
        unit: match.metric.unit,
        entity_type: match.metric.entity,
        row_index: i,
        value,
        raw_value: String(raw ?? ""),
        confidence: confidenceFor(match),
        source_header: match.header,
        source_column_index: match.columnIndex,
        source,
      });
    }

    const unmappedCells: UnmappedCell[] = [];
    for (const u of unmapped) {
      const raw = row?.[u.columnIndex];
      const value = numericCell(raw);
      if (value === null) continue;
      unmappedCells.push({
        header: u.header,
        columnIndex: u.columnIndex,
        raw: String(raw),
        value,
      });
    }

    // Una fila con casi nada suele ser un separador o basura.
    if (observations.length < minPerRow) {
      rowsSkipped++;
      return;
    }

    // Las filas de agregación (TOTAL, AVERAGE, WTD AVG) traen suficientes
    // números como para pasar el filtro por cantidad, así que hay que
    // reconocerlas por su etiqueta.
    const textValues = observations
      .filter((o) => o.unit === "text")
      .map((o) => o.value);
    if (looksLikeAggregateRow(textValues)) {
      rowsSkipped++;
      return;
    }

    routeByUnitOfMeasure(observations);

    for (const obs of observations) {
      coverage[obs.metric_key] = (coverage[obs.metric_key] ?? 0) + 1;
    }
    totalObs += observations.length;

    const textOf = (key: MetricKey): string | null =>
      observations.find((o) => o.metric_key === key)?.value ?? null;

    properties.push({
      key: `${source.accession}:${i}`,
      row_index: i,
      observations,
      unmappedCells,
      label: {
        property_name: textOf("property_name"),
        address: textOf("address"),
        city: textOf("city"),
        /**
         * El estado se normaliza a código de dos letras acá y no en la consulta.
         *
         * Algunos emisores publican "New York" y otros "NY". Guardar el texto
         * crudo dejó 795 préstamos invisibles para /comps, que filtra por código
         * —el 8% del corpus, sin dejar rastro, porque un filtro que no matchea no
         * se queja—. Normalizar al escribir es la única forma de que una consulta
         * escrita después no tenga que saber de esto.
         */
        state: normalizarEstado(textOf("state")),
        property_type: textOf("property_type"),
        loan_seller: textOf("loan_seller"),
      },
    });
  });

  return {
    source,
    headerRowIndex,
    columnsMapped: matches.map((m) => ({
      header: m.header,
      metric: m.metric.key,
      score: Number(m.score.toFixed(3)),
    })),
    columnsUnmapped: unmapped.map((u) => u.header),
    properties,
    stats: {
      dataRows: dataRows.length,
      propertiesKept: properties.length,
      observations: totalObs,
      rowsSkipped,
      coverageByMetric: coverage,
    },
  };
}

/**
 * Chequeos de sanidad sobre lo cosechado.
 *
 * Sin esto no sabés si el mapeo salió bien: una columna mal mapeada produce
 * datos que parecen válidos pero están mal. Estas reglas atrapan los errores
 * más comunes —confundir NOI con loan amount, ocupancia con porcentajes ya
 * divididos, unidades con metros cuadrados.
 */
export interface SanityIssue {
  severity: "error" | "warning";
  metric: string;
  message: string;
  sampleValues: string[];
}

export function checkSanity(result: HarvestResult): SanityIssue[] {
  const issues: SanityIssue[] = [];
  const byMetric = new Map<string, string[]>();

  for (const prop of result.properties) {
    for (const obs of prop.observations) {
      const list = byMetric.get(obs.metric_key) ?? [];
      list.push(obs.value);
      byMetric.set(obs.metric_key, list);
    }
  }

  const nums = (key: string) =>
    (byMetric.get(key) ?? []).map(Number).filter((n) => Number.isFinite(n));

  const median = (arr: number[]) => {
    if (arr.length === 0) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };

  // Ocupancia tiene que quedar en 0-1 tras el parseo.
  const occ = nums("occupancy");
  const badOcc = occ.filter((v) => v < 0 || v > 1);
  if (badOcc.length > 0) {
    issues.push({
      severity: "error",
      metric: "occupancy",
      message: `${badOcc.length} valores fuera de 0-1 — el parseo de porcentaje falló`,
      sampleValues: badOcc.slice(0, 5).map(String),
    });
  }

  // LTV típico de CMBS: 0.3-0.85. Fuera de eso, sospechá del mapeo.
  const ltv = nums("ltv");
  const badLtv = ltv.filter((v) => v <= 0 || v > 1.2);
  if (badLtv.length > ltv.length * 0.1 && badLtv.length > 0) {
    issues.push({
      severity: "warning",
      metric: "ltv",
      message: `${badLtv.length}/${ltv.length} LTV fuera de rango razonable`,
      sampleValues: badLtv.slice(0, 5).map(String),
    });
  }

  // DSCR de CMBS: casi siempre 0.8-4.0.
  const dscr = nums("dscr");
  const badDscr = dscr.filter((v) => v <= 0 || v > 10);
  if (badDscr.length > 0) {
    issues.push({
      severity: "warning",
      metric: "dscr",
      message: `${badDscr.length} DSCR fuera de 0-10 — puede estar mapeado a otra columna`,
      sampleValues: badDscr.slice(0, 5).map(String),
    });
  }

  /**
   * Un valor que aparece repetido en decenas de préstamos delata desalineación.
   *
   * Métricas continuas como NOI, tasa o balance son prácticamente únicas por
   * préstamo. Si el mismo número se repite en muchas filas, lo más probable es
   * que la columna venga de otro bloque: en BANK 2026-BNK52, `interest_rate`
   * traía "360" y "480" repetidos —plazos de amortización en meses.
   */
  const CONTINUOUS: MetricKey[] = [
    "interest_rate", "noi_underwritten", "loan_amount", "appraised_value",
  ];
  for (const key of CONTINUOUS) {
    const values = (byMetric.get(key) ?? []).filter(Boolean);
    if (values.length < 20) continue;

    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);

    const [topValue, topCount] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
    const share = topCount / values.length;

    if (share > 0.15) {
      issues.push({
        severity: "error",
        metric: key,
        message:
          `el valor "${topValue}" se repite en ${topCount} de ${values.length} préstamos ` +
          `(${Math.round(share * 100)}%) — una métrica continua no se repite así, ` +
          `probablemente la columna esté desalineada`,
        sampleValues: [topValue],
      });
    }
  }

  /**
   * Tasa de interés fuera de rango plausible.
   *
   * Este chequeo faltaba y costó caro: un análisis de series temporales dio
   * medianas trimestrales de 84% y 0% para la tasa de un pool de multifamily.
   * Cada valor suelto parecía un porcentaje válido, así que ningún otro control
   * lo detectó — pero una hipoteca comercial al 84% no existe.
   *
   * Rango: entre 1% y 20%. Fuera de ahí no es una tasa de préstamo comercial.
   */
  const rates = nums("interest_rate");
  const badRates = rates.filter((v) => v < 0.01 || v > 0.20);
  if (badRates.length > 0) {
    const share = badRates.length / rates.length;
    issues.push({
      severity: share > 0.2 ? "error" : "warning",
      metric: "interest_rate",
      message:
        `${badRates.length}/${rates.length} tasas fuera de 1%-20% — ` +
        `una hipoteca comercial no cotiza ahí, revisá qué columna se mapeó`,
      sampleValues: badRates.slice(0, 5).map((v) => `${(v * 100).toFixed(2)}%`),
    });
  }

  // Cap rate: entre 2% y 15% en cualquier mercado y tipo de activo.
  const caps = nums("cap_rate");
  const badCaps = caps.filter((v) => v < 0.02 || v > 0.15);
  if (badCaps.length > 0) {
    issues.push({
      severity: "warning",
      metric: "cap_rate",
      message: `${badCaps.length} cap rates fuera de 2%-15%`,
      sampleValues: badCaps.slice(0, 5).map((v) => `${(v * 100).toFixed(2)}%`),
    });
  }

  // NOI debería ser menor que el loan amount en la mayoría de los casos.
  const noiMed = median(nums("noi_underwritten"));
  const loanMed = median(nums("loan_amount"));
  if (noiMed !== null && loanMed !== null && noiMed > loanMed) {
    issues.push({
      severity: "error",
      metric: "noi_underwritten",
      message:
        `la mediana de NOI (${noiMed.toLocaleString()}) supera la de loan amount ` +
        `(${loanMed.toLocaleString()}) — casi seguro están las columnas cruzadas`,
      sampleValues: [],
    });
  }

  // Unidades: un activo con 50.000 "unidades" es metros cuadrados mal mapeados.
  const units = nums("units");
  const hugeUnits = units.filter((v) => v > 5000);
  if (hugeUnits.length > units.length * 0.2 && hugeUnits.length > 0) {
    issues.push({
      severity: "warning",
      metric: "units",
      message: `${hugeUnits.length} propiedades con >5000 unidades — puede ser square feet mal mapeado`,
      sampleValues: hugeUnits.slice(0, 5).map(String),
    });
  }

  /**
   * Cobertura de los conceptos centrales.
   *
   * Se evalúan por CONCEPTO, no por métrica: un Annex A puede publicar solo
   * ocupancia económica, o solo NOI underwritten sin histórico. Alcanza con que
   * alguna variante del concepto esté presente. Avisar por cada variante
   * ausente generaría ruido en cada corrida y terminaría ignorándose.
   */
  const coreConcepts: Array<{ label: string; keys: MetricKey[] }> = [
    { label: "NOI", keys: ["noi_underwritten", "noi_most_recent"] },
    { label: "occupancy", keys: ["occupancy", "occupancy_economic"] },
    { label: "loan_amount", keys: ["loan_amount"] },
  ];

  for (const concept of coreConcepts) {
    const best = Math.max(
      0,
      ...concept.keys.map((k) => result.stats.coverageByMetric[k] ?? 0),
    );
    const pct = result.stats.propertiesKept > 0 ? best / result.stats.propertiesKept : 0;
    if (pct < 0.5) {
      const variants = concept.keys.join(" | ");
      issues.push({
        severity: "warning",
        metric: concept.label,
        message:
          `solo ${Math.round(pct * 100)}% de las filas tienen este concepto ` +
          `(${variants}) — revisá el mapeo de columnas`,
        sampleValues: [],
      });
    }
  }

  return issues;
}

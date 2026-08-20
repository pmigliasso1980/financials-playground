/**
 * Converts Annex A rows into observations in our model.
 *
 * Every cell with data becomes an observation with its full provenance: which
 * filing, which file, which row, which column, and under which original header.
 * That is what later makes it possible to answer "where did this number come
 * from?".
 *
 * Confidence: the Annex A is an audited regulatory document, so the base
 * confidence is high. It drops when the header was ambiguous (a low mapping
 * score) or when the value had to be inferred.
 */

import {
  looksLikeAggregateRow,
  mapColumns,
  parseValue,
  type ColumnMatch,
  type MetricKey,
} from "./columnMap.js";
import { normalizeState } from "./states.js";

export interface SourceRef {
  /** The issuer's CIK. */
  cik: string;
  accession: string;
  companyName: string;
  formType: string;
  filedAt: string;
  /** Name of the Annex A file within the filing. */
  fileName: string;
  fileUrl: string;
}

export interface HarvestedObservation {
  /** Stable identifier derived from filing + row + metric. */
  id: string;
  metric_key: MetricKey;
  metric_label: string;
  unit: string;
  entity_type: "deal" | "property";
  /** Index of the row within the Annex A, 0-based over the data rows. */
  row_index: number;
  value: string;
  /** The raw text of the cell, before parsing. */
  raw_value: string;
  confidence: number;
  /** The column's original header — the key to auditing the mapping. */
  source_header: string;
  source_column_index: number;
  source: SourceRef;
}

/**
 * A cell from a column the mapping could not interpret.
 *
 * WHY STORE WHAT WE DO NOT UNDERSTAND
 *
 * When an identity does not close, the arithmetic already says what the missing
 * number would have to be: if the published debt yield is 13.7% and the NOI
 * 97.1M, the balance has to be 708,777,715. What was missing was knowing which
 * column to take it from, and that was being done by a human reading eighty-seven
 * headers and guessing which one it could be.
 *
 * With the cell stored, the question becomes a comparison: which column of THIS
 * SAME ROW is worth 708,777,715. The answer is not a hypothesis about what the
 * header means, it is a numeric match.
 *
 * Only cells that parse as a number are stored. The rest —dates, descriptions,
 * footnotes— are no use for reconciling and would triple the size of the table.
 */
export interface UnmappedCell {
  header: string;
  columnIndex: number;
  raw: string;
  /** Only if the cell parses as a number; otherwise the cell is not stored. */
  value: number;
}

/** Type only: erased at compile time, so the cycle with toProperties does not exist at runtime. */
import type { HarvestedPropertyRow } from "./toProperties.js";

export interface HarvestedProperty {
  /** Stable key: accession + row index. */
  key: string;
  row_index: number;
  observations: HarvestedObservation[];
  /** Numeric cells from unmapped columns, for the reconciler. */
  unmappedCells: UnmappedCell[];
  /** Shortcut to the text fields, so they can be listed without walking observations. */
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
   * The normalised property rows, which used to be discarded.
   *
   * Filled in by whoever harvests —`toProperties` needs the raw rows and they are
   * no longer here— so it is optional: a caller that does not populate it still
   * works.
   */
  propertyRows?: HarvestedPropertyRow[];
  stats: {
    dataRows: number;
    propertiesKept: number;
    observations: number;
    /** Rows discarded for having no useful data at all. */
    rowsSkipped: number;
    /**
     * Property rows discarded BEFORE reaching here, by `keepLoanRows`.
     *
     * Filled in by whoever harvests, because the filter runs before this function
     * and from here the datum no longer exists. It goes in stats anyway because it
     * is the only way to know how much geography we are throwing away without
     * downloading the documents again.
     *
     * Optional: the 233 issuances already harvested do not have it.
     */
    propertyRowsDropped?: number;
    coverageByMetric: Record<string, number>;
  };
}

/**
 * Reinterprets `Number of Units` according to `Unit of Measure`.
 *
 * DISCOVERED WITH REAL DATA
 *
 * An Annex A does not have separate columns for units and area: it has a single
 * one, `Number of Units`, plus `Unit of Measure` saying what is being counted.
 *
 *   Ventana Residences   193      Units
 *   TheWit Chicago       310      Rooms
 *   Industrial portfolio 425,000  SF     ← this is NOT 425,000 units
 *
 * Without this step, a warehouse enters the Index as a property with 425,000
 * units. `checkSanity` was detecting it —"4 properties with >5000 units"— but
 * the diagnosis pointed at the column mapping, which was fine: the problem was
 * semantic.
 *
 * Rooms, Keys, Pads and Beds are countable units and are left as they are; the
 * `unit_of_measure` is stored separately so an analyst knows what they are.
 */
const AREA_MEASURES = /^(sf|sq\.?\s*ft\.?|square\s*feet|nra|gla|acres?)$/i;

/**
 * The number in a raw cell, or null if it is not a number.
 *
 * Deliberately does NOT use `parseValue`: that function interprets according to
 * the metric's unit —converting percentages to fractions, stripping the "x"
 * suffix from ratios— and here there is no metric, precisely. We want the
 * magnitude exactly as printed, so it can be compared against an implied value.
 *
 * It rejects numbers with an internal space for the same reason `parseValue`
 * does: "48 5%" in Benchmark 2020-B16 could be 48.5 or 485, and repairing it
 * would be guessing.
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
     * The Annex also carries its own dedicated area columns.
     *
     * Here "touch nothing" is NOT enough: the value stays stored as `units`, and
     * a property with 425,000 units contaminates any comparison. Since we
     * already have the area from a dedicated column, the right thing is to
     * discard this value rather than duplicate it.
     *
     * It was the last warning still standing against real data: 11 of the 32
     * loans in the Wells Fargo pool.
     */
    observations.splice(unitsIdx, 1);
    return;
  }

  // No dedicated area column: this value IS the area.
  const units = observations[unitsIdx]!;
  units.metric_key = "square_feet";
  units.metric_label = "Square Feet";
  units.unit = "count";
  units.id = units.id.replace(/:units$/, ":square_feet");
}

/**
 * Base confidence of an observation.
 *
 * The Annex A is regulatory information, so we start high. What lowers the
 * confidence is not the source but our interpretation: if the header matched
 * weakly, we may have mapped the wrong column.
 */
function confidenceFor(match: ColumnMatch): number {
  const base = 0.95;
  // score 1.0 → no penalty; score 0.6 → -0.12
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

    // A row with almost nothing is usually a separator or junk.
    if (observations.length < minPerRow) {
      rowsSkipped++;
      return;
    }

    // Aggregation rows (TOTAL, AVERAGE, WTD AVG) carry enough numbers to pass
    // the count filter, so they have to be recognised by their label.
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
         * The state is normalised to a two-letter code here and not in the query.
         *
         * Some issuers publish "New York" and others "NY". Storing the raw text
         * left 795 loans invisible to /comps, which filters by code —8% of the
         * corpus, without a trace, because a filter that does not match does not
         * complain. Normalising on write is the only way for a query written
         * later not to have to know about this.
         */
        state: normalizeState(textOf("state")),
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
 * Sanity checks on what was harvested.
 *
 * Without these you do not know whether the mapping came out right: a
 * mis-mapped column produces data that looks valid and is wrong. These rules
 * catch the most common errors —confusing NOI with loan amount, occupancy with
 * already-divided percentages, units with square feet.
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

  // Occupancy has to end up in 0-1 after parsing.
  const occ = nums("occupancy");
  const badOcc = occ.filter((v) => v < 0 || v > 1);
  if (badOcc.length > 0) {
    issues.push({
      severity: "error",
      metric: "occupancy",
      message: `${badOcc.length} values outside 0-1 — percentage parsing failed`,
      sampleValues: badOcc.slice(0, 5).map(String),
    });
  }

  // Typical CMBS LTV: 0.3-0.85. Outside that, suspect the mapping.
  const ltv = nums("ltv");
  const badLtv = ltv.filter((v) => v <= 0 || v > 1.2);
  if (badLtv.length > ltv.length * 0.1 && badLtv.length > 0) {
    issues.push({
      severity: "warning",
      metric: "ltv",
      message: `${badLtv.length}/${ltv.length} LTV outside a reasonable range`,
      sampleValues: badLtv.slice(0, 5).map(String),
    });
  }

  // CMBS DSCR: almost always 0.8-4.0.
  const dscr = nums("dscr");
  const badDscr = dscr.filter((v) => v <= 0 || v > 10);
  if (badDscr.length > 0) {
    issues.push({
      severity: "warning",
      metric: "dscr",
      message: `${badDscr.length} DSCR outside 0-10 — it may be mapped to another column`,
      sampleValues: badDscr.slice(0, 5).map(String),
    });
  }

  /**
   * A value repeated across dozens of loans gives misalignment away.
   *
   * Continuous metrics like NOI, rate or balance are practically unique per
   * loan. If the same number repeats across many rows, the column most likely
   * comes from another block: in BANK 2026-BNK52, `interest_rate` carried "360"
   * and "480" repeatedly —amortisation terms in months.
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
          `the value "${topValue}" repeats in ${topCount} of ${values.length} loans ` +
          `(${Math.round(share * 100)}%) — a continuous metric does not repeat like that, ` +
          `the column is probably misaligned`,
        sampleValues: [topValue],
      });
    }
  }

  /**
   * Interest rate outside a plausible range.
   *
   * This check was missing and it cost dearly: a time-series analysis gave
   * quarterly medians of 84% and 0% for the rate of a multifamily pool. Each
   * loose value looked like a valid percentage, so no other control caught it —
   * but an 84% commercial mortgage does not exist.
   *
   * Range: between 1% and 20%. Outside that it is not a commercial loan rate.
   */
  const rates = nums("interest_rate");
  const badRates = rates.filter((v) => v < 0.01 || v > 0.20);
  if (badRates.length > 0) {
    const share = badRates.length / rates.length;
    issues.push({
      severity: share > 0.2 ? "error" : "warning",
      metric: "interest_rate",
      message:
        `${badRates.length}/${rates.length} rates outside 1%-20% — ` +
        `a commercial mortgage does not price there, check which column was mapped`,
      sampleValues: badRates.slice(0, 5).map((v) => `${(v * 100).toFixed(2)}%`),
    });
  }

  // Cap rate: between 2% and 15% in any market and asset type.
  const caps = nums("cap_rate");
  const badCaps = caps.filter((v) => v < 0.02 || v > 0.15);
  if (badCaps.length > 0) {
    issues.push({
      severity: "warning",
      metric: "cap_rate",
      message: `${badCaps.length} cap rates outside 2%-15%`,
      sampleValues: badCaps.slice(0, 5).map((v) => `${(v * 100).toFixed(2)}%`),
    });
  }

  // NOI should be smaller than the loan amount in most cases.
  const noiMed = median(nums("noi_underwritten"));
  const loanMed = median(nums("loan_amount"));
  if (noiMed !== null && loanMed !== null && noiMed > loanMed) {
    issues.push({
      severity: "error",
      metric: "noi_underwritten",
      message:
        `the median NOI (${noiMed.toLocaleString()}) exceeds the median loan amount ` +
        `(${loanMed.toLocaleString()}) — the columns are almost certainly crossed`,
      sampleValues: [],
    });
  }

  // Units: an asset with 50,000 "units" is square feet mis-mapped.
  const units = nums("units");
  const hugeUnits = units.filter((v) => v > 5000);
  if (hugeUnits.length > units.length * 0.2 && hugeUnits.length > 0) {
    issues.push({
      severity: "warning",
      metric: "units",
      message: `${hugeUnits.length} properties with >5000 units — may be square feet mis-mapped`,
      sampleValues: hugeUnits.slice(0, 5).map(String),
    });
  }

  /**
   * Coverage of the core concepts.
   *
   * They are evaluated by CONCEPT, not by metric: an Annex A may publish only
   * economic occupancy, or only underwritten NOI with no trailing figure. It is
   * enough for some variant of the concept to be present. Warning about each
   * absent variant would generate noise on every run and end up ignored.
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
          `only ${Math.round(pct * 100)}% of rows have this concept ` +
          `(${variants}) — check the column mapping`,
        sampleValues: [],
      });
    }
  }

  return issues;
}

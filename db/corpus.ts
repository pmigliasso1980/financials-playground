/**
 * Escritura y lectura del corpus cosechado.
 *
 * La invariante que importa: escribir un filing y volver a leerlo tiene que
 * devolver exactamente el mismo `HarvestResult`. Eso permite que el mock cargue
 * desde la base sin distinguir de dónde vinieron los datos, y que el test de
 * conformidad sea un roundtrip.
 *
 * Recosechar el mismo filing lo REEMPLAZA en vez de duplicarlo. Es el
 * comportamiento correcto: cuando el mapeo mejora —esta semana mejoró cuatro
 * veces— querés reprocesar el corpus, no acumular versiones.
 */

import { TAXONOMY_VERSION } from "../harvest/normalize/definitions.js";
import type { PoolClient } from "pg";
import { query, withTransaction } from "./client.js";
import type {
  HarvestResult,
  HarvestedObservation,
  UnmappedCell,
  HarvestedProperty,
  SourceRef,
} from "../harvest/normalize/toObservations.js";
import type { MetricKey } from "../harvest/normalize/columnMap.js";

export interface SaveReport {
  accession: string;
  loans: number;
  observations: number;
  facts: number;
  replaced: boolean;
}

/**
 * Guarda un HarvestResult completo, en una transacción.
 *
 * Los facts canónicos se calculan acá y no se reciben: derivarlos en el punto
 * de escritura garantiza que la base nunca tenga un fact que no corresponda a
 * sus observations.
 */
export async function saveHarvest(result: HarvestResult): Promise<SaveReport> {
  return withTransaction(async (client) => {
    const { accession } = result.source;

    const existing = await client.query<{ accession: string }>(
      "SELECT accession FROM corpus.filings WHERE accession = $1",
      [accession],
    );
    const replaced = existing.rowCount! > 0;

    // ON DELETE CASCADE limpia préstamos, observations y facts.
    if (replaced) {
      await client.query("DELETE FROM corpus.filings WHERE accession = $1", [accession]);
    }

    await client.query(
      `INSERT INTO corpus.filings
         (accession, cik, company_name, form_type, filed_at, file_name, file_url,
          columns_mapped, columns_unmapped, stats)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        accession,
        result.source.cik,
        result.source.companyName,
        result.source.formType,
        result.source.filedAt || null,
        result.source.fileName,
        result.source.fileUrl,
        JSON.stringify(result.columnsMapped),
        JSON.stringify(result.columnsUnmapped),
        /**
         * La versión de la taxonomía va adentro de stats.
         *
         * Sirve para saber qué filings quedaron cosechados con un mapeo viejo,
         * que es la única forma robusta de decidir qué recosechar cuando el
         * mapeo mejora. Intentamos tres criterios por síntoma —"sin loan_ref",
         * "sin loan_ref usable", "rangos disjuntos"— y los tres fallaron por la
         * misma razón: cada arreglo cambia el síntoma, y el selector queda ciego
         * justo a lo que acaba de romperse.
         *
         * La versión no depende de si el resultado se ve sano.
         */
        JSON.stringify({ ...result.stats, taxonomyVersion: TAXONOMY_VERSION }),
      ],
    );

    /**
     * Tres inserciones por lote, no una por fila.
     *
     * La primera versión hacía un round-trip por observation y otro por fact. Un
     * filing con 40 préstamos y 90 métricas cada uno son ~7.000 idas y vueltas a
     * Postgres; sobre 219 filings, más de un millón. Con la base en localhost eso
     * son doce de los dieciocho minutos que tardaba el lote, y el tiempo no está
     * en la red ni en el parseo: está en la latencia de ida y vuelta.
     *
     * Multi-row INSERT lo baja a tres consultas por filing (más los trozos que
     * haga falta partir por el límite de 65.535 parámetros de Postgres).
     */
    const loanIds = await insertLoans(client, accession, result.properties);

    const obsRows = result.properties.flatMap((prop) =>
      prop.observations.map((obs) => ({ loanId: loanIds.get(prop.row_index)!, obs })),
    );
    const stored = await insertObservations(client, obsRows);

    const byLoan = new Map<number, StoredObservation[]>();
    for (const o of stored) {
      const list = byLoan.get(o.loanId);
      if (list) list.push(o);
      else byLoan.set(o.loanId, [o]);
    }
    const factCount = await insertFacts(client, byLoan);
    const observationCount = stored.length;

    const cellRows = result.properties.flatMap((prop) =>
      prop.unmappedCells.map((cell) => ({
        loanId: loanIds.get(prop.row_index)!,
        cell,
      })),
    );
    await insertUnmappedCells(client, cellRows);

    return {
      accession,
      loans: result.properties.length,
      observations: observationCount,
      facts: factCount,
      replaced,
    };
  });
}

/**
 * Inserta todos los préstamos de un filing en una consulta.
 *
 * Devuelve el id de base indexado por `row_index`, que es la clave estable del
 * préstamo dentro del Annex A y lo que después usan las observations.
 */
async function insertLoans(
  client: PoolClient,
  accession: string,
  props: HarvestedProperty[],
): Promise<Map<number, number>> {
  const ids = new Map<number, number>();
  if (props.length === 0) return ids;

  const COLS = 9;
  const CHUNK = Math.floor(60_000 / COLS); // margen sobre el límite de 65.535

  for (let start = 0; start < props.length; start += CHUNK) {
    const slice = props.slice(start, start + CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];

    slice.forEach((prop, i) => {
      const valueOf = (key: MetricKey) =>
        prop.observations.find((o) => o.metric_key === key)?.value ?? null;
      const base = i * COLS;
      tuples.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},` +
          `$${base + 6},$${base + 7},$${base + 8},$${base + 9})`,
      );
      values.push(
        accession,
        prop.row_index,
        valueOf("loan_id"),
        prop.label.property_name,
        prop.label.address,
        prop.label.city,
        prop.label.state,
        valueOf("zip"),
        prop.label.property_type,
      );
    });

    const { rows } = await client.query<{ id: string; row_index: number }>(
      `INSERT INTO corpus.loans
         (accession, row_index, loan_ref, property_name, address, city, state, zip, property_type)
       VALUES ${tuples.join(",")}
       RETURNING id, row_index`,
      values,
    );

    for (const r of rows) ids.set(Number(r.row_index), Number(r.id));
  }

  return ids;
}

interface StoredObservation extends HarvestedObservation {
  loanId: number;
  dbId: number;
}

/**
 * Inserta las observations de un filing entero, en trozos.
 *
 * El `RETURNING` trae la clave natural —loan_id, metric_key, source_header— para
 * poder reasociar cada id de base con su observation en memoria. Sin eso habría
 * que volver a consultar, que es justo lo que estamos evitando.
 */
async function insertObservations(
  client: PoolClient,
  rows: Array<{ loanId: number; obs: HarvestedObservation }>,
): Promise<StoredObservation[]> {
  if (rows.length === 0) return [];

  /**
   * Deduplicar dentro del lote, no solo contra la base.
   *
   * `ON CONFLICT DO UPDATE` falla con "cannot affect row a second time" si la
   * misma clave aparece dos veces en el MISMO statement. Fila por fila eso nunca
   * pasaba —cada INSERT veía la fila anterior ya escrita—. Al agrupar, sí.
   *
   * Gana la de mayor confianza, que es el mismo criterio que usa la promoción a
   * facts. Empatadas, la primera.
   */
  const byKey = new Map<string, { loanId: number; obs: HarvestedObservation }>();
  for (const row of rows) {
    const key = `${row.loanId}|${row.obs.metric_key}|${row.obs.source_header}`;
    const prev = byKey.get(key);
    if (!prev || row.obs.confidence > prev.obs.confidence) byKey.set(key, row);
  }
  const deduped = [...byKey.values()];

  const COLS = 10;
  const CHUNK = Math.floor(60_000 / COLS);
  const stored: StoredObservation[] = [];

  for (let start = 0; start < deduped.length; start += CHUNK) {
    const slice = deduped.slice(start, start + CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];

    slice.forEach(({ loanId, obs }, i) => {
      const b = i * COLS;
      tuples.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},` +
          `$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`,
      );
      values.push(
        loanId, obs.metric_key, obs.metric_label, obs.unit, obs.entity_type,
        obs.value, obs.raw_value, obs.confidence, obs.source_header, obs.source_column_index,
      );
    });

    const { rows: returned } = await client.query<{
      id: string; loan_id: string; metric_key: string; source_header: string;
    }>(
      `INSERT INTO corpus.observations
         (loan_id, metric_key, metric_label, unit, entity_type,
          value, raw_value, confidence, source_header, source_column)
       VALUES ${tuples.join(",")}
       ON CONFLICT (loan_id, metric_key, source_header) DO UPDATE
         SET value = EXCLUDED.value,
             raw_value = EXCLUDED.raw_value,
             confidence = EXCLUDED.confidence
       RETURNING id, loan_id, metric_key, source_header`,
      values,
    );

    const idByKey = new Map(
      returned.map((r) => [`${r.loan_id}|${r.metric_key}|${r.source_header}`, Number(r.id)]),
    );

    for (const { loanId, obs } of slice) {
      const dbId = idByKey.get(`${loanId}|${obs.metric_key}|${obs.source_header}`);
      if (dbId !== undefined) stored.push({ ...obs, loanId, dbId });
    }
  }

  return stored;
}

/**
 * Promueve las observations a facts canónicos, en una consulta por filing.
 *
 * La lógica de promoción no cambió: por préstamo y métrica gana la de mayor
 * confianza, y queda registrado contra cuántas candidatas compitió.
 */
/**
 * Las celdas sin mapear, para que el reconciliador tenga contra qué comparar.
 *
 * Mismo patrón que las otras tres inserciones —multi-row, deduplicado en
 * memoria, troceado por el límite de parámetros de Postgres— por las mismas
 * razones. La clave única es (loan_id, header): si una fila trae dos columnas
 * con el mismo encabezado, gana la primera, que es lo que también hace el mapeo.
 */
async function insertUnmappedCells(
  client: PoolClient,
  rows: Array<{ loanId: number; cell: UnmappedCell }>,
): Promise<number> {
  if (rows.length === 0) return 0;

  const byKey = new Map<string, { loanId: number; cell: UnmappedCell }>();
  for (const row of rows) {
    const key = `${row.loanId}|${row.cell.header}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  const deduped = [...byKey.values()];

  const COLS = 4;
  const CHUNK = Math.floor(60_000 / COLS);
  let written = 0;

  for (let start = 0; start < deduped.length; start += CHUNK) {
    const slice = deduped.slice(start, start + CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];

    for (const { loanId, cell } of slice) {
      const i = values.length;
      tuples.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4})`);
      values.push(loanId, cell.header, cell.raw, cell.value);
    }

    const { rowCount } = await client.query(
      `INSERT INTO corpus.unmapped_cells (loan_id, header, raw_value, value_num)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (loan_id, header) DO UPDATE
         SET raw_value = EXCLUDED.raw_value, value_num = EXCLUDED.value_num`,
      values,
    );
    written += rowCount ?? 0;
  }

  return written;
}

async function insertFacts(
  client: PoolClient,
  byLoan: Map<number, StoredObservation[]>,
): Promise<number> {
  interface Row {
    loanId: number; metricKey: string; entityRef: string;
    value: string; obsId: number; rationale: string;
  }
  const factRows: Row[] = [];

  for (const [loanId, observations] of byLoan) {
    const groups = new Map<string, StoredObservation[]>();
    for (const obs of observations) {
      const entityRef = obs.entity_type === "deal" ? "deal" : "property";
      const key = `${obs.metric_key}|${entityRef}`;
      const list = groups.get(key);
      if (list) list.push(obs);
      else groups.set(key, [obs]);
    }

    for (const [key, candidates] of groups) {
      const [metricKey, entityRef] = key.split("|") as [string, string];
      const winner = [...candidates].sort((a, b) => b.confidence - a.confidence)[0]!;
      factRows.push({
        loanId,
        metricKey,
        entityRef,
        value: winner.value,
        obsId: winner.dbId,
        rationale:
          candidates.length === 1
            ? "único valor disponible"
            : `confidence ${winner.confidence.toFixed(2)} entre ${candidates.length} candidatos`,
      });
    }
  }

  if (factRows.length === 0) return 0;

  const COLS = 6;
  const CHUNK = Math.floor(60_000 / COLS);

  for (let start = 0; start < factRows.length; start += CHUNK) {
    const slice = factRows.slice(start, start + CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];

    slice.forEach((f, i) => {
      const b = i * COLS;
      tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
      values.push(f.loanId, f.metricKey, f.entityRef, f.value, f.obsId, f.rationale);
    });

    await client.query(
      `INSERT INTO corpus.facts
         (loan_id, metric_key, entity_ref, value, observation_id, promotion_rationale)
       VALUES ${tuples.join(",")}
       ON CONFLICT (loan_id, metric_key, entity_ref) DO UPDATE
         SET value = EXCLUDED.value,
             observation_id = EXCLUDED.observation_id,
             promotion_rationale = EXCLUDED.promotion_rationale,
             updated_at = now()`,
      values,
    );
  }

  return factRows.length;
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

interface FilingRow {
  accession: string;
  cik: string;
  company_name: string;
  form_type: string;
  filed_at: Date | null;
  file_name: string;
  file_url: string;
  columns_mapped: HarvestResult["columnsMapped"];
  columns_unmapped: string[];
  stats: HarvestResult["stats"];
}

interface LoanRow {
  id: string;
  row_index: number;
  property_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  property_type: string | null;
}

interface ObservationRow {
  id: string;
  loan_id: string;
  metric_key: MetricKey;
  metric_label: string;
  unit: string;
  entity_type: "deal" | "property";
  value: string;
  raw_value: string | null;
  confidence: number;
  source_header: string;
  source_column: number | null;
}

/** Lee un filing en la misma forma que produce el harvester. */
export async function loadHarvest(accession: string): Promise<HarvestResult | null> {
  const { rows: filings } = await query<FilingRow>(
    "SELECT * FROM corpus.filings WHERE accession = $1",
    [accession],
  );
  const filing = filings[0];
  if (!filing) return null;

  const { rows: loans } = await query<LoanRow>(
    "SELECT * FROM corpus.loans WHERE accession = $1 ORDER BY row_index",
    [accession],
  );

  const { rows: observations } = await query<ObservationRow>(
    `SELECT o.* FROM corpus.observations o
       JOIN corpus.loans l ON l.id = o.loan_id
      WHERE l.accession = $1
      ORDER BY o.loan_id, o.id`,
    [accession],
  );

  const byLoan = new Map<string, ObservationRow[]>();
  for (const obs of observations) {
    const list = byLoan.get(obs.loan_id);
    if (list) list.push(obs);
    else byLoan.set(obs.loan_id, [obs]);
  }

  const source: SourceRef = {
    cik: filing.cik,
    accession: filing.accession,
    companyName: filing.company_name,
    formType: filing.form_type,
    filedAt: filing.filed_at ? toIsoDate(filing.filed_at) : "",
    fileName: filing.file_name,
    fileUrl: filing.file_url,
  };

  const properties: HarvestedProperty[] = loans.map((loan) => ({
    key: `${accession}:${loan.row_index}`,
    row_index: loan.row_index,
    // Al releer del corpus no se reconstruyen: el reconciliador consulta
    // corpus.unmapped_cells directamente, no pasa por esta forma.
    unmappedCells: [],
    label: {
      property_name: loan.property_name,
      address: loan.address,
      city: loan.city,
      state: loan.state,
      property_type: loan.property_type,
    },
    observations: (byLoan.get(loan.id) ?? []).map((o) => ({
      id: `${accession}:${loan.row_index}:${o.metric_key}`,
      metric_key: o.metric_key,
      metric_label: o.metric_label,
      unit: o.unit,
      entity_type: o.entity_type,
      row_index: loan.row_index,
      value: o.value,
      raw_value: o.raw_value ?? "",
      confidence: Number(o.confidence),
      source_header: o.source_header,
      source_column_index: o.source_column ?? 0,
      source,
    })),
  }));

  return {
    source,
    headerRowIndex: 0,
    columnsMapped: filing.columns_mapped,
    columnsUnmapped: filing.columns_unmapped,
    properties,
    stats: filing.stats,
  };
}

/** Lee todo el corpus. */
export async function loadAllHarvests(): Promise<HarvestResult[]> {
  const { rows } = await query<{ accession: string }>(
    "SELECT accession FROM corpus.filings ORDER BY filed_at DESC NULLS LAST, accession",
  );

  const results: HarvestResult[] = [];
  for (const row of rows) {
    const result = await loadHarvest(row.accession);
    if (result) results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------

export interface CorpusStats {
  filings: number;
  loans: number;
  observations: number;
  facts: number;
  byMetric: Array<{ metric_key: string; loans: number; distinct_headers: number }>;
  topUnmapped: Array<{ header: string; filings: number }>;
}

export async function corpusStats(): Promise<CorpusStats> {
  const counts = await query<{ filings: string; loans: string; observations: string; facts: string }>(
    `SELECT
       (SELECT count(*) FROM corpus.filings)      AS filings,
       (SELECT count(*) FROM corpus.loans)        AS loans,
       (SELECT count(*) FROM corpus.observations) AS observations,
       (SELECT count(*) FROM corpus.facts)        AS facts`,
  );

  const byMetric = await query<{ metric_key: string; loans: string; distinct_headers: string }>(
    "SELECT metric_key, loans, distinct_headers FROM corpus.metric_coverage LIMIT 40",
  );

  const unmapped = await query<{ header: string; filings: string }>(
    "SELECT header, filings FROM corpus.unmapped_headers LIMIT 15",
  );

  const c = counts.rows[0]!;
  return {
    filings: Number(c.filings),
    loans: Number(c.loans),
    observations: Number(c.observations),
    facts: Number(c.facts),
    byMetric: byMetric.rows.map((r) => ({
      metric_key: r.metric_key,
      loans: Number(r.loans),
      distinct_headers: Number(r.distinct_headers),
    })),
    topUnmapped: unmapped.rows.map((r) => ({ header: r.header, filings: Number(r.filings) })),
  };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

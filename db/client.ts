/**
 * Conexión a Postgres.
 *
 * Usa `pg`, que es JavaScript puro. Elegido a propósito sobre alternativas más
 * rápidas con bindings nativos: en este proyecto ya perdimos tiempo con
 * binarios compilados para la plataforma equivocada, y para un corpus de
 * decenas de miles de filas la diferencia de rendimiento no justifica el
 * riesgo.
 */

// Puebla process.env desde .env antes de leer DATABASE_URL.
import "../harvest/env.js";

import pg from "pg";

/**
 * Postgres devuelve NUMERIC como string para no perder precisión. Para
 * `confidence`, que es un decimal chico y acotado, queremos el número.
 */
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

let pool: pg.Pool | null = null;

export interface DbConfig {
  connectionString?: string;
  /** Máximo de conexiones simultáneas. Default 10. */
  max?: number;
}

export const DEFAULT_CONNECTION =
  "postgres://financials:financials@localhost:5433/financials";

export function connectionString(): string {
  return process.env.DATABASE_URL?.trim() || DEFAULT_CONNECTION;
}

export function getPool(config: DbConfig = {}): pg.Pool {
  if (pool) return pool;

  pool = new pg.Pool({
    connectionString: config.connectionString ?? connectionString(),
    max: config.max ?? 10,
    // Sin esto, un Postgres caído deja el proceso colgado sin explicación.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  pool.on("error", (err) => {
    console.error("[db] error en una conexión inactiva:", err.message);
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}

/**
 * Corre una función dentro de una transacción, con rollback ante error.
 *
 * Importa para el corpus: un filing se escribe entero o no se escribe. Una
 * cosecha a medias —préstamos sin sus observations— sería peor que ninguna,
 * porque parecería completa.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

// ---------------------------------------------------------------------------

export interface PingResult {
  ok: boolean;
  message: string;
  version?: string;
  schemaReady?: boolean;
}

/** Chequeo de conectividad con un mensaje que dice qué hacer si falla. */
export async function ping(): Promise<PingResult> {
  const url = connectionString();
  const safe = url.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");

  try {
    const { rows } = await query<{ version: string }>("SELECT version()");
    const version = rows[0]?.version?.split(",")[0] ?? "desconocida";

    const { rows: schema } = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'corpus' AND table_name = 'filings'
       ) AS exists`,
    );

    return {
      ok: true,
      version,
      schemaReady: schema[0]?.exists ?? false,
      message: `Conectado a ${safe}`,
    };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const detail = err instanceof Error ? err.message : String(err);

    if (code === "ECONNREFUSED") {
      return {
        ok: false,
        message:
          `No hay Postgres escuchando en ${safe}.\n\n` +
          `  Levantalo con Docker:\n` +
          `    docker compose up -d\n\n` +
          `  O apuntá a otra instancia:\n` +
          `    export DATABASE_URL=postgres://usuario:clave@host:5432/base`,
      };
    }

    if (code === "28P01" || code === "28000") {
      return { ok: false, message: `Credenciales rechazadas para ${safe}.\n  ${detail}` };
    }

    if (code === "3D000") {
      return {
        ok: false,
        message:
          `La base no existe en ${safe}.\n` +
          `  Con docker compose se crea sola; si usás otra instancia, creala a mano.`,
      };
    }

    return { ok: false, message: `${detail}${code ? ` (${code})` : ""}` };
  }
}

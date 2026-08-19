/**
 * Postgres connection.
 *
 * Uses `pg`, which is pure JavaScript. Chosen deliberately over faster
 * alternatives with native bindings: this project has already lost time to
 * binaries compiled for the wrong platform, and for a corpus of tens of
 * thousands of rows the performance difference does not justify the risk.
 */

// Populates process.env from .env before reading DATABASE_URL.
import "../harvest/env.js";

import pg from "pg";

/**
 * Postgres returns NUMERIC as a string so as not to lose precision. For
 * `confidence`, which is a small bounded decimal, we want the number.
 */
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

let pool: pg.Pool | null = null;

export interface DbConfig {
  connectionString?: string;
  /** Maximum simultaneous connections. Defaults to 10. */
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
    // Without this, a downed Postgres leaves the process hanging with no
    // explanation.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  pool.on("error", (err) => {
    console.error("[db] error on an idle connection:", err.message);
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}

/**
 * Runs a function inside a transaction, rolling back on error.
 *
 * It matters for the corpus: a filing is written whole or not at all. A
 * half-finished harvest —loans without their observations— would be worse than
 * none, because it would look complete.
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

/** Connectivity check with a message that says what to do when it fails. */
export async function ping(): Promise<PingResult> {
  const url = connectionString();
  const safe = url.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");

  try {
    const { rows } = await query<{ version: string }>("SELECT version()");
    const version = rows[0]?.version?.split(",")[0] ?? "unknown";

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
      message: `Connected to ${safe}`,
    };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const detail = err instanceof Error ? err.message : String(err);

    if (code === "ECONNREFUSED") {
      return {
        ok: false,
        message:
          `No Postgres listening on ${safe}.\n\n` +
          `  Start it with Docker:\n` +
          `    docker compose up -d\n\n` +
          `  Or point at another instance:\n` +
          `    export DATABASE_URL=postgres://user:password@host:5432/database`,
      };
    }

    if (code === "28P01" || code === "28000") {
      return { ok: false, message: `Credentials rejected for ${safe}.\n  ${detail}` };
    }

    if (code === "3D000") {
      return {
        ok: false,
        message:
          `The database does not exist at ${safe}.\n` +
          `  With docker compose it is created automatically; on another instance, create it by hand.`,
      };
    }

    return { ok: false, message: `${detail}${code ? ` (${code})` : ""}` };
  }
}

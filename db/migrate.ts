/**
 * Runner de migraciones.
 *
 *   npm run db:migrate          aplica las pendientes
 *   npm run db:migrate -- --status   solo muestra el estado
 *   npm run db:migrate -- --reset    borra el schema corpus y reaplica todo
 *
 * Deliberadamente simple: archivos .sql numerados en db/migrations/, una tabla
 * que registra cuáles se aplicaron, y cada una corre dentro de una transacción.
 * No hay rollback: para revertir se escribe una migración nueva.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { closePool, connectionString, ping, query, withTransaction } from "./client.js";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url).pathname;

const flags = process.argv.slice(2);
const statusOnly = flags.includes("--status");
const reset = flags.includes("--reset");

try {
  await main();
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  await closePool();
  process.exit(1);
}
await closePool();

// ---------------------------------------------------------------------------

async function main() {
  const health = await ping();
  if (!health.ok) {
    console.error(`\n✗ ${health.message}\n`);
    process.exit(1);
  }

  console.log(`\n${health.message}`);
  console.log(`  ${health.version}\n`);

  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  if (reset) {
    console.log("  \x1b[33mReset: borrando el schema corpus\x1b[0m");
    await query("DROP SCHEMA IF EXISTS corpus CASCADE");
    await query("DELETE FROM schema_migrations");
  }

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows } = await query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  if (statusOnly) {
    console.log("Migraciones:");
    for (const file of files) {
      const mark = applied.has(file) ? "\x1b[32m✓\x1b[0m" : "\x1b[90m·\x1b[0m";
      console.log(`  ${mark} ${file}`);
    }
    const pending = files.filter((f) => !applied.has(f)).length;
    console.log(`\n  ${files.length - pending} aplicadas, ${pending} pendientes\n`);
    return;
  }

  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(`  Sin migraciones pendientes (${files.length} aplicadas)\n`);
    return;
  }

  for (const file of pending) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const started = Date.now();

    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });

    console.log(`  \x1b[32m✓\x1b[0m ${file} \x1b[90m(${Date.now() - started} ms)\x1b[0m`);
  }

  console.log(`\n  ${pending.length} migración(es) aplicada(s)\n`);
  console.log(`  Base: ${connectionString().replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@")}\n`);
}

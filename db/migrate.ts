/**
 * Migration runner.
 *
 *   npm run db:migrate               applies the pending ones
 *   npm run db:migrate -- --status   only shows the state
 *   npm run db:migrate -- --reset    drops the corpus schema and reapplies all
 *
 * Deliberately simple: numbered .sql files in db/migrations/, one table
 * recording which ones were applied, and each runs inside a transaction. There
 * is no rollback: to revert, you write a new migration.
 *
 * Migrations are tracked BY FILENAME, with no checksum. That is what makes it
 * safe to edit the comments of an already-applied migration —as the translation
 * to English did across twelve files— without them re-running or looking like
 * tampering. It also means an edit to the SQL itself of an applied migration
 * does nothing, which is why 003 and 004 exist as separate files.
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
    console.log("  \x1b[33mReset: dropping the corpus schema\x1b[0m");
    await query("DROP SCHEMA IF EXISTS corpus CASCADE");
    await query("DELETE FROM schema_migrations");
  }

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows } = await query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  if (statusOnly) {
    console.log("Migrations:");
    for (const file of files) {
      const mark = applied.has(file) ? "\x1b[32m✓\x1b[0m" : "\x1b[90m·\x1b[0m";
      console.log(`  ${mark} ${file}`);
    }
    const pending = files.filter((f) => !applied.has(f)).length;
    console.log(`\n  ${files.length - pending} applied, ${pending} pending\n`);
    return;
  }

  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(`  No pending migrations (${files.length} applied)\n`);
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

  console.log(`\n  ${pending.length} migration(s) applied\n`);
  console.log(`  Database: ${connectionString().replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@")}\n`);
}

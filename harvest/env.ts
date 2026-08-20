/**
 * Loads `.env` into `process.env`.
 *
 * Imported for its side effect, not called:
 *
 *   import "../env.js";
 *
 * ESM imports are evaluated before the body of the module importing them, so it
 * is enough to import this at the top of any file that reads configuration.
 *
 * WHY NOT --env-file
 *
 * Node 20.6+ supports it natively and it would be less code. Two reasons not to
 * use it here:
 *
 * 1. On Node 20 and 21, `--env-file` with a non-existent file **aborts the
 *    process**. `--env-file-if-exists` only arrived in 22.9. That turns an
 *    optional configuration into a hard requirement: someone who clones the
 *    repo and runs the tests —which need no variables at all— finds that
 *    nothing starts.
 *
 * 2. It would have to be passed through `tsx` in every npm script, and flag
 *    forwarding to node depends on the tsx version. One more layer where
 *    something can fail silently.
 *
 * Twenty-five lines of our own have neither problem.
 *
 * PRECEDENCIA
 *
 * The shell wins over the file. If you already exported SEC_USER_AGENT in the
 * terminal, `.env` does not overwrite it. It is dotenv's convention and the
 * right one: what you just typed should beat what was saved earlier.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Project root: this file lives in harvest/. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface LoadedEnv {
  /** Path of the file, if one was found. */
  path: string | null;
  /** Keys that were loaded (those already in the environment are excluded). */
  applied: string[];
  /** Keys present in the file but ignored because the shell already had them. */
  skipped: string[];
}

/**
 * Parses the contents of a .env.
 *
 * Deliberately limited: `KEY=value`, one per line, with optional quotes. No
 * variable interpolation and no multi-line values. A more ambitious parser
 * invites someone to write something that behaves differently depending on who
 * reads it.
 */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // `export FOO=bar` too, because that is what you have in your terminal
    // history and will paste as-is.
    const withoutExport = line.replace(/^export\s+/, "");

    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();

    // Surrounding quotes are stripped. Inside there can be spaces, which is
    // exactly the SEC_USER_AGENT case ("Firstname Lastname mail@domain").
    const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2]!;
    } else {
      // Without quotes, a `#` starts a comment at the end of the line.
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}

export function loadEnvFile(path = resolve(ROOT, ".env")): LoadedEnv {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    // No file, no problem: the variables can come from the shell.
    return { path: null, applied: [], skipped: [] };
  }

  const parsed = parseEnv(content);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== undefined && process.env[key] !== "") {
      skipped.push(key);
      continue;
    }
    process.env[key] = value;
    applied.push(key);
  }

  return { path, applied, skipped };
}

export const loaded = loadEnvFile();

/**
 * Tests for the .env loader.
 *
 *   npx tsx harvest/env.test.ts
 *
 * This is configuration code: when it fails it does not throw — it leaves a
 * variable undefined and the error surfaces ten minutes later, far from the
 * cause. That already happened to us today with SEC_USER_AGENT. That is why the
 * parser is tested line by line.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, loadEnvFile } from "./env.js";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else {
    failed++;
    console.error(`✗ ${label}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function ok(label: string, condition: boolean, detail = ""): void {
  if (condition) passed++;
  else {
    failed++;
    console.error(`✗ ${label}${detail ? `\n    ${detail}` : ""}`);
  }
}

console.log("\n.env loader\n");

// --- basic parsing -----------------------------------------------------------

check("simple key and value", parseEnv("FOO=bar"), { FOO: "bar" });
check("ignores empty lines", parseEnv("\n\nFOO=bar\n\n"), { FOO: "bar" });
check("ignora comentarios", parseEnv("# nota\nFOO=bar"), { FOO: "bar" });
check("tolera espacios alrededor", parseEnv("  FOO = bar  "), { FOO: "bar" });
check("varias claves", parseEnv("A=1\nB=2"), { A: "1", B: "2" });
check("acepta CRLF", parseEnv("A=1\r\nB=2"), { A: "1", B: "2" });

// --- the case that motivated all of this -------------------------------------

/**
 * SEC_USER_AGENT has spaces in its value —"Firstname Lastname mail@domain"— and
 * an `@`. A parser that splits on spaces or treats the value as a simple token
 * breaks it, and the symptom would be a 403 from the SEC ten minutes later.
 */
check(
  "value with spaces, in double quotes",
  parseEnv('SEC_USER_AGENT="Pablo Migliasso pablo@ejemplo.com"'),
  { SEC_USER_AGENT: "Pablo Migliasso pablo@ejemplo.com" },
);
check(
  "the same with single quotes",
  parseEnv("SEC_USER_AGENT='Pablo Migliasso pablo@ejemplo.com'"),
  { SEC_USER_AGENT: "Pablo Migliasso pablo@ejemplo.com" },
);
check(
  "without quotes it also keeps the spaces",
  parseEnv("SEC_USER_AGENT=Pablo Migliasso pablo@ejemplo.com"),
  { SEC_USER_AGENT: "Pablo Migliasso pablo@ejemplo.com" },
);

/**
 * You copy from your terminal history, and there the line has `export` on it.
 * Making that work as-is avoids a typo that gives no clue at all.
 */
check(
  "accepts the line pasted from the shell, with export",
  parseEnv('export SEC_USER_AGENT="Pablo Migliasso pablo@ejemplo.com"'),
  { SEC_USER_AGENT: "Pablo Migliasso pablo@ejemplo.com" },
);

// --- end-of-line comments ----------------------------------------------------

check(
  "comment at the end of an unquoted value",
  parseEnv("FOO=bar # a note"),
  { FOO: "bar" },
);
check(
  "a # inside quotes is NOT a comment",
  parseEnv('FOO="bar # this is part of the value"'),
  { FOO: "bar # this is part of the value" },
);
check(
  "a # glued to the value does not cut it either",
  parseEnv("PASS=abc#123"),
  { PASS: "abc#123" },
);

// --- invalid lines -----------------------------------------------------------

check("no equals sign is ignored", parseEnv("this is nothing"), {});
check("empty key is ignored", parseEnv("=value"), {});
check("key with a hyphen is ignored", parseEnv("MY-KEY=x"), {});
check("empty value is an empty string", parseEnv("FOO="), { FOO: "" });
check(
  "one broken line does not drag down the good ones",
  parseEnv("broken\nFOO=bar\n=also broken\nBAZ=qux"),
  { FOO: "bar", BAZ: "qux" },
);

// --- real file and precedence -----------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "envtest-"));
const file = join(dir, ".env");
writeFileSync(file, 'ENVTEST_NEW=from-file\nENVTEST_EXISTING=from-file\n');

process.env.ENVTEST_EXISTING = "from-shell";
const result = loadEnvFile(file);

check("loads the one that was missing", process.env.ENVTEST_NEW, "from-file");
check("the shell beats the file", process.env.ENVTEST_EXISTING, "from-shell");
check("reports which one it applied", result.applied, ["ENVTEST_NEW"]);
check("and which one it skipped", result.skipped, ["ENVTEST_EXISTING"]);

/**
 * No file, nothing happens. It is the requirement that ruled out Node's
 * `--env-file`: on 20 and 21 it aborts the process if the file does not exist,
 * and that would break the tests of someone who has just cloned the repo and
 * needs no variables at all.
 */
const missing = loadEnvFile(join(dir, "does-not-exist"));
check("a non-existent file breaks nothing", missing.path, null);
check("and applies nothing", missing.applied, []);
ok("no lanza", true);

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} ok, ${failed} failed\n`);
if (failed > 0) process.exit(1);

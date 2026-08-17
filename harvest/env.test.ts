/**
 * Tests del cargador de .env.
 *
 *   npx tsx harvest/env.test.ts
 *
 * Esto es código de configuración: cuando falla, no lanza — deja una variable
 * sin definir y el error aparece diez minutos después, lejos de la causa. Ya nos
 * pasó hoy con SEC_USER_AGENT. Por eso se testea el parser línea por línea.
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
    console.error(`✗ ${label}\n    esperado: ${e}\n    obtenido: ${a}`);
  }
}

function ok(label: string, condition: boolean, detail = ""): void {
  if (condition) passed++;
  else {
    failed++;
    console.error(`✗ ${label}${detail ? `\n    ${detail}` : ""}`);
  }
}

console.log("\nCargador de .env\n");

// --- parseo básico -----------------------------------------------------------

check("clave y valor simples", parseEnv("FOO=bar"), { FOO: "bar" });
check("ignora líneas vacías", parseEnv("\n\nFOO=bar\n\n"), { FOO: "bar" });
check("ignora comentarios", parseEnv("# nota\nFOO=bar"), { FOO: "bar" });
check("tolera espacios alrededor", parseEnv("  FOO = bar  "), { FOO: "bar" });
check("varias claves", parseEnv("A=1\nB=2"), { A: "1", B: "2" });
check("acepta CRLF", parseEnv("A=1\r\nB=2"), { A: "1", B: "2" });

// --- el caso que motivó todo -------------------------------------------------

/**
 * SEC_USER_AGENT tiene espacios en el valor —"Nombre Apellido mail@dominio"— y
 * un `@`. Un parser que corte por espacios o que trate el valor como token
 * simple lo rompe, y el síntoma sería un 403 de la SEC diez minutos después.
 */
check(
  "valor con espacios, entre comillas dobles",
  parseEnv('SEC_USER_AGENT="Pablo Migliasso pablo@ejemplo.com"'),
  { SEC_USER_AGENT: "Pablo Migliasso pablo@ejemplo.com" },
);
check(
  "lo mismo con comillas simples",
  parseEnv("SEC_USER_AGENT='Pablo Migliasso pablo@ejemplo.com'"),
  { SEC_USER_AGENT: "Pablo Migliasso pablo@ejemplo.com" },
);
check(
  "sin comillas también conserva los espacios",
  parseEnv("SEC_USER_AGENT=Pablo Migliasso pablo@ejemplo.com"),
  { SEC_USER_AGENT: "Pablo Migliasso pablo@ejemplo.com" },
);

/**
 * Uno copia del historial de la terminal, y ahí la línea tiene `export`.
 * Que funcione tal cual evita un error de tipeo que no da ninguna pista.
 */
check(
  "acepta la línea pegada del shell, con export",
  parseEnv('export SEC_USER_AGENT="Pablo Migliasso pablo@ejemplo.com"'),
  { SEC_USER_AGENT: "Pablo Migliasso pablo@ejemplo.com" },
);

// --- comentarios al final de línea -------------------------------------------

check(
  "comentario al final de un valor sin comillas",
  parseEnv("FOO=bar # una nota"),
  { FOO: "bar" },
);
check(
  "un # dentro de comillas NO es comentario",
  parseEnv('FOO="bar # esto es parte del valor"'),
  { FOO: "bar # esto es parte del valor" },
);
check(
  "un # pegado al valor tampoco corta",
  parseEnv("PASS=abc#123"),
  { PASS: "abc#123" },
);

// --- líneas inválidas --------------------------------------------------------

check("sin signo igual se ignora", parseEnv("esto no es nada"), {});
check("clave vacía se ignora", parseEnv("=valor"), {});
check("clave con guion se ignora", parseEnv("MI-CLAVE=x"), {});
check("valor vacío es cadena vacía", parseEnv("FOO="), { FOO: "" });
check(
  "una línea rota no arrastra a las buenas",
  parseEnv("rota\nFOO=bar\n=tambien rota\nBAZ=qux"),
  { FOO: "bar", BAZ: "qux" },
);

// --- archivo real y precedencia ---------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "envtest-"));
const file = join(dir, ".env");
writeFileSync(file, 'ENVTEST_NUEVA=desde-archivo\nENVTEST_EXISTENTE=desde-archivo\n');

process.env.ENVTEST_EXISTENTE = "desde-shell";
const result = loadEnvFile(file);

check("carga la que faltaba", process.env.ENVTEST_NUEVA, "desde-archivo");
check("el shell le gana al archivo", process.env.ENVTEST_EXISTENTE, "desde-shell");
check("reporta cuál aplicó", result.applied, ["ENVTEST_NUEVA"]);
check("y cuál salteó", result.skipped, ["ENVTEST_EXISTENTE"]);

/**
 * Sin archivo no pasa nada. Es el requisito que descartó `--env-file` de Node:
 * en la 20 y la 21 aborta el proceso si el archivo no existe, y eso rompería
 * los tests de alguien que recién clona el repo y no necesita ninguna variable.
 */
const missing = loadEnvFile(join(dir, "no-existe"));
check("un archivo inexistente no rompe nada", missing.path, null);
check("y no aplica nada", missing.applied, []);
ok("no lanza", true);

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} ok, ${failed} fallidos\n`);
if (failed > 0) process.exit(1);

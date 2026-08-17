/**
 * Carga `.env` en `process.env`.
 *
 * Se importa por efecto lateral, no se llama:
 *
 *   import "../env.js";
 *
 * Los imports de ESM se evalúan antes que el cuerpo del módulo que los importa,
 * así que basta con importarlo arriba de cualquier archivo que lea configuración.
 *
 * POR QUÉ NO --env-file
 *
 * Node 20.6+ lo soporta de forma nativa y sería menos código. Dos razones para
 * no usarlo acá:
 *
 * 1. En Node 20 y 21, `--env-file` con un archivo inexistente **aborta el
 *    proceso**. `--env-file-if-exists` recién llegó en 22.9. Eso convierte una
 *    configuración opcional en un requisito duro: alguien que clona el repo y
 *    corre los tests —que no necesitan ninguna variable— se encuentra con que
 *    nada arranca.
 *
 * 2. Habría que pasarlo por `tsx` en cada script de npm, y el reenvío de flags a
 *    node depende de la versión de tsx. Una capa más donde algo puede fallar en
 *    silencio.
 *
 * Veinticinco líneas propias no tienen ninguno de los dos problemas.
 *
 * PRECEDENCIA
 *
 * El shell gana sobre el archivo. Si ya exportaste SEC_USER_AGENT en la
 * terminal, `.env` no lo pisa. Es la convención de dotenv y la correcta: lo que
 * escribiste recién debería ganarle a lo que quedó guardado.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Raíz del proyecto: este archivo vive en harvest/. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface LoadedEnv {
  /** Ruta del archivo, si se encontró. */
  path: string | null;
  /** Claves que se cargaron (las que ya existían en el entorno no entran). */
  applied: string[];
  /** Claves presentes en el archivo pero ignoradas porque el shell ya las tenía. */
  skipped: string[];
}

/**
 * Parsea el contenido de un .env.
 *
 * Deliberadamente limitado: `CLAVE=valor`, una por línea, con comillas
 * opcionales. Sin interpolación de variables ni valores multilínea. Un parser
 * más ambicioso invita a que alguien escriba algo que funcione distinto según
 * quién lo lea.
 */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // `export FOO=bar` también, porque es lo que uno tiene en el historial de
    // la terminal y va a pegar tal cual.
    const withoutExport = line.replace(/^export\s+/, "");

    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();

    // Comillas envolventes: se sacan. Adentro puede haber espacios, que es
    // justamente el caso de SEC_USER_AGENT ("Nombre Apellido mail@dominio").
    const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2]!;
    } else {
      // Sin comillas, un `#` inicia comentario al final de la línea.
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
    // Sin archivo no pasa nada: las variables pueden venir del shell.
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

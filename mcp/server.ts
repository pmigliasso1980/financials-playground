/**
 * El corpus como herramienta de un asistente.
 *
 *   npm run mcp     (no se corre a mano: lo lanza el cliente MCP)
 *
 * POR QUÉ ESTO Y NO OTRA PANTALLA
 *
 * Trepp, CompStak, Lev y StackSource viven cada uno en su propia web. Ninguno vive
 * adentro del asistente que el broker ya tiene abierto. Un MCP es la distribución
 * más barata que existe: el usuario no aprende una interfaz nueva, pregunta como
 * venía preguntando y el corpus contesta.
 *
 * SIN DEPENDENCIAS, POR LA MISMA RAZÓN QUE EL SERVIDOR HTTP
 *
 * MCP sobre stdio es JSON-RPC 2.0 delimitado por líneas. Tres métodos —initialize,
 * tools/list, tools/call— son unas cien líneas. Meter un SDK para eso agrega una
 * cadena de dependencias a un proceso que va a correr en la máquina de un tercero.
 *
 * EL PROBLEMA QUE ESTE ARCHIVO TIENE Y LA API NO
 *
 * La API le habla a un programa: devuelve JSON y el cliente decide qué mostrar. Acá
 * del otro lado hay un modelo de lenguaje que va a PARAFRASEAR lo que reciba, y al
 * parafrasear se caen los matices — primero la base de cada número, después el
 * límite del canal.
 *
 * Por eso la herramienta no devuelve JSON pelado. Devuelve texto donde cada
 * salvedad está pegada al número que califica, de forma que no se pueda repetir el
 * número sin repetir la salvedad. "LTV mediana 61% (sobre 24 préstamos)" sobrevive
 * a una paráfrasis; un campo `base: 24` en otra parte del objeto, no.
 *
 * Y la negativa se devuelve como texto afirmativo —"no alcanza para dar un rango,
 * hacen falta cinco"— y no como error, porque un error invita al modelo a
 * reintentar o a inventar el dato faltante.
 */

import { createInterface } from "node:readline";
import { closePool, ping } from "../db/client.js";
import {
  buscarComparables, MIN_COMPARABLES, TIPOS,
  type Respuesta, type Tipo,
} from "../api/comps.js";

const health = await ping();
if (!health.ok) {
  console.error(`financials-mcp: sin base de datos — ${health.message.split("\n")[0]}`);
  process.exit(1);
}

/** La versión que hablamos. Si el cliente pide otra, se responde con la suya si la conocemos. */
const PROTOCOLO = "2024-11-05";
const CONOCIDAS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

const HERRAMIENTA = {
  name: "buscar_comparables",
  description:
    "Busca préstamos comerciales comparables en un corpus de operaciones conduit CMBS " +
    "construido con documentos públicos de SEC EDGAR, y devuelve qué términos " +
    "consiguieron (LTV, DSCR, debt yield, tasa). Sirve para responder '¿qué puedo " +
    "esperar para este préstamo?' antes de salir a buscar prestamistas. " +
    "IMPORTANTE: el corpus cubre SOLO el canal conduit CMBS — no incluye bancos, " +
    "agencias, deuda puente ni compañías de seguros de vida.",
  inputSchema: {
    type: "object",
    properties: {
      estado: { type: "string", description: 'Código de dos letras, por ejemplo "GA"' },
      tipo: { type: "string", enum: [...TIPOS], description: "Tipo de propiedad" },
      monto: { type: "number", description: "Monto del préstamo en dólares, por ejemplo 28000000" },
      ltv_objetivo: {
        type: "number",
        description: "Opcional. El LTV que pide el cliente, como fracción (0.70) o porcentaje (70)",
      },
      meses: { type: "number", description: "Opcional. Ventana hacia atrás. Por defecto 18." },
    },
    required: ["estado", "tipo", "monto"],
  },
} as const;

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const fmt: Record<string, (v: number) => string> = {
  ltv: pct, debt_yield: pct, interest_rate: pct, dscr: (v) => `${v.toFixed(2)}x`,
};

/**
 * El resultado como texto, con cada salvedad pegada a su número.
 *
 * Ver el comentario de arriba: el consumidor de esto es un modelo que parafrasea.
 */
function comoTexto(r: Respuesta): string {
  const c = r.criterios;
  const cabecera = `${c.tipo} · ${c.estado} · ${
    Math.round(c.monto).toLocaleString("en-US")
  } USD · últimos ${c.meses ?? 18} meses`;

  if (!r.suficiente) {
    return (
      `${cabecera}\n\n` +
      `NO HAY DATOS SUFICIENTES para dar un rango: se encontraron ${r.encontrados} ` +
      `préstamos comparables y hacen falta al menos ${r.minimo}. Con menos, una mediana ` +
      `afirmaría más de lo que estos datos saben.\n\n` +
      `Esto NO es un error ni un fallo de la consulta: es el estado del conocimiento. ` +
      `No estimes el rango por otros medios; ofrecé ampliar el criterio.\n\n` +
      `Si se afloja un criterio:\n` +
      r.siAmplias.map((s) => `  · ${s.criterio} → ${s.encontrados} comparables`).join("\n") +
      `\n\n${r.corpus.canal}`
    );
  }

  const dist = r.distribuciones
    .map((m) => {
      const f = fmt[m.metrica] ?? ((v: number) => v.toFixed(2));
      return `  ${m.etiqueta}: mediana ${f(m.p50)} (rango habitual ${f(m.p25)} a ${f(m.p75)}) ` +
        `— calculado sobre ${m.base} de los ${r.encontrados} comparables`;
    })
    .join("\n");

  const obj = r.objetivo
    ? `\n\nSOBRE EL LTV DE ${pct(r.objetivo.ltv)} QUE SE PRETENDE: de los ${r.objetivo.de} ` +
      `comparables que publican LTV, ${r.objetivo.alcanzaron} llegaron a ese nivel o más. ` +
      (r.objetivo.alcanzaron / Math.max(1, r.objetivo.de) < 0.25
        ? `Es una porción chica del canal — conviene revisar la expectativa antes de salir a buscar.`
        : `Está dentro de lo que este canal viene dando.`)
    : "";

  const ejemplos = r.muestra
    .slice(0, 5)
    .map(
      (m) =>
        `  · ${m.propiedad ?? "(sin nombre)"}${m.ciudad ? `, ${m.ciudad}` : ""} — ` +
        `${Math.round(m.monto).toLocaleString("en-US")} USD, ${m.fecha}, ${m.emision}\n` +
        `    documento: ${m.documento}`,
    )
    .join("\n");

  return (
    `${cabecera}\n\n${r.encontrados} préstamos comparables.\n\n${dist}${obj}\n\n` +
    `Cada métrica se calculó solo sobre los comparables que la publican, por eso las ` +
    `bases difieren. Al citar un número, citá también sobre cuántos préstamos está.\n\n` +
    `Ejemplos verificables:\n${ejemplos}\n\n` +
    `${r.corpus.canal}\n${r.corpus.estampa}`
  );
}

// ---------------------------------------------------------------------------
// JSON-RPC sobre stdio
// ---------------------------------------------------------------------------

type Id = string | number | null;
const enviar = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const responder = (id: Id, result: unknown) => enviar({ jsonrpc: "2.0", id, result });
const fallar = (id: Id, code: number, message: string) =>
  enviar({ jsonrpc: "2.0", id, error: { code, message } });

async function manejar(msg: { id?: Id; method?: string; params?: Record<string, unknown> }) {
  const id = msg.id ?? null;

  switch (msg.method) {
    case "initialize": {
      const pedida = (msg.params?.protocolVersion as string) ?? PROTOCOLO;
      return responder(id, {
        protocolVersion: CONOCIDAS.has(pedida) ? pedida : PROTOCOLO,
        capabilities: { tools: {} },
        serverInfo: { name: "financials-comparables", version: "0.1.0" },
      });
    }

    /** Notificaciones: no llevan id y no se responden. */
    case "notifications/initialized":
    case "notifications/cancelled":
      return;

    case "ping":
      return responder(id, {});

    case "tools/list":
      return responder(id, { tools: [HERRAMIENTA] });

    case "tools/call": {
      const nombre = msg.params?.name as string;
      if (nombre !== HERRAMIENTA.name) {
        return fallar(id, -32602, `Herramienta desconocida: ${nombre}`);
      }
      const a = (msg.params?.arguments ?? {}) as Record<string, unknown>;

      /**
       * La validación devuelve isError con un texto que explica qué mandar, en vez
       * de un error de JSON-RPC. Un error de protocolo el modelo no lo puede
       * corregir; un texto que dice "estado tiene que ser dos letras" sí.
       */
      const estado = String(a.estado ?? "").trim().toUpperCase();
      const tipo = String(a.tipo ?? "").trim();
      const monto = Number(a.monto);
      const problemas: string[] = [];
      if (!/^[A-Z]{2}$/.test(estado)) problemas.push('estado: código de dos letras, como "GA"');
      if (!TIPOS.includes(tipo as Tipo)) problemas.push(`tipo: uno de ${TIPOS.join(", ")}`);
      if (!Number.isFinite(monto) || monto <= 0) problemas.push("monto: número positivo en dólares");
      if (problemas.length > 0) {
        return responder(id, {
          content: [{ type: "text", text: `Parámetros a corregir:\n${problemas.map((p) => `  · ${p}`).join("\n")}` }],
          isError: true,
        });
      }

      const ltvRaw = a.ltv_objetivo != null ? Number(a.ltv_objetivo) : undefined;
      const r = await buscarComparables({
        estado,
        tipo: tipo as Tipo,
        monto,
        meses: a.meses != null ? Number(a.meses) : undefined,
        /** 70 y 0,70 son la misma intención; adivinar mal cambia la respuesta. */
        ltvObjetivo: ltvRaw == null ? undefined : ltvRaw > 2 ? ltvRaw / 100 : ltvRaw,
      });

      return responder(id, {
        content: [{ type: "text", text: comoTexto(r) }],
        /** Estructurado además del texto, para clientes que lo sepan usar. */
        structuredContent: r as unknown as Record<string, unknown>,
      });
    }

    default:
      if (id !== null) fallar(id, -32601, `Método no implementado: ${msg.method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (linea) => {
  if (!linea.trim()) return;
  let msg: { id?: Id; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(linea);
  } catch {
    return fallar(null, -32700, "JSON inválido");
  }
  try {
    await manejar(msg);
  } catch (err) {
    fallar(msg.id ?? null, -32603, err instanceof Error ? err.message : String(err));
  }
});

rl.on("close", () => closePool().then(() => process.exit(0)));

/** El log va a stderr: stdout es el canal del protocolo y un console.log lo rompe. */
console.error(
  `financials-mcp listo · herramienta "${HERRAMIENTA.name}" · mínimo ${MIN_COMPARABLES} comparables`,
);

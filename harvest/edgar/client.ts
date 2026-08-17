/**
 * Cliente HTTP para SEC EDGAR.
 *
 * SEC tiene reglas de acceso programático que no son opcionales: si no las
 * respetás te bloquean la IP. Las dos que importan:
 *
 *   1. User-Agent con nombre y email de contacto reales. Un UA genérico
 *      (curl, node-fetch, axios) devuelve 403.
 *   2. Máximo 10 requests por segundo.
 *
 * Fuente: https://www.sec.gov/os/webmaster-faq#developers
 *
 * Este cliente exige el UA por variable de entorno y limita a 8 req/s con
 * margen. No hay forma de saltearlo — es a propósito.
 */

// Puebla process.env desde .env antes de que nadie lea la configuración.
// Import por efecto lateral: los imports de ESM se evalúan antes que el cuerpo.
import "../env.js";

const SEC_MAX_RPS = 8; // el límite real es 10; dejamos aire
const MIN_INTERVAL_MS = 1000 / SEC_MAX_RPS;

let lastRequestAt = 0;

export class EdgarError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "EdgarError";
  }
}

/**
 * SEC exige identificarse. Poné algo como:
 *   export SEC_USER_AGENT="Pablo Migliasso pablo@ejemplo.com"
 */
export function getUserAgent(): string {
  const ua = process.env.SEC_USER_AGENT?.trim();

  if (!ua) {
    throw new Error(
      "Falta SEC_USER_AGENT.\n\n" +
        "No es una credencial: EDGAR es público y gratis, no hay cuenta ni API key.\n" +
        "La SEC exige que todo cliente automatizado se identifique con nombre y email\n" +
        "en el header User-Agent, para poder avisarte si tu script se descontrola en\n" +
        "vez de bloquear el rango de IPs entero. Sin eso devuelven 403.\n\n" +
        "Ponelo en .env, que persiste entre terminales:\n\n" +
        '  SEC_USER_AGENT="Tu Nombre tu@email.com"\n\n' +
        "o exportalo solo para esta sesión:\n\n" +
        '  export SEC_USER_AGENT="Tu Nombre tu@email.com"\n\n' +
        "Ver https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data",
    );
  }

  // Chequeo laxo: que tenga pinta de "algo <espacio> algo@algo".
  if (!/\S+@\S+\.\S+/.test(ua)) {
    throw new Error(
      `SEC_USER_AGENT="${ua}" no incluye un email.\n` +
        'SEC quiere un contacto real, ej: "Pablo Migliasso pablo@ejemplo.com"',
    );
  }

  return ua;
}

/** Espacia las requests para no pasar el límite de SEC. */
async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

export interface FetchOptions {
  /** Reintentos ante 429 y 5xx. Default 3. */
  maxRetries?: number;
  timeoutMs?: number;
  accept?: string;
}

async function request(url: string, opts: FetchOptions = {}): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const userAgent = getUserAgent();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await throttle();

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": userAgent,
          "Accept-Encoding": "gzip, deflate",
          ...(opts.accept ? { Accept: opts.accept } : {}),
        },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
      });
    } catch (err) {
      if (attempt === maxRetries) {
        throw new EdgarError(0, url, `error de red: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }

    if (res.ok) return res;

    // 403 casi siempre es el User-Agent, no un permiso.
    if (res.status === 403) {
      throw new EdgarError(
        403,
        url,
        "SEC devolvió 403. Casi siempre es el User-Agent: tiene que incluir " +
          `nombre y email reales. El tuyo es "${userAgent}".`,
      );
    }

    if (res.status === 404) {
      throw new EdgarError(404, url, "no existe");
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === maxRetries) {
      throw new EdgarError(res.status, url, `HTTP ${res.status} ${res.statusText}`);
    }

    // SEC manda Retry-After en algunos 429.
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, waitMs));
  }

  throw new EdgarError(0, url, "se agotaron los reintentos");
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await request(url, { ...opts, accept: "application/json" });
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await request(url, opts);
  return await res.text();
}

export async function fetchBuffer(url: string, opts: FetchOptions = {}): Promise<Buffer> {
  const res = await request(url, opts);
  return Buffer.from(await res.arrayBuffer());
}

/** Chequeo rápido de conectividad y User-Agent antes de una corrida larga. */
export async function preflight(): Promise<{ ok: boolean; message: string }> {
  try {
    getUserAgent();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  try {
    // Endpoint chico y estable.
    await fetchJson("https://www.sec.gov/files/company_tickers.json", { maxRetries: 1, timeoutMs: 15_000 });
    return { ok: true, message: `EDGAR alcanzable, User-Agent aceptado (${getUserAgent()})` };
  } catch (err) {
    if (err instanceof EdgarError) {
      return { ok: false, message: `${err.message}\n  URL: ${err.url}` };
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

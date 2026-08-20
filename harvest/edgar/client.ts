/**
 * HTTP client for SEC EDGAR.
 *
 * The SEC has programmatic access rules that are not optional: ignore them and
 * they block your IP. The two that matter:
 *
 *   1. A User-Agent with a real name and contact email. A generic UA
 *      (curl, node-fetch, axios) returns 403.
 *   2. A maximum of 10 requests per second.
 *
 * Fuente: https://www.sec.gov/os/webmaster-faq#developers
 *
 * This client requires the UA via environment variable and caps at 8 req/s for
 * margin. There is no way around it — on purpose.
 */

// Populates process.env from .env before anyone reads configuration.
// Imported for its side effect: ESM imports are evaluated before the body.
import "../env.js";

const SEC_MAX_RPS = 8; // the real limit is 10; we leave room
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
 * The SEC requires you to identify yourself. Set something like:
 *   export SEC_USER_AGENT="Pablo Migliasso pablo@example.com"
 */
export function getUserAgent(): string {
  const ua = process.env.SEC_USER_AGENT?.trim();

  if (!ua) {
    throw new Error(
      "SEC_USER_AGENT is missing.\n\n" +
        "It is not a credential: EDGAR is public and free, there is no account and\n" +
        "no API key. The SEC requires every automated client to identify itself with\n" +
        "a name and email in the User-Agent header, so they can warn you if your\n" +
        "script misbehaves rather than blocking the whole IP range. Without it they\n" +
        "return 403.\n\n" +
        "Put it in .env, which persists across terminals:\n\n" +
        '  SEC_USER_AGENT="Your Name you@email.com"\n\n' +
        "or export it for this session only:\n\n" +
        '  export SEC_USER_AGENT="Your Name you@email.com"\n\n' +
        "See https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data",
    );
  }

  // Loose check: it should look like "something <space> something@something".
  if (!/\S+@\S+\.\S+/.test(ua)) {
    throw new Error(
      `SEC_USER_AGENT="${ua}" does not include an email.\n` +
        'SEC quiere un contacto real, ej: "Pablo Migliasso pablo@ejemplo.com"',
    );
  }

  return ua;
}

/** Spaces out requests so as not to exceed the SEC limit. */
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
        throw new EdgarError(0, url, `network error: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }

    if (res.ok) return res;

    // A 403 is almost always the User-Agent, not a permission.
    if (res.status === 403) {
      throw new EdgarError(
        403,
        url,
        "The SEC returned 403. It is almost always the User-Agent: it has to include " +
          `a real name and email. Yours is "${userAgent}".`,
      );
    }

    if (res.status === 404) {
      throw new EdgarError(404, url, "no existe");
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === maxRetries) {
      throw new EdgarError(res.status, url, `HTTP ${res.status} ${res.statusText}`);
    }

    // The SEC sends Retry-After on some 429s.
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, waitMs));
  }

  throw new EdgarError(0, url, "retries exhausted");
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

/** Quick connectivity and User-Agent check before a long run. */
export async function preflight(): Promise<{ ok: boolean; message: string }> {
  try {
    getUserAgent();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  try {
    // Small, stable endpoint.
    await fetchJson("https://www.sec.gov/files/company_tickers.json", { maxRetries: 1, timeoutMs: 15_000 });
    return { ok: true, message: `EDGAR alcanzable, User-Agent aceptado (${getUserAgent()})` };
  } catch (err) {
    if (err instanceof EdgarError) {
      return { ok: false, message: `${err.message}\n  URL: ${err.url}` };
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

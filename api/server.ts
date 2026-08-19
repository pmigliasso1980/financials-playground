/**
 * The server. Transport and nothing else.
 *
 *   npm run api          → http://localhost:8787
 *
 * WHY NO FRAMEWORK
 *
 * Four routes and an envelope do not justify a dependency. The project already has
 * the rule elsewhere —the HTML pages have no dependencies and that is why they open
 * on a double click— and it holds here too: `node:http` is enough, and if real
 * middleware is ever needed, migrating four handlers is an afternoon.
 *
 * WHAT IT DOES AND WHAT IT DOES NOT
 *
 * It decides nothing. All the logic lives in `api/comps.ts` and in the `db/`
 * modules, so the server can be thrown away and rewritten without touching a
 * business rule.
 *
 * THE ENVELOPE, WHICH COSTS ONE LINE
 *
 * `request_id` + `timestamp` + `data` on every response. It comes from the earlier
 * emulation (see `docs/own-architecture.md` §7) and turned out to be the most
 * useful part of that contract: when someone reports "it gave me the wrong
 * answer", the request_id is the only thing that lets you find the run.
 *
 * WHAT IS MISSING AND HAS TO BE SAID
 *
 * There is no auth. The corpus comes from public EDGAR documents, so it may never
 * be needed; but until that is decided, this is NOT exposed to the internet.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { closePool, ping } from "../db/client.js";
import { corpusState, provenanceStamp } from "../db/provenance.js";
import { findComparables, MIN_COMPARABLES, PROPERTY_TYPES, type PropertyType } from "./comps.js";

const PORT = Number(process.env.PORT ?? 8787);

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

interface Failure {
  code: string;
  message: string;
  /** What to send so it works. An error without this forces you to read the code. */
  expected?: string;
}

/**
 * Validation returns the COMPLETE error, not the first one.
 *
 * A client that sends three bad parameters and gets one error at a time makes
 * three round trips to discover what could have been said in one.
 */
function validateComps(q: URLSearchParams): { ok: true; v: Params } | { ok: false; failures: Failure[] } {
  const failures: Failure[] = [];

  const state = (q.get("state") ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    failures.push({
      code: "invalid_state",
      message: `state="${q.get("state") ?? ""}" is not a two-letter code`,
      expected: "state=GA",
    });
  }

  const type = (q.get("type") ?? "").trim();
  if (!PROPERTY_TYPES.includes(type as PropertyType)) {
    failures.push({
      code: "invalid_type",
      message: `type="${type}" is not a type in the corpus`,
      expected: PROPERTY_TYPES.join(" | "),
    });
  }

  const amount = Number(q.get("amount"));
  if (!Number.isFinite(amount) || amount <= 0) {
    failures.push({
      code: "invalid_amount",
      message: `amount="${q.get("amount") ?? ""}" is not a positive number`,
      expected: "amount=28000000 (in dollars)",
    });
  }

  const band = q.has("band") ? Number(q.get("band")) : undefined;
  if (band != null && (!Number.isFinite(band) || band <= 0 || band > 3)) {
    failures.push({ code: "invalid_band", message: "band outside (0, 3]", expected: "band=0.5" });
  }

  const months = q.has("months") ? Number(q.get("months")) : undefined;
  if (months != null && (!Number.isInteger(months) || months < 1 || months > 240)) {
    failures.push({ code: "invalid_months", message: "months outside [1, 240]", expected: "months=18" });
  }

  /**
   * The LTV is accepted as a fraction (0.70) and as a percentage (70) because a
   * broker writes both, and guessing wrong changes the answer without warning. It
   * is normalised and returned normalised in `criteria` so what was understood is
   * visible.
   */
  let targetLtv: number | undefined;
  if (q.has("target_ltv")) {
    const raw = Number(q.get("target_ltv"));
    if (!Number.isFinite(raw) || raw <= 0 || raw > 100) {
      failures.push({ code: "invalid_ltv", message: "target_ltv out of range", expected: "target_ltv=0.70 or 70" });
    } else {
      targetLtv = raw > 2 ? raw / 100 : raw;
    }
  }

  if (failures.length > 0) return { ok: false, failures };
  return {
    ok: true,
    v: {
      state, type: type as PropertyType, amount, band, months, targetLtv,
      /**
       * National scope is asked for, not fallen into. See the comment on `Scope`
       * in comps.ts: automating it killed the refusal.
       */
      national: q.get("national") === "1" || q.get("national") === "true",
    },
  };
}

interface Params {
  state: string; type: PropertyType; amount: number;
  band?: number; months?: number; targetLtv?: number; national?: boolean;
}

const server = createServer(async (req, res) => {
  const requestId = randomUUID();
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const respond = (status: number, data: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
    });
    res.end(JSON.stringify({ request_id: requestId, timestamp: new Date().toISOString(), data }, null, 2));
  };

  try {
    if (req.method !== "GET") return respond(405, { error: { code: "method_not_allowed" } });

    /**
     * The page is served from the same process.
     *
     * A loose file opened with file:// cannot call the API because of CORS, and
     * standing up a second server for one HTML file is infrastructure without a
     * reason. It is read from disk on every request: it is 8 KB, and that way it
     * can be edited without restarting.
     */
    /**
     * Two pages, two audiences.
     *
     * `/` is for someone with a concrete deal. `/scenarios` runs the twelve
     * scenarios at once and is for us: it shows at a glance what the corpus can
     * and cannot answer. Mixing them would force a broker to look at eleven rows
     * they do not care about.
     */
    const PAGES: Record<string, string> = {
      "/": "ui.html",
      "/index.html": "ui.html",
      "/scenarios": "scenarios.html",
    };
    const page = PAGES[url.pathname];
    if (page) {
      const html = await readFile(new URL(`./${page}`, import.meta.url), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-request-id": requestId });
      return res.end(html);
    }

    if (url.pathname === "/health") {
      return respond(200, { ok: true });
    }

    if (url.pathname === "/corpus") {
      const e = await corpusState();
      return respond(200, { ...e, provenanceStamp: provenanceStamp(e), types: PROPERTY_TYPES });
    }

    if (url.pathname === "/comps") {
      const p = validateComps(url.searchParams);
      if (!p.ok) return respond(422, { error: { code: "invalid_parameters", failures: p.failures } });
      const r = await findComparables(p.v);
      /**
       * "Not enough comparables" is 200, not 404 or 422.
       *
       * It is the state of the knowledge, not a failure: the client has to be able
       * to distinguish it from a downed server or a malformed query, because the
       * action that follows is different —widen the criteria, not retry.
       */
      return respond(200, r);
    }

    return respond(404, {
      error: {
        code: "not_found",
        routes: ["/", "/scenarios", "/health", "/corpus", "/comps?state=GA&type=Multifamily&amount=28000000"],
      },
    });
  } catch (err) {
    console.error(`[${requestId}]`, err);
    return respond(500, { error: { code: "internal_error", request_id: requestId } });
  }
});

server.listen(PORT, () => {
  const e = `http://localhost:${PORT}`;
  console.log(`\n  API listening on \x1b[1m${e}\x1b[0m\n`);
  console.log(`  \x1b[90m${e}/scenarios  → the twelve scenarios at once\x1b[0m\n`);
  console.log(`  \x1b[90mOr from the console:\x1b[0m`);
  console.log(`    curl "${e}/corpus"`);
  console.log(`    curl "${e}/comps?state=GA&type=Multifamily&amount=28000000&target_ltv=0.70"`);
  console.log(
    `\n  \x1b[90mNo auth: do not expose to the internet until that is decided. Minimum ${MIN_COMPARABLES}` +
      ` comparables to give a range.\x1b[0m\n`,
  );
});

for (const s of ["SIGINT", "SIGTERM"] as const) {
  process.on(s, () => {
    server.close(() => closePool().then(() => process.exit(0)));
  });
}

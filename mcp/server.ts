/**
 * The corpus as an assistant's tool.
 *
 *   npm run mcp     (not run by hand: the MCP client launches it)
 *
 * WHY THIS AND NOT ANOTHER SCREEN
 *
 * Trepp, CompStak, Lev and StackSource each live on their own website. None of them
 * lives inside the assistant the broker already has open. An MCP is the cheapest
 * distribution there is: the user learns no new interface, asks the way they were
 * already asking, and the corpus answers.
 *
 * NO DEPENDENCIES, FOR THE SAME REASON AS THE HTTP SERVER
 *
 * MCP over stdio is newline-delimited JSON-RPC 2.0. Three methods —initialize,
 * tools/list, tools/call— are about a hundred lines. Pulling in an SDK for that adds
 * a dependency chain to a process that will run on a third party's machine.
 *
 * THE PROBLEM THIS FILE HAS AND THE API DOES NOT
 *
 * The API talks to a program: it returns JSON and the client decides what to show.
 * Here, on the other side, is a language model that will PARAPHRASE whatever it
 * receives, and paraphrasing drops the nuances — first each number's base, then the
 * channel's limit.
 *
 * So the tool does not return bare JSON. It returns text where every caveat is glued
 * to the number it qualifies, so that the number cannot be repeated without
 * repeating the caveat. "Median LTV 61% (over 24 loans)" survives a paraphrase; a
 * `base: 24` field elsewhere in the object does not.
 *
 * And the refusal is returned as affirmative text —"not enough to give a range, ten
 * are needed"— and not as an error, because an error invites the model to retry or
 * to invent the missing datum.
 */

import { createInterface } from "node:readline";
import { closePool, ping } from "../db/client.js";
import {
  findComparables, MIN_COMPARABLES, PROPERTY_TYPES,
  type CompsResponse, type PropertyType,
} from "../api/comps.js";

const health = await ping();
if (!health.ok) {
  console.error(`financials-mcp: no database — ${health.message.split("\n")[0]}`);
  process.exit(1);
}

/** The version we speak. If the client asks for another, we answer with theirs if we know it. */
const PROTOCOL = "2024-11-05";
const KNOWN = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

const TOOL = {
  name: "find_comparables",
  description:
    "Searches for comparable commercial loans in a corpus of conduit CMBS deals " +
    "built from public SEC EDGAR documents, and returns the terms they got (LTV, " +
    "DSCR, debt yield, rate). Useful for answering 'what can I expect for this " +
    "loan?' before going out to find lenders. " +
    "IMPORTANT: the corpus covers ONLY the conduit CMBS channel — it does not " +
    "include banks, agencies, bridge debt or life insurance companies.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: 'Two-letter code, for example "GA"' },
      type: { type: "string", enum: [...PROPERTY_TYPES], description: "Property type" },
      amount: { type: "number", description: "Loan amount in dollars, for example 28000000" },
      target_ltv: {
        type: "number",
        description: "Optional. The LTV the client is asking for, as a fraction (0.70) or percentage (70)",
      },
      months: { type: "number", description: "Optional. Look-back window. Defaults to 18." },
    },
    required: ["state", "type", "amount"],
  },
} as const;

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const fmt: Record<string, (v: number) => string> = {
  ltv: pct, debt_yield: pct, interest_rate: pct, dscr: (v) => `${v.toFixed(2)}x`,
};

/**
 * The result as text, with every caveat glued to its number.
 *
 * See the comment above: the consumer of this is a model that paraphrases.
 */
function asText(r: CompsResponse): string {
  const c = r.criteria;
  const header = `${c.type} · ${c.state} · ${
    Math.round(c.amount).toLocaleString("en-US")
  } USD · last ${c.months ?? 18} months`;

  if (!r.sufficient) {
    return (
      `${header}\n\n` +
      `THERE IS NOT ENOUGH DATA to give a range: ${r.found} comparable loans were ` +
      `found and at least ${r.minimum} are needed. With fewer, a median would assert ` +
      `more than this data knows.\n\n` +
      `This is NOT an error nor a failure of the query: it is the state of the ` +
      `knowledge. Do not estimate the range by other means; offer to widen the ` +
      `criteria.\n\n` +
      `If a criterion is loosened:\n` +
      r.ifWidened.map((s) => `  · ${s.criterion} → ${s.found} comparables`).join("\n") +
      `\n\n${r.corpus.channel}`
    );
  }

  const dist = r.distributions
    .map((m) => {
      const f = fmt[m.metric] ?? ((v: number) => v.toFixed(2));
      return `  ${m.label}: median ${f(m.p50)} (usual range ${f(m.p25)} to ${f(m.p75)}) ` +
        `— computed over ${m.base} of the ${r.found} comparables`;
    })
    .join("\n");

  const target = r.target
    ? `\n\nON THE ${pct(r.target.ltv)} LTV BEING SOUGHT: of the ${r.target.of} ` +
      `comparables that publish an LTV, ${r.target.reached} reached that level or higher. ` +
      (r.target.reached / Math.max(1, r.target.of) < 0.25
        ? `That is a small slice of the channel — the expectation is worth revisiting before going out to market.`
        : `It is within what this channel has been delivering.`)
    : "";

  const examples = r.sample
    .slice(0, 5)
    .map(
      (m) =>
        `  · ${m.property ?? "(no name)"}${m.city ? `, ${m.city}` : ""} — ` +
        `${Math.round(m.amount).toLocaleString("en-US")} USD, ${m.date}, ${m.issuance}\n` +
        `    document: ${m.document}`,
    )
    .join("\n");

  return (
    `${header}\n\n${r.found} comparable loans.\n\n${dist}${target}\n\n` +
    `Each metric was computed only over the comparables that publish it, which is why ` +
    `the bases differ. When quoting a number, quote how many loans it is based on too.\n\n` +
    `Verifiable examples:\n${examples}\n\n` +
    `${r.corpus.channel}\n${r.corpus.provenanceStamp}`
  );
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

type Id = string | number | null;
const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id: Id, result: unknown) => send({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg: { id?: Id; method?: string; params?: Record<string, unknown> }) {
  const id = msg.id ?? null;

  switch (msg.method) {
    case "initialize": {
      const requested = (msg.params?.protocolVersion as string) ?? PROTOCOL;
      return reply(id, {
        protocolVersion: KNOWN.has(requested) ? requested : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "financials-comparables", version: "0.1.0" },
      });
    }

    /** Notifications: they carry no id and are not answered. */
    case "notifications/initialized":
    case "notifications/cancelled":
      return;

    case "ping":
      return reply(id, {});

    case "tools/list":
      return reply(id, { tools: [TOOL] });

    case "tools/call": {
      const name = msg.params?.name as string;
      if (name !== TOOL.name) {
        return fail(id, -32602, `Unknown tool: ${name}`);
      }
      const a = (msg.params?.arguments ?? {}) as Record<string, unknown>;

      /**
       * Validation returns isError with text explaining what to send, rather than a
       * JSON-RPC error. A protocol error is something the model cannot correct;
       * text saying "state has to be two letters" is.
       */
      const state = String(a.state ?? "").trim().toUpperCase();
      const type = String(a.type ?? "").trim();
      const amount = Number(a.amount);
      const problems: string[] = [];
      if (!/^[A-Z]{2}$/.test(state)) problems.push('state: two-letter code, like "GA"');
      if (!PROPERTY_TYPES.includes(type as PropertyType)) {
        problems.push(`type: one of ${PROPERTY_TYPES.join(", ")}`);
      }
      if (!Number.isFinite(amount) || amount <= 0) problems.push("amount: positive number in dollars");
      if (problems.length > 0) {
        return reply(id, {
          content: [{ type: "text", text: `Parameters to correct:\n${problems.map((p) => `  · ${p}`).join("\n")}` }],
          isError: true,
        });
      }

      const ltvRaw = a.target_ltv != null ? Number(a.target_ltv) : undefined;
      const r = await findComparables({
        state,
        type: type as PropertyType,
        amount,
        months: a.months != null ? Number(a.months) : undefined,
        /** 70 and 0.70 are the same intent; guessing wrong changes the answer. */
        targetLtv: ltvRaw == null ? undefined : ltvRaw > 2 ? ltvRaw / 100 : ltvRaw,
      });

      return reply(id, {
        content: [{ type: "text", text: asText(r) }],
        /** Structured as well as the text, for clients that know how to use it. */
        structuredContent: r as unknown as Record<string, unknown>,
      });
    }

    default:
      if (id !== null) fail(id, -32601, `Method not implemented: ${msg.method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg: { id?: Id; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, "Invalid JSON");
  }
  try {
    await handle(msg);
  } catch (err) {
    fail(msg.id ?? null, -32603, err instanceof Error ? err.message : String(err));
  }
});

rl.on("close", () => closePool().then(() => process.exit(0)));

/** The log goes to stderr: stdout is the protocol's channel and a console.log breaks it. */
console.error(
  `financials-mcp ready · tool "${TOOL.name}" · minimum ${MIN_COMPARABLES} comparables`,
);

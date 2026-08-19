# Connecting the corpus to an assistant

`npm run mcp` is not run by hand: the MCP client launches it.

## Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "financials": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "cwd": "/Users/pablomigliasso/code/financials-playground"
    }
  }
}
```

It requires Postgres to be running (`npm run db:up`). If it is not, the server
exits with code 1 and a message on stderr rather than hanging.

## What it exposes

A single tool, `find_comparables`. State, property type, amount and optionally the
LTV the client is asking for.

> The tool and its parameters were renamed when the project moved to English.
> It used to be `buscar_comparables`, with `estado` / `tipo` / `monto` /
> `ltv_objetivo` / `meses`. Any assistant configured against the old names has to
> be repointed — the MCP tool name is a public contract, and nothing warns you when
> it changes.

## Why it returns text and not JSON

On the other side is a model that will paraphrase. Paraphrasing drops the nuances,
and the first to go are each number's base and the channel's limit.

So every caveat is glued to the number it qualifies: *"median LTV 61% — computed
over 24 of the 31 comparables"* survives a paraphrase. A `base: 24` field elsewhere
in the object does not.

The refusal is returned as affirmative text and **not** as a protocol error: an
error invites the model to retry or to fill in the missing datum on its own, which
is exactly what we do not want.

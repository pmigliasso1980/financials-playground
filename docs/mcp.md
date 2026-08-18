# Conectar el corpus a un asistente

`npm run mcp` no se corre a mano: lo lanza el cliente MCP.

## Claude Desktop

En `claude_desktop_config.json`:

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

Requiere que Postgres esté levantado (`npm run db:up`). Si no lo está, el servidor
sale con código 1 y un mensaje por stderr en vez de quedarse colgado.

## Qué expone

Una sola herramienta, `buscar_comparables`. Estado, tipo de propiedad, monto y
opcionalmente el LTV que pide el cliente.

## Por qué devuelve texto y no JSON

Del otro lado hay un modelo que va a parafrasear. Al parafrasear se caen los
matices, y los primeros en caerse son la base de cada número y el límite del canal.

Por eso cada salvedad va pegada al número que califica: *"LTV mediana 61% —
calculado sobre 24 de los 31 comparables"* sobrevive a una paráfrasis. Un campo
`base: 24` en otra parte del objeto, no.

La negativa se devuelve como texto afirmativo y **no** como error de protocolo: un
error invita al modelo a reintentar o a completar el dato faltante por su cuenta,
que es exactamente lo que no queremos.

#!/usr/bin/env bash
# Sincroniza la documentación pública de Lev a docs/vendor/.
#
# Lev publica su corpus en formato machine-readable justamente para esto.
# Volvé a correrlo cuando quieras refrescar: los docs cambian seguido.
#
#   npm run sync:docs
#
# Después, para generar los tipos TS desde el OpenAPI:
#   npm run gen:types

set -euo pipefail

BASE="https://www.lev.com/docs"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docs/vendor"
mkdir -p "$OUT"

fetch() {
  local url="$1" dest="$2"
  printf '  %-24s ' "$(basename "$dest")"
  if curl -fsSL --max-time 60 "$url" -o "$dest"; then
    printf 'ok  (%s)\n' "$(du -h "$dest" | cut -f1 | tr -d ' ')"
  else
    printf 'FALLÓ\n'
    return 1
  fi
}

echo "Sincronizando docs de Lev → docs/vendor/"
echo

# Índice compacto + instrucciones para agentes + referencia de endpoints.
fetch "$BASE/llms.txt"            "$OUT/llms.txt"

# Corpus completo como markdown en un solo archivo. Ideal para drop de contexto.
fetch "$BASE/llms-full.txt"       "$OUT/llms-full.txt"

# Todas las Q&A del FAQ de producto.
fetch "$BASE/llms-faq.txt"        "$OUT/llms-faq.txt"

# OpenAPI 3.1 — la fuente para generar tipos y clientes.
fetch "$BASE/openapi.json"        "$OUT/openapi.json"

# Chunks a nivel sección con intents y keywords, pensado para retrieval.
fetch "$BASE/content-index.json"  "$OUT/content-index.json"

echo
echo "Listo. Próximo paso:  npm run gen:types"

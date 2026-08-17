# Verificación

> Reemplaza el checkpoint anterior. El mock está terminado y verificado.

**Typecheck:** 0 errores en `src/`, `mock/`, `examples/`, `scripts/`.
**Smoke:** 43 checks, 0 fallidos, 0 salteados.

```bash
npm run mock     # terminal 1
npm run smoke    # terminal 2
```

## Qué se verificó ejecutándolo

| Área | Comprobado |
|---|---|
| Envelope | `request_id` + `timestamp` + `data` en toda respuesta |
| Auth | 401 con token inválido y con key revocada · 400 sin `X-Origin-App` |
| Scopes | `read_only` lee pero no escribe (403) · sin `ai:actions` no hay unlock |
| Paginación | cursor sin solapamiento entre páginas · `cursor`+`sort` → 400 · limit clampeado a 200 |
| Filtros | coma = OR · operadores `gte`/`lte` · `fields` recorta e incluye `id` siempre |
| Errores | 404 con `not_found` · 422 con enum inválido · request_id presente |
| Idempotencia | mismo body → replay sin duplicar · body distinto → 409 |
| Deal Index | observations en conflicto · promover preserva provenance · free-text marca override · métrica no editable → 422 · `value` + `observation_id` juntos → 422 |
| Créditos | preview no cobra · lender match cuesta 2.000 · deal sin geocodificar → 422 antes de cobrar |
| Rate limits | tier free: 10 requests al endpoint, la 11 devuelve 429 |
| Flujo completo | `ex:match` de punta a punta: preview → confirmar → 4 lenders → company → placement |

## Lo que NO está verificado

**La ruta con Claude nunca se ejecutó.** Todo el desarrollo corrió con
`MOCK_FORCE_DETERMINISTIC=1` porque el entorno donde trabajé no tiene
`ANTHROPIC_API_KEY` ni salida a la API de Anthropic. El código de
`mock/ai/provider.ts` —la llamada, el parseo del JSON, el fallback ante error—
está escrito pero sin probar. Es la parte menos confiable del proyecto.

Cuando le pongas la key: si algo falla, el fallback debería atajarlo y seguir
con scoring por keywords. Eso también es teoría.

**Tampoco se validó contra `api.lev.com`.** Todas las formas de respuesta salen
de la documentación, no de la API real. Ahora que tenés cuenta, el paso que más
valor tiene es:

```bash
LEV_API_BASE=https://api.lev.com/api/external/v2 LEV_API_KEY=<tu-key> npm run smoke
```

Donde el smoke falle contra la API real, gana la API real y hay que corregir el
mock. Los checks que gastan créditos están salteados por default.

## Decisiones de diseño

- **La cuenta por default espeja tu situación**: tier `free`, 3.000 créditos.
  Con eso entra 1 lender match (2.000) + 5 unlocks (200 c/u).
- **Las acciones que cobran previsualizan por default.** Hay que pasar
  `?confirm=true` para que cobren. Es el patrón que Lev codifica en sus tools MCP.
- **Hay conflictos de datos sembrados a propósito**: el T-12 y el OM de cada
  deal reportan NOIs distintos, para que la promoción del Index tenga algo real
  que resolver.
- **El seed garantiza cobertura de lenders.** Los programas se generan al azar,
  así que agregué un paso (`ensureLenderCoverage`) que asegura ≥4 candidatos
  viables por deal. Sin eso el match devolvía cero para varios deals: realista,
  pero inútil para desarrollar.
- **Los campos `_mock_*` no existen en Lev.** Se sacan de los serializers en
  `routes/misc.ts` y `routes/dealIndex.ts` si molestan.

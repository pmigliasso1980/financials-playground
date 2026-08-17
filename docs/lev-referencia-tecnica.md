# Lev — Referencia técnica para construir

> Compilado de la documentación pública de lev.com (docs actualizados entre marzo y julio 2026). Relevado el 5 de agosto de 2026.
> Todo lo que sigue proviene de la doc oficial salvo donde se indique explícitamente como inferencia o discrepancia.

---

## Índice

1. [Contexto de empresa y producto](#1-contexto-de-empresa-y-producto)
2. [Arquitectura: una API, tres superficies](#2-arquitectura-una-api-tres-superficies)
3. [Modelo de datos](#3-modelo-de-datos)
4. [Autenticación y scopes](#4-autenticación-y-scopes)
5. [Convenciones de la REST API](#5-convenciones-de-la-rest-api)
6. [Mapa completo de endpoints](#6-mapa-completo-de-endpoints)
7. [Deal Index — la pieza diferencial](#7-deal-index--la-pieza-diferencial)
8. [MCP: arquitectura, auth y catálogo de tools](#8-mcp-arquitectura-auth-y-catálogo-de-tools)
9. [CLI](#9-cli)
10. [Patrones de agentes](#10-patrones-de-agentes)
11. [Créditos y facturación](#11-créditos-y-facturación)
12. [Seguridad y compliance](#12-seguridad-y-compliance)
13. [Recursos machine-readable](#13-recursos-machine-readable)
14. [Rutas de construcción](#14-rutas-de-construcción)
15. [Huecos, discrepancias y preguntas abiertas](#15-huecos-discrepancias-y-preguntas-abiertas)
16. [Fuentes](#16-fuentes)

---

## 1. Contexto de empresa y producto

**Lev, Inc.** — 50 W 17th St, Floor 4, New York, NY 10011. Tel. (888) 977-4117. Fundador/CEO: Yaakov Zar.

- **+$110M** levantados. Inversores: JLL Spark, Citi, Capital One, NFX, Canaan, StepStone, First American, Dwight Capital, Cross River, Ludlow Ventures, Capital Property Partners.
- Escala declarada en `llms.txt`: **7.000+ lenders** en el directorio y **$50B+** en transacciones procesadas.
- Trayectoria: de brokerage tech-enabled a "sistema operativo" para transacciones de commercial real estate (CRE).

**Posicionamiento:** combinar la mayor fuente de datos CRE en tiempo real con IA específica del dominio, para sponsors y brokers. El claim central es *CRE-native*: el modelo de datos habla de deals, term sheets, lenders, placements y pipelines, no de "documentos" genéricos.

### El sistema de producto: 35 productos en 4 capas

**Apps (12)** — superficies de trabajo:

| Producto | Qué hace |
|---|---|
| Lev CRM | Historial de relaciones, actividad de lenders, contexto de follow-up |
| Lev Pipeline | Oportunidades, etapas de lender, ownership de tareas, riesgo de cierre |
| Lev Vault | Deal room seguro: archivos, diligence, versiones, handoffs |
| Lev Agent | Asistente CRE que lee contexto de deal, responde y ejecuta acciones |
| Lev Checklist | Checklists de borrower e internos con requisitos, owners, due dates |
| Lev Memo | Genera credit memos, debt/equity memos, OMs, materiales de deal |
| Lev Index | Knowledge graph de facts del deal, compilado automáticamente |
| Lev Inbox | Prioriza requests, replies, aprobaciones y comunicación de deal |
| Lev Cortex | Gobierna skills, versiones, evals, logs y aprobaciones de agentes |
| Lev Campaigns | Outreach a lenders/sponsors/borrowers con follow-up asistido |
| Lev Commissions | Comisiones, splits de referral y team payouts, invoicing |
| Lev Match | Rankea lenders por deal según intent y criterios de financiamiento |

**Agents (11)** — lender outreach, term sheet extractor, document extractor, checklist creator, underwriting, origination, market expert, sales comps, investment sales OM creator, debt financing OM creator, credit memo creator.

En una captura de Lev Cortex se ven agentes versionados corriendo sobre **Claude Opus 4.5, Claude Sonnet 4.5 y GPT-5** — es decir, Lev es multi-modelo y versiona cada agente.

**Data (6)** — lender search, lender contact routing, lender profiles, lead sourcing, Lender Pulse (movimientos de pricing y apetito), recent market terms.

**Platform (6)** — Lev API, Lev MCP, Lev CLI, Integraciones, Lev in Claude, Lev in ChatGPT.

### Integraciones nativas

- **Deal systems:** Salesforce, HubSpot, DealCloud
- **Documentos:** Google Drive, Box, SharePoint
- **Work surfaces:** Gmail, Outlook, Excel
- **Automatización:** Snowflake, Zapier

---

## 2. Arquitectura: una API, tres superficies

```
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │   REST API   │   │  MCP Server  │   │   Lev CLI    │
        │  API key /   │   │  OAuth JWT   │   │   API key    │
        │     JWT      │   │   (Auth0)    │   │  (keychain)  │
        └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
               │                  │                  │
               └──────────────────┼──────────────────┘
                                  ▼
                  https://api.lev.com/api/external/v2
                        (lev-backend, mismos scopes
                         y políticas de autorización)
```

**Regla de decisión que Lev documenta explícitamente:**

| Usá | Cuándo |
|---|---|
| **MCP** | Clientes de IA interactivos (Claude, Cursor) con tool use, retrieval y human-in-the-loop, en nombre de un usuario logueado |
| **REST** | Jobs de sync backend, integraciones de producto, cualquier cosa server-to-server. Contratos estables, API keys, sin login interactivo |
| **CLI** | Workflows de terminal, scripts ad-hoc, CI/CD, o darle a un agente de código acceso a shell sobre Lev |

> ⚠️ **No apuntes servicios headless al MCP.** El servidor MCP espera una sesión de usuario viva y **no soporta operación multi-tenant compartida**. Para service-to-service, REST + API key.

### Stack del MCP server (documentado)

```
MCP Client (Claude, Cursor, …)
        │  Streamable HTTP (POST /mcp)
        ▼
Lev MCP Server (FastMCP, Python)
  ├── Verificación de JWT Auth0 (RS256, JWKS)
  ├── Tool registry (60 tools en 13 grupos)
  └── Cliente API async (retries, circuit breaker)
        │  Authorization: Bearer <jwt>
        │  X-Origin-App: mcp
        ▼
Lev API
```

- **Transporte:** Streamable HTTP. Sin stdio, sin SSE. Una conexión persistente por sesión.
- **Runtime:** Python + FastMCP, gunicorn + uvicorn workers en producción.
- **Nota:** la página de producto de Lev MCP menciona `mcp.lev.com/sse` como endpoint, pero la doc técnica dice explícitamente "no SSE" y usa `https://mcp.lev.com/mcp`. Tomá la doc técnica como fuente de verdad.

---

## 3. Modelo de datos

**Jerarquía de recursos** (de `llms.txt`):

- **Deal** es el recurso central.
- Sub-recursos de un deal: `financials`, `properties`, `team`, `placements`, `term-sheets`, `vaults`, `documents`, `checklists`, `memos`, `notes`, `index/*`.
- **Contacts** y **Companies** son recursos CRM scopeados a la cuenta.
- El **Lender Directory es global**, no scopeado a cuenta.

```
Account
 └── Deal ─────────────────────────────────────────────────┐
      ├── financials            (DealFinancials)           │
      ├── properties            (Property[])               │
      ├── team                  (TeamMember[])             │
      ├── pipelines             (hasta 10 filas activas)   │
      ├── index/                ← knowledge graph de facts │
      │    ├── facts (canónicos, con sot_id)               │
      │    ├── observations (candidatos por documento)     │
      │    ├── metric-definitions                          │
      │    └── entities (deal, property:N, sponsor)        │
      ├── vaults/               ← Resources + Deal Rooms   │
      │    ├── documents (archivos subidos)                │
      │    └── checklists → sections → tasks → files       │
      ├── memos/                ← deal books generados     │
      ├── placements/  ────────► Company (lender)          │
      │    └── term-sheets/     ← quotes por placement     │
      └── notes/                                           │
                                                           │
Account CRM                                                │
 ├── Company (lender | sponsor)  ◄─────────────────────────┘
 └── Contact (lender_contact | sponsor)

Global
 └── Lender Directory → Lender (org_id) → Programs
```

### Objeto Deal

| Campo | Tipo | Nota |
|---|---|---|
| `id` | integer | |
| `title` | string\|null | |
| `loan_amount` | number\|null | |
| `loan_type` | LoanType\|null | |
| `transaction_type` | TransactionType\|null | |
| `business_plan` | BusinessPlanType\|null | |
| `description` | string\|null | |
| `estimated_close_date` | string\|null | ISO 8601 |
| `close_date` | string\|null | fecha real de cierre |
| `owner_account_id` | integer\|null | |
| `created_at` / `updated_at` | string\|null | ISO 8601 |
| `financials` | object\|null | con `?include=financials` |
| `properties` | array\|null | con `?include=properties` |
| `team` | array\|null | con `?include=team` |
| `pipelines` | array\|null | con `?include=pipelines`, hasta 10 filas: `pipeline_id`, `status_name`, `updated_at` |

### Objeto Vault

Un vault es el contenedor de documentos de un deal.

| Campo | Tipo | Nota |
|---|---|---|
| `id` | integer | pasalo como `vault_id` en List Documents |
| `type` | string | `resources` (único, privado, working files) o `shared` (Deal Room compartible) |
| `title` | string\|null | `Deal Resources` para el privado; los shared: `Deal Room`, `Closing`, o uno por lender |
| `is_default` | boolean | `true` para el Deal Room primario |
| `document_count` | integer | |

> **Nomenclatura:** ante usuarios, "vaults" suele significar los Deal Rooms compartidos. Todo deal tiene además un área **Resources** privada. Usá siempre el `title`, nunca el `type` crudo.

### Objeto Checklist Task

Vive dentro de un checklist, que vive en un Deal Room (los checklists **no** existen en el vault Resources privado).

| Campo | Tipo | Nota |
|---|---|---|
| `id`, `title`, `description`, `position` | | |
| `status` | string | `to_do` \| `requested` \| `reviewing` \| `updates_needed` \| `approved` \| `cancelled` |
| `is_completed` | boolean | **flag separado de `status`** — una tarea puede estar `approved` pero no completa |
| `due_date` | string\|null | |
| `role` | string\|null | ej. borrower, lender |
| `assignee` | object\|null | usuario Lev asignado |
| `assigned_team` | object\|null | account, lender o borrower team |
| `collaborators` | array | `id` es null para externos sin cuenta Lev |
| `document_types` | array | tipos esperados (Appraisal, Rent roll, …) |
| `files` | array | `document_id`, `vault_resource_id`, `name`, `origin` |
| `subtasks` | array | un nivel de anidamiento |

### Enums (todos lowercase en el wire)

```
loan_type:          construction | heavy_bridge | light_bridge | permanent
                    | land | predevelopment | tbd
transaction_type:   acquisition | refinance | new_construction | tbd
business_plan:      stabilized | value_add | construction | land
contact_type:       lender_contact | sponsor
company_type:       lender | sponsor
note parent_type:   contact | deal | placement | company | checklist_task
memo_type:          debt_financing_om | credit_memo | investment_sales
                    | debt_brokerage | equity_raise | broker_opinion_of_value
                    | investment_committee | invoice | other
```

**Placements:**

```
status:         new | sent | lender_reviewing | terms_received | term_sheet_received
                | executed_ts_in_closing | closed | unresponsive | willing_to_negotiate
                | lender_passed | archived | carve_out | carve_out_closed
lender_status:  origination | new | lead_qualification | quotation | negotiation
                | offer | term_sheet | good_faith_deposit | diligence | in_closing
                | closed | archived
visibility:     hidden | masked | shared
```

> `archived` es exclusivo de `update_placement` — no se puede enviar en el create. No hay verbo DELETE para placements.

**Term sheets:**

```
quote_type:          guidance | indication | soft_quote | hard_quote | term_sheet
rate_type:           fixed | floating
recourse:            personal_recourse | fund_corporate_recourse | non_recourse
recourse_type:       full | partial | burn_off
floor_type:          base_rate | total_rate
prepayment_penalty:  step_down | defeasance | minimum_interest | yield_maintenance
                     | minimum_multiple | swap_breakage | no_prepayment_penalty
                     | no_ability_to_prepay | flat_fee | other
payment_method:      accrued | partial | current_pay
capital_source_type: balance_sheet | agency | cmbs_clo | warehouse | sba
base_rate:           enum key (treasury_y5, sofr_m1, prime_rate, …) o display value
                     ("Treasury 5-Yr", "SOFR 30-Day Avg", "Prime Rate"),
                     o el literal `none-fixed` para fijo sin benchmark
```

> ⚠️ **Semántica de `total_rate`:** es el **spread** cuando el term sheet tiene un `base_rate` de benchmark. Es la **tasa all-in fija** solo cuando no hay benchmark (`base_rate` null o `none-fixed`). Con base rate, la all-in se calcula como `base_rate_value + total_rate`. Este es un lugar fácil de romper una integración.

---

## 4. Autenticación y scopes

### Dos métodos

| Método | Caso de uso | Vida del token |
|---|---|---|
| **API Key** | Server-to-server, CI/CD, automatización | Larga (hasta revocación) |
| **JWT (Auth0)** | Clientes interactivos, MCP | Corta (configurable) |

Ambos usan `Authorization: Bearer <token>`. La API detecta el tipo automáticamente.

### API Keys

- Prefijo `lev_sk_` (ej. `lev_sk_live_4f2a…`).
- Se crean en app.lev.com → Settings → API Keys (**requiere ser workspace admin**), o vía `POST /api-keys` con `{ label }`.
- El valor completo se muestra **una sola vez**.
- La revocación es instantánea (`DELETE /api-keys/{key_id}`).
- **Techos por tier:** Free 2 · Standard 10 · Enterprise 50. Excederlo devuelve `422`. El conteo actual está en `platform.api_keys = { current_count, max_allowed }` de `GET /me`.
- Una key está atada a un usuario y una cuenta: **no puede acceder a nada que el usuario no vea en la app**.
- Validación programática (endpoint sin auth): `POST /auth/validate-api-key` con `{ "api_key": "..." }` → devuelve `{ valid, user_id, account_id, scopes[], tier }`.

### Scopes granulares

| Dominio | Read | Write |
|---|---|---|
| Account | `account:read` | `account:write` |
| Checklists | `checklists:read` | `checklists:write` |
| Companies | `companies:read` | `companies:write` |
| Contacts | `contacts:read` | `contacts:write` |
| Deals | `deals:read` | `deals:write` |
| Documents | `documents:read` | `documents:write` |
| Lender directory | `lenders:read` | — |
| Market data | `market:read` | — |
| Pipelines | `pipelines:read` | `pipelines:write` |
| Placements | `placements:read` | `placements:write` |
| Term sheets | `termsheets:read` | `termsheets:write` |

Más un scope de acción:

- **`ai:actions`** — requerido para acciones con IA como `POST /deals/{id}/actions/search-lenders` y `POST /contacts/{id}/actions/unlock`. **No lo otorga `deals:write`**. Este es el scope que gatea todo lo que consume créditos.

**Presets al crear una key:**

| Permiso | Scopes |
|---|---|
| `full_access` (default) | Todos, incluido `ai:actions` |
| `read_only` | Todos los `*:read`. Sin writes, sin `ai:actions` |

Los JWT reciben la misma superficie que `full_access`, filtrada además por el rol Lev del usuario a nivel recurso.

### Headers obligatorios

| Header | Requerido | Descripción |
|---|---|---|
| `Authorization` | Sí | `Bearer <api_key_or_jwt>` |
| `X-Origin-App` | Sí | Identifica la app que llama (ej. `my-integration`, `claude-desktop`) |
| `X-Active-Account` | Solo JWT multi-cuenta | `slug` de la cuenta. Las API keys **no lo leen** (están atadas a una cuenta al emitirse) |
| `Content-Type` | POST/PATCH | `application/json` |
| `Idempotency-Key` | Recomendado en writes | UUID, expiry 24h |

### Multi-cuenta

Un usuario puede pertenecer a varias cuentas (broker en dos brokerages, o sponsor + lender).

- Toda request de un usuario multi-cuenta debe llevar `X-Active-Account: <slug>`.
- **Excepción: `GET /me`.** Es el endpoint de discovery — llamarlo *sin* el header devuelve la respuesta unscoped con `available_accounts[]`. Todos los demás endpoints lo exigen.
- Sin el header, un usuario multi-cuenta recibe `400 Bad Request`: *"Active account required. Provide X-Active-Account header or use an API key."*
- **Dos formas de cambiar de cuenta:**
  - *Per-request (JWT):* cambiar el valor del header.
  - *Persistido:* `PATCH /me/active-account` con `{ "slug": "..." }`. Queda guardado en el registro del usuario hasta el próximo cambio. La tool `switch_account` del MCP es un wrapper de esto.

### Errores de auth

- `401 unauthorized` — token faltante, inválido o expirado
- `403 forbidden` — token válido, permisos insuficientes (`type: "forbidden"`)

---

## 5. Convenciones de la REST API

**Base URL:** `https://api.lev.com/api/external/v2`

### Envelope de respuesta

Objeto único:

```json
{
  "request_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-03-20T15:30:45Z",
  "data": { "id": 123, "title": "Example Deal" }
}
```

Lista:

```json
{
  "request_id": "...",
  "timestamp": "2026-03-20T15:30:45Z",
  "data": [ … ],
  "pagination": {
    "total": 142,
    "limit": 50,
    "cursor": "eyJpZCI6IDJ9",
    "has_more": true,
    "next_cursor": "eyJpZCI6IDUyfQ=="
  }
}
```

Todo response trae `request_id` (UUID v4, correlacionable con soporte) y `timestamp` (ISO 8601).

### Paginación

| Estrategia | Cuándo | Estabilidad | Uso |
|---|---|---|---|
| **Cursor** | Default (sin `sort`) | Estable, sin duplicados ni saltos | Bulk sync, iteración confiable |
| **Offset** | Cuando se pasa `sort` | Puede desplazarse si cambian datos | Browsing ordenado, tablas de UI |

- `limit`: default 50, min 1, **max 200**.
- **Cursor y `sort` son mutuamente excluyentes** → combinarlos devuelve `400 bad_request`.
- Para bulk sync de producción: siempre cursor.

### Filtrado, sorting y sparse fieldsets

**Operadores de filtro:**

| Operador | Sintaxis | Ejemplo |
|---|---|---|
| `eq` (default) | `filter[field]=value` | `filter[loan_type]=heavy_bridge` |
| `gt` | `filter[field][gt]=value` | `filter[loan_amount][gt]=1000000` |
| `gte` | `filter[field][gte]=value` | `filter[created_at][gte]=2026-01-01` |
| `lt` | `filter[field][lt]=value` | `filter[loan_amount][lt]=5000000` |
| `lte` | `filter[field][lte]=value` | `filter[updated_at][lte]=2026-03-01` |

Múltiples valores en `eq` van separados por coma y se tratan como **OR**: `filter[loan_type]=heavy_bridge,permanent`.

**Campos filtrables:**

| Recurso | Campos |
|---|---|
| Deals | `loan_type`, `transaction_type`, `business_plan`, `loan_amount`, `created_at`, `updated_at` |
| Lender Directory | `state`, `name` (search) |
| Contacts / Companies | Varía por endpoint |

**Campos ordenables:** Deals → `title`, `loan_amount`, `created_at`, `updated_at`. Lender Directory → `name`. Prefijo `-` para descendente; se pueden encadenar: `sort=-loan_amount,title`.

**Otros:**
- `fields=` — lista separada por comas (`id` siempre incluido; en documents, `vault` también).
- `include=` — sub-recursos embebidos. La referencia de Deals lista `financials`, `properties`, `team`, `pipelines`; la página de Filtering & Sorting solo lista `financials`, `properties` (ver §15). Evita N+1.

### Errores

```json
{
  "request_id": "...",
  "error": {
    "status": 404,
    "type": "not_found",
    "message": "Deal with id 999 not found",
    "details": {}
  }
}
```

Campos opcionales: `prerequisites` (acciones necesarias antes de que la request pueda tener éxito) y `upgrade_url` (cuando el error está gateado por tier).

| Código | `type` | Significado |
|---|---|---|
| 200 / 201 | — | OK / Created |
| 400 | `bad_request` | Body inválido, campos faltantes, query params malformados |
| 401 | `unauthorized` | Token faltante, inválido o expirado |
| 403 | `forbidden` | Token válido, permisos insuficientes |
| 404 | `not_found` | No existe **o** el usuario no tiene acceso |
| 409 | `conflict` | Conflicto de idempotencia (mismo key, body distinto) |
| 422 | `validation_error` | JSON válido pero semánticamente inválido (enum inválido, etc.) |
| 429 | `rate_limit_exceeded` | Rate limit |
| 500 | `internal_error` | Error inesperado |
| 503 | `service_unavailable` | Usado por los endpoints de `index/*` cuando el servicio de búsqueda está caído |

> **404 se devuelve tanto cuando el recurso no existe como cuando el usuario no tiene acceso** — deliberado, para no filtrar información sobre existencia de recursos.

### Idempotencia

```
Idempotency-Key: evt_8f3c2a91
```

Reusar el key con un body distinto:

```json
{
  "request_id": "req_9X1B7d",
  "error": "idempotency_key_reused",
  "existing_resource": "fact_44"
}
```

Expiry: 24 horas. Soportado en `POST /deals`, notes, y demás writes.

### Rate limits (REST)

Dos buckets por minuto en cada request autenticada:

| Tier API | Límite por cuenta | Límite por endpoint |
|---|---|---|
| `free` | 30 req/min | 10 req/min |
| `standard` | 100 req/min | 20 req/min |
| `enterprise` | 500 req/min | 60 req/min |

El bucket por cuenta es compartido entre todos los endpoints v2; el por-endpoint está keyed por cuenta+endpoint, así un endpoint ocupado no consume todo el presupuesto.

Tu tier y límites vivos: `GET /me` → `platform.api_tier` y `platform.rate_limits`.

Endpoints públicos sin auth:

| Endpoint | Límite |
|---|---|
| `POST /auth/validate-api-key` | 10 req/min |
| `GET /health` | 100 req/min |

Respuesta 429:

```json
{
  "request_id": "...",
  "error": {
    "status": 429,
    "type": "rate_limit_exceeded",
    "message": "Per-minute API rate limit reached. Contact help@lev.com if you need a higher tier.",
    "details": {},
    "limit_type": "requests_per_minute",
    "retry_after_seconds": 60
  }
}
```

### Health check

```bash
curl https://api.lev.com/api/external/v2/health
```

```json
{
  "request_id": "...",
  "timestamp": "2026-03-20T15:30:45Z",
  "data": { "status": "ok", "version": "2.0.0", "timestamp": "..." }
}
```

Sin auth. `data.version` reporta la versión del contrato (el `v2` de la URL). Distinto del `/health` del MCP server.

---

## 6. Mapa completo de endpoints

### Auth y API keys

```
POST   /auth/validate-api-key          (sin auth)  → { valid, user_id, account_id, scopes[], tier }
POST   /api-keys                       body: label*
GET    /api-keys                       query: limit, offset
DELETE /api-keys/{key_id}
GET    /health                         (sin auth)
```

### Deals

```
GET    /deals                          query: limit, cursor, offset, sort, fields, include,
                                              filter[loan_type], filter[transaction_type],
                                              filter[business_plan], filter[archived],
                                              filter[loan_amount][gte|lte],
                                              filter[created_at][gte|lte]
GET    /deals/{deal_id}                query: include, fields
POST   /deals                          body: title*, loan_amount, loan_type, transaction_type,
                                              business_plan, description, estimated_close_date,
                                              pipeline_ids[], deal_financials
PATCH  /deals/{deal_id}                partial update + deal_financials
DELETE /deals/{deal_id}                archive (soft-delete)

GET    /deals/{deal_id}/financials
GET    /deals/{deal_id}/properties
GET    /deals/{deal_id}/team
```

### Deal Index

```
POST   /deals/{deal_id}/index/search              body: context* (1-4000 chars), min_score (def 0.3),
                                                        limit (def 20, 1-200), include_signed_urls
POST   /deals/{deal_id}/index/observations        body: sot_id | metric_id (al menos uno), entity_ref,
                                                        page, limit, include_signed_urls
PATCH  /deals/{deal_id}/index/facts               body: sot_id*, y exactamente uno de value | observation_id
GET    /deals/{deal_id}/index/metric-definitions  query: metric_label, category_id, page, limit (def 100)
GET    /deals/{deal_id}/index/entities
POST   /deals/{deal_id}/index/facts               body: values*[] → { metric_id*, value*, entity_ref, group_ref }
```

### Documentos, vaults, checklists, memos

```
GET    /deals/{deal_id}/vaults
GET    /deals/{deal_id}/documents                 query: limit, cursor, search, extension,
                                                        folder_id, vault_id, fields
GET    /deals/{deal_id}/documents/{document_id}
GET    /deals/{deal_id}/documents/{document_id}/download   → link firmado de vida corta
GET    /deals/{deal_id}/checklists                query: vault_id
GET    /deals/{deal_id}/memos                     query: limit, offset, search, filter[title],
                                                        filter[status], filter[memo_type],
                                                        filter[pdf_ready], vault_id
GET    /deals/{deal_id}/memos/{memo_uuid}         query: quality (original|high|medium|low)

POST   /checklist-tasks                           body: title*, + uno de section_id | checklist_id
                                                        | parent_task_id, description, status,
                                                        assigned_user_id, due_date, document_type_ids[]
PATCH  /checklist-tasks/{task_id}
POST   /checklist-tasks/{task_id}/complete
```

### Notes (polimórfico)

```
GET|POST        /deals/{deal_id}/notes
PATCH|DELETE    /deals/{deal_id}/notes/{note_id}
GET|POST        /contacts/{contact_id}/notes
PATCH|DELETE    /contacts/{contact_id}/notes/{note_id}
GET|POST        /placements/{placement_id}/notes
PATCH|DELETE    /placements/{placement_id}/notes/{note_id}
GET|POST        /companies/{company_id}/notes
PATCH|DELETE    /companies/{company_id}/notes/{note_id}
GET|POST        /checklist-tasks/{task_id}/notes     ← comentarios del borrower portal
PATCH|DELETE    /checklist-tasks/{task_id}/notes/{note_id}
```

> Solo podés editar o borrar notas que vos creaste. El delete es **hard delete, sin undo**.

### Pipelines

```
GET    /pipelines
GET    /pipelines/{pipeline_id}
POST   /deals/{deal_id}/pipeline       body: pipeline_id*, pipeline_status_id
```

### Placements

```
GET    /placements                     query: limit, cursor
GET    /placements/{placement_id}
POST   /placements                     body: deal_id*, private_company_id*, contact_id, status,
                                             visibility, description, score, outreach_date, lender_status
PATCH  /placements/{placement_id}      (archivar con status="archived")
```

`deal_id`, `private_company_id` y `contact_id` quedan **bloqueados al crear**.

### CRM

```
GET    /contacts                       query: limit, cursor, fields
GET    /contacts/{contact_id}
POST   /contacts                       body: contact_type*, company_id*, first_name, last_name, email,
                                             title, department, address, address2, city, state, zip,
                                             linkedin_url, photo_url, phones[], is_primary
PATCH  /contacts/{contact_id}
POST   /contacts/{contact_id}/actions/unlock    ← consume créditos, requiere scope ai:actions

GET    /companies                      query: limit, cursor, fields
GET    /companies/{company_id}
POST   /companies                      body: name*, company_type*, website, address, city, state,
                                             zip, org_id, linkedin_url
PATCH  /companies/{company_id}
```

### Lenders y term sheets

```
GET    /lenders/directory              query: name, filter[state], sort, fields, limit, cursor
GET    /lenders/{org_id}               → perfil + programas embebidos
GET    /lenders/{org_id}/programs

GET    /deals/{deal_id}/term-sheets    query: limit, cursor
GET    /deals/{deal_id}/term-sheets/{term_sheet_id}
POST   /deals/{deal_id}/term-sheets    body: placement_id*, total_rate*, initial_funding*,
                                             quote_type*, rate_type*, + ~28 campos opcionales
PATCH  /deals/{deal_id}/term-sheets/{term_sheet_id}
DELETE /deals/{deal_id}/term-sheets/{term_sheet_id}   (soft delete)
```

Campos opcionales de term sheet: `title`, `winning`, `is_visible_to_borrower`, `base_rate`, `max_ltv`, `max_ltc`, `additional_funding`, `floor`, `floor_type`, `term`, `amortization`, `io_period`, `extension_one/two/three`, `recourse`, `recourse_type`, `prepayment_penalty`, `prepayment_penalty_details`, `min_dscr`, `min_debt_yield`, `origination_fee`, `extension_fee`, `exit_fee`, `good_faith_deposit`, `notes`, `ir_details`, `payment_method`, `capital_source_type`.

### Account, billing, market data

```
GET    /me                             → perfil, cuenta, platform (api_tier, rate_limits,
                                          granted_scopes, api_keys)
GET    /me/accounts
PATCH  /me/active-account              body: slug*
GET    /account/team

GET    /billing/summary
GET    /billing/credits/balance

GET    /market/base-rates              → SOFR, CMT, Prime, Treasury
GET    /market/asset-types
```

### Acción de IA (mencionada, sin página de referencia dedicada)

```
POST   /deals/{deal_id}/actions/search-lenders    ← requiere ai:actions, consume créditos
```

---

## 7. Deal Index — la pieza diferencial

Esto es lo que distingue a Lev de una API CRUD de CRM. **Index es una base de datos estructurada por deal** que organiza facts, métricas y detalles, y alimenta todos los documentos que se generan.

### El modelo de tres niveles

```
Metric Definition        "NOI", "Occupancy", "Purchase Price", …
        │                 (catálogo de lo que se puede registrar)
        ▼
   Observation           valor extraído de UN documento específico
        │                 (rent_roll.pdf dice NOI = $2.8M)
        │                 varias observations pueden competir por el mismo fact
        ▼
  Canonical Fact         el valor que Lev muestra, elegido por su lógica de promoción
   (sot_id)               "SOT" = source of truth
```

Cada fact tiene un `sot_id` prefijado — ej. `d:5362` (deal-level) o `a:123:property:690` (scopeado a una property). Cada observation tiene un `observation_id`.

### Los seis endpoints y para qué sirve cada uno

| Endpoint | Para qué |
|---|---|
| `POST /index/search` | Buscar facts canónicos por **contexto en lenguaje natural**. Devuelve valores rankeados con provenance. Es el retrieval semántico sobre el deal |
| `POST /index/observations` | Ver todos los valores candidatos extraídos por documento detrás de un fact. Para mostrar provenance o elegir entre candidatos |
| `PATCH /index/facts` | Cambiar el valor canónico. **Exactamente uno de:** `value` (reemplazo free-text) u `observation_id` (promover un valor extraído — *preserva la provenance*) |
| `GET /index/metric-definitions` | Descubrir qué se puede registrar. Cada definición trae un hint `suggested_write_via` |
| `GET /index/entities` | A qué entidades se pueden colgar facts (`deal`, `property:690`, sponsor) |
| `POST /index/facts` | Registrar valores provistos por el usuario. Si ya hay canónico, **agrega una observation de tipo user-input** y la lógica de promoción decide qué se muestra |

**Distinción operativa clave:**

- `record_deal_facts` / `POST /index/facts` → *agregar* un valor. La promoción decide.
- `update_deal_index_fact` / `PATCH /index/facts` → *corregir* un valor específico. Fuerza el canónico.

La editabilidad se valida server-side: métricas no editables devuelven un error claro.

### Por qué importa para construir

1. **Es el retrieval layer que no tenés que construir.** `POST /index/search` con `context` en lenguaje natural devuelve facts rankeados con la fuente. No necesitás tu propio pipeline de embeddings sobre los documentos del deal.
2. **La provenance es de primera clase.** `include_signed_urls: true` devuelve URLs firmadas de vida corta para inspeccionar el documento fuente. Cualquier cifra que muestres downstream puede citar su origen.
3. **Auto-actualización.** Según el changelog, Index refresca valores extraídos automáticamente al subir documentos nuevos.
4. **Es lo que alimenta a Memo.** Los deal books generados salen de Index. Si escribís facts correctos, los documentos salen correctos.

**Extracción de documentos:** el changelog y la doc de Learn describen que subir documentos dispara extracción automática a campos de Index. Las líneas de pricing incluyen `DOC-{S,M,L,XL}-{TEXT,TABLE}` por extracción, y `FIL-046` (extract data from documents, per field) — o sea que el costo escala con tamaño de documento y tipo de contenido.

---

## 8. MCP: arquitectura, auth y catálogo de tools

### Instalación por cliente

**Claude Desktop / claude.ai** — Settings → Connectors → **+** → Lev → Connect. (En Team/Enterprise puede aparecer **Request**, que pide aprobación al owner del workspace.) También listado en el directorio de conectores de Claude.

**Claude Code:**

```bash
claude mcp add --transport http \
  --client-id FPVfGZHwa9wvqhLwmXiaZyJPEjnaVAZB \
  --callback-port 9876 \
  --scope user \
  Lev https://mcp.lev.com/mcp

claude /mcp   # para autenticar
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "Lev": {
      "url": "https://mcp.lev.com/mcp",
      "auth": {
        "CLIENT_ID": "FPVfGZHwa9wvqhLwmXiaZyJPEjnaVAZB",
        "scopes": ["openid", "email"]
      }
    }
  }
}
```

**VS Code** (`mcp.json`):

```json
{
  "servers": {
    "Lev": { "type": "http", "url": "https://mcp.lev.com/mcp" }
  }
}
```

### Flujo OAuth

1. La primera tool call dispara OAuth 2.0 authorization-code con PKCE.
2. El cliente descubre metadata en `<mcp-server-url>/.well-known/oauth-authorization-server` (authorize, token, JWKS).
3. Se abre el browser en la login page hosteada de Auth0.
4. Auth0 redirige con un authorization code; el cliente lo canjea por un access token RS256 + refresh token.
5. Cada request lleva `Authorization: Bearer <jwt>`; el server valida firma, expiry, audience e issuer contra el JWKS.
6. Refresh silencioso al expirar. **Nunca seteás el header a mano.**

**Scopes que el server pide a Auth0:** solo `openid` y `email`. Eso identifica al usuario y lo correlaciona con su registro Lev. **Los permisos reales vienen de la cuenta Lev** — el MCP server nunca eleva privilegios, y no cachea decisiones de autorización (un cambio de rol aplica en la siguiente tool call).

**Headers que el MCP manda upstream:** `Authorization`, `X-Origin-App: mcp`, `X-Request-Id` (por tool call), `Content-Type`. **No manda `X-Active-Account`** — `switch_account` persiste la preferencia vía `PATCH /me/active-account`.

**Provisioning programático:** existe un flujo para provisionar acceso MCP server-side sin OAuth interactivo, pero **no es parte de la superficie pública** ni funciona con API keys/JWT estándar. Hay que hablar con Lev — revisan modelo de deployment, scoping de cuenta, permisos, auditoría y rotación de keys.

### Validar la conexión (3 checks)

1. *"Use the Lev MCP server to get my profile"* → debe llamar `get_my_profile` y devolver email, user ID y cuentas disponibles.
2. *"List my first five deals in Lev"* → `list_deals` con `limit=5`, datos reales.
3. Pedir el catálogo de tools → deben aparecer los grupos core.

### Catálogo: 60 tools en 13 grupos

Convención: **R** = read (seguro repetir), **W** = write (debe ir tras confirmación humana). Los enums van lowercase; el server normaliza pero conviene prompt-earlos en minúscula.

#### Deals

| Tool | R/W | Nota |
|---|---|---|
| `list_deals` | R | filtros: loan_type, transaction_type, business_plan, min/max_loan_amount, archived |
| `get_deal` | R | includes: financials, properties, team; reporta estado `archived` |
| `show_deal` | R | card interactiva en hosts MCP Apps; texto compacto en el resto |
| `summarize_deal` | R | prosa en 3 niveles (`brief`/`standard`/`memo`). Consolida get_deal + search_deal_index + list_term_sheets + list_placements. **Las afirmaciones cuantitativas citan su documento fuente** |
| `create_deal` | W | requiere `title` |
| `update_deal` | W | campos + financials canónicos |
| `delete_deal` | W | soft delete |
| `move_deal_to_pipeline_status` | W | deal_id, pipeline_id, pipeline_status_id |

**Cuándo usar cuál:** `show_deal` para "mostrame / abrí el deal" · `summarize_deal` para narrativa · `get_deal` para campos CRM crudos · `search_deal_index` para una métrica puntual o su fuente.

#### Deal Index

| Tool | R/W |
|---|---|
| `search_deal_index` | R |
| `list_deal_index_observations` | R |
| `update_deal_index_fact` | W |
| `list_deal_index_metric_definitions` | R |
| `record_deal_facts` | W |

#### Documentos y vaults

| Tool | R/W | Nota |
|---|---|---|
| `list_deal_vaults` | R | contenedores, no archivos |
| `list_deal_documents` | R | metadata, **sin download links** |
| `get_deal_document` | R | incluye link de descarga de vida corta |
| `browse_deal_vaults` | R | browser interactivo (MCP App) |
| `list_deal_memos` | R | published + draft, filtros por status/type/pdf_ready |
| `get_deal_memo` | R | con link a PDF; drafts sin renderizar tienen `pdf_ready: false` |

> Ante un pedido amplio tipo "qué documentos tiene este deal", conviene llamar `list_deal_documents` **y** `list_deal_memos` para que aparezcan juntos archivos subidos y deal books generados.

#### Checklists

`get_deal_checklist` (R) · `create_checklist_task` (W) · `update_checklist_task` (W) · `complete_checklist_task` (W)

> `complete_checklist_task` además **aprueba los archivos ya adjuntos**. Reabrir con `update_checklist_task(is_completed=false)`.

#### Contacts / Companies / Notes

`list_contacts`, `get_contact`, `create_contact`, `update_contact`, **`unlock_contact`** (W, ~200 créditos) · `list_companies`, `get_company`, `create_company`, `update_company` · `list_notes`, `create_note`, `update_note`, `delete_note`.

#### Lenders

| Tool | R/W | Nota |
|---|---|---|
| `get_lender` | R | por `lender_id`, opcional `include_programs` |
| `recommend_lenders_for_deal` | W | **~2.000 créditos.** Corre en background. Requiere property geocodificada y loan expectations seteadas. Llamado sin confirmación, previsualiza el costo y no cobra |
| `get_lender_recommendations` | R | ranked, paginado (limit def 10, cap 25). Cada resultado: `org_id`, `ai_score`, reasoning, loan programs |

**Flujo completo de matching:** `recommend_lenders_for_deal` → `get_lender_recommendations` → materializar con `create_company` (pasar `organization_name` como `name`, `company_type: lender`, y el `org_id`) → abrir outreach con `create_placement`.

#### Placements / Pipelines / Term Sheets

`list_placements`, `get_placement`, `create_placement`, `update_placement` · `list_pipelines`, `summarize_pipeline` (agrega stages, conteos, totales de loan, deals destacados: los más atascados y los que cierran pronto) · `list_term_sheets`, `get_term_sheet`, `summarize_term_sheets` (calcula el líder por tasa más baja y por costo all-in más bajo), `create_term_sheet`, `update_term_sheet`, `delete_term_sheet`.

> Para leer el pipeline actual de un deal: `get_deal` con `include=pipelines` (es el default).

#### Market Data / Account / Billing

`get_base_rates` (R, cache ~30 min) · `get_asset_types` (R) · `get_my_profile` (R, **llamala primero para confirmar la conexión**) · `list_team_members` · `list_available_accounts` · `switch_account` (W, fuzzy match por nombre o slug) · `get_my_billing_summary` (R, **usala antes de workflows que consumen créditos**).

#### MCP Apps helpers (app-only)

`read_memo_pdf_bytes`, `read_deal_document_bytes` — el modelo **no** debe llamarlas directo.

### Formas de respuesta

```jsonc
// List tools
{ "deals": [...], "total": 237, "showing": 20, "has_more": true }

// Detail tools
{ "deal": { "id": 101, "title": "...", "loan_amount": 12500000 } }

// Write tools
{ "message": "Deal created successfully", "deal": { "id": 103, "title": "..." } }
```

### Errores del MCP

Los errores vuelven como **strings planos, nunca como excepciones**. Internamente el server mapea: 400/422 → validation, 401 → authentication, 403 → forbidden, 404 → not found, 429 → rate limited, 5xx → server error; cada uno con un prefijo legible.

```
Validation failed: loan_amount must be greater than 0
Deal not found: 101
Unauthorized: your session has expired. Please sign in again.
Upstream service is temporarily unavailable. Please retry in a few seconds.
```

Es deliberado: el modelo puede repetirle el mensaje al usuario sin parsear un envelope.

### Límites del MCP

| Dimensión | Límite |
|---|---|
| Global | 100 requests/minuto por sesión |
| Por tool | 20 requests/tool/minuto |
| Concurrencia | 10 requests in-flight |

### Circuit breaker

- **Threshold:** 5 respuestas 5xx consecutivas del upstream abren el breaker.
- **Cooldown:** 30 segundos en OPEN; toda tool call devuelve *"Upstream service is temporarily unavailable"*.
- **Recovery:** pasa a HALF_OPEN y deja pasar una sonda. Respuesta limpia → cierra. Otra falla → reabre.
- **429 no dispara el breaker** — los rate limits son esperables, no outages.

Health del MCP:

```bash
curl https://mcp.lev.com/health
```

```json
{ "status": "ok", "version": "0.1.0", "lev_api": "reachable", "circuit_breaker": "closed" }
```

`circuit_breaker`: `closed` | `open` | `half_open`. `lev_api`: `reachable` | `degraded`.

### Tracing

Cada tool call reenvía un `X-Request-Id` UUID a lev-backend. **No se expone al output del LLM** (deliberado: agrega tokens sin ayudar al razonamiento). Para debuggear: anotá tool name + timestamp y contactá soporte.

### Hueco conocido

**No hay tool de búsqueda directory-wide de lenders en MCP.** El descubrimiento de lenders es deal-scoped (`recommend_lenders_for_deal`). Si ya conocés el `lender_id`, usá `get_lender`. La búsqueda global sí existe en REST (`GET /lenders/directory`).

### MCP Apps

Widgets visuales que acompañan el resultado de la tool en clientes compatibles. Los clientes que no los renderizan reciben igual el resultado subyacente — **la app no reemplaza el contrato de la tool**.

El app estrella es `browse_deal_vaults`: agrupa Resources primero, después los Deal Rooms compartidos con tiles de monograma. Imágenes y PDFs previsualizables abren dentro de la vista. Los memos draft van a un estado de detalle que explica que todavía no hay PDF.

---

## 9. CLI

```bash
pipx install lev-cli        # requiere Python 3.13+
lev --version
lev auth login              # pide la API key; se guarda en el keychain del SO
lev auth status
lev deals list              # tabla formateada en terminal interactiva
lev deals list -o json | jq '.data[0].title'
```

**Detalle clave:** al pipear, el CLI **auto-cambia a JSON**, lo que lo hace directamente parseable por un agente de código con acceso a shell. Ese es el caso de uso que Lev tiene en mente.

Hay instaladores alternativos (Homebrew, binarios standalone, Windows) documentados en CLI Setup.

> ⚠️ La página de producto marca el CLI como **"coming soon"**, pero la doc de build tiene instalación completa y comandos. Ver §15.

---

## 10. Patrones de agentes

### Principios de diseño (textual de la doc)

- **Retrieve before acting.** Traé deals, placements, term sheets y contexto de cuenta *antes* de que el modelo recomiende algo.
- **Keep tools narrow.** Lecturas chicas y acciones explícitas, en vez de un prompt gigante que le pide al modelo inferir estado faltante.
- **Make handoffs visible.** Cuando el agente quiere mutar datos o mandar un mensaje, mostrá el razonamiento exacto y los records fuente primero.
- **Use resource pages as contracts.** Atá las instrucciones del prompt a los schemas y constraints de las páginas de referencia.

### El flujo canónico de 5 pasos

| # | Paso | Resultado esperado |
|---|---|---|
| 1 | **Identificar contexto** | El agente sabe de qué deal, cuenta o lender se está hablando |
| 2 | **Traer records primarios** | El mínimo grounding necesario, nada más |
| 3 | **Resumir con citas** | El usuario ve los facts sobre los que razona el modelo antes de que algo se mueva |
| 4 | **Pedir confirmación** | Ningún write ni acción externa sin aprobación explícita |
| 5 | **Ejecutar y loguear** | La acción corrió, y tenés un `request_id` para trazarla |

### Prompt pattern de referencia

```
You are helping a broker evaluate a deal.

1. Read the deal, deal financials, placements, and term sheets.
2. Summarize the facts you found.
3. Recommend the next action only if the records are sufficient.
4. If data is missing, say exactly what to fetch next.
```

### Filosofía, en sus palabras

> *"Un agente que expone sus records recuperados, su próxima acción y el payload exacto del write es más útil que un agente que intenta sentirse mágico."*

Checkpoints de review recomendados:
- Antes de crear o actualizar placements.
- Antes de resumir o comparar term sheets para compartir externamente.
- Antes de cualquier comunicación saliente a un lender disparada por un agente.

### Receta: Broker Copilot

El copilot mínimo útil responde tres preguntas: **¿en qué estado está el deal? ¿qué se mandó o discutió ya? ¿qué debería hacer el broker ahora?**

Bloques:
- **Records primarios:** deals, financials, properties, placements, term sheets, contexto de cuenta/team.
- **Workflow AI-native:** MCP para tooling interactivo, o un orquestador server-side que llame la API determinísticamente.
- **Decision layer:** que el modelo resuma trade-offs, pero writes y acciones salientes detrás de aprobación explícita.
- **Review layer:** mostrar los records recuperados y la acción propuesta exacta antes de confirmar.

Secuencia de tools: deal + financials → placements + term sheets → resumen + próxima acción → si hay write, mostrar el cambio exacto y pedir confirmación.

### Patrones de data sync

**Tres modos:**
- **Backfill** — cursor pagination para caminar el dataset completo determinísticamente.
- **Incremental** — filtros tipo `updated_at` + checkpoints guardados.
- **On-demand refresh** — lecturas específicas cuando el usuario abre una vista de detalle.

**Backfill (TypeScript):**

```typescript
let cursor: string | null = null

while (true) {
  const url = new URL("https://api.lev.com/api/external/v2/deals")
  url.searchParams.set("limit", "100")
  if (cursor) url.searchParams.set("cursor", cursor)

  const response = await fetch(url, {
    headers: {
      Authorization: "Bearer YOUR_API_KEY",
      "X-Origin-App": "warehouse-sync",
    },
  })

  const payload = await response.json()
  await writeBatch(payload.data)

  if (!payload.pagination?.has_more) break
  cursor = payload.pagination.next_cursor
}
```

**Incremental:** guardá el timestamp de la última corrida exitosa, releé una ventana de solapamiento chica para tolerar clock skew y writes demorados, y deduplicá en destino por resource ID.

**Checklist operativo:**
- Monitoreá `request_id` de los batches fallidos.
- Alertá sobre 401/403/429 repetidos.
- Mantené los writes idempotentes en destino para poder reproducir un batch.
- Versioná el schema de destino deliberadamente, los campos de Lev van a crecer.

> Offset pagination es para browsing ordenado, **no** para bulk sync durable.

### Chaining con otras herramientas

El cookbook de MCP asume que el asistente tiene además Gmail/Outlook, Drive/OneDrive, Excel/Sheets, Calendar, Slack, Zoom, Salesforce/HubSpot, DocuSign, Box/Dropbox. Ejemplos:

- *"Llegaron term sheets revisados por mail anoche — leelos y actualizá el quote de cada deal en Lev."*
- *"Usá el transcript de mi Zoom con el sponsor para crear el deal en Lev — property, loan request y asset type."*
- *"Todos los días hábiles a las 18h, corré una rutina de follow-up: agarrá mis grabaciones de Zoom, traé el contexto del deal de Lev, guardá los resúmenes en Notion, y redactá los mails de follow-up."*

También se puede arrastrar un PDF o spreadsheet directo al chat y pedir que construya el deal desde el archivo (debt financing summary, proforma, rent roll, OM).

---

## 11. Créditos y facturación

### Planes (agosto 2026, facturación anual)

| Plan | Precio/mes | Créditos/mes | $/crédito |
|---|---|---|---|
| Lev Core | $80 | 2.500 | $0,032 |
| Lev Select | $200 | 8.500 | $0,024 |
| Lev Pro | $400 | (no publicado en la tabla) | $0,016 |
| Enterprise | Custom | Custom | Volume pricing |

Todos los planes incluyen **todas** las features de la plataforma — solo cambia el volumen de créditos y el precio unitario. Rollover mensual incluido (solo en anual). Pool de créditos compartido por equipo.

Promo vigente: 3.000 créditos + Lev Agent ilimitado durante agosto.

### Costos por acción (los que la doc expone concretamente)

| Acción | Costo | Dónde está documentado |
|---|---|---|
| AI lender match (`recommend_lenders_for_deal`) | **~2.000 créditos** | MCP Tools |
| Unlock contact (`unlock_contact`) | **~200 créditos** | MCP Tools |
| "Lev Credits Consumed" (per action) | **300** | Tabla de pricing, sección Origination |

La página de pricing docs lista ~25 line items (IDs `DAT-*`, `DOC-*`, `DRC-*`, `FIL-*`, `MKT-*`, `SCH-*`, `OUT-*`, `INVOICE-IB`, `Exports`) pero **casi todos figuran en 0 créditos** al momento del relevamiento. Ver §15.

Equivalencias que publica la página de pricing comercial (Core / Select / Pro):
- AI lender searches: 1 / 4 / 12
- Offering Memos: ~5 / ~17 / ~50
- Marketing Status Reports: 3 / 13 / 38
- Contact enrichments: 312 / 1.062 / 3.125

### Guardrails de crédito en el diseño de tools

Esto está codificado en el comportamiento de las tools MCP, no solo en la doc:

1. Las tools que cobran **exigen que el agente confirme el costo con el usuario primero**.
2. Llamadas sin confirmación **previsualizan el costo y no cobran nada**.
3. `unlock_contact` es **idempotente** — re-correrla sobre un contacto ya desbloqueado lo devuelve sin segundo cargo.
4. `get_my_billing_summary` / `GET /billing/credits/balance` existen para chequear saldo *antes* de workflows caros.
5. El scope `ai:actions` es la puerta única: sin él, ninguna acción cobrable es alcanzable. Una key `read_only` no puede gastar créditos.

**Si construís sobre esto:** replicá el patrón. Chequeá balance → previsualizá costo → pedí confirmación → ejecutá.

---

## 12. Seguridad y compliance

| Área | Detalle |
|---|---|
| **Controles operativos** | SOC 2 Type II · pentest más reciente Q2 2025 · lista pública de subprocesadores |
| **Identidad y acceso** | SSO/SAML · RBAC · audit logs |
| **Protección de datos** | AES-256 en reposo, TLS 1.2+ en tránsito · **sin entrenamiento sobre datos del cliente, nunca** · residencia de datos en USA |
| **Modelo de permisos** | Ni API keys ni JWT pueden acceder a datos que el usuario subyacente no ve en la app. El MCP nunca eleva privilegios |
| **No leakage** | 404 uniforme para "no existe" y "no tenés acceso" |

Recursos: `/docs/learn/security`, `/docs/learn/compliance`, `/docs/learn/ai-data-handling`, `/docs/learn/subprocessors`, `/docs/learn/data-retention`, `/docs/learn/trust`.

---

## 13. Recursos machine-readable

Esto merece atención aparte: Lev diseñó su documentación para ser consumida por agentes.

| Recurso | Qué es |
|---|---|
| `https://www.lev.com/docs/llms.txt` | Índice compacto del corpus + **instrucciones para agentes LLM** + referencia de endpoints por sección |
| `https://www.lev.com/docs/llms-full.txt` | Todas las páginas concatenadas como markdown limpio — para un drop de contexto de una sola vez |
| `https://www.lev.com/docs/llms-faq.txt` | Todas las Q&A del FAQ de producto |
| `https://www.lev.com/docs/openapi.json` | Spec OpenAPI 3.1 — para code generation o poblar Postman |
| `https://www.lev.com/docs/content-index.json` | Chunks a nivel sección con intents y keywords, para retrieval |
| `<cualquier ruta>.md` | Markdown limpio por página, ej. `https://www.lev.com/docs/build/deals.md` |

Además cada página tiene botones "Copy as Markdown", "Open in Claude" y "Open in ChatGPT".

**Instrucciones que le dan a los agentes** (textual de `llms.txt`):

> *"When generating code: always use cursor pagination for bulk sync, use `fields` param to minimize payloads, use `include` to avoid N+1 requests, and handle 429 with exponential backoff."*

**Aprovechalo:** si vas a construir, el primer paso más eficiente es tirarle `llms-full.txt` a un modelo, o generar un cliente desde `openapi.json`.

---

## 14. Rutas de construcción

Lev enmarca la decisión como tres niveles de leverage:

| # | Enfoque | Leverage | Techo | Timeline |
|---|---|---|---|---|
| 01 | **Build from scratch** — data model, workflow logic, permisos, UI propios | El más bajo | El más bajo | Meses de trabajo de plataforma |
| 02 | **Build on foundation models** — IA genérica + workflow logic CRE + evals + guardrails + UX | Moderado | Alto | Semanas a prototipos útiles |
| 03 | **Build on Lev** — data CRE, workflow intelligence, agentes y superficies desde el día uno | El más alto | El más alto | Minutos a workflows vivos |

### Tres formas de usar la plataforma

**A. Usar las apps** — agregar una capability de Lev al workflow existente sin cambiar el sistema de registro. 50+ plugins disponibles independientemente. Corre igual sobre la data, permisos y workflow layer de Lev, así que se puede expandir después sin empezar de nuevo.

**B. Integrar en otros sistemas** — REST API y MCP exponen data CRE, workflow tools y primitivas de automatización a tus propios productos. Claude, Cursor, Windsurf y clientes internos trabajan contra las mismas capabilities. Lev declara **148 capabilities en 20 dominios**.

**C. Construir sobre las APIs con FDEs** — Forward-Deployed Engineers de Lev mapean el workflow real (decisiones, handoffs, excepciones), construyen el agente sobre la plataforma, y lo ponen en producción. Claim: **de sesión de scoping a agente en producción en menos de 7 días, sin requerir recursos de dev de tu lado.**

### Ruta sugerida dado que arrancás sin cuenta

```
1. Crear cuenta gratis en lev.com (promo: 3.000 créditos + Agent ilimitado en agosto)
2. Conectar el MCP a Claude Desktop  →  validar con get_my_profile + list_deals
3. Recorrer el cookbook con un deal de prueba  →  entender el modelo de datos desde el uso
4. Generar una API key read-only  →  primer GET /deals con curl
5. Generar el cliente desde openapi.json  →  primer script de sync
6. Recién ahí decidir qué construir encima
```

El paso 3 es el que más rinde: el cookbook está escrito como prompts listos para pegar, y usar el sistema desde el chat te enseña el modelo de datos más rápido que leer los schemas.

---

## 15. Huecos, discrepancias y preguntas abiertas

Cosas que noté al cruzar fuentes. Vale confirmarlas con Lev antes de apoyarse en ellas.

| # | Tema | Detalle |
|---|---|---|
| 1 | **Rate limits contradictorios** | `llms.txt` dice "200 req/min reads, 30 req/min writes, 10 req/min auth validation". La página Rate Limits dice buckets por tier: 30/100/500 por cuenta y 10/20/60 por endpoint. **Son modelos distintos.** La página dedicada está actualizada a junio 2026 y es más específica — probablemente sea la vigente, pero conviene verificar con `GET /me` → `platform.rate_limits` |
| 2 | **Tabla de créditos en 0** | La página de pricing docs (actualizada abril 2026) lista ~25 line items casi todos en **0 créditos**, mientras las tools MCP declaran 2.000 y 200 créditos para lender match y unlock contact. La tabla parece estar sin poblar o reflejar un período promocional |
| 3 | **CLI: "coming soon" vs. documentado** | La página de producto dice coming soon; la doc de build tiene `pipx install lev-cli`, comandos y flags completos. Puede ser beta privada o la página de producto quedó desactualizada |
| 4 | **Endpoint MCP: `/mcp` vs `/sse`** | La página de producto muestra `mcp.lev.com/sse`; la doc técnica dice explícitamente "no stdio, no SSE" y usa `https://mcp.lev.com/mcp` |
| 5 | **`show_deal` duplicado** | Aparece dos veces en la tabla de Deals del catálogo de tools, con descripciones ligeramente distintas. Probable error de la doc — no dos tools |
| 6 | **Créditos de Lev Pro** | La tabla comparativa de pricing no muestra el número de créditos mensuales de Pro (sí muestra $0,016/crédito, lo que implicaría 25.000/mes a $400 — **esto es inferencia mía, no dato publicado**) |
| 7 | **`POST /deals/{id}/actions/search-lenders`** | Mencionado en la doc de Authentication como ejemplo de `ai:actions`, pero no tiene página de referencia propia ni aparece en la lista de endpoints de `llms.txt`. Es el equivalente REST de `recommend_lenders_for_deal` |
| 8 | **Sin webhooks documentados** | Los keywords de la doc mencionan "webhooks" pero no hay página ni endpoints. El patrón de sync es polling con cursor + `updated_at`. Si necesitás push, hay que preguntar |
| 9 | **`filter[updated_at]` inconsistente** | La página Filtering & Sorting **sí** lista `updated_at` como filtrable en Deals, pero la referencia de `GET /deals` y `llms.txt` solo enumeran `filter[created_at][gte\|lte]`. Como el sync incremental depende de esto, conviene probarlo antes de diseñar el pipeline |
| 9b | **`include` inconsistente** | La referencia de Deals lista 4 includes (`financials`, `properties`, `team`, `pipelines`); Filtering & Sorting lista solo 2. Probablemente esta última quedó desactualizada (marzo vs. junio 2026) |
| 10 | **Sin SDKs oficiales** | No hay librerías cliente publicadas. El camino es generar desde `openapi.json` |
| 11 | **Sin ambientes de sandbox** | La sección "Environments" de MCP Setup está vacía en el render. No hay mención de un ambiente de test separado — presumiblemente se trabaja contra producción con datos de prueba |
| 12 | **Quickstart con typo** | El Quickstart muestra `GET /api/external/v2/build/deals?limit=5` — el `build/` sobra, el path correcto es `/api/external/v2/deals` |

---

## 16. Fuentes

**Sitio de producto**
- https://www.lev.com/ · /products · /platform · /pricing · /about
- /products/lev-agent · /products/lev-api · /products/lev-mcp

**Docs — Build**
- /docs/build · /docs/build/api-overview · /docs/build/getting-started
- /docs/build/authentication · /docs/build/api-keys · /docs/build/account
- /docs/build/pagination · /docs/build/filtering-sorting · /docs/build/errors · /docs/build/rate-limits
- /docs/build/deals · /docs/build/lender-search
- /docs/build/agent-workflows · /docs/build/broker-copilot · /docs/build/data-sync-patterns
- /docs/build/mcp/overview · /docs/build/mcp/setup · /docs/build/mcp/tools
- /docs/build/mcp/auth · /docs/build/mcp/errors-limits · /docs/build/mcp/apps · /docs/build/mcp/cookbook

**Docs — Learn**
- /docs/learn/pricing

**Machine-readable**
- /docs/llms.txt

*Relevado el 5 de agosto de 2026. Las páginas de docs declaran fechas de actualización entre marzo y julio de 2026.*

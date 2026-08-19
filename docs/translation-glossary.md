# Translation glossary

The project was written in Spanish and is being moved to English. This file
records the naming decisions so they do not drift across the 54 source files,
and so the non-obvious ones can be argued with.

It is a migration artefact. Once the move is finished and nothing reads it, it
can be deleted.

## Why some names are not the literal translation

Three cases where the direct translation is the wrong choice:

- **`Respuesta` → `CompsResponse`, not `Response`.** `Response` is a global in
  Node 18+ and in the DOM. Shadowing it in a file that also does HTTP is the
  kind of name collision that compiles fine and confuses everyone reading it.
- **`MetricaSpec` → `CohortMetric`, not `MetricSpec`.** `MetricSpec` already
  exists in `harvest/normalize/columnMap.ts` and means something different: the
  column-mapping spec, not a benchmark metric. Two unrelated types with one name
  is how you get an import from the wrong module.
- **`EstadoCorpus` → `CorpusState`, and `estado` in the geographic sense stays
  `state`.** Spanish `estado` carries both meanings — "status" and "US state" —
  and they are all over this codebase. Every occurrence had to be read for which
  one it was; they are not interchangeable in English.

## Types and interfaces

| Spanish | English | Where |
|---|---|---|
| `Alcance` | `Scope` | `api/comps.ts` — how wide the geographic search went |
| `Aparte` | `Apart` | `db/compositionDistance.ts` |
| `Composicion` | `Composition` | `db/cohortBenchmark.ts` |
| `Criterios` | `Criteria` | `api/comps.ts` |
| `Distribucion` | `Distribution` | `api/comps.ts` |
| `Emision` | `Issuance` | `db/cohortBenchmark.ts` |
| `EstadoCorpus` | `CorpusState` | `db/procedencia.ts` |
| `MetricaResultado` | `CohortMetricResult` | `db/cohortBenchmark.ts` |
| `MetricaSpec` | `CohortMetric` | `db/cohortBenchmark.ts` |
| `Peldano` | `Rung` | `api/comps.ts` — one step of the geographic ladder |
| `Respuesta` | `CompsResponse` | `api/comps.ts` |
| `Tipo` | `PropertyType` | `api/comps.ts` |

## Constants

| Spanish | English |
|---|---|
| `BANDA_DEFECTO` | `DEFAULT_BAND` |
| `CODIGOS` | `STATE_CODES` |
| `CONCENTRACION_TIPO` | `TYPE_CONCENTRATION` |
| `DIVISIONES` | `DIVISIONS` |
| `MESES_DEFECTO` | `DEFAULT_MONTHS` |
| `METRICAS` | `COHORT_METRICS` |
| `MIN_PARA_METRICA` | `MIN_PER_METRIC` |
| `MIN_PARES` | `MIN_PAIRS` |
| `SEMILLA` | `SEED` |
| `SIMULACIONES` | `SIMULATIONS` |
| `TIPOS` | `PROPERTY_TYPES` |
| `UMBRALES` | `THRESHOLDS` |

## Functions

| Spanish | English |
|---|---|
| `aparte` | `apart` |
| `avisosDeCaducidad` | `stalenessWarnings` |
| `buscarComparables` | `findComparables` |
| `calcularBenchmark` | `computeBenchmark` |
| `cargarCandidatas` | `loadCandidates` |
| `casoSql` | `sqlCase` |
| `divisionDe` | `divisionOf` |
| `estadoCorpus` | `corpusState` |
| `estampa` | `provenanceStamp` |
| `indiceEdgar` | `edgarIndexUrl` |
| `normalizarEstado` | `normalizeState` |
| `sinReferencia` | `metricsWithoutBaseline` |
| `tv` | `totalVariation` |

`pct`, `rng`, `esc` and `query` are already English abbreviations and stay.

## Recurring local names

These appear as local variables in dozens of files. Listed so the same word does
not get three translations.

| Spanish | English |
|---|---|
| `alcance` | `scope` |
| `banda` | `band` |
| `carteras` | `portfolios` |
| `ciega` / `ciegos` | `blind` |
| `consulta` | `query` |
| `criterios` | `criteria` |
| `datos` | `data` |
| `emisiones` | `issuances` |
| `encontrados` | `found` |
| `escalera` | `ladder` |
| `estado` (geographic) | `state` |
| `estado` (status) | `status` |
| `filas` | `rows` |
| `mejor` | `best` |
| `meses` | `months` |
| `monto` | `amount` |
| `objetivo` | `target` |
| `peldanos` | `rungs` |
| `prestamos` | `loans` |
| `propiedades` | `properties` |
| `resultado` | `result` |
| `respuesta` | `response` |
| `suficiente` | `sufficient` |
| `tiradas` | `discarded` |
| `vacios` | `empty` |

## Files renamed

| Spanish | English |
|---|---|
| `api/casos.ts` | `api/scenarios.ts` |
| `api/casos.html` | `api/scenarios.html` |
| `db/fixEstados.ts` | `db/fixStates.ts` |
| `db/procedencia.ts` | `db/provenance.ts` |
| `db/procedenciaCli.ts` | `db/provenanceCli.ts` |
| `db/sinEstado.ts` | `db/missingState.ts` |
| `harvest/normalize/estados.ts` | `harvest/normalize/states.ts` |

`api/comps.ts` keeps its name — "comps" is the industry term in English too.

## npm scripts renamed

| Before | After |
|---|---|
| `db:fix-estados` | `db:fix-states` |
| `db:sin-estado` | `db:missing-state` |
| `db:procedencia` | `db:provenance` |
| `api:casos` | `api:scenarios` |

## Routes renamed

`/casos` becomes `/scenarios`. It has no external consumers — the only caller is
the link in `api/ui.html`.

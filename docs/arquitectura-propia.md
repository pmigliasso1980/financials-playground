# Construir nuestra propia API CRE

> Punto de partida: todo lo aprendido de Lev + el mock funcionando.
> Este documento es para decidir, no para implementar. Las decisiones marcadas
> **⟶ tuya** requieren que elijas antes de que escriba código.

---

## 1. Lo que ya tenemos

El "mock" no es descartable. Es un servidor que ya implementa:

| Pieza | Estado | Reusable |
|---|---|---|
| Contrato HTTP (envelope, errores, request_id) | Funcionando | Sí, tal cual |
| Paginación cursor + offset | Funcionando | Sí, tal cual |
| Filtros con operadores, sparse fieldsets, includes | Funcionando | Sí, tal cual |
| Auth con API keys + scopes granulares | Funcionando | Base sólida |
| Rate limiting por dos buckets | Funcionando | Sí, tal cual |
| Idempotencia con expiry | Funcionando | Sí, tal cual |
| Ledger de créditos con preview | Funcionando | Base sólida |
| **Deal Index de tres niveles** | Funcionando | **Sí — es lo más valioso** |
| Modelo de datos CRE completo | Funcionando | Sí, como schema |
| Capa de IA con fallback | Funcionando | Sí |

**Lo que le falta para ser una API real:**

- Persistencia. Hoy todo vive en memoria y se pierde al reiniciar.
- Ingesta real de documentos. Hoy el texto extraído está sembrado a mano.
- Multi-tenancy de verdad (hoy hay dos cuentas hardcodeadas).
- Auth de producción: hashing de keys, rotación, OAuth si hace falta.
- Migraciones, observabilidad, deploy.

Eso es trabajo conocido, no investigación. Lo difícil está en otro lado.

---

## 2. Lo difícil de verdad

Acá conviene ser honesto sobre qué hace fuerte a Lev, porque define si hay
espacio o no.

### 2.1 El moat que no podemos copiar

**7.000+ lenders con programas, apetito, contactos y actividad reciente.**

Ese dataset es el activo central de Lev y no se construye escribiendo código.
Se construye con años de operar un brokerage, o comprando datos, o scrapeando
—con los problemas legales que eso trae.

Sin datos de lenders, un "lender match" no tiene nada que matchear. Es la
diferencia entre nuestro mock (12 lenders inventados) y su producto.

**Implicancia:** cualquier plan que dependa de competir en *lender matching*
arranca perdiendo. Si vamos por ahí, hay que resolver primero de dónde salen
los datos.

### 2.2 Lo caro pero factible

**Extracción de documentos.** Convertir un rent roll en XLSX, un T-12 en PDF
escaneado o un OM de 80 páginas en observations estructuradas con provenance.

Lev cobra por tamaño y tipo (`DOC-S/M/L/XL` × `TEXT/TABLE`), lo que revela que
tienen infra de extracción con costos escalonados. Con modelos actuales esto es
alcanzable, pero no trivial: OCR para escaneados, parsing de tablas, y sobre
todo **evaluación** —saber si la extracción salió bien.

### 2.3 Lo que ya resolvimos

**El Deal Index.** El modelo de tres niveles con lógica de promoción explícita
lo tenemos andando. Y nuestra versión tiene algo que la de Lev no expone: el
`rationale` de por qué ganó cada valor.

Eso no es un detalle menor. En underwriting, "¿de dónde salió este número y por
qué le creemos a este documento y no al otro?" es *la* pregunta.

---

## 3. Dónde puede haber espacio

Tres hipótesis, no excluyentes. Ninguna es obvia; hay que elegir.

### A. Vertical más angosto

Lev cubre todo CRE. Un producto que haga *una* cosa mucho mejor —solo
multifamily, solo construction lending, solo un mercado geográfico— puede ganar
en profundidad lo que pierde en amplitud, y necesita muchos menos datos.

*Ventaja:* el moat de lenders se achica a un subconjunto manejable.
*Riesgo:* mercado más chico.

### B. Capa de inteligencia sobre datos ajenos

No competir en datos: integrarse. El sistema de registro sigue siendo el CRM que
el cliente ya usa, y nosotros aportamos el Index + extracción + razonamiento.

*Ventaja:* elimina el problema del dataset de lenders.
*Riesgo:* dependés de integraciones, y Lev también hace esto.

### C. Infraestructura para otros

Vender el Deal Index y la extracción como primitivas a otros que construyen
software CRE. No competir con Lev en el producto final sino en la capa de abajo.

*Ventaja:* el moat es técnico, no de datos.
*Riesgo:* mercado de desarrolladores CRE es chico.

**⟶ tuya:** cuál de estas, u otra.

---

## 4. Decisiones de arquitectura

### 4.1 ¿Contrato compatible con Lev o propio?

| | Compatible | Propio |
|---|---|---|
| Migración desde Lev | Trivial | Requiere trabajo del cliente |
| Libertad de diseño | Atada a sus decisiones | Total |
| Percepción | "Clon" | Producto propio |

Mi lectura: **empezar compatible en las partes buenas y divergir donde su diseño
tiene costuras**. Su contrato tiene decisiones sólidas (envelope con request_id,
cursor estable, idempotencia, scopes granulares) que no vale la pena reinventar.
Pero también tiene cosas que arreglaría:

- `total_rate` significando spread o all-in según contexto — es una trampa.
- `404` para "no existe" y "sin acceso" —defendible, pero dificulta debuggear.
- Sin webhooks: obliga a polling.
- El estado de checklist separado en `status` + `is_completed` es confuso.

**⟶ tuya:** compatible, propio, o compatible-con-mejoras.

### 4.2 Persistencia

Recomiendo **Postgres**. El modelo es relacional (deals → properties →
observations → facts), necesitás transacciones para la promoción de facts, y
`jsonb` cubre lo semiestructurado.

Para la búsqueda semántica del Index: `pgvector` en la misma base evita sumar
un servicio. Si crece, se migra.

*Alternativa:* SQLite para el prototipo, migrando después. Más rápido de
arrancar, menos realista.

**⟶ tuya:** Postgres desde el día uno, o SQLite primero.

### 4.3 El Index: ¿keywords, embeddings o LLM?

Hoy tenemos LLM con fallback a keywords. Para producción:

- **Embeddings** para el retrieval (rápido, barato, escala).
- **LLM** solo para reranking del top-N y para generar el reasoning.

Ese híbrido es más barato y más rápido que llamar al modelo con todo el catálogo,
que es lo que hace nuestro prototipo.

### 4.4 Extracción de documentos

El pipeline mínimo:

```
upload → detectar tipo → (OCR si hace falta) → chunking →
extracción estructurada por métrica → observation con confidence + snippet →
promoción → fact canónico
```

La parte que la mayoría subestima: **evaluación**. Sin un set de documentos
etiquetados no sabés si un cambio en el prompt mejoró o empeoró la extracción.

**RESUELTO** — ver §4.5.

### 4.5 De dónde salen los datos de evaluación

No hacen falta documentos privados para empezar. El harvester (`harvest/`) baja
los **Annex A** de prospectos CMBS desde SEC EDGAR: planillas públicas con
cientos de propiedades reales y sus métricas.

Lo que los hace especialmente útiles: **el par ya viene armado**. El Annex A es
la verdad estructurada; el prospecto en PDF describe los mismos préstamos en
prosa. Eso es exactamente el par (documento no estructurado → facts
estructurados) que hace falta para evaluar extracción.

Otras fuentes complementarias:

| Fuente | Qué aporta |
|---|---|
| Fannie Mae Multifamily Loan Performance | 72k+ préstamos, 62 atributos — distribuciones reales |
| FHFA Public Use Database | tamaño de propiedad, UPB, tipo de vendedor |
| MISMO Commercial Rent Roll Dataset | el estándar de la industria para campos de rent roll |
| Plantillas públicas de rent roll y T-12 | layouts reales para generar sintéticos creíbles |
| FinTabNet | 113k tablas financieras — el subproblema de extraer tablas de PDF |

**MISMO merece atención aparte.** Hoy las `metric_definitions` las inventé yo
mirando la doc de Lev. Alinearlas al estándar MISMO nos daría interoperabilidad
y credibilidad sin costo. Es una tarea acotada y de alto retorno.

**La limitación que queda:** un set sintético te dice si el pipeline funciona,
no si sobrevive al mundo. Los rent rolls reales vienen en cuarenta formatos, a
veces escaneados torcidos, con notas a mano. Eso ya no bloquea el arranque, pero
sigue siendo algo a conseguir en paralelo.

---

## 5. Propuesta de v0

Si tuviera que elegir por dónde empezar, sin saber todavía el producto:

1. **Persistir lo que ya funciona.** Migrar el store en memoria a Postgres,
   manteniendo el contrato intacto. El smoke actual es la red de seguridad:
   si sigue pasando en verde, la migración no rompió nada.

2. **Ingesta real de un solo tipo de documento.** Elegir el más común —rent
   roll en XLSX— y hacer el pipeline completo hasta observations. Un tipo bien
   resuelto enseña más que cinco a medias.

3. **Reemplazar el ranking del Index por embeddings + rerank.**

4. **Recién ahí decidir el producto**, con la infra andando.

Los pasos 1-3 son valiosos con cualquiera de las tres hipótesis de §3. Es
trabajo que no se tira.

---

## 6. Lo que necesito de vos

| Decisión | Por qué bloquea |
|---|---|
| Hipótesis de producto (§3) | Define si el dataset de lenders es un problema |
| Contrato compatible o propio (§4.1) | Define el diseño de todos los endpoints |
| Postgres o SQLite (§4.2) | Define el setup |
| ~~¿Documentos reales?~~ | ~~Resuelto: EDGAR (§4.5)~~ |

## 7. La emulación de Lev: qué se conservó y por qué se borró

Durante la primera etapa construimos una emulación completa de la API de Lev
—unas 7.000 líneas entre `mock/`, `src/` y el puente `harvest/load/`— para poder
trabajar contra su contrato sin tener cuenta paga. Cuando el proyecto pasó de
*integrarse con Lev* a *construir un corpus propio*, ese código quedó huérfano
pero siguió en el repositorio, y siguió cobrando intereses: `metricBridge.ts`
era un `Record<MetricKey, …>` exhaustivo, así que **cada métrica nueva del
harvester obligaba a darla de alta en un store que ya nadie consultaba.** Las
cuatro métricas de cooperativas pasaron por ahí sin ningún motivo.

Se borró. Lo que sigue es lo que valía la pena conservar y no estaba en el doc
de referencia.

### Convenciones de contrato que reusaríamos

Están descritas en detalle en `lev-referencia-tecnica.md` §5. Las que resultaron
realmente útiles al implementarlas, y no solo elegantes en el papel:

- **Sobre `request_id` / `timestamp` / `data`.** El costo es una línea; el
  beneficio es que cualquier respuesta es rastreable en logs sin correlacionar
  por timestamp. Lo volveríamos a hacer.
- **Cursor y offset como modos mutuamente excluyentes,** con el cursor
  incompatible con `sort`. Suena arbitrario hasta que uno intenta paginar un
  conjunto que se reordena entre páginas.
- **Scopes granulares separando lectura de acción.** `ai:actions` aparte de
  `deals:write` permite dar a un agente permiso para sugerir sin permiso para
  escribir. Es la distinción que más se usa en la práctica.
- **Idempotencia con expiración explícita.** Guardar la respuesta original y
  devolverla igual ante un reintento evita el caso feo: el cliente reintenta por
  timeout y crea dos veces.

### El patrón de la capa de IA

`mock/ai/` implementaba búsqueda semántica y matching con un LLM real y un
fallback determinista detrás de la misma interfaz. El patrón que vale, en una
línea: **la ruta determinista no es un plan B degradado, es el oráculo de los
tests.** Con el LLM apagado la suite corre offline y verifica la forma de la
respuesta; con el LLM prendido se verifica la calidad. Si el fallback devolviera
algo estructuralmente distinto, esa propiedad se pierde.

### La lógica de promoción

`mock/store/promotion.ts` resolvía múltiples observaciones de la misma métrica en
un valor canónico. Esa lógica **no se perdió**: vive en `db/corpus.ts`, aplicada
al corpus real, y de hecho es una versión mejor porque opera sobre observaciones
con provenance verdadera en vez de un seed sintético.

## 8. Estado actual

Lo que quedó en pie:

```
harvest/                   cosecha desde SEC EDGAR
  edgar/                   cliente SEC, descubrimiento de Annex A y de 10-D
  normalize/               mapeo de columnas → observations con provenance
  parse/                   tablas HTML/xlsx, informe del servicer
  test.ts · real.test.ts · scale.test.ts · fixtures.test.ts · servicer.test.ts

db/                        corpus en Postgres
  migrations/              001 corpus · 002 desempeño
  corpus.ts                escritura y lectura, promoción a facts
  challenge.ts             falsificación de hallazgos de originación
  outcomes.ts              suscripción contra resultado
  servicerBatch.ts         cosecha de desempeño en lote
```

El corpus: 100 filings, 3.579 préstamos, 47 métricas, y 325 préstamos con NOI
real posterior al cierre.

**Restricción operativa:** no tengo salida de red a la API de Anthropic desde
donde ejecuto, y las cosechas contra EDGAR las corre el usuario.

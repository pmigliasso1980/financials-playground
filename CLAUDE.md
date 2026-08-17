# Contexto para Claude

Corpus de préstamos CMBS armado desde documentos públicos de la SEC, con las
herramientas para interrogarlo y para intentar demostrar que está mal.

Empezá leyendo `docs/hallazgo-suscripcion.md` —el resultado y sus agujeros— y
`docs/taxonomia-cre.md`, que documenta las 94 métricas con el incidente que
motivó cada distinción.

---

## Cómo trabajamos acá

Estas no son preferencias de estilo. Cada una salió de un error concreto que
costó tiempo, y están acá para no repetirlo.

### Enunciá qué esperás ver ANTES de correr algo

Es la regla que más valor produjo. Casi todos los errores se detectaron porque
volvió un número distinto del anunciado, no por razonar:

- "el DSCR sube a 99%" → subió a 95%, y ese 5% era real
- "la causa es el rate limit" → era una variable de entorno faltante
- "B18 vuelve a 65 préstamos" → no se recosechó, y eso destapó un selector ciego

Una predicción que no puede estar mal no sirve. "Podría subir o bajar" no falsea
nada.

### Después de tres ataques fallidos, dejá de atacar y explicá

La afirmación "BANK suscribe cuatro veces mejor que BBCMS" sobrevivió **nueve**
intentos de matarla: cobertura del join, población listada, formato del bloque,
filtros del parser, valores crudos en veinte emisiones, administrador maestro,
administrador especial, composición por tipo de propiedad, y un bloque entero
del 10-D que el parser no leía.

Los nueve preguntaban lo mismo: *"¿esto es un artefacto?"*. Los nueve dieron que
no, y ninguno acercó nada a la verdad. **Nueve "no es un artefacto" no hacen un
"es real".**

El décimo preguntó *"¿qué sería esto si fuera real?"* y la mató en un intento: el
shelf no origina préstamos, los compra. Estandarizando por vendedor × añada
ninguna emisora se aparta.

Una hipótesis rival concreta vale más que cualquier cantidad de verificación
defensiva, porque puede confirmar además de refutar. Si no se puede formular
ninguna, ese es el dato.

### Antes de atacar un hallazgo, releé lo que el proyecto ya escribió

La explicación de esa brecha estaba en `docs/hallazgo-suscripcion.md` desde hacía
semanas: *"las cooperativas de Nueva York vienen clasificadas como multifamily; en
los deals BANK son la mitad del pool"*. Se redescubrió tres días después por otro
camino, sin haber releído el archivo.

### La unidad de análisis se elige antes que el método

Un shelf de CMBS empaqueta préstamos comprados a varios originadores. Preguntarle
"¿quién suscribe mejor?" es un error de categoría que ninguna sofisticación
estadística corrige, y que se podía ver sin datos.

### Los umbrales se fijan antes de ver el número

En `db/challenge.ts` y `db/outcomes.ts` los cortes están escritos antes de correr
la consulta. Elegir el umbral mirando el resultado es elegir la conclusión.

### Los diagnósticos muestran valores, no conteos

Un conteo confirma la hipótesis; una muestra del dato crudo la puede romper.

- "83 de 83 filas con loan_ref" → sonaba a salud
- `"Loan", "Property", "Property"` → mostró que el identificador era el flag

Los tres bugs más caros se destaparon viendo el valor, nunca la métrica agregada.

### No definas nada por síntoma

Hice tres veces el mismo error. La recosecha dirigida seleccionaba filings por
"no tiene identificador"; después arreglé el mapeo, el síntoma cambió a "tiene
identificador basura", y el selector los dio por sanos. Cambié el criterio a
"identificador usable", y el siguiente arreglo dejó un filing con un solo id
numérico entre 83 — pasó igual.

**Un detector definido sobre "falta X" queda ciego cuando el modo de fallo pasa
a ser "X está pero mal", que es el caso más común en pipelines de datos.**

`--refresh-stale` usa la versión de la taxonomía con que se cosechó cada filing.
Ese predicado no se mueve cuando arreglás algo.

### Un fallo tiene que decir cuál de sus causas es

"33 sin pegar" tiene tres causas con tres arreglos distintos. Antes de intentar
arreglar, hacé que el error las distinga. Ver `db/servicerBatch.ts`.

### Un diagnóstico que no se apaga cuando la causa se arregla es ruido

La sección "Dónde fallan" de `db:identities` seguía alarmando con 27 casos de
3.528. Si el residuo es chico, decilo.

### Los tests pueden fijar un error

Escribí un test afirmando que `"Loan"` mapeaba a `loan_id`. Era el flag. La suite
certificó el bug en cada corrida. **Los tests que escribe quien escribió el mapeo
son consistencia interna, no verificación.** La verificación real son las
identidades aritméticas (`db:identities`) y mirar valores crudos.

### Un índice que falta no se nota hasta que explota

`facts.observation_id` referenciaba a `observations(id)` con ON DELETE SET NULL y
sin índice. Postgres no indexa el lado que referencia de una foreign key. Cada
observation borrada disparaba un Seq Scan completo de `facts`.

Con mil filas es instantáneo; con medio millón, una recosecha pasa de minutos a
horas. **No hay señal temprana**: un test de rendimiento con datos de juguete
nunca lo encuentra. Toda columna que sea el lado referenciado de un CASCADE o
SET NULL necesita índice, aunque ninguna consulta de lectura la use.

### Una exclusión rota desaloja, no ensucia

La exclusión de `debt_yield` decía `/total\s*debt/i` y el encabezado real era
"Total **Mortgage** Debt UW NOI Debt Yield". La palabra del medio la volvía
inofensiva.

Lo que esperaba: unos préstamos con el ratio equivocado. Lo que pasaba: como una
columna solo puede ir a una métrica, la de deuda total le ganaba el lugar a la
sénior y la sénior quedaba sin destino —`debt_yield_total_debt` tampoco la
reclamaba, mismo regex—. En BANK 2020-BNK26 eran 20 préstamos con el número de
otro y **55 sin ningún número**.

Arreglar el regex subió la cobertura del debt yield de 92% a 96% y el n de 8.302
a 8.609. **Predije que ganaríamos exactitud perdiendo cobertura y ganamos las
dos**, porque mi modelo del daño era el equivocado.

Un patrón de exclusión que no matchea no deja las cosas como estaban: deja
entrar a un impostor que ocupa el lugar del bueno.

### Un corpus incompleto es indistinguible de uno correcto

Las cinco identidades miran préstamos que están. Ninguna ve los que faltan: si
el parser descarta la mitad de las filas, la otra mitad sigue cerrando sus
identidades, sus valores siguen siendo razonables y los chequeos de sanidad
siguen pasando.

Morgan Stanley 2021-L5 bajó de 65 a 19 préstamos entre dos cosechas y se notó de
casualidad, porque el total del corpus se movió 46 y yo estaba mirando por otro
motivo. Discutimos si el número bueno era 19 o 65 sin forma de decidirlo.

`% of Initial Pool Balance` lo decide gratis: las participaciones suman uno por
construcción. L5 sumaba 63,7%, o sea que **ni 19 ni 65 eran correctos** —el total
ronda los 30—. Está en 207 de 220 emisiones y 201 suman 100%.

Vale para cualquier corpus: buscá la cantidad que el propio documento obliga a
sumar un total conocido. Es la única familia de comprobación que detecta
ausencia.

### El piso de ruido va ANTES de buscar el efecto

Murieron tres hipótesis seguidas. La tercera —"el NOI entregado se derrumbó de
11,5% a 1,0% entre 2021 y 2024"— era el resultado principal del proyecto.

El bootstrap sobre las medianas por añada dio un error estándar de 2,37% y una
diferencia mínima detectable de **6,6 puntos**. Ninguno de los 10 pares de añadas
tiene intervalos de confianza que no se pisen: con esta muestra, **ninguna añada
es distinguible de ninguna otra**.

Ese cálculo cuesta una tarde y se podría haber hecho el primer día. Se hizo
después de meses de cosecha y semanas de verificar el mapeo.

Lo que NO fue la causa: la muestra alcanzaba. 10,5 puntos supera los 6,6 de
piso — si el derrumbe hubiera sido real, habría aparecido. El efecto no estaba.

**Antes de buscar un efecto, medí qué efecto podés ver.** Si el piso de ruido es
más grande que lo que buscás, no hay análisis que lo arregle.

### Una migración aplicada no se toca

Editar una migración ya corrida obliga a `db:reset`, que borra el corpus. Ya pasó
una vez, y la recosecha falló después. Los cambios van en un archivo nuevo.

---

## Comandos

```bash
npm run db:up && npm run db:migrate
npm run harvest:batch -- --limit 300 --years 7    # cosecha (~5 min / 160 filings)
npm run harvest:batch -- --limit 300 --years 7 --refresh-stale   # recosecha lo
                                                  # cosechado con un mapeo viejo

npm run db:identities    # ¿el mapeo es correcto? — la verificación más fuerte
npm run db:performance   # NOI real posterior al cierre, desde los 10-D
npm run db:outcomes      # proyectado contra entregado, por añada
npm run db:challenge     # intentos de falsear los hallazgos de originación
npm run db:explain       # de qué columna salió cada número
npm run db:reconcile     # qué columna sin mapear vale lo que falta
npm run db:bias          # ¿la muestra con 10-D representa a su pool?
npm run db:power         # ¿qué efecto puede detectar esta muestra?
npm run db:analyze       # distribuciones por tipo de activo

npm run test:all         # 207 checks, todos offline
```

**`SEC_USER_AGENT` es obligatorio.** No es una credencial: EDGAR es público y
gratis. La SEC exige nombre y email en el header para poder avisarte si tu script
se descontrola. Va en `.env` (ya está en `.gitignore`).

---

## Trampas del Annex A que no están documentadas en ningún lado

Salieron de que un número no cerraba. Están en `docs/taxonomia-cre.md` con más
detalle.

**Siete saldos para el mismo préstamo.** Los ratios que publica el emisor se
calculan contra *trust + pari passu no-trust*, no contra la columna que dice
"Balance". Usar la equivocada da debt yields de 3947%.

**El servicio de deuda es de la nota del trust; el DSCR, del préstamo entero.**
Hay que escalarlo por saldo antes de dividir.

**Un préstamo con período de solo intereses tiene dos servicios de deuda**, y el
DSCR publicado usa el menor.

**El formato 2020 parte en dos columnas lo que el moderno junta:** columna 0 con
el flag `Loan`/`Property`, columna 1 con el identificador titulado solo `"ID"`.

**Hay erratas en los documentos.** Benchmark 2020-B16 publica `"48 5%"` donde va
`48.5%`. Un número con espacio interno devuelve null: repararlo sería adivinar
entre 48.5 y 485.

**"0.00" con fechas vacías es no reportado**, no cero.

**El "Pros ID" del servicer varía por administrador.** En Computershare es el
número del prospecto; en Citigroup esa columna se llama `OMCR` y la que dice
"Loan ID" es el ID interno del servicer.

---

## Estado

222 emisiones · 8.981 préstamos · 94 métricas · 2.246 préstamos con desempeño
posterior al cierre.

Identidades sobre 8.935 préstamos (taxonomía `2026.08.6`):

| identidad | n | cierra |
|---|---|---|
| debt yield = NOI / saldo | 8.599 | 97% |
| LTV = saldo / tasación | 8.582 | 98% |
| NCF = NOI − reposición − TI/LC | 8.014 | 93% |
| DSCR (NCF) | 7.086 | 91% |
| DSCR (NOI) | 7.175 | 90% |
| suma de participaciones del pool | 207 emisiones | 201 dan 100% |

El denominador correcto es `trust + pari passu no-trust` —o `balance_senior_total`
cuando el Annex lo publica—: 97% contra 75% del saldo del trust solo.

Los dos DSCR están topeados por la cobertura de `debt_service_*` (79-80%), no
por error de mapeo.

**El hallazgo principal murió.** Ver `docs/hallazgo-suscripcion.md`: a tamaño
constante la caída del NOI entregado desaparece —2020 y 2024 dan lo mismo, 2,5%—
y el bootstrap muestra que ninguna añada es distinguible de otra. Lo que
sobrevive es que el NOI **proyectado** es plano entre añadas (3,0 · 3,6 · 3,5 ·
3,4 · 4,3), y eso sí aguanta la estratificación.

### Dónde retomar

El corpus está al día con `2026.08.8`. No hay cambios sin cosechar.

Lo último fue el reconciliador (`npm run db:reconcile`): compara el saldo
implícito por la identidad contra las celdas sin mapear de esa misma fila y
propone de qué columna sacar el número que falta. Encontró
`balance_senior_total` —una columna que varias emisiones publican con el sénior
entero— y las dos columnas *Piece Non-Trust*. Al aplicarlas, los préstamos que
fallan bajaron de 351 a 244 y **las propuestas desaparecieron de su propia
salida**, que es la prueba de que la herramienta cierra el ciclo.

Lo que queda en su salida es ruido de coincidencia —1 préstamo cada uno— salvo
`"Cut-off Balance"`, con 16 en 2 emisiones.

Próximo paso propuesto, en orden:

1. **El sesgo por añada de la muestra con desempeño.** Comparar el perfil de los
   préstamos con 10-D contra el del pool completo, añada por añada. Es lo único
   pendiente que puede invalidar el titular: el 11,5% de 2021 sale justo de las
   añadas que peor parsean.
2. **Más fixtures.** Hoy hay 3 y corren el pipeline entero offline en 200 ms.
   Con ~20 —uno por familia de formato— un cambio de mapeo se juzga en segundos
   en vez de con una recosecha de 5 minutos. Es el prerrequisito real para
   trabajar con varios agentes: sin verificación por propuesta, N agentes
   producen N cambios con un solo veredicto global y ninguna atribución.
3. Las 3 emisiones con filas perdidas (apilado de páginas del Annex A).

### Abierto

- **El join del servicer en 2020 sigue parcial.** Benchmark 2020-B16/B18/B22 y
  DBJPM 2020-C9 ahora parsean bien —33, 37, 33 y 31 préstamos— pero pegan solo
  1-5 contra su informe del servicer, con 20-24 sin pegar. La numeración del
  Annex A de esas añadas no coincide con el Pros ID. Es lo que queda por
  entender de ese formato.
- **Esos filings dan 18-22 observations por préstamo** contra 60-70 de los
  modernos. Es esperable —el Annex A de 2020 tiene menos columnas— pero conviene
  confirmar que no falta un bloque.
- **101 préstamos sin `property_type`** mapeado.
- **15 emisiones con cero préstamos que cierren.** El grupo que falla tiene el
  doble de saldo mediano (26,8M vs 13M) y 3,6× el NOI (6,1M vs 1,7M) que el que
  cierra. Ese perfil —préstamos grandes, repartidos— es la firma de una
  convención de saldo que no modelamos, la misma familia de error que el pari
  passu. `db:identities` ahora las nombra en vez de contarlas.
- **Las identidades no corren solas** después de cosechar.
- **BANK 2021-BNK31 a BNK35** no reportan años completos de NOI.
- `db/snapshot.ts` existe pero sus umbrales son inventados. No confiar todavía.

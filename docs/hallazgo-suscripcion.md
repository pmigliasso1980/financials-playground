# Cuatro hipótesis muertas y el instrumento que las mató

> **Estado: cuatro hipótesis murieron; una sobrevive.**
> El hallazgo original —el derrumbe del crecimiento del NOI por añada— es falso.
> Lo que quedó en pie está un nivel más abajo: entre originadores, no entre
> emisoras. Ver "Lo primero que sobrevivió".
>
> Este documento antes afirmaba que el crecimiento del NOI entregado se derrumbó
> de 11,5% en la añada 2021 a 1,0% en 2024. No sobrevivió a la verificación. Lo
> que sigue es el registro de cómo murió y de lo que quedó en pie, porque eso es
> más reutilizable que el número que reemplazaría.

---

## Lo que se afirmaba

Sobre 222 emisiones de CMBS y 8.935 préstamos cosechados de documentos públicos
de la SEC, se comparó lo que el originador proyectó al suscribir contra lo que la
propiedad entregó después, usando los informes del servicer (10-D) como fuente
del resultado real.

La conclusión era:

> Entre 2021 y 2024 el crecimiento de NOI proyectado se mantuvo casi constante
> (4,2% → 3,9%) mientras el entregado se derrumbó (11,5% → 1,0%). La suscripción
> no se volvió más agresiva; el mercado dejó de convalidarla.

Sonaba bien, tenía una explicación mecánica plausible y hasta se contrastó contra
el índice de NOI de Moody's, cayendo dentro de su banda publicada para las añadas
2019-2023. Nada de eso alcanzó.

---

## Cómo murió

### Primer golpe: la muestra no representa a su pool

Los préstamos con informe del servicer son ~2.200 de 8.935. Comparar añadas
supone que cada submuestra se parece a su pool, o al menos que se desvía igual en
todas. Ninguna de las dos cosas era cierta.

| añada | pool | con 10-D | cobertura | saldo mediano con/sin | ratio |
|---|---|---|---|---|---|
| 2020 | 1.430 | 365 | 26% | 20,0M / 10,5M | **1,90x** |
| 2021 | 1.664 | 556 | 33% | 14,1M / 8,8M | 1,61x |
| 2022 | 1.111 | 536 | 48% | 14,3M / 10,0M | 1,43x |
| 2023 | 792 | 311 | 39% | 24,0M / 39,0M | **0,62x** |
| 2024 | 1.401 | 397 | 28% | 21,0M / 18,3M | 1,15x |

**El sesgo cambia de signo.** En 2020 el 10-D pega contra préstamos 90% más
grandes que el resto del pool; en 2023 contra préstamos 38% más chicos.
Dispersión 3,10x, contra un umbral de 1,5x fijado antes de mirar los números.

Un sesgo constante no habría roto nada: todas las añadas estarían corridas para
el mismo lado y la comparación entre ellas se sostendría. Lo que rompe la serie
es que el sesgo varíe.

### Segundo golpe: a tamaño constante no hay caída

La forma de separar el efecto del tamaño del efecto del tiempo es comparar dentro
de una banda de tamaño fija. Se eligió 10M-30M **antes** de ver el resultado,
porque las medianas de las cinco submuestras caen todas adentro.

| añada | n | NOI entregado | proyectado sobre histórico |
|---|---|---|---|
| 2020 | 89 | 2,5% | 3,0% |
| 2021 | 157 | 8,7% | 3,6% |
| 2022 | 145 | 4,1% | 3,5% |
| 2023 | 89 | 5,6% | 3,4% |
| 2024 | 120 | 2,5% | 4,3% |

**2020 y 2024 dan exactamente lo mismo: 2,5%.** No hay derrumbe, hay una joroba
con 2021 como pico. Y los dos extremos del titular original se movieron hacia el
centro —11,5% pasó a 8,7%, 1,0% pasó a 2,5%—, que es la firma de un efecto de
composición.

Una tentación que hubo que resistir: comparando 2021 → 2024 en vez de 2020 → 2024
la caída da 6,2 puntos y habría pasado el umbral de supervivencia. Pero elegir
2021 como punto de partida es elegir el pico de la curva para maximizar la
caída — el mismo error que ya se había cometido antes en este proyecto midiendo
"estabilidad entre añadas" comparando los extremos de una U.

### Tercer golpe: ninguna añada es distinguible de ninguna otra

Bootstrap de 2.000 réplicas por añada, semilla fija, sobre la misma banda:

| añada | n | mediana | IC 95% | ancho |
|---|---|---|---|---|
| 2020 | 89 | 2,5% | [−1,6% , 6,9%] | 8,5% |
| 2021 | 157 | 8,7% | [3,3% , 12,9%] | 9,6% |
| 2022 | 145 | 4,1% | [0,8% , 8,2%] | 7,4% |
| 2023 | 89 | 5,6% | [−3,1% , 12,5%] | 15,6% |
| 2024 | 120 | 2,5% | [0,3% , 5,0%] | 4,7% |

- Error estándar típico de una mediana anual: **2,37%**
- Diferencia mínima detectable entre dos añadas: **6,6%**
- **Pares de añadas con intervalos que no se pisan: 0 de 10**

Ni siquiera la diferencia más grande —2021 contra 2024, 6,2 puntos— alcanza el
piso de ruido.

---

## Qué NO explica el fracaso

Es tentador cerrar con "la muestra era muy chica". No es cierto y conviene
decirlo, porque la conclusión correcta es distinta.

El efecto afirmado eran 10,5 puntos y el piso de ruido son 6,6. **La muestra
podía detectarlo.** Si el derrumbe hubiera sido real, habría aparecido. Lo que
pasó no es que el instrumento fuera ciego: es que el efecto no está, y los 10,5
puntos originales eran composición de la muestra.

Tampoco es cuestión de cosechar mucho más. Para bajar el piso a 5 puntos hacen
falta ~2x más préstamos por añada, de 120 a ~208. Eso es alcanzable —hoy la
cobertura del 10-D es 26-48%, hay 176 préstamos sin pegar contra su informe, seis
emisiones BANK que no reportan años completos, y las añadas 2025-2026 todavía no
maduraron—. Pero antes de hacer ese trabajo conviene preguntarse si un efecto de
5 puntos sería interesante.

---

## Qué sí queda en pie

**El proyectado es plano.** 3,0 · 3,6 · 3,5 · 3,4 · 4,3 a lo largo de cinco
añadas, dentro de la banda de tamaño. Esa mitad del hallazgo original aguanta la
estratificación intacta. Los originadores proyectan crecimiento de NOI en un
rango estrecho y estable sin importar el momento del ciclo.

Es un resultado menor pero real, y es el único que sobrevivió a todo.

**El corpus.** 222 emisiones, 8.935 préstamos, 94 métricas, verificadas contra
las identidades aritméticas del propio emisor:

| identidad | n | cierra |
|---|---|---|
| debt yield = NOI / saldo | 8.599 | 97% |
| LTV = saldo / tasación | 8.582 | 98% |
| NCF = NOI − reposición − TI/LC | 8.014 | 93% |
| DSCR (NCF) | 7.086 | 91% |
| DSCR (NOI) | 7.175 | 90% |
| suma de participaciones del pool | 207 emisiones | 201 dan 100% |

**Las trampas del Annex A**, documentadas en `docs/taxonomia-cre.md`. No están
escritas en ningún lado y cada una salió de que un número no cerraba.

---

## Las otras dos hipótesis

No es la primera que muere. Antes cayeron:

**"La oficina se suscribe más agresivo."** El gap entre proyectado e histórico
era mayor en oficinas, pero desapareció al notar que se explicaba por la
visibilidad contractual de la renta: los activos con contratos largos —oficina,
industrial, retail— permiten proyectar sobre renta ya firmada, y el "gap" medía
eso, no agresividad.

**"Multifamily rompe la banda de LTV."** La mediana de LTV de multifamily daba
11%, lo cual parecía una anomalía enorme. Eran cooperativas de vivienda de Nueva
York, que toman deuda muy chica contra un valor muy alto y vienen clasificadas
como multifamily. En los deals BANK son la mitad del pool.

**"BANK suscribe cuatro veces mejor que BBCMS."** La más cara de todas, porque
sobrevivió más. Ajustado por añada, tipo de propiedad y tercil de DSCR, el shelf
BANK transfería a special servicing con un SIR de 0,42 contra 1,66 de BBCMS,
intervalos que no se tocaban.

Sobrevivió **nueve** intentos de matarla: la cobertura del join (97,7%), la
población que cada administrador lista, el formato del bloque de morosidad, los
filtros del parser, el valor crudo verificado en veinte emisiones, el
administrador maestro, el administrador especial, la composición por tipo de
propiedad, y un bloque entero del 10-D —"Specially Serviced Loan Detail"— que el
parser no leía y aportaba 35 eventos.

Murió con el décimo, que fue el primero que no era defensivo. Mapeando la
columna *Mortgage Loan Seller* del Annex A y estandarizando por **originador ×
añada**, ninguna emisora se aparta: BANK 1,01 · BBCMS 1,10 · BMO 1,03 · Wells
0,83, todos los intervalos conteniendo el 1.

BANK no suscribe mejor: **compra a otros originadores**. Su pool viene de NCB
—National Cooperative Bank, cooperativas de vivienda, 396 préstamos con cero
eventos— más BANA, WFB y MSMCH. El de BBCMS viene de Barclays, LMF y UBS. Entre
originadores la variación real va de 0% a 11,2%.

**Cuatro de cuatro.** Ese patrón importa más que cualquiera de las cuatro por
separado.

---

## Los dos errores que hicieron cara a la cuarta

**El error de categoría.** Un shelf de CMBS no es un originador: es un vehículo
que empaqueta préstamos comprados a varios bancos. Atribuirle calidad de
suscripción era felicitar a la caja por lo que hizo la fábrica, y eso se podía
decir el primer día sin ningún dato. Nueve ataques sofisticados al numerador y
al denominador no compensan una unidad de análisis mal elegida.

**La respuesta estaba escrita en este archivo.** La sección de arriba dice, desde
hace semanas, que las cooperativas de Nueva York vienen clasificadas como
multifamily y que *"en los deals BANK son la mitad del pool"*. Eso es exactamente
el mecanismo que terminó explicando la brecha. Se redescubrió por otro camino
—desde los datos del vendedor— sin releer la documentación del propio proyecto.

Los dos son fallas del mismo tipo: **conocimiento disponible que no se consultó
porque la atención estaba puesta en defender una afirmación en vez de en
explicarla.**

---

## La asimetría entre atacar y explicar

Los nueve ataques preguntaban *"¿esto es un artefacto?"*. Los nueve dieron que
no, y ninguno acercó nada a la verdad. Nueve "no es un artefacto" no hacen un
"es real".

El décimo preguntaba *"¿qué sería esto si fuera real?"* — y en un solo intento
mostró que el efecto vivía un nivel más abajo. Una hipótesis rival concreta vale
más que cualquier cantidad de verificaciones defensivas, porque puede confirmar
además de refutar.

**Regla práctica:** después de tres ataques fallidos a un hallazgo, dejar de
atacarlo y formular la explicación alternativa más específica posible. Si no se
puede formular ninguna, ese es el dato.

---

## Lo primero que sobrevivió

Después de matar el efecto emisora, la variación quedó donde correspondía: entre
**originadores**. Comparando cada préstamo contra otros del mismo tipo de
propiedad, la misma añada, el mismo tercil de DSCR y el mismo tercil de LTV:

| originador | SIR | IC 95% | préstamos | eventos |
|---|---|---|---|---|
| NCB | 0,00 | [0,00 , 0,57] | 365 | 0 |
| LMF | 1,89 | [1,28 , 2,70] | 270 | 30 |
| UBS AG | 2,21 | [1,18 , 3,78] | 172 | 13 |

Con corrección de Bonferroni sobre 14 pruebas (p < 0,0036), usando
SE de log(SIR) ≈ 1/√observados: **LMF sobrevive** (z = 3,49, p ≈ 0,0005), **UBS
no** (z = 2,86, p ≈ 0,0042). NCB sobrevive por intervalo pero mide producto —
presta a cooperativas de vivienda— no habilidad.

### Por qué este resultado es distinto de los cuatro que murieron

**Está en la unidad de análisis correcta.** El originador decide a quién presta;
la emisora solo elige a quién comprarle.

**Sobrevivió un test bidireccional.** Los controles por tipo, DSCR y LTV solo
podían achicar el residuo, y lo achicaron: 3,61 → 2,26 → 1,89. Un control que
reduce es débilmente informativo. La distribución por añada podía moverlo en las
dos direcciones: si los 30 eventos de LMF estaban amontonados en 2021-2022 era
una apuesta de ciclo, no suscripción. Están repartidos en **las cinco añadas**,
con 34% en su peor año contra 12% de su pool ahí.

BMO y MSMCH sí resultaron apuestas de ciclo: 72% de los eventos de BMO en 2023,
67% de los de MSMCH en 2021.

**No está confundido con la emisora.** LMF coloca en cuatro shelves distintos.

### Lo que todavía puede matarlo

`property_type` no captura **producto**. Las cooperativas viven dentro de
multifamily y ese mecanismo exacto mató el efecto emisora. Si LMF se especializa
en un subproducto de riesgo distinto dentro de su tipo, el 1,89 es el mismo
artefacto con otro nombre. La columna `property_type_detailed` ya está en la
taxonomía y nunca se usó.

Faltan además geografía y tamaño de préstamo. Y el sesgo de stock sigue siendo
estructural para todos por igual.

---

## La lección, que es lo reutilizable

Cada hipótesis murió por una razón distinta y ninguna murió por razonar mejor.
Murieron porque se construyó un instrumento capaz de matarlas:

1. **Las identidades aritméticas** (`db:identities`) — métricas mapeadas por
   separado tienen que satisfacer las relaciones que el emisor usó para
   calcularlas. Verificación sin fuente externa.
2. **La suma del pool** — las participaciones suman uno por construcción. Es la
   única comprobación que detecta **ausencia**; todas las demás miran la calidad
   de lo que hay.
3. **El reconciliador** (`db:reconcile`) — el valor implícito por una identidad
   comparado contra las celdas sin mapear de la misma fila. Convierte "leé
   ochenta y siete encabezados y adiviná" en una coincidencia numérica.
4. **El chequeo de sesgo** (`db:bias`) — ¿la submuestra se parece a su pool?
5. **El piso de ruido** (`db:power`) — ¿qué efecto puede detectar esta muestra?

Las dos últimas son las que mataron este hallazgo, y las dos se construyeron
**después** de creerlo. Ese es el orden equivocado y vale reconocerlo: el
proyecto pasó meses acumulando datos y semanas verificando el mapeo antes de
preguntarse si la pregunta era contestable con la muestra disponible.

**El piso de ruido debería calcularse antes de buscar el efecto, no después de
encontrarlo.** Cuesta una tarde y decide si vale la pena el resto.

---

## Qué sigue

El corpus sirve. Lo que no sirve es preguntarle diferencias entre añadas sobre
una variable tan ruidosa como el crecimiento del NOI de una propiedad individual.

Dos caminos, y los dos evitan el problema en vez de pelearlo:

**Una variable de resultado menos ruidosa.** La morosidad es binaria, tiene
mucha menos varianza que un cociente de dos números con colas gordas, y hace
falta muchísima menos muestra para detectar una diferencia de tasas. Está en los
mismos 10-D que ya se descargan: hoy se lee una sola columna de ese documento.

**Preguntas transversales.** Sin eje temporal, el n pasa de ~120 por celda a
miles. Cómo varía el debt yield suscrito por tipo de activo controlando por LTV,
qué estructuras de deuda concentran qué perfiles, cómo se distribuyen las
reservas. Ahí el corpus está sobrado de muestra.

Lo que **no** haría: más trusts sobre la misma pregunta. Duplica el trabajo de
mapeo para mover el piso de ruido de 6,6 a 4,7 puntos.

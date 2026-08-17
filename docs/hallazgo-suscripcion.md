# Tres hipótesis muertas y el instrumento que las mató

> **Estado: el hallazgo principal de este proyecto es falso.**
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

**Tres de tres.** Ese patrón importa más que cualquiera de las tres por separado.

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

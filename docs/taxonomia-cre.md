# Taxonomía CRE

> Versión 2026.08.4 · 94 métricas

Este documento describe cómo interpretamos las columnas de un Annex A de CMBS.
Está pensado para que alguien que suscribe deals pueda revisarlo y marcar qué
está mal o qué falta, sin leer código.

**Por qué existe.** Los datos son públicos: cualquiera puede bajar los mismos
filings de SEC. Lo que no es trivial es interpretarlos. Un Annex A publica el
NOI en cuatro añadas, el LTV contra tres denominadores distintos y el DSCR
sobre dos bases. Confundirlos produce números plausibles y equivocados —el
tipo de error que no salta a la vista y contamina todo lo que se derive.

## Errores que motivaron estas distinciones

Cada uno se detectó con datos reales. En todos los casos el valor extraído
era correcto y la etiqueta estaba mal.

**Annual Debt Service (P&I)** — Esta métrica no existía: el bloque entero del Annex A que la contiene se descartaba porque ninguna de sus columnas estaba mapeada. Veníamos leyendo el DSCR ya calculado sin tener nunca sus dos partes, o sea sin poder verificarlo ni recalcularlo bajo otro supuesto.

**Underwritten TI / LC** — Junto con underwritten_replacement_reserve es la diferencia entre NOI y NCF. Sin ellas teníamos las dos puntas de esa resta y ninguno de los sustraendos, así que no se podía verificar que NCF = NOI − reservas.

**Underwritten NOI** — El encabezado 'Underwritten NOI DSCR (x)' contiene las palabras 'Underwritten' y 'NOI', así que un patrón genérico se lo llevaba. El NOI de un hotel quedó guardado como 1.83 —su DSCR— en vez de $10.932.267.

**Most Recent NOI** — Sin distinguirlas, ganaba la que aparecía primero en la planilla —que suele ser la más vieja. Un hotel en Chicago reportaba $9,7M cuando su NOI último era $11,4M: un 17% de diferencia, con la etiqueta equivocada.

**LTV** — Mapeamos 'Whole Loan Cut-off Date LTV' en vez de 'Cut-off Date LTV'. Como solo los préstamos partidos tienen whole loan, la cobertura quedó en 8 de 32 préstamos. El valor era correcto; la métrica, otra.

**Loan Amount** — Apuntaba a 'Original Balance ($)' sin excluir calificadores. Tysons Corner Center quedó con $2.460.000 —la rebanada de este trust en un préstamo de $709M— y el debt yield calculado daba 3947%. Lo delataron las identidades aritméticas: el saldo implícito por debt yield y el implícito por LTV coincidían en 288x hasta el tercer dígito.

**Interest Rate** — Una serie temporal mostró tasas medianas de 84% y 0% en ciertos trimestres. El valor crudo era '480' y '360': plazos de amortización en meses que llegaban a la columna de tasa por una tabla mal adoptada. Ninguna validación de rango existía porque cada valor suelto parecía un porcentaje.

**Co-op Units** — Marqué como dato roto un LTV mediano de 11% en una familia de emisores, asumiendo que un préstamo de CMBS no cotiza así. La aritmética decía lo contrario —préstamo de $8,5M contra tasación de $38,6M, cap rate normal de 5,9%— y las columnas que lo explicaban llevaban horas en la lista de encabezados sin mapear, descartadas por parecer de nicho. El error fue de interpretación, no de extracción: los datos siempre estuvieron bien.

**Occupancy** — Una exclusión de /economic/ pensada para separarlas terminó descartando la única ocupación que ese Annex publicaba, y quedamos sin ninguna.

**Units** — Un galpón entró al índice con 425.000 unidades. El chequeo de sanidad lo detectó, pero el diagnóstico inicial fue equivocado: se creyó que era un error de mapeo cuando era semántico.

**Square Feet** — El patrón /nra/ se llevaba 'Largest Tenant % of NRA'. En Tysons Corner Center guardábamos 14 como superficie —el porcentaje que ocupa el inquilino principal— en vez de los pies cuadrados. Un valor de dos dígitos donde debería haber seis, invisible salvo mirando la procedencia fila por fila.

**Loan / Property Flag** — Un préstamo de $70M sobre dos hoteles se contaba como tres deals y sumaba $140M al pool.

## Métricas

### Resultado operativo

#### Third Most Recent NOI

`noi_third_most_recent` · moneda · nivel propiedad

El NOI de hace tres períodos.

<details><summary>Encabezados que la capturan</summary>

```
  third most recent … noi
  third most recent net operating

  se descarta si contiene:
    dscr
    debt yield
    date
    description
    reserve
    ff & e
    ti / lc
    cash flow
    egi
    expenses
    occupancy
```

</details>

#### Second Most Recent NOI

`noi_second_most_recent` · moneda · nivel propiedad

El NOI del anteúltimo período cerrado, típicamente hace dos años.

**Cómo se distingue.** Junto con third most recent forma la serie histórica. Tenerlas separadas permite contestar cómo viene evolucionando una propiedad, no solo dónde está.

<details><summary>Encabezados que la capturan</summary>

```
  second most recent … noi
  second most recent net operating

  se descarta si contiene:
    dscr
    debt yield
    date
    description
    reserve
    ff & e
    ti / lc
    cash flow
    egi
    expenses
    occupancy
```

</details>

#### Most Recent NOI

`noi_most_recent` · moneda · nivel propiedad

El NOI del último período cerrado, normalmente los últimos doce meses. Es lo que la propiedad produjo de verdad.

**Cómo se distingue.** Un Annex A publica hasta cuatro añadas de NOI. El patrón /most recent.*noi/ matchea también 'Second Most Recent' y 'Third Most Recent'.

<details><summary>Encabezados que la capturan</summary>

```
  (most recent|t-12|ttm|trailing) … noi
  noi … (most recent|t-12|ttm|trailing)
  (most recent|trailing) net operating income

  se descarta si contiene:
    dscr
    debt yield
    date
    description
    reserve
    ff & e
    ti / lc
    cash flow
    egi
    expenses
    occupancy
    (second|third|fourth) most recent
```

</details>

#### Underwritten NOI

`noi_underwritten` · moneda · nivel propiedad

El NOI que el originador proyecta para el préstamo. Es una estimación, no un dato histórico: incorpora leases firmados que todavía no producen, ahorros esperados y estabilización proyectada.

**Cómo se distingue.** No es lo mismo que el NOI real. La diferencia entre ambos mide cuánto estira la suscripción, y es una de las pocas señales de agresividad de mercado calculables con datos públicos.

<details><summary>Encabezados que la capturan</summary>

```
  (uw|u/w|underwrit\w*) … noi
  noi … (uw|u/w|underwrit\w*)
  underwritten net operating income
  noi
  net operating income

  se descarta si contiene:
    most recent
    t-12
    ttm
    trailing
    ncf
    dscr
    debt yield
    date
    description
    reserve
    ff & e
    ti / lc
    cash flow
    egi
    expenses
    occupancy
```

</details>

#### Effective Gross Income

`effective_gross_income` · moneda · nivel propiedad

Ingreso bruto potencial menos vacancia, concesiones e incobrables. El numerador antes de restar gastos.

<details><summary>Encabezados que la capturan</summary>

```
  egi
  effective gross income

  se descarta si contiene:
    (second|third|fourth) most recent
```

</details>

#### Operating Expenses

`operating_expenses` · moneda · nivel propiedad

Gastos operativos del período. EGI menos gastos da el NOI.

<details><summary>Encabezados que la capturan</summary>

```
  operating expenses
  opex
  total expenses
  expenses
  expenses \(\)

  se descarta si contiene:
    (second|third|fourth) most recent
```

</details>

#### Net Cash Flow

`net_cash_flow` · moneda · nivel propiedad

NOI menos las reservas de capital: reemplazos, mejoras de inquilino y comisiones de corretaje. Es lo que efectivamente queda para servir la deuda.

**Cómo se distingue.** Siempre menor que el NOI. Los ratios calculados sobre NCF son más conservadores que los calculados sobre NOI, y un Annex A publica ambos.

<details><summary>Encabezados que la capturan</summary>

```
  net cash flow

  se descarta si contiene:
    dscr
    debt yield
```

</details>

### Ocupación

#### Economic Occupancy

`occupancy_economic` · porcentaje · nivel propiedad

Ocupación económica: proporción del ingreso potencial que efectivamente se cobra, después de concesiones, períodos de gracia e incobrables.

**Cómo se distingue.** Un edificio puede estar 100% arrendado y tener 85% de ocupación económica si dio meses gratis. La brecha entre ambas es una señal de blandura del mercado.

<details><summary>Encabezados que la capturan</summary>

```
  economic occupancy
  economic occ

  se descarta si contiene:
    date
```

</details>

#### Occupancy

`occupancy` · porcentaje · nivel propiedad

Ocupación física o arrendada: qué proporción del espacio está ocupada o bajo contrato.

**Cómo se distingue.** Distinta de la económica, que descuenta concesiones e incobrables y siempre es menor o igual. Muchos Annex A publican solo una de las dos.

<details><summary>Encabezados que la capturan</summary>

```
  physical occ
  % occupied
  occupied … %
  occupancy

  se descarta si contiene:
    economic
    date
    area
    rentable
    sf
    square
```

</details>

### Físico

#### Unit of Measure

`unit_of_measure` · texto · nivel propiedad

Qué cuenta la columna de unidades: Units, Rooms, Pads, Beds o SF. Sin este dato, comparar activos no tiene sentido.

<details><summary>Encabezados que la capturan</summary>

```
  unit of measure
  measure
```

</details>

#### Units

`units` · conteo · nivel propiedad

Cantidad de unidades contables: departamentos, habitaciones de hotel, lotes o camas según el tipo de activo.

**Cómo se distingue.** Un Annex A usa una sola columna 'Number of Units' para todo y una columna aparte, 'Unit of Measure', dice qué se está contando. Cuando la medida es de superficie, el número NO son unidades.

<details><summary>Encabezados que la capturan</summary>

```
  number of units
  # of units
  units / (rooms|pads|beds|keys)
  units
  (rooms|keys|pads)

  se descarta si contiene:
    per unit
    / unit
    price
    of measure
```

</details>

#### Square Feet

`square_feet` · conteo · nivel propiedad

Superficie rentable neta.

**Cómo se distingue.** Puede venir de una columna propia o de 'Number of Units' cuando la medida es SF. Multifamily y hotelería reportan unidades; oficinas, retail e industrial reportan superficie.

<details><summary>Encabezados que la capturan</summary>

```
  net rentable area
  square feet
  sq. ft.
  nra
  gla
  sf

  se descarta si contiene:
    per s(q|f)
    / s(q|f)
    price
    rent roll
    %
    percent
    share
    largest tenant
    tenant \d
```

</details>

#### Year Built

`year_built` · año · nivel propiedad

Año de construcción.

**Cómo se distingue.** Los préstamos sobre varias propiedades reportan 'Various'. Eso es ausencia de dato, no un año.

<details><summary>Encabezados que la capturan</summary>

```
  year built
  built
  yoc
```

</details>

### Saldos

#### Loan Amount

`loan_amount` · moneda · nivel préstamo

El saldo que ESTE trust tiene del préstamo a la fecha de corte. Es lo que compró la emisión, no lo que debe el prestatario.

**Cómo se distingue.** Un Annex A publica siete saldos del mismo préstamo y este es solo uno. Los ratios que publica el emisor —debt yield, DSCR, LTV— no se calculan contra este número cuando el préstamo está repartido entre varios trusts: se calculan contra el préstamo completo, porque el NOI que publica es el de la propiedad entera.

<details><summary>Encabezados que la capturan</summary>

```
  cut-off date (principal )balance
  original (principal )balance
  loan amount
  original loan

  se descarta si contiene:
    per (unit|sf|room|key)
    / (unit|sf)
    whole loan
    pari passu
    companion
    subordinate
    mezzanine
    total debt
    maturity|ard
    %|percent
    ground lease
    pool
```

</details>

#### Whole Loan Cut-off Date Balance

`balance_whole_loan` · moneda · nivel préstamo

El saldo del préstamo completo, sumando todas las notas pari passu estén donde estén.

**Cómo se distingue.** Este es el número contra el que el emisor calcula sus ratios, porque el NOI que publica es el de la propiedad entera. Comparar el NOI completo contra la porción del trust es comparar cosas de escalas distintas.

<details><summary>Encabezados que la capturan</summary>

```
  whole loan cut-off date balance
  whole loan balance

  se descarta si contiene:
    %|percent
    ltv
    dscr
    debt yield
```

</details>

#### Non-Trust Pari Passu Companion Loan Cut-off Date Balance

`balance_pari_passu_non_trust` · moneda · nivel préstamo

La parte del préstamo que está en OTRAS emisiones, con la misma prioridad de cobro que la nuestra.

**Cómo se distingue.** Sumado al saldo del trust da el total senior. 'Pari passu' significa que cobran a la par: ninguna nota está subordinada a la otra, solo repartidas entre emisiones distintas.

<details><summary>Encabezados que la capturan</summary>

```
  non- trust pari passu … balance

  se descarta si contiene:
    %|percent
```

</details>

#### Subordinate Companion Loan Cut-off Date Balance

`balance_subordinate` · moneda · nivel préstamo

Deuda del mismo inmueble que cobra DESPUÉS que las notas senior. Suele llamarse B-note.

**Cómo se distingue.** No es pari passu: está subordinada. Por eso el LTV 'whole loan' y el LTV a secas difieren —uno la incluye y el otro no— y por eso un préstamo puede verse conservador a nivel trust y apalancado a nivel inmueble.

<details><summary>Encabezados que la capturan</summary>

```
  subordinate companion … balance
  b-note … balance

  se descarta si contiene:
    %|percent
```

</details>

#### Mezzanine Debt Cut-off Date Balance

`balance_mezzanine` · moneda · nivel préstamo

Deuda garantizada por las participaciones societarias del dueño, no por el inmueble.

**Cómo se distingue.** No aparece en el LTV del préstamo pero existe y compite por el mismo flujo. Es la capa que hace que 'total debt LTV' sea mayor que 'whole loan LTV'.

<details><summary>Encabezados que la capturan</summary>

```
  mezzanine debt … balance
  mezz … balance

  se descarta si contiene:
    %|percent
    rate
```

</details>

#### Original Balance

`balance_original` · moneda · nivel préstamo

El monto al originar, antes de cualquier amortización.

**Cómo se distingue.** Difiere del saldo a la fecha de corte solo en préstamos que ya amortizaron algo. En un pool mayoritariamente interest-only son casi idénticos, y esa coincidencia es justamente lo que hace fácil confundirlos.

<details><summary>Encabezados que la capturan</summary>

```
  original balance at securiti[sz]ation
  balance at origination
  original (principal )balance

  se descarta si contiene:
    whole loan
    pari passu
    companion
    subordinate
    mezzanine
    %|percent
    cut-off
```

</details>

### Valuación

#### Appraised Value

`appraised_value` · moneda · nivel propiedad

Valor de tasación usado para calcular el LTV.

**Cómo se distingue.** Los Annex A publican además un 'Appraised Value Type' que indica si es valor as-is, as-stabilized o as-complete. Sin ese calificador, comparar tasaciones entre préstamos puede engañar.

<details><summary>Encabezados que la capturan</summary>

```
  appraised value
  appraisal value
  value

  se descarta si contiene:
    date
    per
```

</details>

#### Cap Rate

`cap_rate` · porcentaje · nivel propiedad

Tasa de capitalización: NOI sobre valor.

**Cómo se distingue.** Cuando no viene publicada se puede derivar del NOI y la tasación, pero el resultado depende de qué NOI se use —underwritten o real— y las dos dan números distintos.

<details><summary>Encabezados que la capturan</summary>

```
  cap rate
  capitalization rate
```

</details>

### Estructura de deuda

#### Whole Loan LTV

`ltv_whole_loan` · porcentaje · nivel préstamo

LTV medido contra el préstamo completo, incluidas las notas pari passu que quedaron en otros trusts.

**Cómo se distingue.** Solo existe para préstamos partidos. Su ausencia en un préstamo no es un dato faltante: significa que no está estructurado así.

<details><summary>Encabezados que la capturan</summary>

```
  whole loan … ltv
  ltv … whole loan

  se descarta si contiene:
    maturity
    ard
```

</details>

#### Total Debt LTV

`ltv_total_debt` · porcentaje · nivel préstamo

LTV incluyendo toda la deuda sobre la propiedad: el préstamo hipotecario más mezzanine y subordinada.

**Cómo se distingue.** Es el apalancamiento real del activo. Puede ser sustancialmente mayor que el LTV del trust, y es el número que importa para evaluar riesgo de default.

<details><summary>Encabezados que la capturan</summary>

```
  total debt … ltv
  ltv … total debt

  se descarta si contiene:
    maturity
    ard
```

</details>

#### LTV at Maturity

`ltv_maturity` · porcentaje · nivel préstamo

LTV proyectado al vencimiento o a la fecha de amortización anticipada, después de la amortización del período.

**Cómo se distingue.** Mide riesgo de refinanciación, no apalancamiento de origen. En préstamos interest-only coincide con el LTV de cierre.

<details><summary>Encabezados que la capturan</summary>

```
  ltv … (maturity|ard|balloon)
  (maturity|balloon) … ltv
```

</details>

#### LTV

`ltv` · porcentaje · nivel préstamo

Loan-to-value del préstamo que está en ESTE trust, medido contra la tasación al cierre.

**Cómo se distingue.** Un préstamo grande se parte en notas pari passu que se reparten entre varios trusts. El LTV del trust mide solo el pedazo securitizado acá; el whole loan mide el préstamo entero; el total debt suma además mezzanine y subordinada. Tres denominadores distintos.

<details><summary>Encabezados que la capturan</summary>

```
  cut-off date ltv
  ltv
  loan[-\s]*to[-\s]*value

  se descarta si contiene:
    maturity
    balloon
    ard
    whole loan
    total debt
    coop
```

</details>

#### Whole Loan DSCR

`dscr_whole_loan` · ratio · nivel préstamo

DSCR contra el servicio de deuda del préstamo completo, no solo el pedazo del trust.

<details><summary>Encabezados que la capturan</summary>

```
  whole loan … dscr
  dscr … whole loan
```

</details>

#### Total Debt DSCR

`dscr_total_debt` · ratio · nivel préstamo

DSCR contra el servicio de toda la deuda, incluida la mezzanine.

<details><summary>Encabezados que la capturan</summary>

```
  total debt … dscr
  dscr … total debt
```

</details>

#### NCF DSCR

`dscr_ncf` · ratio · nivel préstamo

Cobertura calculada sobre net cash flow, o sea después de reservas de capital. La medida conservadora.

<details><summary>Encabezados que la capturan</summary>

```
  ncf dscr
  dscr … ncf

  se descarta si contiene:
    whole loan
    total debt
```

</details>

#### DSCR

`dscr` · ratio · nivel préstamo

Cobertura del servicio de deuda calculada sobre NOI: cuántas veces el resultado operativo cubre los pagos.

**Cómo se distingue.** Distinguir del DSCR sobre NCF, que descuenta reservas y siempre da menor. Y de las variantes whole loan y total debt, que cambian el denominador.

<details><summary>Encabezados que la capturan</summary>

```
  noi dscr
  dscr
  debt service coverage

  se descarta si contiene:
    ncf
    whole loan
    total debt
```

</details>

#### Whole Loan Debt Yield

`debt_yield_whole_loan` · porcentaje · nivel préstamo

Debt yield contra el saldo del préstamo completo.

<details><summary>Encabezados que la capturan</summary>

```
  whole loan … debt yield
  debt yield … whole loan
```

</details>

#### Total Debt Debt Yield

`debt_yield_total_debt` · porcentaje · nivel préstamo

Debt yield contra el total de la deuda sobre la propiedad.

<details><summary>Encabezados que la capturan</summary>

```
  total debt … debt yield
```

</details>

#### NCF Debt Yield

`debt_yield_ncf` · porcentaje · nivel préstamo

Debt yield calculado sobre net cash flow.

<details><summary>Encabezados que la capturan</summary>

```
  ncf debt yield
  debt yield … ncf

  se descarta si contiene:
    whole loan
    total debt
```

</details>

#### Debt Yield

`debt_yield` · porcentaje · nivel préstamo

NOI dividido el saldo del préstamo. Mide el retorno del prestamista si tuviera que tomar la propiedad, sin depender de tasaciones.

**Cómo se distingue.** A diferencia del LTV, no usa el valor tasado, así que no se distorsiona cuando las tasaciones se inflan. Por eso muchos suscriptores lo prefieren.

<details><summary>Encabezados que la capturan</summary>

```
  noi debt yield
  debt yield

  se descarta si contiene:
    ncf
    whole loan
    total debt
```

</details>

#### Interest Rate

`interest_rate` · porcentaje · nivel préstamo

Tasa del préstamo hipotecario.

**Cómo se distingue.** Un Annex A publica además la tasa de la deuda subordinada y la de la mezzanine, que cotizan muy por encima. Mezclarlas contamina cualquier serie de costo de deuda.

<details><summary>Encabezados que la capturan</summary>

```
  interest rate
  coupon
  mortgage rate

  se descarta si contiene:
    type
    accrual
    mezzanine
    mezz
    subordinate
    companion
    b-note
```

</details>

### Cooperativas

#### Co-op Units

`coop_units` · conteo · nivel propiedad

Cantidad de unidades de una cooperativa de vivienda. Su presencia identifica al préstamo como cooperativo, que es un segmento con economía propia.

**Cómo se distingue.** Las cooperativas vienen clasificadas como Multifamily pero no se comportan igual: la cooperativa es dueña del edificio y toma deuda mínima contra un valor alto. LTV de 10-20% con DSCR de 4x a 12x es lo normal ahí.

<details><summary>Encabezados que la capturan</summary>

```
  coop … coop units
  co-op units
```

</details>

#### Co-op Sponsor Units

`coop_sponsor_units` · conteo · nivel propiedad

Unidades que todavía retiene el sponsor original de la conversión. Una proporción alta indica una cooperativa poco madura, con más riesgo.

<details><summary>Encabezados que la capturan</summary>

```
  coop … sponsor units
  co-op … sponsor units
```

</details>

#### Co-op Rental Value

`coop_rental_value` · moneda · nivel propiedad

Valor del edificio tasado como propiedad de renta.

<details><summary>Encabezados que la capturan</summary>

```
  coop … rental value
  co-op … rental value
```

</details>

#### Co-op LTV as Rental

`coop_ltv_as_rental` · porcentaje · nivel préstamo

El LTV que tendría el edificio valuado como propiedad de renta en vez de como cooperativa.

**Cómo se distingue.** Es el único número de apalancamiento comparable entre una cooperativa y un multifamily convencional. El LTV normal de una cooperativa no se puede poner en la misma tabla que el del resto.

<details><summary>Encabezados que la capturan</summary>

```
  coop … ltv … rental
  ltv as rental
```

</details>

### Estructura del documento

#### Loan / Property Flag

`loan_property_flag` · texto · nivel préstamo

Indica si la fila describe un préstamo o una de las propiedades que lo garantizan.

**Cómo se distingue.** Un préstamo sobre tres propiedades genera cuatro filas: una del préstamo y tres de propiedades. Tratarlas todas como préstamos multiplica el portfolio y suma el balance varias veces.

<details><summary>Encabezados que la capturan</summary>

```
  loan / property flag
  loan or property
```

</details>

#### Loan ID

`loan_id` · texto · nivel préstamo

Identificador del préstamo dentro del pool. Es la clave que permite unir los bloques horizontales en que viene partido el Annex A.

<details><summary>Encabezados que la capturan</summary>

```
  loan id
  loan id number
```

</details>

### Reservas

#### Upfront TI/LC Reserve

`reserve_tilc_upfront` · moneda · nivel préstamo

Dinero efectivamente depositado al cierre para cubrir futuras comisiones y mejoras de inquilinos.

**Cómo se distingue.** Es un saldo real, a diferencia de underwritten_tilc que es un supuesto. Un edificio con vacancia alta suele traer una reserva grande acá: el prestamista quiere el dinero apartado antes de prestar.

<details><summary>Encabezados que la capturan</summary>

```
  upfront ti / lc

  se descarta si contiene:
    caps
    underwritten
```

</details>

#### Upfront Debt Service Reserve

`reserve_debt_service_upfront` · moneda · nivel préstamo

Fondo depositado al cierre para pagar cuotas si el flujo no alcanza.

**Cómo se distingue.** Contiene la frase 'Debt Service' igual que las métricas de servicio de deuda, pero es lo contrario: no es una obligación, es un colchón contra ella. Su presencia suele indicar que el prestamista dudaba de que la propiedad cubriera la cuota desde el día uno.

<details><summary>Encabezados que la capturan</summary>

```
  upfront debt service reserve

  se descarta si contiene:
    caps
```

</details>

#### Underwritten Replacement / FF&E Reserve

`underwritten_replacement_reserve` · moneda · nivel propiedad

Deducción anual por reposición de componentes de capital —techos, equipos, mobiliario en hoteles—. Como la anterior, es un ajuste de cálculo, no un depósito.

**Cómo se distingue.** Su gemela en escrow es 'Upfront Replacement / PIP Reserve'. En hoteles aparece como FF&E, que es la misma idea con otro nombre.

<details><summary>Encabezados que la capturan</summary>

```
  underwritten replacement
  underwritten … ff & e reserve
```

</details>

#### Underwritten TI / LC

`underwritten_tilc` · moneda · nivel propiedad

Deducción anual que el suscriptor resta del NOI en concepto de comisiones de corretaje y mejoras para inquilinos. No es plata que exista: es un ajuste para estimar el flujo sostenible.

**Cómo se distingue.** Se confunde con 'Upfront TI/LC Reserve', que sí es plata depositada en escrow al cierre. Una es un supuesto del modelo y la otra es un saldo bancario. El encabezado se diferencia solo por la primera palabra —'Underwritten' contra 'Upfront'— y ambos contienen 'TI/LC'.

<details><summary>Encabezados que la capturan</summary>

```
  underwritten ti / lc
```

</details>

### Servicio de deuda

#### Annual Debt Service (P&I)

`debt_service_pi` · moneda · nivel préstamo

El pago anual de capital e intereses que el préstamo exige una vez que empieza a amortizar. Es el denominador del DSCR.

**Cómo se distingue.** Convive con 'Annual Debt Service (IO)', que es el pago durante el período de solo intereses y siempre es menor. Un préstamo con dos años de IO tiene dos servicios de deuda distintos según el momento, y el DSCR publicado suele calcularse contra el de IO —lo que lo hace ver mejor de lo que va a ser cuando empiece a amortizar.

<details><summary>Encabezados que la capturan</summary>

```
  annual debt service \( p & i
  debt service \( p & i

  se descarta si contiene:
    reserve
    coverage
    dscr
```

</details>

#### Annual Debt Service (IO)

`debt_service_io` · moneda · nivel préstamo

El pago anual durante el período de solo intereses, sin amortización de capital.

**Cómo se distingue.** Siempre menor que el P&I. La diferencia entre ambos es cuánto sube la cuota cuando termina el IO, y es la medida directa del riesgo de refinanciación de un préstamo que hoy cumple cómodo.

<details><summary>Encabezados que la capturan</summary>

```
  annual debt service \( io
  debt service \( io

  se descarta si contiene:
    reserve
    coverage
    dscr
```

</details>

#### Amortization Type

`amortization_type` · texto · nivel préstamo

Cómo devuelve capital el préstamo: 'Interest Only' toda la vida, 'Amortizing' desde el principio, o 'Interest Only, Amortizing' con IO parcial.

**Cómo se distingue.** Un pool con mayoría de Interest Only no amortiza nada, así que todo el capital vence al final. Es una característica estructural que ninguna métrica de ratio muestra.

<details><summary>Encabezados que la capturan</summary>

```
  amorti[sz]ation type
```

</details>

#### ARD Loan

`ard_loan` · texto · nivel préstamo

Si el préstamo tiene Anticipated Repayment Date: una fecha en la que se espera el repago y a partir de la cual la tasa sube fuerte y el flujo se barre para amortizar.

**Cómo se distingue.** El ARD funciona como vencimiento efectivo aunque el vencimiento legal sea posterior. Los LTV y DSCR 'a vencimiento' de un préstamo con ARD se calculan al ARD, no al vencimiento legal.

<details><summary>Encabezados que la capturan</summary>

```
  ard loan
```

</details>

#### Original Amortization Term

`amortization_term_original` · conteo · nivel préstamo

Plazo sobre el que se calcula la cuota, en meses. Normalmente 360, aunque el préstamo venza mucho antes.

**Cómo se distingue.** Es un supuesto de cálculo, no una fecha real. Los dos plazos comparten la palabra 'term' y la unidad, y confundirlos triplica o divide por tres el horizonte del préstamo.

<details><summary>Encabezados que la capturan</summary>

```
  original amorti[sz]ation term
```

</details>

#### Original Term To Maturity / ARD

`term_original` · conteo · nivel préstamo

Plazo original hasta el vencimiento o la fecha de ARD, en meses.

**Cómo se distingue.** No confundir con el plazo de amortización, que suele ser mucho más largo —360 meses típicamente— y define la cuota, no el vencimiento. Un préstamo con plazo 120 y amortización 360 devuelve una fracción chica del capital antes de vencer.

<details><summary>Encabezados que la capturan</summary>

```
  original term to maturity

  se descarta si contiene:
    amorti
    interest[-\s]*only
```

</details>

### Control de flujo

#### Holdback / Earnout Amount

`holdback_amount` · moneda · nivel préstamo

Parte del préstamo aprobada pero no desembolsada, que se libera si la propiedad cumple una condición —alquilar un espacio, alcanzar un NOI—.

**Cómo se distingue.** Un holdback grande indica que el saldo actual no refleja el préstamo completo. Los ratios calculados sobre el saldo desembolsado se ven mejores de lo que van a ser cuando se libere el resto.

<details><summary>Encabezados que la capturan</summary>

```
  holdback / earnout amount
  earnout amount

  se descarta si contiene:
    description
```

</details>

#### Lockbox Type

`lockbox_type` · texto · nivel préstamo

Quién cobra el alquiler. 'Hard' significa que los inquilinos pagan directo a una cuenta controlada por el prestamista; 'Soft' que paga el prestatario y transfiere; 'Springing' que se activa si se rompe un umbral.

**Cómo se distingue.** Es una de las pocas variables del Annex A que describe control en vez de magnitud. Dos préstamos con el mismo DSCR y distinto lockbox tienen severidades de pérdida muy distintas si el prestatario se estresa.

<details><summary>Encabezados que la capturan</summary>

```
  lockbox
```

</details>

#### Cash Management

`cash_management` · texto · nivel préstamo

Si el excedente de caja queda barrido en cuentas del prestamista. Suele activarse por gatillo, no desde el cierre.

<details><summary>Encabezados que la capturan</summary>

```
  cash management
```

</details>

### Otras

#### Prior Period EGI

`egi_prior_period` · moneda · nivel propiedad

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  (second|third|fourth) most recent … egi
  (second|third|fourth) most recent effective gross
```

</details>

#### Prior Period Expenses

`expenses_prior_period` · moneda · nivel propiedad

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  (second|third|fourth) most recent … expenses
```

</details>

#### Year Renovated

`year_renovated` · año · nivel propiedad

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  year renovated
  renovated
```

</details>

#### Detailed Property Type

`property_type_detailed` · texto · nivel propiedad

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  detailed property type
  property sub-type
```

</details>

#### Mezzanine Interest Rate

`interest_rate_mezzanine` · porcentaje · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  mezzanine … (interest )rate
  mezz … rate
```

</details>

#### Subordinate Interest Rate

`interest_rate_subordinate` · porcentaje · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  subordinate … (interest )rate
  companion loan … rate
  b-note … rate
```

</details>

#### Property Type

`property_type` · texto · nivel propiedad

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  property type
  type
  asset type

  se descarta si contiene:
    loan
    rate
    sub
```

</details>

#### Property Name

`property_name` · texto · nivel propiedad

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  property name
  property
  loan name

  se descarta si contiene:
    type
    address
    city
    state
```

</details>

#### Address

`address` · texto · nivel propiedad

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  address
  street
```

</details>

#### City

`city` · texto · nivel propiedad

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  city
```

</details>

#### State

`state` · texto · nivel propiedad

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  state
```

</details>

#### Zip

`zip` · texto · nivel propiedad

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  zip
  postal code
```

</details>

#### Upfront RE Tax Reserve

`reserve_tax_upfront` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  upfront (re )tax reserve
  tax reserve … upfront
```

</details>

#### Monthly RE Tax Reserve

`reserve_tax_monthly` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  monthly (re )tax reserve
```

</details>

#### Upfront Insurance Reserve

`reserve_insurance_upfront` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  upfront insurance reserve
```

</details>

#### Monthly Insurance Reserve

`reserve_insurance_monthly` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  monthly insurance reserve
```

</details>

#### Replacement Reserve Cap

`reserve_replacement_cap` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  replacement reserve caps
  (replacement|ff & e) … caps

  se descarta si contiene:
    ti / lc
```

</details>

#### Upfront Replacement / PIP Reserve

`reserve_replacement_upfront` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  upfront replacement
  upfront … pip

  se descarta si contiene:
    caps
```

</details>

#### Monthly Replacement / FF&E Reserve

`reserve_replacement_monthly` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  monthly replacement
  monthly … ff & e reserve

  se descarta si contiene:
    caps
```

</details>

#### TI/LC Reserve Cap

`reserve_tilc_cap` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  ti / lc … caps
```

</details>

#### Monthly TI/LC Reserve

`reserve_tilc_monthly` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  monthly ti / lc

  se descarta si contiene:
    caps
    underwritten
```

</details>

#### Debt Service Reserve Cap

`reserve_debt_service_cap` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  debt service reserve caps
```

</details>

#### Monthly Debt Service Reserve

`reserve_debt_service_monthly` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  monthly debt service reserve

  se descarta si contiene:
    caps
```

</details>

#### Upfront Deferred Maintenance Reserve

`reserve_deferred_maintenance` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  deferred maintenance
```

</details>

#### Other Reserve Description

`reserve_other_description` · texto · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  other reserve description
```

</details>

#### Other Reserve Cap

`reserve_other_cap` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  other reserve caps
```

</details>

#### Upfront Other Reserve

`reserve_other_upfront` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  upfront other reserve

  se descarta si contiene:
    caps
    description
```

</details>

#### Monthly Other Reserve

`reserve_other_monthly` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  monthly other reserve

  se descarta si contiene:
    caps
    description
```

</details>

#### Interest Accrual Method

`interest_accrual_method` · texto · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  interest accrual method
  accrual (method|basis)
```

</details>

#### Original Interest-Only Period

`io_period_original` · conteo · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  original interest[-\s]*only period
  original io period
```

</details>

#### Remaining Interest-Only Period

`io_period_remaining` · conteo · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  remaining interest[-\s]*only period
  remaining io period
```

</details>

#### Remaining Amortization Term

`amortization_term_remaining` · conteo · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  remaining amorti[sz]ation term
```

</details>

#### Remaining Term To Maturity / ARD

`term_remaining` · conteo · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  remaining term to maturity

  se descarta si contiene:
    amorti
    interest[-\s]*only
```

</details>

#### Origination Date

`origination_date` · texto · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  origination date
```

</details>

#### First Payment Date

`first_payment_date` · texto · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  first payment date
```

</details>

#### Seasoning

`seasoning_months` · conteo · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  seasoning
```

</details>

#### # of Properties

`property_count` · conteo · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  # of properties
  number of properties
```

</details>

#### Holdback / Earnout Description

`holdback_description` · texto · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  holdback / earnout description
  earnout description
```

</details>

#### Trust Pari Passu Cut-off Date Balance

`balance_pari_passu_trust` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  trust pari passu … balance

  se descarta si contiene:
    non- trust
    %|percent
```

</details>

#### Maturity / ARD Balance

`balance_maturity` · moneda · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  maturity / ard balance
  balloon balance

  se descarta si contiene:
    %|percent
    ltv
```

</details>

#### % of Initial Pool Balance

`pool_share` · porcentaje · nivel préstamo

*Sin definición documentada.*

<details><summary>Encabezados que la capturan</summary>

```
  % of initial pool balance
  % of pool
```

</details>

## Cómo revisar esto

Las preguntas que más valor tienen si trabajás en el rubro:

1. ¿Alguna definición está mal?
2. ¿Falta alguna distinción que importe? Por ejemplo: ¿conviene separar
   ocupación por tipo de activo, o el NOI ajustado por inquilinos únicos?
3. ¿Alguna de estas distinciones es irrelevante en la práctica?
4. ¿Hay columnas del Annex A que no capturamos y deberíamos?

Para ver qué columnas quedaron sin mapear en el corpus actual: `npm run db:stats`.

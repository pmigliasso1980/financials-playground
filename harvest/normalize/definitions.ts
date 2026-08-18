/**
 * Definiciones de la taxonomía CRE.
 *
 * POR QUÉ ESTE ARCHIVO EXISTE APARTE
 *
 * `columnMap.ts` resuelve el problema técnico: qué patrón matchea qué columna.
 * Este archivo guarda el problema de dominio: qué significa cada métrica y por
 * qué se distingue de sus vecinas.
 *
 * La separación es deliberada. Los patrones son código y los revisa un
 * programador; las definiciones son conocimiento del rubro y las tiene que
 * poder revisar alguien que suscriba deals, sin leer TypeScript. De acá sale
 * `npm run taxonomy`, que genera un documento para eso.
 *
 * Cada entrada que existe acá se ganó su lugar rompiendo algo con datos reales.
 * Las que no tienen nota es porque nunca dieron problema.
 */

import type { MetricKey } from "./columnMap.js";

/**
 * Versión de la taxonomía.
 *
 * Se registra con cada observation para poder medir si un cambio mejoró o
 * empeoró la cobertura del corpus. Subir cuando se agregan o redefinen
 * métricas, no cuando se ajusta un patrón.
 */
/**
 * 2026.08.17: el corpus pasa a guardar las filas de propiedad.
 *
 * Se sube la versión porque el contenido de una cosecha cambió, no porque cambió
 * una métrica. `harvest:batch` recosecha lo que no coincida con esta versión, así
 * que las 233 emisiones quedan marcadas para volver a bajar — es la única forma de
 * llenar corpus.properties sin escribir un camino de migración aparte.
 */
export const TAXONOMY_VERSION = "2026.08.17";

export interface MetricDefinition {
  /** Qué mide, en una oración que entienda alguien del rubro. */
  definition: string;
  /**
   * Con qué se confunde y cómo distinguirlas. Solo donde hubo un problema real.
   */
  disambiguation?: string;
  /** Qué pasó cuando estuvo mal. La evidencia de por qué la distinción importa. */
  incident?: string;
  /** Familia conceptual, para agrupar en el documento. */
  family?: string;
}

export const DEFINITIONS: Partial<Record<MetricKey, MetricDefinition>> = {
  // -------------------------------------------------------------------------
  // Los siete saldos
  // -------------------------------------------------------------------------

  balance_whole_loan: {
    family: "Saldos",
    definition:
      "El saldo del préstamo completo, sumando todas las notas pari passu estén donde estén.",
    disambiguation:
      "Este es el número contra el que el emisor calcula sus ratios, porque el NOI que publica es el de la propiedad entera. Comparar el NOI completo contra la porción del trust es comparar cosas de escalas distintas.",
  },
  balance_pari_passu_non_trust: {
    family: "Saldos",
    definition:
      "La parte del préstamo que está en OTRAS emisiones, con la misma prioridad de cobro que la nuestra.",
    disambiguation:
      "Sumado al saldo del trust da el total senior. 'Pari passu' significa que cobran a la par: ninguna nota está subordinada a la otra, solo repartidas entre emisiones distintas.",
  },
  balance_subordinate: {
    family: "Saldos",
    definition:
      "Deuda del mismo inmueble que cobra DESPUÉS que las notas senior. Suele llamarse B-note.",
    disambiguation:
      "No es pari passu: está subordinada. Por eso el LTV 'whole loan' y el LTV a secas difieren —uno la incluye y el otro no— y por eso un préstamo puede verse conservador a nivel trust y apalancado a nivel inmueble.",
  },
  balance_mezzanine: {
    family: "Saldos",
    definition:
      "Deuda garantizada por las participaciones societarias del dueño, no por el inmueble.",
    disambiguation:
      "No aparece en el LTV del préstamo pero existe y compite por el mismo flujo. Es la capa que hace que 'total debt LTV' sea mayor que 'whole loan LTV'.",
  },
  balance_original: {
    family: "Saldos",
    definition: "El monto al originar, antes de cualquier amortización.",
    disambiguation:
      "Difiere del saldo a la fecha de corte solo en préstamos que ya amortizaron algo. En un pool mayoritariamente interest-only son casi idénticos, y esa coincidencia es justamente lo que hace fácil confundirlos.",
  },

  // -------------------------------------------------------------------------
  // Servicio de deuda y estructura del préstamo
  // -------------------------------------------------------------------------

  debt_service_pi: {
    family: "Servicio de deuda",
    definition:
      "El pago anual de capital e intereses que el préstamo exige una vez que empieza a amortizar. Es el denominador del DSCR.",
    disambiguation:
      "Convive con 'Annual Debt Service (IO)', que es el pago durante el período de solo intereses y siempre es menor. Un préstamo con dos años de IO tiene dos servicios de deuda distintos según el momento, y el DSCR publicado suele calcularse contra el de IO —lo que lo hace ver mejor de lo que va a ser cuando empiece a amortizar.",
    incident:
      "Esta métrica no existía: el bloque entero del Annex A que la contiene se descartaba porque ninguna de sus columnas estaba mapeada. Veníamos leyendo el DSCR ya calculado sin tener nunca sus dos partes, o sea sin poder verificarlo ni recalcularlo bajo otro supuesto.",
  },
  debt_service_io: {
    family: "Servicio de deuda",
    definition:
      "El pago anual durante el período de solo intereses, sin amortización de capital.",
    disambiguation:
      "Siempre menor que el P&I. La diferencia entre ambos es cuánto sube la cuota cuando termina el IO, y es la medida directa del riesgo de refinanciación de un préstamo que hoy cumple cómodo.",
  },
  amortization_type: {
    family: "Servicio de deuda",
    definition:
      "Cómo devuelve capital el préstamo: 'Interest Only' toda la vida, 'Amortizing' desde el principio, o 'Interest Only, Amortizing' con IO parcial.",
    disambiguation:
      "Un pool con mayoría de Interest Only no amortiza nada, así que todo el capital vence al final. Es una característica estructural que ninguna métrica de ratio muestra.",
  },
  term_original: {
    family: "Servicio de deuda",
    definition: "Plazo original hasta el vencimiento o la fecha de ARD, en meses.",
    disambiguation:
      "No confundir con el plazo de amortización, que suele ser mucho más largo —360 meses típicamente— y define la cuota, no el vencimiento. Un préstamo con plazo 120 y amortización 360 devuelve una fracción chica del capital antes de vencer.",
  },
  amortization_term_original: {
    family: "Servicio de deuda",
    definition:
      "Plazo sobre el que se calcula la cuota, en meses. Normalmente 360, aunque el préstamo venza mucho antes.",
    disambiguation:
      "Es un supuesto de cálculo, no una fecha real. Los dos plazos comparten la palabra 'term' y la unidad, y confundirlos triplica o divide por tres el horizonte del préstamo.",
  },
  ard_loan: {
    family: "Servicio de deuda",
    definition:
      "Si el préstamo tiene Anticipated Repayment Date: una fecha en la que se espera el repago y a partir de la cual la tasa sube fuerte y el flujo se barre para amortizar.",
    disambiguation:
      "El ARD funciona como vencimiento efectivo aunque el vencimiento legal sea posterior. Los LTV y DSCR 'a vencimiento' de un préstamo con ARD se calculan al ARD, no al vencimiento legal.",
  },

  // -------------------------------------------------------------------------
  // Reservas: plata depositada contra ajustes de cálculo
  // -------------------------------------------------------------------------
  //
  // Esta es la distinción más resbaladiza del bloque nuevo, porque los nombres
  // son casi idénticos y los conceptos no se parecen en nada.

  underwritten_tilc: {
    family: "Reservas",
    definition:
      "Deducción anual que el suscriptor resta del NOI en concepto de comisiones de corretaje y mejoras para inquilinos. No es plata que exista: es un ajuste para estimar el flujo sostenible.",
    disambiguation:
      "Se confunde con 'Upfront TI/LC Reserve', que sí es plata depositada en escrow al cierre. Una es un supuesto del modelo y la otra es un saldo bancario. El encabezado se diferencia solo por la primera palabra —'Underwritten' contra 'Upfront'— y ambos contienen 'TI/LC'.",
    incident:
      "Junto con underwritten_replacement_reserve es la diferencia entre NOI y NCF. Sin ellas teníamos las dos puntas de esa resta y ninguno de los sustraendos, así que no se podía verificar que NCF = NOI − reservas.",
  },
  underwritten_replacement_reserve: {
    family: "Reservas",
    definition:
      "Deducción anual por reposición de componentes de capital —techos, equipos, mobiliario en hoteles—. Como la anterior, es un ajuste de cálculo, no un depósito.",
    disambiguation:
      "Su gemela en escrow es 'Upfront Replacement / PIP Reserve'. En hoteles aparece como FF&E, que es la misma idea con otro nombre.",
  },
  reserve_tilc_upfront: {
    family: "Reservas",
    definition:
      "Dinero efectivamente depositado al cierre para cubrir futuras comisiones y mejoras de inquilinos.",
    disambiguation:
      "Es un saldo real, a diferencia de underwritten_tilc que es un supuesto. Un edificio con vacancia alta suele traer una reserva grande acá: el prestamista quiere el dinero apartado antes de prestar.",
  },
  reserve_debt_service_upfront: {
    family: "Reservas",
    definition:
      "Fondo depositado al cierre para pagar cuotas si el flujo no alcanza.",
    disambiguation:
      "Contiene la frase 'Debt Service' igual que las métricas de servicio de deuda, pero es lo contrario: no es una obligación, es un colchón contra ella. Su presencia suele indicar que el prestamista dudaba de que la propiedad cubriera la cuota desde el día uno.",
  },

  // -------------------------------------------------------------------------
  // Control del flujo de fondos
  // -------------------------------------------------------------------------

  lockbox_type: {
    family: "Control de flujo",
    definition:
      "Quién cobra el alquiler. 'Hard' significa que los inquilinos pagan directo a una cuenta controlada por el prestamista; 'Soft' que paga el prestatario y transfiere; 'Springing' que se activa si se rompe un umbral.",
    disambiguation:
      "Es una de las pocas variables del Annex A que describe control en vez de magnitud. Dos préstamos con el mismo DSCR y distinto lockbox tienen severidades de pérdida muy distintas si el prestatario se estresa.",
  },
  cash_management: {
    family: "Control de flujo",
    definition:
      "Si el excedente de caja queda barrido en cuentas del prestamista. Suele activarse por gatillo, no desde el cierre.",
  },
  holdback_amount: {
    family: "Control de flujo",
    definition:
      "Parte del préstamo aprobada pero no desembolsada, que se libera si la propiedad cumple una condición —alquilar un espacio, alcanzar un NOI—.",
    disambiguation:
      "Un holdback grande indica que el saldo actual no refleja el préstamo completo. Los ratios calculados sobre el saldo desembolsado se ven mejores de lo que van a ser cuando se libere el resto.",
  },

  // -------------------------------------------------------------------------
  // Resultado operativo
  // -------------------------------------------------------------------------

  noi_underwritten: {
    family: "Resultado operativo",
    definition:
      "El NOI que el originador proyecta para el préstamo. Es una estimación, no un dato histórico: incorpora leases firmados que todavía no producen, ahorros esperados y estabilización proyectada.",
    disambiguation:
      "No es lo mismo que el NOI real. La diferencia entre ambos mide cuánto estira la suscripción, y es una de las pocas señales de agresividad de mercado calculables con datos públicos.",
    incident:
      "El encabezado 'Underwritten NOI DSCR (x)' contiene las palabras 'Underwritten' y 'NOI', así que un patrón genérico se lo llevaba. El NOI de un hotel quedó guardado como 1.83 —su DSCR— en vez de $10.932.267.",
  },
  noi_most_recent: {
    family: "Resultado operativo",
    definition:
      "El NOI del último período cerrado, normalmente los últimos doce meses. Es lo que la propiedad produjo de verdad.",
    disambiguation:
      "Un Annex A publica hasta cuatro añadas de NOI. El patrón /most recent.*noi/ matchea también 'Second Most Recent' y 'Third Most Recent'.",
    incident:
      "Sin distinguirlas, ganaba la que aparecía primero en la planilla —que suele ser la más vieja. Un hotel en Chicago reportaba $9,7M cuando su NOI último era $11,4M: un 17% de diferencia, con la etiqueta equivocada.",
  },
  noi_second_most_recent: {
    family: "Resultado operativo",
    definition: "El NOI del anteúltimo período cerrado, típicamente hace dos años.",
    disambiguation:
      "Junto con third most recent forma la serie histórica. Tenerlas separadas permite contestar cómo viene evolucionando una propiedad, no solo dónde está.",
  },
  noi_third_most_recent: {
    family: "Resultado operativo",
    definition: "El NOI de hace tres períodos.",
  },
  net_cash_flow: {
    family: "Resultado operativo",
    definition:
      "NOI menos las reservas de capital: reemplazos, mejoras de inquilino y comisiones de corretaje. Es lo que efectivamente queda para servir la deuda.",
    disambiguation:
      "Siempre menor que el NOI. Los ratios calculados sobre NCF son más conservadores que los calculados sobre NOI, y un Annex A publica ambos.",
  },
  egi_underwritten: {
    family: "Resultado operativo",
    definition:
      "Ingreso bruto potencial menos vacancia, concesiones e incobrables, según la proyección del suscriptor. El numerador antes de restar gastos.",
    disambiguation:
      "Es una proyección, no una medición: no confundir con egi_most_recent, que es lo que el edificio produjo en el último período informado.",
  },
  egi_most_recent: {
    family: "Resultado operativo",
    definition: "EGI efectivamente realizado en el último período informado.",
  },
  expenses_underwritten: {
    family: "Resultado operativo",
    definition: "Gastos operativos proyectados por el suscriptor. EGI menos gastos da el NOI.",
  },
  expenses_most_recent: {
    family: "Resultado operativo",
    definition: "Gastos operativos efectivamente incurridos en el último período informado.",
  },

  // -------------------------------------------------------------------------
  // Estructura de deuda
  // -------------------------------------------------------------------------

  ltv: {
    family: "Estructura de deuda",
    definition:
      "Loan-to-value del préstamo que está en ESTE trust, medido contra la tasación al cierre.",
    disambiguation:
      "Un préstamo grande se parte en notas pari passu que se reparten entre varios trusts. El LTV del trust mide solo el pedazo securitizado acá; el whole loan mide el préstamo entero; el total debt suma además mezzanine y subordinada. Tres denominadores distintos.",
    incident:
      "Mapeamos 'Whole Loan Cut-off Date LTV' en vez de 'Cut-off Date LTV'. Como solo los préstamos partidos tienen whole loan, la cobertura quedó en 8 de 32 préstamos. El valor era correcto; la métrica, otra.",
  },
  ltv_whole_loan: {
    family: "Estructura de deuda",
    definition:
      "LTV medido contra el préstamo completo, incluidas las notas pari passu que quedaron en otros trusts.",
    disambiguation:
      "Solo existe para préstamos partidos. Su ausencia en un préstamo no es un dato faltante: significa que no está estructurado así.",
  },
  ltv_total_debt: {
    family: "Estructura de deuda",
    definition:
      "LTV incluyendo toda la deuda sobre la propiedad: el préstamo hipotecario más mezzanine y subordinada.",
    disambiguation:
      "Es el apalancamiento real del activo. Puede ser sustancialmente mayor que el LTV del trust, y es el número que importa para evaluar riesgo de default.",
  },
  ltv_maturity: {
    family: "Estructura de deuda",
    definition:
      "LTV proyectado al vencimiento o a la fecha de amortización anticipada, después de la amortización del período.",
    disambiguation:
      "Mide riesgo de refinanciación, no apalancamiento de origen. En préstamos interest-only coincide con el LTV de cierre.",
  },
  dscr: {
    family: "Estructura de deuda",
    definition:
      "Cobertura del servicio de deuda calculada sobre NOI: cuántas veces el resultado operativo cubre los pagos.",
    disambiguation:
      "Distinguir del DSCR sobre NCF, que descuenta reservas y siempre da menor. Y de las variantes whole loan y total debt, que cambian el denominador.",
  },
  dscr_ncf: {
    family: "Estructura de deuda",
    definition:
      "Cobertura calculada sobre net cash flow, o sea después de reservas de capital. La medida conservadora.",
  },
  dscr_whole_loan: {
    family: "Estructura de deuda",
    definition: "DSCR contra el servicio de deuda del préstamo completo, no solo el pedazo del trust.",
  },
  dscr_total_debt: {
    family: "Estructura de deuda",
    definition: "DSCR contra el servicio de toda la deuda, incluida la mezzanine.",
  },
  debt_yield: {
    family: "Estructura de deuda",
    definition:
      "NOI dividido el saldo del préstamo. Mide el retorno del prestamista si tuviera que tomar la propiedad, sin depender de tasaciones.",
    disambiguation:
      "A diferencia del LTV, no usa el valor tasado, así que no se distorsiona cuando las tasaciones se inflan. Por eso muchos suscriptores lo prefieren.",
  },
  debt_yield_ncf: {
    family: "Estructura de deuda",
    definition: "Debt yield calculado sobre net cash flow.",
  },
  debt_yield_whole_loan: {
    family: "Estructura de deuda",
    definition: "Debt yield contra el saldo del préstamo completo.",
  },
  debt_yield_total_debt: {
    family: "Estructura de deuda",
    definition: "Debt yield contra el total de la deuda sobre la propiedad.",
  },
  loan_amount: {
    family: "Saldos",
    definition:
      "El saldo que ESTE trust tiene del préstamo a la fecha de corte. Es lo que compró la emisión, no lo que debe el prestatario.",
    disambiguation:
      "Un Annex A publica siete saldos del mismo préstamo y este es solo uno. Los ratios que publica el emisor —debt yield, DSCR, LTV— no se calculan contra este número cuando el préstamo está repartido entre varios trusts: se calculan contra el préstamo completo, porque el NOI que publica es el de la propiedad entera.",
    incident:
      "Apuntaba a 'Original Balance ($)' sin excluir calificadores. Tysons Corner Center quedó con $2.460.000 —la rebanada de este trust en un préstamo de $709M— y el debt yield calculado daba 3947%. Lo delataron las identidades aritméticas: el saldo implícito por debt yield y el implícito por LTV coincidían en 288x hasta el tercer dígito.",
  },
  interest_rate: {
    family: "Estructura de deuda",
    definition: "Tasa del préstamo hipotecario.",
    disambiguation:
      "Un Annex A publica además la tasa de la deuda subordinada y la de la mezzanine, que cotizan muy por encima. Mezclarlas contamina cualquier serie de costo de deuda.",
    incident:
      "Una serie temporal mostró tasas medianas de 84% y 0% en ciertos trimestres. El valor crudo era '480' y '360': plazos de amortización en meses que llegaban a la columna de tasa por una tabla mal adoptada. Ninguna validación de rango existía porque cada valor suelto parecía un porcentaje.",
  },

  // -------------------------------------------------------------------------
  // Cooperativas
  // -------------------------------------------------------------------------

  coop_units: {
    family: "Cooperativas",
    definition:
      "Cantidad de unidades de una cooperativa de vivienda. Su presencia identifica al préstamo como cooperativo, que es un segmento con economía propia.",
    disambiguation:
      "Las cooperativas vienen clasificadas como Multifamily pero no se comportan igual: la cooperativa es dueña del edificio y toma deuda mínima contra un valor alto. LTV de 10-20% con DSCR de 4x a 12x es lo normal ahí.",
    incident:
      "Marqué como dato roto un LTV mediano de 11% en una familia de emisores, asumiendo que un préstamo de CMBS no cotiza así. La aritmética decía lo contrario —préstamo de $8,5M contra tasación de $38,6M, cap rate normal de 5,9%— y las columnas que lo explicaban llevaban horas en la lista de encabezados sin mapear, descartadas por parecer de nicho. El error fue de interpretación, no de extracción: los datos siempre estuvieron bien.",
  },
  coop_ltv_as_rental: {
    family: "Cooperativas",
    definition:
      "El LTV que tendría el edificio valuado como propiedad de renta en vez de como cooperativa.",
    disambiguation:
      "Es el único número de apalancamiento comparable entre una cooperativa y un multifamily convencional. El LTV normal de una cooperativa no se puede poner en la misma tabla que el del resto.",
  },
  coop_rental_value: {
    family: "Cooperativas",
    definition: "Valor del edificio tasado como propiedad de renta.",
  },
  coop_sponsor_units: {
    family: "Cooperativas",
    definition:
      "Unidades que todavía retiene el sponsor original de la conversión. Una proporción alta indica una cooperativa poco madura, con más riesgo.",
  },

  // -------------------------------------------------------------------------
  // Ocupación
  // -------------------------------------------------------------------------

  occupancy: {
    family: "Ocupación",
    definition:
      "Ocupación física o arrendada: qué proporción del espacio está ocupada o bajo contrato.",
    disambiguation:
      "Distinta de la económica, que descuenta concesiones e incobrables y siempre es menor o igual. Muchos Annex A publican solo una de las dos.",
    incident:
      "Una exclusión de /economic/ pensada para separarlas terminó descartando la única ocupación que ese Annex publicaba, y quedamos sin ninguna.",
  },
  occupancy_economic: {
    family: "Ocupación",
    definition:
      "Ocupación económica: proporción del ingreso potencial que efectivamente se cobra, después de concesiones, períodos de gracia e incobrables.",
    disambiguation:
      "Un edificio puede estar 100% arrendado y tener 85% de ocupación económica si dio meses gratis. La brecha entre ambas es una señal de blandura del mercado.",
  },

  // -------------------------------------------------------------------------
  // Físico
  // -------------------------------------------------------------------------

  units: {
    family: "Físico",
    definition:
      "Cantidad de unidades contables: departamentos, habitaciones de hotel, lotes o camas según el tipo de activo.",
    disambiguation:
      "Un Annex A usa una sola columna 'Number of Units' para todo y una columna aparte, 'Unit of Measure', dice qué se está contando. Cuando la medida es de superficie, el número NO son unidades.",
    incident:
      "Un galpón entró al índice con 425.000 unidades. El chequeo de sanidad lo detectó, pero el diagnóstico inicial fue equivocado: se creyó que era un error de mapeo cuando era semántico.",
  },
  unit_of_measure: {
    family: "Físico",
    definition:
      "Qué cuenta la columna de unidades: Units, Rooms, Pads, Beds o SF. Sin este dato, comparar activos no tiene sentido.",
  },
  square_feet: {
    family: "Físico",
    definition: "Superficie rentable neta.",
    disambiguation:
      "Puede venir de una columna propia o de 'Number of Units' cuando la medida es SF. Multifamily y hotelería reportan unidades; oficinas, retail e industrial reportan superficie.",
    incident:
      "El patrón /nra/ se llevaba 'Largest Tenant % of NRA'. En Tysons Corner Center guardábamos 14 como superficie —el porcentaje que ocupa el inquilino principal— en vez de los pies cuadrados. Un valor de dos dígitos donde debería haber seis, invisible salvo mirando la procedencia fila por fila.",
  },
  year_built: {
    family: "Físico",
    definition: "Año de construcción.",
    disambiguation:
      "Los préstamos sobre varias propiedades reportan 'Various'. Eso es ausencia de dato, no un año.",
  },

  // -------------------------------------------------------------------------
  // Valuación
  // -------------------------------------------------------------------------

  appraised_value: {
    family: "Valuación",
    definition: "Valor de tasación usado para calcular el LTV.",
    disambiguation:
      "Los Annex A publican además un 'Appraised Value Type' que indica si es valor as-is, as-stabilized o as-complete. Sin ese calificador, comparar tasaciones entre préstamos puede engañar.",
  },
  cap_rate: {
    family: "Valuación",
    definition: "Tasa de capitalización: NOI sobre valor.",
    disambiguation:
      "Cuando no viene publicada se puede derivar del NOI y la tasación, pero el resultado depende de qué NOI se use —underwritten o real— y las dos dan números distintos.",
  },

  // -------------------------------------------------------------------------
  // Estructurales
  // -------------------------------------------------------------------------

  loan_property_flag: {
    family: "Estructura del documento",
    definition:
      "Indica si la fila describe un préstamo o una de las propiedades que lo garantizan.",
    disambiguation:
      "Un préstamo sobre tres propiedades genera cuatro filas: una del préstamo y tres de propiedades. Tratarlas todas como préstamos multiplica el portfolio y suma el balance varias veces.",
    incident:
      "Un préstamo de $70M sobre dos hoteles se contaba como tres deals y sumaba $140M al pool.",
  },
  loan_id: {
    family: "Estructura del documento",
    definition:
      "Identificador del préstamo dentro del pool. Es la clave que permite unir los bloques horizontales en que viene partido el Annex A.",
  },
};

/**
 * Mapeo de columnas del Annex A a nuestras métricas.
 *
 * Este es el corazón del harvester y la parte que más se rompe. Cada emisor
 * nombra las columnas distinto, y a veces el mismo emisor cambia entre deals.
 * Ejemplos reales del mismo concepto:
 *
 *   NOI:        "Most Recent NOI", "UW NOI", "Underwritten Net Operating Income",
 *               "NOI ($)", "Most Recent NOI ($)", "T-12 NOI"
 *   Ocupancia:  "Occupancy", "% Occupied", "Occupancy Rate", "Physical Occupancy (%)"
 *   Unidades:   "Units", "Units/Rooms/Pads", "# of Units", "Units/SF"
 *
 * Estrategia: patrones por métrica, con puntaje. No exact match, porque el
 * primer emisor nuevo lo rompe.
 *
 * NOTA IMPORTANTE sobre NOI: hay dos conceptos distintos que conviene NO
 * mezclar. "UW NOI" (underwritten) es la proyección del originador; "Most
 * Recent NOI" es lo que la propiedad produjo de verdad. Los mapeamos a métricas
 * separadas — justamente el tipo de distinción que hace útil al Deal Index.
 */

export type MetricKey =
  | "noi_underwritten"
  | "noi_most_recent"
  | "noi_second_most_recent"
  | "noi_third_most_recent"
  | "egi_underwritten"
  | "egi_most_recent"
  | "egi_second_most_recent"
  | "egi_third_most_recent"
  | "expenses_underwritten"
  | "expenses_most_recent"
  | "expenses_second_most_recent"
  | "expenses_third_most_recent"
  | "net_cash_flow"
  | "dscr_ncf"
  | "debt_yield_ncf"
  | "ltv_whole_loan"
  | "ltv_total_debt"
  | "ltv_maturity"
  | "dscr_whole_loan"
  | "dscr_total_debt"
  | "debt_yield_whole_loan"
  | "debt_yield_total_debt"
  | "unit_of_measure"
  | "property_type_detailed"
  | "coop_units"
  | "coop_sponsor_units"
  | "coop_rental_value"
  | "coop_ltv_as_rental"
  | "loan_property_flag"
  | "loan_id"
  | "occupancy"
  | "occupancy_economic"
  | "units"
  | "square_feet"
  | "year_built"
  | "year_renovated"
  | "loan_amount"
  | "appraised_value"
  | "ltv"
  | "dscr"
  | "debt_yield"
  | "interest_rate"
  | "interest_rate_mezzanine"
  | "interest_rate_subordinate"
  | "property_type"
  | "loan_seller"
  | "property_name"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "cap_rate"
  | "debt_service_pi"
  | "debt_service_io"
  | "amortization_type"
  | "interest_accrual_method"
  | "ard_loan"
  | "term_original"
  | "term_remaining"
  | "amortization_term_original"
  | "amortization_term_remaining"
  | "io_period_original"
  | "io_period_remaining"
  | "origination_date"
  | "first_payment_date"
  | "seasoning_months"
  | "property_count"
  | "underwritten_replacement_reserve"
  | "underwritten_tilc"
  | "reserve_tax_upfront"
  | "reserve_tax_monthly"
  | "reserve_insurance_upfront"
  | "reserve_insurance_monthly"
  | "reserve_replacement_upfront"
  | "reserve_replacement_monthly"
  | "reserve_replacement_cap"
  | "reserve_tilc_upfront"
  | "reserve_tilc_monthly"
  | "reserve_tilc_cap"
  | "reserve_debt_service_upfront"
  | "reserve_debt_service_monthly"
  | "reserve_debt_service_cap"
  | "reserve_deferred_maintenance"
  | "reserve_other_upfront"
  | "reserve_other_monthly"
  | "reserve_other_cap"
  | "reserve_other_description"
  | "holdback_amount"
  | "holdback_description"
  | "lockbox_type"
  | "cash_management"
  | "balance_whole_loan"
  | "balance_pari_passu_trust"
  | "balance_pari_passu_non_trust"
  | "balance_subordinate"
  | "balance_mezzanine"
  | "balance_maturity"
  | "balance_original"
  | "pool_share"
  | "balance_total_debt"
  | "balance_senior_total";

export interface MetricSpec {
  key: MetricKey;
  label: string;
  unit: "currency" | "percent" | "ratio" | "count" | "years" | "text";
  entity: "deal" | "property";
  /** Patrones que suman puntaje si aparecen en el header. */
  patterns: RegExp[];
  /** Patrones que descalifican — evitan falsos positivos. */
  exclude?: RegExp[];
}

/**
 * NOTA SOBRE COLUMNAS SATÉLITE
 *
 * Un Annex A real no tiene una columna de NOI: tiene un racimo.
 *
 *   Underwritten Net Operating Income ($)   ← la que queremos
 *   Underwritten NOI DSCR (x)
 *   Underwritten NOI Debt Yield (%)
 *   Third Most Recent NOI Date
 *   Third Most Recent Description
 *
 * Todas contienen "NOI" o "Underwritten". Sin estas exclusiones, la primera que
 * aparece se lleva la métrica y la columna verdadera queda huérfana. Pasó con
 * datos reales: el NOI de un hotel quedó guardado como 1.83, que era su DSCR.
 */
const NOI_SATELLITES = [
  /dscr/i,
  /debt\s*yield/i,
  /\bdate\b/i,
  /description/i,
  /reserve/i,
  /ff\s*&?\s*e/i,
  /\bti\s*\/\s*lc\b/i,
  /cash\s*flow/i,
  /\begi\b/i,
  /expenses?/i,
  /occupancy/i,
];

/**
 * El orden importa: las métricas más específicas van primero, para que
 * "Most Recent NOI" no caiga en el patrón genérico de NOI underwritten, ni
 * "Unit of Measure" en el de "Units".
 */
/**
 * "Total Debt" no siempre se escribe "Total Debt".
 *
 * INCIDENTE: quince emisiones de 2020-2021 no cerraban ni una fila de la
 * identidad del debt yield. La causa era una palabra: el encabezado dice
 * "Total Mortgage Debt UW NOI Debt Yield" y la exclusión pedía las dos palabras
 * pegadas, así que no matchea con "Mortgage" en el medio.
 *
 * El efecto fue doble y por eso costó verlo. El ratio de deuda total entró como
 * si fuera el sénior —imposible de cerrar contra ningún saldo sénior, porque el
 * denominador incluye la subordinada— y al mismo tiempo `debt_yield_total_debt`,
 * que existe justamente para recibirlo, tampoco lo capturó por la misma razón.
 * Una métrica quedó contaminada y la otra vacía con el mismo bug.
 *
 * "Total Senior Notes" NO va acá: eso es trust + pari passu, que es exactamente
 * el denominador que usamos. Excluirlo rompería las emisiones Benchmark.
 * El lookahead de "service" no es paranoia: "Total Debt Service Coverage Ratio"
 * es un DSCR sénior legítimo, y sin el lookahead esta exclusión lo tiraría. La
 * exclusión anterior tenía el mismo agujero; al ensancharla, el riesgo crece.
 */
const TOTAL_DEBT = /total\s*(mortgage|secured|combined)?\s*debt(?!\s*service)/i;

/**
 * Columnas de NOI histórico disfrazadas de suscrito.
 *
 * CSAIL 2020-C19 publica "Third Most Recent NOI Debt Yield" y ninguna columna
 * llamada simplemente "debt yield". Nuestro patrón /\bnoi\s*debt\s*yield/i la
 * agarró: guardamos como ratio suscrito un ratio calculado sobre el NOI de dos
 * años antes del cierre. No es un número mal parseado, es otro número.
 */
const HISTORICAL = [/most\s*recent/i, /\btrailing\b/i, /\bt-?12\b/i, /\bhistorical\b/i];

export const METRIC_SPECS: MetricSpec[] = [
  /**
   * NOTA SOBRE AÑADAS
   *
   * Un Annex A publica el mismo concepto en varios períodos:
   *
   *   Third Most Recent NOI ($)     ← hace ~3 años
   *   Second Most Recent NOI ($)    ← hace ~2 años
   *   Most Recent NOI ($)           ← el último cerrado
   *   Underwritten NOI ($)          ← la proyección del originador
   *
   * El patrón genérico /most recent.*noi/ matchea las tres primeras y se queda
   * con la que aparece antes en la planilla, que suele ser la más VIEJA. Con
   * datos reales eso etiquetó un NOI de hace tres períodos como si fuera el
   * actual: $9,7M cuando el underwritten era $10,9M.
   *
   * Cada añada va a su propia métrica. Además de evitar el error, le da al Index
   * una serie temporal: "¿cómo viene evolucionando el NOI?" pasa a ser
   * contestable.
   */
  {
    key: "noi_third_most_recent",
    label: "Third Most Recent NOI",
    unit: "currency",
    entity: "property",
    patterns: [/\bthird\s*most\s*recent\b.*\bnoi\b/i, /\bthird\s*most\s*recent\s*net\s*operating/i],
    exclude: NOI_SATELLITES,
  },
  {
    key: "noi_second_most_recent",
    label: "Second Most Recent NOI",
    unit: "currency",
    entity: "property",
    patterns: [/\bsecond\s*most\s*recent\b.*\bnoi\b/i, /\bsecond\s*most\s*recent\s*net\s*operating/i],
    exclude: NOI_SATELLITES,
  },
  {
    key: "noi_most_recent",
    label: "Most Recent NOI",
    unit: "currency",
    entity: "property",
    patterns: [
      /\b(most\s*recent|t-?12|ttm|trailing)\b.*\bnoi\b/i,
      /\bnoi\b.*\b(most\s*recent|t-?12|ttm|trailing)\b/i,
      /\b(most\s*recent|trailing)\s*net\s*operating\s*income/i,
    ],
    // Un Annex A real trae columnas satélite alrededor del NOI —fecha,
    // descripción, DSCR, debt yield— que contienen la palabra "NOI" y se
    // robarían la métrica. Ver NOTA sobre columnas satélite más arriba.
    // Y las añadas anteriores ya tienen su propia métrica.
    exclude: [...NOI_SATELLITES, /\b(second|third|fourth)\s*most\s*recent\b/i],
  },
  {
    key: "noi_underwritten",
    label: "Underwritten NOI",
    unit: "currency",
    entity: "property",
    patterns: [
      /\b(uw|u\/w|underwrit\w*)\b.*\bnoi\b/i,
      /\bnoi\b.*\b(uw|u\/w|underwrit\w*)\b/i,
      /\bunderwritten\s*net\s*operating\s*income/i,
      /^\s*noi\b/i,
      /\bnet\s*operating\s*income/i,
    ],
    exclude: [/most\s*recent/i, /t-?12/i, /ttm/i, /trailing/i, /ncf/i, ...NOI_SATELLITES],
  },
  /**
   * EGI Y GASTOS: UNA CLAVE POR COLUMNA, COMO EL NOI.
   *
   * Antes eran cuatro claves para ocho columnas: `effective_gross_income`
   * juntaba "Underwritten EGI" con "Most Recent EGI", y `egi_prior_period`
   * juntaba "Second" con "Third Most Recent". Los pares empataban en el puntaje
   * y `mapColumns` desempataba por orden de columna, que depende de cómo
   * quedaron los bloques tras `joinAnnexTables` y varía por emisión.
   *
   * Detectado con `harvest:ties`: las cuatro claves empataban en las 6
   * emisiones muestreadas, una por añada.
   *
   * Underwritten y Most Recent no son variantes de lo mismo: uno es la
   * proyección del suscriptor y el otro lo que el edificio produjo. Es
   * exactamente la distinción que sostiene la medición de Griffin, y estaba
   * decidida por el orden de las columnas.
   *
   * `real.test.ts` ya afirmaba la intención correcta —EGI a underwritten,
   * prior_period a third— y pasaba, pero por el orden del fixture, no por la
   * taxonomía. Una validación que no podía fallar.
   *
   * El NOI ya tenía las cuatro claves separadas desde el principio. Esto es
   * copiarle la estructura, no inventar una.
   */
  {
    key: "egi_third_most_recent",
    label: "Third Most Recent EGI",
    unit: "currency",
    entity: "property",
    patterns: [/\bthird\s*most\s*recent\b.*\begi\b/i, /\bthird\s*most\s*recent\s*effective\s*gross/i],
  },
  {
    key: "egi_second_most_recent",
    label: "Second Most Recent EGI",
    unit: "currency",
    entity: "property",
    patterns: [/\bsecond\s*most\s*recent\b.*\begi\b/i, /\bsecond\s*most\s*recent\s*effective\s*gross/i],
  },
  {
    key: "egi_most_recent",
    label: "Most Recent EGI",
    unit: "currency",
    entity: "property",
    patterns: [/\bmost\s*recent\b.*\begi\b/i, /\bmost\s*recent\s*effective\s*gross/i],
    exclude: [/\b(second|third|fourth)\s*most\s*recent\b/i],
  },
  {
    key: "egi_underwritten",
    label: "Underwritten EGI",
    unit: "currency",
    entity: "property",
    patterns: [
      /\bunderwritten\b.*\begi\b/i,
      /\bu\/?w\b.*\begi\b/i,
      /\bunderwritten\s*effective\s*gross/i,
      // Respaldo: un Annex A con una sola columna de EGI, sin calificar.
      /\begi\b/i,
      /effective\s*gross\s*income/i,
    ],
    exclude: [/most\s*recent/i],
  },
  {
    key: "expenses_third_most_recent",
    label: "Third Most Recent Expenses",
    unit: "currency",
    entity: "property",
    patterns: [/\bthird\s*most\s*recent\b.*expenses?/i],
  },
  {
    key: "expenses_second_most_recent",
    label: "Second Most Recent Expenses",
    unit: "currency",
    entity: "property",
    patterns: [/\bsecond\s*most\s*recent\b.*expenses?/i],
  },
  {
    key: "expenses_most_recent",
    label: "Most Recent Expenses",
    unit: "currency",
    entity: "property",
    patterns: [/\bmost\s*recent\b.*expenses?/i],
    exclude: [/\b(second|third|fourth)\s*most\s*recent\b/i],
  },
  {
    key: "expenses_underwritten",
    label: "Underwritten Expenses",
    unit: "currency",
    entity: "property",
    patterns: [
      /\bunderwritten\b.*expenses?/i,
      /\bu\/?w\b.*expenses?/i,
      /operating\s*expenses?/i,
      /\bopex\b/i,
      /total\s*expenses?/i,
      /^\s*expenses?\b/i,
      /\bexpenses?\s*\(\$\)/i,
    ],
    exclude: [/most\s*recent/i],
  },
  /**
   * Ocupancia física y económica son métricas distintas: la económica descuenta
   * concesiones e incobrables, así que siempre es menor. Muchos Annex A solo
   * publican la económica, así que si las unificáramos bajo una exclusión de
   * "economic" nos quedaríamos sin ninguna.
   */
  {
    key: "occupancy_economic",
    label: "Economic Occupancy",
    unit: "percent",
    entity: "property",
    patterns: [/economic\s*occupancy/i, /\beconomic\s*occ\b/i],
    exclude: [/\bdate\b/i],
  },
  {
    key: "occupancy",
    label: "Occupancy",
    unit: "percent",
    entity: "property",
    /**
     * EL ORDEN ACÁ NO ES COSMÉTICO: DESEMPATA.
     *
     * `scoreHeader` puntúa 1 - i*0.08 según la posición del patrón, así que dos
     * encabezados que caen en el mismo patrón empatan, y `mapColumns` resuelve
     * el empate por orden de columna.
     *
     * El Annex A conduit —que es plantilla compartida: los encabezados salen
     * byte por byte iguales en BMO, Benchmark, Wells, JPMorgan y BANK— trae
     * seis columnas de ocupación: `Leased Occupancy (%)`, `Underwritten Hotel
     * Occupancy (%)` y la serie histórica `Most Recent` / `Second` / `Third`.
     * Todas matcheaban solo `/occupancy/` y empataban en 0,76.
     *
     * Como `joinAnnexTables` une los bloques en una sola tabla y el mapeo corre
     * una vez sobre los encabezados unidos, ganaba la que quedara primero — y
     * eso depende del orden de los bloques, que varía por emisión.
     *
     * Cuando ganaba una columna de hotel, solo los hoteles quedaban con dato.
     * En 7 emisiones de 2026 el conteo de préstamos con ocupación era
     * exactamente el conteo de hoteles: BANK5 6 de 35 con 18% hospitality,
     * BMO 2026-C15 cero de 16 sin ningún hotel.
     *
     * Peor que el agujero: los valores que sí había no eran la misma métrica
     * que en las otras 21 emisiones. La cobertura se veía como 76% y adentro
     * había dos cantidades distintas mezcladas.
     */
    patterns: [
      // La columna del conduit: cubre todo tipo de activo. Gana siempre que esté.
      /leased\s*occ/i,
      /physical\s*occ/i,
      /%\s*occupied/i,
      /\boccupied\b.*%/i,
      // Genérico: incluye "Underwritten Hotel Occupancy" y "Most Recent
      // Occupancy". Son ocupación de verdad y sirven cuando no hay Leased
      // —una emisión mono-hotel no tiene otra cosa—, pero pierden contra ella.
      /\boccupancy\b/i,
    ],
    /**
     * "area", "sf" y "rentable" aparecen cuando un encabezado de grupo tipo
     * "Physical & Occupancy" se pega a una columna de superficie.
     *
     * La serie histórica ordinal se excluye entera: "Second/Third/Fourth/Fifth
     * Most Recent" son fotos viejas del mismo activo, no la ocupación vigente.
     * "Most Recent" a secas NO se excluye — en varios formatos es la columna
     * corriente y la única que hay.
     */
    exclude: [
      /economic/i,
      /\bdate\b/i,
      /\barea\b/i,
      /rentable/i,
      /\bsf\b/i,
      /square/i,
      /(second|third|fourth|fifth)\s+most\s+recent/i,
    ],
  },
  {
    key: "unit_of_measure",
    label: "Unit of Measure",
    unit: "text",
    entity: "property",
    // Va ANTES de `units`: "Unit of Measure" empieza con "Unit" y si no le
    // ganamos la prioridad, `units` se queda con esta columna de texto y
    // "Number of Units" —el conteo real— queda sin mapear.
    patterns: [/unit\s*of\s*measure/i, /^\s*measure\b/i],
  },
  {
    key: "units",
    label: "Units",
    unit: "count",
    entity: "property",
    patterns: [
      /\bnumber\s*of\s*units\b/i,
      /#\s*of\s*units/i,
      /units?\s*\/\s*(rooms|pads|beds|keys)/i,
      /^\s*units?\b/i,
      /\b(rooms|keys|pads)\b/i,
    ],
    exclude: [/per\s*unit/i, /\/\s*unit/i, /price/i, /of\s*measure/i],
  },
  {
    key: "square_feet",
    label: "Square Feet",
    unit: "count",
    entity: "property",
    patterns: [
      /\bnet\s*rentable\s*area\b/i,
      /\bsquare\s*feet\b/i,
      /\bsq\.?\s*ft\.?\b/i,
      /\bnra\b/i,
      /\bgla\b/i,
      /\bsf\b/i,
    ],
    /**
     * Ojo con excluir /rent/ a secas: mata "Net Rentable Area", que es
     * justamente uno de los nombres más comunes de esta columna.
     *
     * Los `%` son otra historia. "Largest Tenant % of NRA" contiene "NRA" y se
     * lo llevaba este patrón: en Tysons Corner Center guardábamos 14 como
     * superficie —el porcentaje que ocupa el inquilino principal— en vez de los
     * pies cuadrados. Un valor de dos dígitos en una métrica que debería tener
     * seis, invisible salvo que se mire la procedencia fila por fila.
     */
    exclude: [
      /per\s*s(q|f)/i, /\/\s*s(q|f)/i, /price/i, /\brent\s+roll\b/i,
      /%/, /percent/i, /\bshare\b/i, /largest\s*tenant/i, /\btenant\s*\d/i,
    ],
  },
  {
    key: "year_built",
    label: "Year Built",
    unit: "years",
    entity: "property",
    patterns: [/year\s*built/i, /^\s*built\b/i, /\byoc\b/i],
  },
  {
    key: "year_renovated",
    label: "Year Renovated",
    unit: "years",
    entity: "property",
    patterns: [/year\s*renovated/i, /^\s*renovated\b/i],
  },
  {
    key: "loan_amount",
    label: "Loan Amount",
    unit: "currency",
    entity: "deal",
    /**
     * EL SALDO DEL TRUST, NO EL DEL PRÉSTAMO.
     *
     * Un Annex A publica siete saldos distintos para el mismo préstamo. Esta
     * métrica es el que le corresponde a este trust a la fecha de corte; los
     * otros seis tienen métrica propia más abajo.
     *
     * La preferencia por "Cut-off Date Balance" sobre "Original Balance" no es
     * estética: el original es el monto al originar y el de corte es el vigente
     * cuando el trust lo compró. Para un préstamo que ya amortizó algo, no son
     * iguales.
     *
     * INCIDENTE: apuntaba a "Original Balance ($)" sin excluir ningún
     * calificador. En Tysons Corner Center guardaba $2.460.000 —la rebanada de
     * este trust en un préstamo de $709M repartido entre decenas de emisiones—
     * y con eso el debt yield calculado daba 3947%. Las identidades aritméticas
     * lo delataron: el saldo implícito por debt yield y el implícito por LTV
     * coincidían en 288x, hasta el tercer dígito.
     */
    /**
     * "Current Balance" en el formato Benchmark/JPMDB 2020.
     *
     * Esas emisiones publican "Original Balance ($)" y "Current Balance ($)" en
     * vez de original y cut-off. Sin el patrón, `loan_amount` caía en el
     * original —el monto al originar, no el vigente cuando el trust lo compró— y
     * en un préstamo que ya amortizó no son el mismo número. Son 97 préstamos en
     * 8 emisiones, entre ellas Benchmark 2020-B17 y B20.
     *
     * Va DESPUÉS del de cut-off para que donde existan las dos gane la explícita.
     */
    patterns: [
      /cut-?off\s*date\s*(principal\s*)?balance/i,
      /^\s*current\s*balance\b/i,
      /original\s*(principal\s*)?balance/i,
      /\bloan\s*amount\b/i,
      /\boriginal\s*loan\b/i,
    ],
    exclude: [
      /per\s*(unit|sf|room|key)/i, /\/\s*(unit|sf)/i,
      /whole\s*loan/i, /pari\s*passu/i, /companion/i, /subordinate/i,
      /mezzanine/i, TOTAL_DEBT, /maturity|ard/i, /%|percent/i,
      /ground\s*lease/i, /pool/i, /additional\s*debt/i, /senior\s*notes?/i,
    ],
  },
  {
    key: "appraised_value",
    label: "Appraised Value",
    unit: "currency",
    entity: "property",
    patterns: [/appraised\s*value/i, /appraisal\s*value/i, /^\s*value\b/i],
    /**
     * "Appraised Value Type" es una columna de TEXTO ("As Is", "As Stabilized")
     * y empataba en 1,00 con "Appraised Value ($)".
     *
     * El exclude de "per" estaba sin anclar: matcheaba la subcadena adentro de
     * cualquier palabra —"Property" la contiene— así que excluía encabezados
     * que no tenían nada que ver. Anclado con \b hace lo que decía hacer.
     */
    exclude: [/date/i, /\bper\b/i, /\btype\b/i],
  },
  /**
   * NOTA SOBRE ESTRUCTURAS DE DEUDA
   *
   * Un Annex A publica el mismo ratio contra denominadores distintos:
   *
   *   Cut-off Date LTV Ratio (%)               ← el préstamo que está en ESTE trust
   *   Whole Loan Cut-off Date LTV Ratio (%)    ← incluye las notas pari passu
   *                                              que quedaron en otros trusts
   *   Total Debt Cut-off Date LTV Ratio (%)    ← suma mezzanine y deuda subordinada
   *   LTV Ratio at Maturity / ARD (%)          ← al vencimiento, no al cierre
   *
   * No son matices: el whole loan LTV puede ser 60% mientras el del trust es
   * 45%. Un patrón genérico /ltv/ toma la primera columna que aparece y el
   * resultado depende del orden de las columnas.
   *
   * Con datos reales tomó "Whole Loan Cut-off Date LTV", que solo existe para
   * los préstamos partidos: 8 de 32. La cobertura al 25% fue lo que delató el
   * problema —el valor en sí era correcto, solo que de otra métrica.
   *
   * Las variantes van primero para que el patrón base no se las quede.
   */
  {
    key: "ltv_whole_loan",
    label: "Whole Loan LTV",
    unit: "percent",
    entity: "deal",
    patterns: [/whole\s*loan\b.*\bltv\b/i, /\bltv\b.*whole\s*loan/i],
    exclude: [/maturity/i, /\bard\b/i],
  },
  {
    key: "ltv_total_debt",
    label: "Total Debt LTV",
    unit: "percent",
    entity: "deal",
    patterns: [/total\s*(mortgage\s*)?debt\b.*\bltv\b/i, /\bltv\b.*total\s*(mortgage\s*)?debt/i],
    exclude: [/maturity/i, /\bard\b/i],
  },
  {
    key: "ltv_maturity",
    label: "LTV at Maturity",
    unit: "percent",
    entity: "deal",
    patterns: [/\bltv\b.*\b(maturity|ard|balloon)\b/i, /\b(maturity|balloon)\b.*\bltv\b/i],
  },
  {
    key: "ltv",
    label: "LTV",
    unit: "percent",
    entity: "deal",
    patterns: [/cut-?off\s*date\s*ltv/i, /\bltv\b/i, /loan[-\s]*to[-\s]*value/i],
    exclude: [/maturity/i, /balloon/i, /\bard\b/i, /whole\s*loan/i, TOTAL_DEBT, /\bcoop\b/i],
  },
  /**
   * Los Annex A reales traen DOS DSCR y DOS debt yields: uno sobre NOI y otro
   * sobre NCF (net cash flow, que descuenta reservas de capex y TI/LC). Son
   * métricas distintas —el NCF siempre es más conservador— y mapearlas a la
   * misma perdería justo la diferencia que a un analista le importa.
   *
   * El orden importa: las variantes explícitas van antes del patrón genérico.
   */
  /**
   * DSCR y debt yield sufren la misma multiplicación que el LTV: cada uno
   * aparece contra el préstamo del trust, contra el whole loan y contra la
   * deuda total. Las variantes van primero y el patrón base las excluye, para
   * que cuál gana no dependa del orden de las columnas.
   */
  {
    key: "dscr_whole_loan",
    label: "Whole Loan DSCR",
    unit: "ratio",
    entity: "deal",
    patterns: [/whole\s*loan\b.*\bdscr\b/i, /\bdscr\b.*whole\s*loan/i],
  },
  {
    key: "dscr_total_debt",
    label: "Total Debt DSCR",
    unit: "ratio",
    entity: "deal",
    patterns: [/total\s*(mortgage\s*)?debt\b.*\bdscr\b/i, /\bdscr\b.*total\s*(mortgage\s*)?debt/i],
  },
  {
    key: "dscr_ncf",
    label: "NCF DSCR",
    unit: "ratio",
    entity: "deal",
    patterns: [/\bncf\s*dscr\b/i, /dscr.*\bncf\b/i],
    exclude: [/whole\s*loan/i, TOTAL_DEBT],
  },
  {
    key: "dscr",
    label: "DSCR",
    unit: "ratio",
    entity: "deal",
    patterns: [/\bnoi\s*dscr\b/i, /\bdscr\b/i, /debt\s*service\s*coverage/i],
    exclude: [/\bncf\b/i, /whole\s*loan/i, TOTAL_DEBT],
  },
  {
    key: "debt_yield_whole_loan",
    label: "Whole Loan Debt Yield",
    unit: "percent",
    entity: "deal",
    patterns: [/whole\s*loan\b.*debt\s*yield/i, /debt\s*yield.*whole\s*loan/i],
  },
  {
    key: "debt_yield_total_debt",
    label: "Total Debt Debt Yield",
    unit: "percent",
    entity: "deal",
    patterns: [/total\s*(mortgage\s*)?debt\b.*debt\s*yield/i],
  },
  {
    key: "debt_yield_ncf",
    label: "NCF Debt Yield",
    unit: "percent",
    entity: "deal",
    patterns: [/\bncf\s*debt\s*yield/i, /debt\s*yield.*\bncf\b/i],
    exclude: [/whole\s*loan/i, TOTAL_DEBT],
  },
  {
    key: "debt_yield",
    label: "Debt Yield",
    unit: "percent",
    entity: "deal",
    patterns: [/\bnoi\s*debt\s*yield/i, /debt\s*yield/i],
    exclude: [/\bncf\b/i, /whole\s*loan/i, TOTAL_DEBT, ...HISTORICAL],
  },
  {
    key: "net_cash_flow",
    label: "Net Cash Flow",
    unit: "currency",
    entity: "property",
    patterns: [/\bnet\s*cash\s*flow\b/i],
    exclude: [/dscr/i, /debt\s*yield/i],
  },
  {
    key: "property_type_detailed",
    label: "Detailed Property Type",
    unit: "text",
    entity: "property",
    patterns: [/detailed\s*property\s*type/i, /property\s*sub-?type/i],
  },
  /**
   * PRÉSTAMOS A COOPERATIVAS
   *
   * Una cooperativa de vivienda —típicamente de Nueva York— es dueña del
   * edificio y toma deuda muy chica contra un valor muy alto. Un LTV de 10-20%
   * con DSCR de 4x a 12x es normal ahí, no un error.
   *
   * Vienen clasificadas como "Multifamily", así que sin distinguirlas arrastran
   * las medianas de esa categoría hacia abajo. En los deals BANK son la mitad
   * del pool: la mediana de LTV de multifamily daba 11%.
   *
   * Se detectan por las columnas específicas que el Annex les dedica.
   */
  {
    key: "coop_units",
    label: "Co-op Units",
    unit: "count",
    entity: "property",
    patterns: [/\bcoop\b.*\bcoop\s*units\b/i, /^\s*co-?op\s*units\b/i],
  },
  {
    key: "coop_sponsor_units",
    label: "Co-op Sponsor Units",
    unit: "count",
    entity: "property",
    patterns: [/\bcoop\b.*sponsor\s*units/i, /co-?op.*sponsor\s*units/i],
  },
  {
    key: "coop_rental_value",
    label: "Co-op Rental Value",
    unit: "currency",
    entity: "property",
    patterns: [/\bcoop\b.*rental\s*value/i, /co-?op.*rental\s*value/i],
  },
  {
    key: "coop_ltv_as_rental",
    label: "Co-op LTV as Rental",
    unit: "percent",
    entity: "deal",
    // El LTV que tendría el edificio si se valuara como renta en vez de
    // cooperativa. Es el número comparable contra un multifamily normal.
    patterns: [/\bcoop\b.*ltv.*rental/i, /ltv\s*as\s*rental/i],
  },
  {
    key: "loan_property_flag",
    label: "Loan / Property Flag",
    unit: "text",
    entity: "deal",
    // Distingue la fila del préstamo de las filas de sus propiedades.
    // Sin esto, un préstamo con 2 propiedades genera 3 deals.
    // "Loan/Prop." es la abreviatura que usan las emisiones 2020-2021 para el
    // mismo flag. Sin ella, las filas de propiedad de esas añadas se cuentan
    // como préstamos —el bug que ya nos costó una iteración entera—.
    patterns: [
      /loan\s*\/\s*property\s*flag/i,
      /loan\s*or\s*property/i,
      /^\s*loan\s*\/\s*prop\.?\s*$/i,
      // "Loan" a secas: las emisiones 2020 titulan así la columna cuyos valores
      // son "Loan" y "Property". Se distingue del identificador por el valor,
      // no por el nombre.
      /^\s*loan\s*$/i,
      // "Property Flag": Morgan Stanley 2021-L5 y su familia. Mismos valores
      // —"Loan" y "Property"— con el nombre invertido respecto de los demás.
      //
      // INCIDENTE: sin este patrón la clasificación cae en la heurística de
      // respaldo, que en L5 dejó 19 préstamos y 52 filas de propiedad sobre 71.
      // El reparto real es 65 y 6. Se perdían 46 préstamos enteros, en silencio:
      // ningún chequeo de sanidad se dispara porque los que quedan están bien.
      /^\s*property\s*flag\s*$/i,
    ],
    // "Property Flag" no debe llevarse property_name ni property_type, que
    // corren después en el array pero podrían competir por el mismo header.
    exclude: [/\bname\b/i, /\btype\b/i, /\bcount\b/i, /#/],
  },
  {
    key: "loan_id",
    label: "Loan ID",
    unit: "text",
    entity: "deal",
    /**
     * Clave para unir los bloques horizontales del Annex A, y para unir contra
     * el informe del servicer.
     *
     * SEIS NOMBRES PARA LA MISMA COLUMNA.
     *
     * Los dos primeros patrones cubrían las emisiones 2022-2026. Sobre las de
     * 2020-2021 no matcheaban ninguna: 33 emisiones y 2.919 préstamos quedaban
     * SIN identificador, y por lo tanto sin posibilidad de unirse a su
     * desempeño. No fallaba nada visible —los préstamos se cosechaban bien— solo
     * que después no pegaban contra nada.
     *
     * Los nombres, con en cuántos filings aparece cada uno:
     *
     *   Mortgage Loan Number   13      Loan No.        2
     *   Control Number          7      Loan/Prop.      4  (es el flag, no el id)
     *   Loan #                  5      Loan            4  (TAMBIÉN el flag)
     *
     * Y el identificador de esas mismas emisiones se llama "ID" a secas, en la
     * columna de al lado. Dos columnas para lo que el formato moderno resuelve
     * con una.
     *
     * EL "Loan" PELADO ES EL FLAG. Lo agregué acá pensando que era un
     * identificador abreviado y fue exactamente el error contra el que advierte
     * el párrafo de abajo. El síntoma tardó una corrida en aparecer y vino
     * doble: los loan_ref quedaron con valores "Loan" y "Property" —los del
     * flag— y, como `loan_property_flag` se quedó sin columna, las filas de
     * propiedad dejaron de filtrarse. Benchmark 2020-B18 pasó de 65 préstamos a
     * 155 y sus observations por préstamo cayeron de 40 a 3,9.
     *
     * Los dos síntomas eran el mismo bug. Y el test que escribí afirmaba que
     * "Loan" debía mapear a loan_id, así que la suite lo bendecía.
     *
     * LAS EXCLUSIONES NO SON OPCIONALES. "Mortgage Loan Seller" aparece en 9
     * filings y matchea /mortgage\s*loan/ perfectamente; guardaría el nombre del
     * banco como identificador. Lo mismo "Net Mortgage Loan Rate", "Crossed
     * Loan", "Loan per Net Rentable Area" y "Pari Passu Companion Loan Annual
     * Debt Service". Un patrón generoso sin exclusiones convierte un agujero en
     * datos equivocados, que es peor.
     */
    patterns: [
      /^\s*loan\s*id\b/i,
      /loan\s*id\s*number/i,
      /mortgage\s*loan\s*number/i,
      /control\s*number/i,
      /^\s*loan\s*#/i,
      /^\s*loan\s*no\.?\s*$/i,
      // Las emisiones 2020 parten en dos lo que el formato moderno junta:
      // columna 0 con el flag ("Loan"/"Property") y columna 1 con el número,
      // titulada solo "ID". Sin este patrón ningún bloque de esos filings tiene
      // clave, ninguno es unible, y el join horizontal se queda con la única
      // tabla que sí la tenía —la de deuda mezzanine, de una fila—.
      /^\s*id\s*$/i,
    ],
    exclude: [
      /seller/i, /rate/i, /cross/i, /flag/i, /\bper\b/i, /companion/i,
      /debt\s*service/i, /balance/i, /amount/i, /%|percent/i, /group/i,
      /purpose/i, /term/i, /type/i,
    ],
  },
  /**
   * Las tasas también se multiplican por estructura de deuda.
   *
   * Un Annex A publica la del préstamo hipotecario, la de la deuda subordinada
   * y la de la mezzanine. Sin separarlas terminan todas en `interest_rate` y
   * contaminan cualquier serie: la mezzanine se cotiza muy por encima.
   *
   * Encontrado revisando por qué la tasa mediana de un trimestre daba 84%.
   */
  {
    key: "interest_rate_mezzanine",
    label: "Mezzanine Interest Rate",
    unit: "percent",
    entity: "deal",
    patterns: [/mezzanine\b.*(interest\s*)?rate/i, /\bmezz\b.*rate/i],
  },
  {
    key: "interest_rate_subordinate",
    label: "Subordinate Interest Rate",
    unit: "percent",
    entity: "deal",
    patterns: [
      /subordinate\b.*(interest\s*)?rate/i,
      /companion\s*loan\b.*rate/i,
      /\bb-?note\b.*rate/i,
    ],
  },
  {
    key: "interest_rate",
    label: "Interest Rate",
    unit: "percent",
    entity: "deal",
    patterns: [/interest\s*rate/i, /\bcoupon\b/i, /mortgage\s*rate/i],
    exclude: [
      /type/i, /accrual/i,
      /mezzanine/i, /\bmezz\b/i, /subordinate/i, /companion/i, /\bb-?note\b/i,
    ],
  },
  {
    key: "cap_rate",
    label: "Cap Rate",
    unit: "percent",
    entity: "property",
    patterns: [/\bcap\s*rate\b/i, /capitalization\s*rate/i],
  },
  {
    key: "property_type",
    label: "Property Type",
    unit: "text",
    entity: "property",
    /**
     * "General Property Type" y "Detailed Property Type" empataban en 1,00, así
     * que qué taxonomía quedaba guardada dependía del orden de los bloques.
     *
     * No son granularidades intercambiables: la general da ~9 categorías
     * ("Retail"), la detallada decenas ("Anchored Retail", "Unanchored"). Esta
     * columna es el estrato de la exclusión mono-tipo, de la composición del
     * benchmark y de toda comparación por tipo — mezclarlas hace incomparables
     * dos emisiones sin que nada lo indique.
     *
     * Se prefiere la general: menos categorías, más pares por celda, y es la
     * que ya usan los cortes existentes. La detallada tiene su propia clave,
     * `property_type_detailed`.
     */
    patterns: [/general\s*property\s*type/i, /property\s*type/i, /^\s*type\b/i, /asset\s*type/i],
    exclude: [/loan/i, /rate/i, /sub/i, /detailed/i],
  },
  {
    key: "loan_seller",
    label: "Mortgage Loan Seller",
    unit: "text",
    /**
     * QUIÉN ORIGINÓ EL PRÉSTAMO, QUE NO ES QUIÉN ARMÓ LA EMISIÓN
     *
     * Todo el análisis de "emisoras" venía atribuyéndole a BANK o a BBCMS lo que
     * hicieron sus vendedores. Un deal BANK agrupa préstamos originados por Bank
     * of America, Morgan Stanley y Wells Fargo; el shelf es el empaquetador.
     *
     * Y es la variable que puede CONFIRMAR el efecto en vez de solo no matarlo:
     * el mismo vendedor coloca en varias emisiones, así que el diseño queda
     * cruzado por construcción. Wells Fargo vende hacia BANK (SIR 0,42) y hacia
     * su propio shelf (1,20). Si el vendedor manda, fijarlo debería aplanar esa
     * diferencia.
     *
     * La entidad es `property` porque ese es el nivel de fila del Annex A, no
     * porque el vendedor describa una propiedad: en un préstamo con varias
     * propiedades el valor se repite. Sirve igual — la pregunta se hace a nivel
     * préstamo y ahí el valor es único.
     *
     * LAS EXCLUSIONES
     *
     * "Mortgage Loan Seller" ya figuraba en este archivo, pero solo como
     * exclusión de `loan_amount` —el encabezado aparece en 9 filings y el patrón
     * de monto lo capturaba—. Acá hay que evitar el camino inverso: columnas que
     * hablan del vendedor sin nombrarlo, como el número de préstamos que aportó
     * o el porcentaje del pool.
     */
    entity: "property",
    patterns: [
      /mortgage\s*loan\s*seller/i,
      /^\s*loan\s*seller\b/i,
      /\boriginator\b/i,
      /originating\s*(lender|bank)/i,
      /\bseller\b/i,
    ],
    exclude: [/count/i, /number\s*of/i, /#/, /\bpct\b/i, /percent/i, /%/, /balance/i, /amount/i],
  },
  {
    key: "property_name",
    label: "Property Name",
    unit: "text",
    entity: "property",
    patterns: [/property\s*name/i, /^\s*property\b/i, /loan\s*name/i],
    exclude: [/type/i, /address/i, /city/i, /state/i],
  },
  {
    key: "address",
    label: "Address",
    unit: "text",
    entity: "property",
    patterns: [/\baddress\b/i, /^\s*street\b/i],
  },
  {
    key: "city",
    label: "City",
    unit: "text",
    entity: "property",
    patterns: [/^\s*city\b/i],
  },
  {
    key: "state",
    label: "State",
    unit: "text",
    entity: "property",
    patterns: [/^\s*state\b/i],
  },
  {
    key: "zip",
    label: "Zip",
    unit: "text",
    entity: "property",
    patterns: [/\bzip\b/i, /postal\s*code/i],
  },

  // -------------------------------------------------------------------------
  // Bloques que hasta ahora se descartaban enteros
  // -------------------------------------------------------------------------
  //
  // Un Annex A reparte sus columnas en bloques horizontales unidos por Loan ID.
  // Tres de esos bloques no tenían NINGUNA columna mapeada, así que
  // `findHeaderRow` —que exige cuatro coincidencias— los daba por no-Annex y el
  // pipeline los descartaba completos. No se perdían préstamos (los mismos IDs
  // están en los bloques que sí leíamos) pero sí se perdían estas métricas, y de
  // forma invisible: el listado de "columnas sin mapear" solo cubre bloques que
  // llegamos a abrir.
  //
  // ORDEN Y COLISIONES
  //
  // Las reservas van primero y el servicio de deuda las excluye explícitamente,
  // porque "Upfront Debt Service Reserve" contiene "Debt Service" y sin eso se
  // lo llevaría `debt_service_pi`. Mismo problema entre "Underwritten TI / LC"
  // —una deducción del NCF— y "Upfront TI/LC Reserve" —un escrow al cierre—:
  // suenan igual y son cosas distintas, así que cada uno excluye al otro.

  {
    key: "reserve_tax_upfront",
    label: "Upfront RE Tax Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/upfront\s*(re\s*)?tax\s*reserve/i, /\btax\s*reserve\b.*upfront/i],
  },
  {
    key: "reserve_tax_monthly",
    label: "Monthly RE Tax Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/monthly\s*(re\s*)?tax\s*reserve/i],
  },
  {
    key: "reserve_insurance_upfront",
    label: "Upfront Insurance Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/upfront\s*insurance\s*reserve/i],
  },
  {
    key: "reserve_insurance_monthly",
    label: "Monthly Insurance Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/monthly\s*insurance\s*reserve/i],
  },
  {
    key: "reserve_replacement_cap",
    label: "Replacement Reserve Cap",
    unit: "currency",
    entity: "deal",
    patterns: [/replacement\s*reserve\s*caps?/i, /(replacement|ff\s*&?\s*e).*\bcaps?\b/i],
    exclude: [/\bti\s*\/?\s*lc\b/i],
  },
  {
    key: "reserve_replacement_upfront",
    label: "Upfront Replacement / PIP Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/upfront\s*replacement/i, /upfront.*\bpip\b/i],
    exclude: [/\bcaps?\b/i],
  },
  {
    key: "reserve_replacement_monthly",
    label: "Monthly Replacement / FF&E Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/monthly\s*replacement/i, /monthly.*ff\s*&?\s*e\s*reserve/i],
    exclude: [/\bcaps?\b/i],
  },
  {
    key: "reserve_tilc_cap",
    label: "TI/LC Reserve Cap",
    unit: "currency",
    entity: "deal",
    patterns: [/\bti\s*\/?\s*lc\b.*\bcaps?\b/i],
  },
  {
    key: "reserve_tilc_upfront",
    label: "Upfront TI/LC Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/upfront\s*ti\s*\/?\s*lc/i],
    exclude: [/\bcaps?\b/i, /underwritten/i],
  },
  {
    key: "reserve_tilc_monthly",
    label: "Monthly TI/LC Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/monthly\s*ti\s*\/?\s*lc/i],
    exclude: [/\bcaps?\b/i, /underwritten/i],
  },
  {
    key: "reserve_debt_service_cap",
    label: "Debt Service Reserve Cap",
    unit: "currency",
    entity: "deal",
    patterns: [/debt\s*service\s*reserve\s*caps?/i],
  },
  {
    key: "reserve_debt_service_upfront",
    label: "Upfront Debt Service Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/upfront\s*debt\s*service\s*reserve/i],
    exclude: [/\bcaps?\b/i],
  },
  {
    key: "reserve_debt_service_monthly",
    label: "Monthly Debt Service Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/monthly\s*debt\s*service\s*reserve/i],
    exclude: [/\bcaps?\b/i],
  },
  {
    key: "reserve_deferred_maintenance",
    label: "Upfront Deferred Maintenance Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/deferred\s*maintenance/i],
  },
  {
    key: "reserve_other_description",
    label: "Other Reserve Description",
    unit: "text",
    entity: "deal",
    patterns: [/other\s*reserve\s*description/i],
  },
  {
    key: "reserve_other_cap",
    label: "Other Reserve Cap",
    unit: "currency",
    entity: "deal",
    patterns: [/other\s*reserve\s*caps?/i],
  },
  {
    key: "reserve_other_upfront",
    label: "Upfront Other Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/upfront\s*other\s*reserve/i],
    exclude: [/\bcaps?\b/i, /description/i],
  },
  {
    key: "reserve_other_monthly",
    label: "Monthly Other Reserve",
    unit: "currency",
    entity: "deal",
    patterns: [/monthly\s*other\s*reserve/i],
    exclude: [/\bcaps?\b/i, /description/i],
  },

  // --- deducciones del NCF, no escrows -------------------------------------
  //
  // Estas dos son la diferencia entre NOI y NCF: el suscriptor resta una reserva
  // teórica de reposición y otra de comisiones e incentivos de alquiler. No son
  // plata depositada —eso son las reserve_* de arriba— sino un ajuste de cálculo.
  // Tenerlas permite verificar que NCF = NOI − estas dos.
  {
    key: "underwritten_replacement_reserve",
    label: "Underwritten Replacement / FF&E Reserve",
    unit: "currency",
    entity: "property",
    patterns: [/underwritten\s*replacement/i, /underwritten.*ff\s*&?\s*e\s*reserve/i],
  },
  {
    key: "underwritten_tilc",
    label: "Underwritten TI / LC",
    unit: "currency",
    entity: "property",
    patterns: [/underwritten\s*ti\s*\/?\s*lc/i],
  },

  // --- servicio de deuda y estructura del préstamo --------------------------
  {
    key: "debt_service_pi",
    label: "Annual Debt Service (P&I)",
    unit: "currency",
    entity: "deal",
    patterns: [/annual\s*debt\s*service\s*\(?\s*p\s*&?\s*i/i, /debt\s*service\s*\(?\s*p\s*&?\s*i/i],
    exclude: [/reserve/i, /coverage/i, /\bdscr\b/i],
  },
  {
    key: "debt_service_io",
    label: "Annual Debt Service (IO)",
    unit: "currency",
    entity: "deal",
    patterns: [/annual\s*debt\s*service\s*\(?\s*io\b/i, /debt\s*service\s*\(?\s*io\b/i],
    exclude: [/reserve/i, /coverage/i, /\bdscr\b/i],
  },
  {
    key: "amortization_type",
    label: "Amortization Type",
    unit: "text",
    entity: "deal",
    patterns: [/amorti[sz]ation\s*type/i],
  },
  {
    key: "interest_accrual_method",
    label: "Interest Accrual Method",
    unit: "text",
    entity: "deal",
    patterns: [/interest\s*accrual\s*method/i, /accrual\s*(method|basis)/i],
  },
  {
    key: "ard_loan",
    label: "ARD Loan",
    unit: "text",
    entity: "deal",
    patterns: [/\bard\s*loan\b/i],
  },
  {
    key: "io_period_original",
    label: "Original Interest-Only Period",
    unit: "count",
    entity: "deal",
    patterns: [/original\s*interest[-\s]*only\s*period/i, /original\s*\bio\b\s*period/i],
  },
  {
    key: "io_period_remaining",
    label: "Remaining Interest-Only Period",
    unit: "count",
    entity: "deal",
    patterns: [/remaining\s*interest[-\s]*only\s*period/i, /remaining\s*\bio\b\s*period/i],
  },
  {
    key: "amortization_term_original",
    label: "Original Amortization Term",
    unit: "count",
    entity: "deal",
    patterns: [/original\s*amorti[sz]ation\s*term/i],
  },
  {
    key: "amortization_term_remaining",
    label: "Remaining Amortization Term",
    unit: "count",
    entity: "deal",
    patterns: [/remaining\s*amorti[sz]ation\s*term/i],
  },
  {
    key: "term_original",
    label: "Original Term To Maturity / ARD",
    unit: "count",
    entity: "deal",
    patterns: [/original\s*term\s*to\s*maturity/i],
    exclude: [/amorti/i, /interest[-\s]*only/i],
  },
  {
    key: "term_remaining",
    label: "Remaining Term To Maturity / ARD",
    unit: "count",
    entity: "deal",
    patterns: [/remaining\s*term\s*to\s*maturity/i],
    exclude: [/amorti/i, /interest[-\s]*only/i],
  },
  {
    key: "origination_date",
    label: "Origination Date",
    unit: "text",
    entity: "deal",
    patterns: [/origination\s*date/i],
  },
  {
    key: "first_payment_date",
    label: "First Payment Date",
    unit: "text",
    entity: "deal",
    patterns: [/first\s*payment\s*date/i],
  },
  {
    key: "seasoning_months",
    label: "Seasoning",
    unit: "count",
    entity: "deal",
    patterns: [/\bseasoning\b/i],
  },
  {
    key: "property_count",
    label: "# of Properties",
    unit: "count",
    entity: "deal",
    patterns: [/#\s*of\s*properties/i, /number\s*of\s*properties/i],
  },

  // --- control de flujo de fondos -------------------------------------------
  {
    key: "holdback_amount",
    label: "Holdback / Earnout Amount",
    unit: "currency",
    entity: "deal",
    patterns: [/holdback\s*\/?\s*earnout\s*amount/i, /\bearnout\s*amount/i],
    exclude: [/description/i],
  },
  {
    key: "holdback_description",
    label: "Holdback / Earnout Description",
    unit: "text",
    entity: "deal",
    patterns: [/holdback\s*\/?\s*earnout\s*description/i, /\bearnout\s*description/i],
  },
  {
    key: "lockbox_type",
    label: "Lockbox Type",
    unit: "text",
    entity: "deal",
    patterns: [/\blockbox\b/i],
  },
  {
    key: "cash_management",
    label: "Cash Management",
    unit: "text",
    entity: "deal",
    patterns: [/cash\s*management/i],
  },
  // -------------------------------------------------------------------------
  // Los otros seis saldos
  // -------------------------------------------------------------------------
  //
  // Es la misma trampa que el LTV, peor. Con el LTV eran tres denominadores;
  // con el saldo son siete columnas que se llaman casi igual y significan cosas
  // distintas. Los ratios que publica el emisor —debt yield, DSCR, LTV— se
  // calculan contra el préstamo completo, no contra la porción del trust, así
  // que sin estas columnas ninguna identidad puede cerrar en los préstamos
  // grandes.

  {
    key: "balance_whole_loan",
    label: "Whole Loan Cut-off Date Balance",
    unit: "currency",
    entity: "deal",
    patterns: [/whole\s*loan\s*cut-?off\s*date\s*balance/i, /whole\s*loan\s*balance/i],
    exclude: [/%|percent/i, /ltv/i, /dscr/i, /debt\s*yield/i],
  },
  /**
   * El sénior completo, publicado en una sola columna.
   *
   * ENCONTRADO POR EL RECONCILIADOR, NO POR LEER ENCABEZADOS
   *
   * Los ratios del emisor se calculan contra trust + pari passu no-trust, y
   * nosotros lo armábamos sumando dos métricas. Resulta que varias emisiones
   * publican ese total en una columna propia —"Total Cut-off Date Pari Passu
   * Debt"— y la estábamos ignorando.
   *
   * No salió de mirar la lista de columnas sin mapear: salió de preguntar qué
   * celda de cada fila vale el saldo implícito por la identidad. 33 préstamos en
   * 4 emisiones coincidieron dentro del 1%, con ejemplos como 1.001,0M contra
   * 1.001,3M de implícito. La columna se identificó por su valor, no por su
   * nombre.
   *
   * Vale más que la suma cuando está: no depende de que las dos partes se hayan
   * mapeado bien, ni de que el Annex publique las dos.
   *
   * NO confundir con `balance_total_debt`, que además incluye la subordinada y
   * la mezzanine. Coinciden solo cuando el préstamo no tiene deuda junior, que
   * es por qué "Total Debt Cut-off Balance" también apareció en el
   * reconciliador — esa se deja donde está, porque en un préstamo con B-note
   * daría un denominador inflado.
   */
  {
    key: "balance_senior_total",
    label: "Total Senior (Trust + Pari Passu) Cut-off Balance",
    unit: "currency",
    entity: "deal",
    patterns: [
      /total\s*cut-?off\s*date\s*pari\s*passu\s*debt/i,
      /total\s*current\s*balance\s*pari\s*passu\s*debt/i,
      /total\s*pari\s*passu\s*debt\s*(cut-?off|current)/i,
      /total\s*senior\s*notes?\s*cut-?off\s*date\s*balance/i,
      /senior\s*notes?\s*cut-?off\s*date\s*balance/i,
      // El original va último: mismo criterio que loan_amount, donde estén las
      // dos gana la de fecha de corte.
      /total\s*original\s*balance\s*pari\s*passu\s*debt/i,
    ],
    exclude: [
      /%|percent/i, /\bltv\b/i, /dscr/i, /debt\s*yield/i,
      /per\s*(unit|sf)/i, /\(y\s*\/\s*n\)/i, /monthly|annual/i,
    ],
  },
  {
    key: "balance_pari_passu_trust",
    label: "Trust Pari Passu Cut-off Date Balance",
    unit: "currency",
    entity: "deal",
    patterns: [/\btrust\s*pari\s*passu\b.*balance/i],
    exclude: [/non-?\s*trust/i, /%|percent/i],
  },
  {
    key: "balance_pari_passu_non_trust",
    label: "Non-Trust Pari Passu Companion Loan Cut-off Date Balance",
    unit: "currency",
    entity: "deal",
    /**
     * El segundo patrón cubre las emisiones que no escriben "non-trust".
     *
     * Un "companion loan" es, por definición, la porción que NO está en este
     * trust: si estuviera, no sería companion. Así que "Cut-off Date Pari Passu
     * Companion Loan Balance ($)" es el mismo concepto con otro nombre. Aparece
     * en 7 emisiones que hoy tienen 144 préstamos con el debt yield roto.
     *
     * Es una inferencia sobre la terminología, no una certeza. La prueba es la
     * identidad: si al mapearla el debt yield cierra en esos 144, el concepto
     * era el que creemos. Si el denominador se pasa, la columna incluía también
     * la porción del trust y hay que restarla.
     *
     * Las exclusiones son las banderas y los flujos: el mismo bloque trae
     * "Pari Passu (Y/N)" y "Pari Passu Companion Loan Annual Debt Service ($)".
     */
    /**
     * ORIGINAL Y FECHA DE CORTE NO SON EL MISMO SALDO, TAMPOCO ACÁ.
     *
     * `loan_amount` distingue los dos —prefiere el de corte y manda el original
     * a su propia métrica— porque en un préstamo que ya amortizó no coinciden.
     * Esta métrica se había olvidado de hacer la misma distinción.
     *
     * El resultado era peor que un número impreciso: el denominador sumaba el
     * saldo a fecha de corte del trust con el saldo ORIGINAL del companion. Dos
     * fechas distintas en la misma cuenta. CF 2020-CF4 y Benchmark 2020-B18
     * mapeaban "Non-Trust Pari Passu Original Balance($)" y ninguna de sus filas
     * cerraba la identidad del debt yield.
     *
     * Los patrones van de más específico a más general: donde el Annex publique
     * las dos columnas gana la de corte, y donde solo esté la original se usa
     * esa —con la fecha mezclada, pero visible en el encabezado que guardamos—.
     */
    patterns: [
      /non-?\s*trust\s*pari\s*passu.*cut-?off\s*date.*balance/i,
      /cut-?off\s*date\s*pari\s*passu(?!.*\btrust\b).*balance/i,
      /pari\s*passu\s*companion\s*loan\s*cut-?off.*balance/i,
      /non-?\s*trust\s*pari\s*passu.*balance/i,
      /pari\s*passu\s*companion\s*loan.*balance/i,
      // "Pari Passu Piece Non-Trust Cut-Off Balance" y "Original Balance Piece
      // Non-Trust ($)": 52 préstamos en 5 emisiones, identificados por el
      // reconciliador porque su valor iguala lo que le falta al saldo del trust.
      /pari\s*passu\s*piece\s*non-?\s*trust.*balance/i,
      /balance\s*piece\s*non-?\s*trust/i,
    ],
    exclude: [
      /%|percent/i, /\(y\s*\/\s*n\)/i, /control/i,
      /debt\s*service/i, /monthly|annual/i, /per\s*(unit|sf)/i,
    ],
  },
  {
    key: "balance_subordinate",
    label: "Subordinate Companion Loan Cut-off Date Balance",
    unit: "currency",
    entity: "deal",
    patterns: [/subordinate\s*companion.*balance/i, /\bb-?note\b.*balance/i],
    exclude: [/%|percent/i],
  },
  {
    key: "balance_mezzanine",
    label: "Mezzanine Debt Cut-off Date Balance",
    unit: "currency",
    entity: "deal",
    patterns: [/mezzanine\s*debt.*balance/i, /\bmezz\b.*balance/i],
    exclude: [/%|percent/i, /rate/i],
  },
  {
    key: "balance_total_debt",
    label: "Total Debt Cut-off Date Balance",
    unit: "currency",
    entity: "deal",
    // El denominador de ltv_total_debt y debt_yield_total_debt, que ya
    // mapeábamos sin tener nunca su base. Aparece en 176 filings.
    patterns: [/total\s*(mortgage\s*)?debt\s*cut-?off\s*date\s*balance/i, /total\s*(mortgage\s*)?debt\s*balance/i],
    exclude: [/%|percent/i, /ltv/i, /dscr/i, /debt\s*yield/i, /\bper\b/i],
  },
  {
    key: "balance_maturity",
    label: "Maturity / ARD Balance",
    unit: "currency",
    entity: "deal",
    patterns: [/maturity\s*\/?\s*ard\s*balance/i, /balloon\s*balance/i],
    exclude: [/%|percent/i, /ltv/i],
  },
  {
    key: "balance_original",
    label: "Original Balance",
    unit: "currency",
    entity: "deal",
    /**
     * El patrón genérico va tercero A PROPÓSITO.
     *
     * `scoreHeader` decae 0.08 por posición, así que este spec puntúa 0.84 sobre
     * "Original Balance ($)" mientras `loan_amount` puntúa 0.92 con el mismo
     * header. La asignación es golosa y global, así que el efecto es:
     *
     *   hay "Cut-off Date Balance"  → loan_amount se queda con ese (1.00) y
     *                                 el original cae acá
     *   solo hay "Original Balance" → loan_amount lo toma (0.92 > 0.84)
     *
     * Es el fallback que hacía falta: un Annex A que no publique saldo a la
     * fecha de corte igual tiene que producir `loan_amount`. Sin este orden,
     * esa familia de formato quedaría sin saldo y en silencio.
     */
    patterns: [
      // Las dos primeras son grafías raras y van acá solo para que la genérica
      // quede en el índice 2 y puntúe 0.84. "Original Principal Balance" NO va
      // arriba: es la misma columna escrita completa, y ponerla primero le
      // robaba el saldo a `loan_amount` en los Annex A que la usan.
      /original\s*balance\s*at\s*securiti[sz]ation/i,
      /balance\s*at\s*origination/i,
      /original\s*(principal\s*)?balance/i,
    ],
    exclude: [
      /whole\s*loan/i, /pari\s*passu/i, /companion/i, /subordinate/i,
      /mezzanine/i, /%|percent/i, /cut-?off/i,
    ],
  },
  {
    key: "pool_share",
    label: "% of Initial Pool Balance",
    unit: "percent",
    entity: "deal",
    patterns: [/%\s*of\s*initial\s*pool\s*balance/i, /%\s*of\s*pool/i],
  },
];

export interface ColumnMatch {
  columnIndex: number;
  header: string;
  metric: MetricSpec;
  score: number;
}

/**
 * ¿Este texto identifica una métrica por sí solo, sin contexto?
 *
 * Lo usa el fusionado de encabezados HTML para decidir si necesita pegarle el
 * encabezado de grupo. "Net Rentable Area (SF)" se entiende solo; "NOI" a
 * secas no —puede ser underwritten o trailing— y necesita el grupo.
 *
 * El umbral es alto a propósito: ante la duda conviene fusionar, porque un
 * encabezado ambiguo se puede desambiguar con el grupo, pero un encabezado
 * contaminado por el grupo se mapea mal en silencio.
 */
export function mapsToSomeMetric(header: string, minScore = 0.9): boolean {
  for (const spec of METRIC_SPECS) {
    if (scoreHeader(header, spec) >= minScore) return true;
  }
  return false;
}

/**
 * Puntúa un header contra una métrica.
 * 0 = no aplica. Cuanto más específico el patrón que matchea, más alto.
 */
export function scoreHeader(header: string, spec: MetricSpec): number {
  const clean = header.replace(/\s+/g, " ").trim();
  if (!clean) return 0;

  if (spec.exclude?.some((re) => re.test(clean))) return 0;

  for (let i = 0; i < spec.patterns.length; i++) {
    if (spec.patterns[i]!.test(clean)) {
      // Los primeros patrones de la lista son los más específicos.
      return 1 - i * 0.08;
    }
  }
  return 0;
}

/**
 * Mapea los headers de una planilla a métricas.
 *
 * Resuelve conflictos: si dos columnas matchean la misma métrica, gana la de
 * mayor puntaje. Si una columna matchea varias métricas, gana la de mayor
 * puntaje. Así evitamos que "UW NOI" y "Most Recent NOI" terminen en la misma.
 */
export function mapColumns(headers: string[]): {
  matches: ColumnMatch[];
  unmapped: Array<{ columnIndex: number; header: string }>;
} {
  const candidates: ColumnMatch[] = [];

  headers.forEach((header, columnIndex) => {
    if (!header?.trim()) return;
    for (const metric of METRIC_SPECS) {
      const score = scoreHeader(header, metric);
      if (score > 0) candidates.push({ columnIndex, header, metric, score });
    }
  });

  candidates.sort((a, b) => b.score - a.score);

  const usedColumns = new Set<number>();
  const usedMetrics = new Set<MetricKey>();
  const matches: ColumnMatch[] = [];

  for (const c of candidates) {
    if (usedColumns.has(c.columnIndex) || usedMetrics.has(c.metric.key)) continue;
    usedColumns.add(c.columnIndex);
    usedMetrics.add(c.metric.key);
    matches.push(c);
  }

  matches.sort((a, b) => a.columnIndex - b.columnIndex);

  const unmapped = headers
    .map((header, columnIndex) => ({ columnIndex, header }))
    .filter((h) => h.header?.trim() && !usedColumns.has(h.columnIndex));

  return { matches, unmapped };
}

// ---------------------------------------------------------------------------
// Parseo de valores
// ---------------------------------------------------------------------------

/**
 * Convierte el valor crudo de la celda al tipo de la métrica.
 *
 * Los Annex A mezclan formatos sin piedad: "$1,234,567", "1234567", "94.5%",
 * "0.945", "1.25x", "N/A", "-", "" y celdas vacías. Devuelve null cuando no
 * hay dato — que es distinto de cero.
 */
export function parseValue(raw: unknown, unit: MetricSpec["unit"]): string | null {
  if (raw === null || raw === undefined) return null;

  if (unit === "text") {
    const s = String(raw).trim();
    return s && !isNullish(s) ? s : null;
  }

  let s = String(raw).trim();
  if (!s || isNullish(s)) return null;

  const hadPercentSign = s.includes("%");
  const isNegative = /^\(.*\)$/.test(s); // contabilidad: (1,234) = -1234

  /**
   * Un número con un espacio en el medio no es un número.
   *
   * Benchmark 2020-B16 publica un LTV como "48 5%" y un debt yield como "13 1%":
   * un espacio donde va el punto decimal. Es un error de tipeo del emisor —las
   * celdas vecinas dicen "65.8%" y "9.0%"— y está así en el HTML de la SEC.
   *
   * Al sacar los espacios junto con las comas, "13 1%" se convertía en 131% y
   * entraba al corpus como 1.31. El chequeo de sanidad lo agarraba por rango,
   * pero un "12 5%" habría dado 1.25 y pasado desapercibido.
   *
   * Reparar la intención sería adivinar: "13 1" podría ser 13.1 o 131. Preferimos
   * el agujero declarado, que es la misma decisión que tomamos con los saldos y
   * con los identificadores no numéricos.
   *
   * El separador de miles va con coma en estos documentos, nunca con espacio, así
   * que no hay caso legítimo que esto rompa.
   */
  const withoutMoney = s.replace(/[$,()%]/g, "").replace(/x$/i, "").trim();
  if (/\d[\s\u00a0]+\d/.test(withoutMoney)) return null;

  s = s
    .replace(/[$,\s]/g, "")
    .replace(/[()]/g, "")
    .replace(/x$/i, "")
    .replace(/%/g, "");

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  let value = isNegative ? -n : n;

  if (unit === "percent") {
    // "94.5%" → 0.945 ; "0.945" ya está en fracción.
    // Heurística: con signo de %, o sin él pero > 1.5, asumimos porcentaje.
    if (hadPercentSign || value > 1.5) value = value / 100;
    // Dividir por 100 introduce ruido de punto flotante: 93.1/100 da
    // 0.9309999999999999. Redondeamos a 6 decimales, que es más precisión de
    // la que cualquier Annex A reporta.
    value = round(value, 6);
  }

  if (unit === "ratio") {
    value = round(value, 4);
  }

  if (unit === "count" || unit === "years") {
    value = Math.round(value);
    // Un año fuera de rango es basura, no dato.
    if (unit === "years" && (value < 1700 || value > 2100)) return null;
  }

  return String(value);
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/**
 * Reconoce filas de agregación: totales, subtotales, promedios.
 *
 * Los Annex A intercalan estas filas entre los datos y hay que descartarlas.
 * Contar observations no alcanza: una fila "TOTAL" con NOI y balance sumados
 * tiene datos suficientes para pasar el filtro por cantidad.
 */
export function looksLikeAggregateRow(textValues: Array<string | null>): boolean {
  const AGGREGATE = /^\s*(grand\s+)?(total|subtotal|sub-total|average|avg|weighted\s*average|wtd\.?\s*avg|sum|count|min|max|median)\b/i;
  return textValues.some((v) => v !== null && AGGREGATE.test(v));
}

/**
 * Marcadores de "sin dato" que aparecen en Annex A reales.
 *
 * `NAP` (not applicable) y `NAV` (not available) son convención de CMBS y
 * significan cosas distintas para un analista, pero para nosotros ambos son
 * ausencia de dato. `Various` aparece cuando un préstamo cubre varias
 * propiedades con valores distintos — tampoco es un número.
 */
function isNullish(s: string): boolean {
  return /^(n\/?a|na|nap|nav|none|null|various|-+|—|\.\.\.)$/i.test(s.trim());
}

/**
 * Encuentra la fila de headers en una planilla.
 *
 * Los Annex A arrancan con filas de título, logos y notas antes de la tabla
 * real. Buscamos la primera fila que mapee al menos `minMatches` métricas.
 */
export function findHeaderRow(
  rows: unknown[][],
  opts: { maxScan?: number; minMatches?: number } = {},
): { rowIndex: number; headers: string[]; matchCount: number } | null {
  const maxScan = opts.maxScan ?? 30;
  const minMatches = opts.minMatches ?? 4;

  let best: { rowIndex: number; headers: string[]; matchCount: number } | null = null;

  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const headers = (rows[i] ?? []).map((c) => (c === null || c === undefined ? "" : String(c)));
    const nonEmpty = headers.filter((h) => h.trim()).length;
    if (nonEmpty < minMatches) continue;

    const { matches } = mapColumns(headers);
    if (matches.length >= minMatches && (!best || matches.length > best.matchCount)) {
      best = { rowIndex: i, headers, matchCount: matches.length };
    }
  }

  return best;
}

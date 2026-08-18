/**
 * El estado, a código de dos letras.
 *
 * POR QUÉ EXISTE
 *
 * El monitor encontró **1.585 préstamos con estado inválido: el 16,4% del corpus**.
 * De ésos, 795 tienen el nombre escrito completo —"New York", "California",
 * "Texas"— porque algunos emisores lo publican así y el harvester guardaba el texto
 * crudo sin normalizar.
 *
 * Esos préstamos eran invisibles para TODA consulta de `/comps`, que filtra por
 * código de dos letras. No aparecían en el estado, ni en la región, ni en la
 * consulta nacional. Y no dejaban rastro: un filtro que no matchea no se queja.
 *
 * Apareció de costado, buscando por qué industrial en California daba 9
 * comparables y el Pacífico entero también 9. Nueva York tiene 1.839 préstamos con
 * código y 206 más escritos "New York": un 11% que el producto no veía.
 *
 * LO QUE ESTA TABLA NO ARREGLA
 *
 * Los otros 790 tienen el estado VACÍO, y ahí no hay nada que mapear. La sospecha
 * —a verificar, no a suponer— es que sean carteras multi-estado, el mismo fenómeno
 * que explica la mayor parte de los préstamos sin tipo de propiedad: un préstamo
 * sobre propiedades en cinco estados no tiene UN estado, y el Annex A deja la celda
 * en blanco o pone "Various".
 *
 * Si es eso, la respuesta correcta no es completarlo sino tratarlo como lo que es.
 *
 * SE MAPEA SOLO LO SEGURO
 *
 * Nombre completo, territorios y abreviaturas con punto. Nada de coincidencias
 * parciales ni
 * distancias de edición: un estado mal adivinado pone un préstamo en el mercado
 * equivocado, y eso es peor que dejarlo afuera —que al menos el monitor lo cuenta—.
 * Lo que no está en la tabla queda inválido y sigue apareciendo en la alerta.
 */

/** Los cincuenta más DC, por nombre completo. */
const POR_NOMBRE: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY",
  /**
   * DC va DESPUÉS de "washington" a propósito no —los objetos no tienen orden
   * garantizado— así que las variantes se listan explícitas. "Washington" a secas
   * es el estado; el distrito siempre se escribe distinto.
   */
  "district of columbia": "DC", "washington dc": "DC", "washington, d.c.": "DC",
  "washington d.c.": "DC",
};

/**
 * Territorios, que casi me como.
 *
 * La primera versión de `CODIGOS` salía solo de los cincuenta estados más DC, así
 * que `normalizarEstado("PR")` habría devuelto null y los préstamos de Puerto Rico
 * —que hoy funcionan— habrían desaparecido del producto. Un arreglo que rompe algo
 * que andaba, exactamente lo que este archivo viene a evitar.
 *
 * Puerto Rico tiene mercado CMBS de verdad; los otros son raros pero cuestan una
 * línea y su ausencia costaría un préstamo invisible.
 */
const TERRITORIOS: Record<string, string> = {
  "puerto rico": "PR", "virgin islands": "VI", "u.s. virgin islands": "VI",
  guam: "GU", "american samoa": "AS", "northern mariana islands": "MP",
};

/** Abreviaturas con punto que aparecen en los Annex A. */
const ABREVIATURAS: Record<string, string> = {
  "calif.": "CA", "conn.": "CT", "fla.": "FL", "ill.": "IL", "ind.": "IN",
  "kans.": "KS", "mass.": "MA", "mich.": "MI", "minn.": "MN", "miss.": "MS",
  "n.c.": "NC", "n.j.": "NJ", "n.m.": "NM", "n.y.": "NY", "okla.": "OK",
  "penn.": "PA", "penna.": "PA", "tenn.": "TN", "tex.": "TX", "va.": "VA",
  "wash.": "WA", "wis.": "WI", "wisc.": "WI", "d.c.": "DC",
};

/** Los códigos válidos, para no aceptar cualquier par de letras. */
export const CODIGOS = new Set([
  ...Object.values(POR_NOMBRE),
  ...Object.values(TERRITORIOS),
]);

/**
 * Devuelve el código de dos letras, o `null` si no se puede afirmar cuál es.
 *
 * `null` es una respuesta: el préstamo queda contado en la alerta del monitor en
 * vez de asignado a un estado inventado.
 */
export function normalizarEstado(crudo: string | null | undefined): string | null {
  if (!crudo) return null;
  const limpio = crudo.trim().replace(/\s+/g, " ");
  if (!limpio) return null;

  /** Ya es un código: se acepta solo si existe de verdad. */
  if (/^[A-Za-z]{2}$/.test(limpio)) {
    const cod = limpio.toUpperCase();
    return CODIGOS.has(cod) ? cod : null;
  }

  const clave = limpio.toLowerCase();
  return POR_NOMBRE[clave] ?? TERRITORIOS[clave] ?? ABREVIATURAS[clave] ?? null;
}

/**
 * El mismo mapeo como CASE de SQL, para `db:fix-estados`, que arregla lo ya
 * cosechado sin volver a bajar los documentos.
 *
 * Se genera desde la MISMA tabla en vez de escribirse a mano: dos listas de
 * cincuenta entradas que hay que mantener sincronizadas divergen en la primera
 * corrección que se hace en una sola, y esta sesión ya lo mostró tres veces.
 */
export function casoSql(columna = "state"): string {
  const ramas = [
    ...Object.entries(POR_NOMBRE),
    ...Object.entries(TERRITORIOS),
    ...Object.entries(ABREVIATURAS),
  ]
    .map(([nombre, cod]) => `      WHEN lower(btrim(${columna})) = ${sqlLiteral(nombre)} THEN '${cod}'`)
    .join("\n");
  return `CASE\n      WHEN btrim(${columna}) ~ '^[A-Za-z]{2}$' THEN upper(btrim(${columna}))\n${ramas}\n      ELSE NULL\n    END`;
}

const sqlLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

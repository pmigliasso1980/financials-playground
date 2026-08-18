/**
 * Smoke de la API: corre contra el servidor levantado, no contra mocks.
 *
 *   npm run api        # terminal 1
 *   npm run api:smoke  # terminal 2
 *
 * POR QUÉ EXISTE, Y CUÁL ES EL CHEQUEO QUE LO MOTIVÓ
 *
 * La primera versión de la pantalla mostraba cada comparable con un link "a la
 * SEC" que era una URL de búsqueda escrita de memoria: parámetros vacíos y
 * `action` repetido dos veces. No llevaba a ninguna parte, y el dato correcto
 * —`file_url`— estaba en la base desde el principio.
 *
 * Eso pasó el typecheck, pasó la revisión y se commiteó describiéndolo como
 * "lleva cada comparable a su documento en la SEC". Un string no tiene tipo que
 * lo desmienta.
 *
 * Así que el chequeo central de este archivo es ese: **toda URL que la API
 * devuelve tiene que apuntar al archivo de EDGAR**, y la forma se verifica contra
 * el patrón real. Es el único test acá que atrapa una alucinación en vez de un
 * error de programación.
 *
 * LO QUE ESTE SMOKE NO HACE
 *
 * No abre las URLs. Verificar que respondan 200 obligaría a pegarle a sec.gov en
 * cada corrida, y eso convierte un test rápido en uno que falla por red. Verifica
 * la FORMA; que el archivo exista lo garantiza el harvester, que lo descargó.
 */

const BASE = process.env.API ?? "http://localhost:8787";

let ok = 0;
let fallidos = 0;

function check(nombre: string, condicion: boolean, detalle?: string) {
  if (condicion) {
    ok++;
    console.log(`  \x1b[32m✓\x1b[0m ${nombre}`);
  } else {
    fallidos++;
    console.log(`  \x1b[31m✗\x1b[0m ${nombre}${detalle ? `\n      \x1b[90m${detalle}\x1b[0m` : ""}`);
  }
}

async function get(ruta: string) {
  const res = await fetch(`${BASE}${ruta}`);
  const cuerpo = await res.json();
  return { status: res.status, ...cuerpo };
}

console.log(`\n  Smoke de la API — ${BASE}\n`);

try {
  const salud = await get("/health");
  check("/health responde 200", salud.status === 200);
  check("toda respuesta trae request_id", typeof salud.request_id === "string");
} catch {
  console.error(
    `\n  \x1b[31mNo se pudo conectar a ${BASE}.\x1b[0m Levantá el servidor con \x1b[1mnpm run api\x1b[0m\n`,
  );
  process.exit(1);
}

const corpus = await get("/corpus");
check("/corpus trae la estampa de procedencia", typeof corpus.data?.estampa === "string");
check("/corpus lista los tipos", Array.isArray(corpus.data?.tipos) && corpus.data.tipos.length > 0);

// ---------------------------------------------------------------------------
// Parámetros inválidos: todos los errores juntos, no el primero
// ---------------------------------------------------------------------------

const malos = await get("/comps?state=GEORGIA&type=Casas&amount=cero");
check("parámetros inválidos → 422", malos.status === 422);
check(
  "devuelve los TRES errores, no solo el primero",
  malos.data?.error?.fallos?.length === 3,
  `devolvió ${malos.data?.error?.fallos?.length}`,
);
check(
  "cada error dice qué mandar",
  (malos.data?.error?.fallos ?? []).every((f: { esperado?: string }) => typeof f.esperado === "string"),
);

// ---------------------------------------------------------------------------
// Una consulta imposible: se niega y ofrece salida
// ---------------------------------------------------------------------------

const vacia = await get("/comps?state=WY&type=Self+Storage&amount=999000000");
check("consulta sin comparables → 200, NO 404", vacia.status === 200);
check("y se declara insuficiente", vacia.data?.suficiente === false);
check(
  "muestra la escalera geográfica completa",
  Array.isArray(vacia.data?.escalera) && vacia.data.escalera.length === 3,
  `escalera: ${JSON.stringify(vacia.data?.escalera?.map((p: { etiqueta: string }) => p.etiqueta))}`,
);
check(
  "y además ofrece aflojar tamaño y ventana",
  Array.isArray(vacia.data?.siAmplias) && vacia.data.siAmplias.length === 2,
);

// ---------------------------------------------------------------------------
// La consulta real: acá vive el chequeo que motivó el archivo
// ---------------------------------------------------------------------------

const r = await get("/comps?state=NY&type=Multifamily&amount=25000000&months=60&target_ltv=70");
check("consulta válida → 200", r.status === 200);
check("trae el límite del canal en la respuesta", typeof r.data?.corpus?.canal === "string");
check("trae la estampa del corpus", typeof r.data?.corpus?.estampa === "string");
check(
  "el LTV se normalizó de 70 a 0,70",
  r.data?.criterios?.ltvObjetivo === 0.7,
  `quedó en ${r.data?.criterios?.ltvObjetivo}`,
);

if (r.data?.suficiente) {
  const m = r.data.muestra as Array<{ documento: string; indice: string; emision: string }>;
  check("devuelve comparables", m.length > 0);

  /**
   * El alcance tiene que estar y ser coherente con la escalera: si dice "estado",
   * el primer peldaño tiene que llegar al mínimo por sí solo.
   */
  check(
    "declara hasta dónde abrió el radio",
    ["estado", "region", "pais"].includes(r.data.alcance),
    `alcance: ${r.data.alcance}`,
  );
  const primerPeldano = r.data.escalera?.[0];
  check(
    "el alcance es coherente con la escalera",
    r.data.alcance !== "estado" || primerPeldano.encontrados >= 10,
    `dice "${r.data.alcance}" pero ${primerPeldano?.etiqueta} tiene ${primerPeldano?.encontrados}`,
  );

  /** EL CHEQUEO. Una URL inventada muere acá y en ningún otro lado. */
  const malDocumento = m.filter((c) => !/^https:\/\/www\.sec\.gov\/Archives\/edgar\//.test(c.documento));
  check(
    "TODO documento apunta al archivo real de EDGAR",
    malDocumento.length === 0,
    malDocumento[0] ? `ej: ${malDocumento[0].documento}` : undefined,
  );

  const PATRON = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/\d{10}-\d{2}-\d{6}-index\.htm$/;
  const malIndice = m.filter((c) => !PATRON.test(c.indice));
  check(
    "TODO índice tiene la forma cik/accession/accession-index.htm",
    malIndice.length === 0,
    malIndice[0] ? `ej: ${malIndice[0].indice}` : undefined,
  );

  check(
    "ninguna URL quedó con parámetros vacíos",
    !m.some((c) => /[?&][a-z_]+=(&|$)/i.test(c.documento) || /[?&][a-z_]+=(&|$)/i.test(c.indice)),
  );

  /**
   * Cada distribución declara su propia base y esa base no puede superar al total:
   * si lo hiciera, estaría contando préstamos que no son comparables.
   */
  const dists = r.data.distribuciones as Array<{ base: number; etiqueta: string }>;
  check("cada métrica declara su base", dists.every((d) => Number.isInteger(d.base) && d.base > 0));
  check(
    "ninguna base supera al total de comparables",
    dists.every((d) => d.base <= r.data.encontrados),
    dists.map((d) => `${d.etiqueta}=${d.base}`).join(" · ") + ` vs ${r.data.encontrados}`,
  );
} else {
  console.log(
    `  \x1b[33m·\x1b[0m la consulta de prueba no tuvo comparables (${r.data?.encontrados}); ` +
      `no se pudo verificar la forma de las URLs`,
  );
}

console.log(
  `\n  ${fallidos === 0 ? "\x1b[32m" : "\x1b[31m"}${ok} ok · ${fallidos} fallidos\x1b[0m\n`,
);
process.exit(fallidos === 0 ? 0 : 1);

/**
 * ¿En qué se aparta esta emisión de su cohorte?
 *
 *   npm run db:benchmark                    # la más reciente
 *   npm run db:benchmark -- BNK52
 *   npm run db:benchmark -- --listar
 *
 * QUÉ ES ESTO Y QUÉ NO
 *
 * Es la primera pieza con forma de servicio en vez de diagnóstico: entra una
 * emisión, sale dónde cae respecto de las otras de su año. Tiene entrada,
 * salida, y un usuario imaginable — alguien mirando un deal que quiere saber si
 * los términos son de mercado.
 *
 * Los once scripts anteriores eran instrumentos para quien construye. Este
 * responde una pregunta que alguien más podría hacer.
 *
 * POR QUÉ CONTRA LA COHORTE Y NO CONTRA LA HISTORIA
 *
 * `db:stability` mostró que 6 de 7 métricas se desplazan más del 20% entre
 * añadas, y que condicionar por plazo no lo arregla: es macro. Una referencia
 * pooled mediría el ciclo, no la emisión.
 *
 * Además es la comparación que alguien quiere: nadie pregunta si su deal de
 * 2026 se aparta de 2013.
 *
 * LA UNIDAD DE COMPARACIÓN ES LA EMISIÓN, NO EL PRÉSTAMO
 *
 * Se compara la MEDIANA del pool contra la distribución de las medianas de las
 * otras emisiones del año. Comparar préstamo contra préstamo mezclaría la
 * variación de adentro de un pool con la de entre pools, y la pregunta es sobre
 * el pool.
 *
 * Con 27 pares, un percentil tiene una resolución de ~4 puntos. Se reporta la
 * posición ordinal —"3ª de 28"— porque es lo que el número realmente soporta.
 *
 * QUÉ EXCLUYE Y POR QUÉ
 *
 * Las emisiones de un solo tipo de propiedad no son conduits diversificados:
 * son otro producto. Compararlas contra la cohorte conduit produce diferencias
 * garantizadas que no significan nada. Se excluyen del grupo de referencia y se
 * dice cuáles.
 */

import { closePool, ping, query } from "./client.js";
import {
  calcularBenchmark, cargarCandidatas, CONCENTRACION_TIPO, METRICAS,
  MIN_PARA_METRICA, MIN_PARES, pct,
} from "./cohortBenchmark.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/**
 * LAS CONSTANTES, LAS MÉTRICAS Y EL CÁLCULO VIVEN EN cohortBenchmark.ts
 *
 * Antes estaban acá, y cuando apareció `db:page` había dos caminos posibles:
 * duplicarlas o compartirlas. Duplicarlas es cómo la ocupación terminó con dos
 * definiciones contradiciéndose en la misma pantalla —una exigía diez préstamos,
 * la otra uno—, así que el cálculo se movió a un módulo y este script quedó como
 * lo que es: una vista.
 */
const args = process.argv.slice(2);
const LISTAR = args.includes("--listar");

/**
 * `--auditoria`: ¿en cuántas emisiones de la cohorte resuelve cada métrica?
 *
 * POR QUÉ EXISTE
 *
 * La primera corrida devolvió "Ocupación — sin dato en esta emisión". En un
 * diagnóstico eso es una nota al pie; en un producto es lo que destruye la
 * confianza, porque el usuario no sabe si el dato no existe o si nosotros no lo
 * encontramos.
 *
 * Y antes de decidir cuál de las dos cosas es, hace falta el denominador: si la
 * ocupación resuelve en 5 de 28 emisiones no debería estar en la herramienta;
 * si resuelve en 26, son dos emisiones con un problema de mapeo.
 *
 * Es la misma regla que venimos usando —medir la cobertura antes de construir
 * encima— aplicada al benchmark en vez de al corpus.
 */
const AUDITORIA = args.includes("--auditoria");
const BUSQUEDA = args.find((a) => !a.startsWith("--")) ?? null;


const candidatas = await cargarCandidatas();

if (LISTAR) {
  console.log(`\n${"═".repeat(78)}`);
  console.log("Emisiones disponibles (más recientes primero)");
  console.log(`${"═".repeat(78)}\n`);
  for (const c of candidatas.slice(0, 30)) {
    const share = c.shareDominante;
    console.log(
      `  ${c.filed.slice(0, 10)}  ${c.nombre.slice(0, 42).padEnd(44)} ${String(c.pool).padStart(4)}` +
        (share > CONCENTRACION_TIPO
          ? `  \x1b[33mmono-tipo (${pct(share)} ${c.tipoDominante})\x1b[0m`
          : ""),
    );
  }
  console.log();
  await closePool();
  process.exit(0);
}

if (AUDITORIA) {
  const anadaAudit = String(new Date().getFullYear());
  const cohorte = candidatas.filter((c) => c.anada === anadaAudit);
  const accs = cohorte.map((c) => c.accession);

  console.log(`\n${"═".repeat(78)}`);
  console.log(`Auditoría del benchmark — cohorte ${anadaAudit}`);
  console.log(`${"═".repeat(78)}\n`);
  console.log(`  ${cohorte.length} emisiones. ¿En cuántas resuelve cada métrica?\n`);
  console.log(`  métrica          resuelve   emisiones sin dato`);
  console.log(`  ${"─".repeat(70)}`);

  for (const m of METRICAS) {
    const { rows } = await query<{ accession: string; n: string }>(
      `SELECT l.accession, count(*)::text AS n
         FROM corpus.facts fa
         JOIN corpus.loans l ON l.id = fa.loan_id
        WHERE fa.metric_key = $1
          AND fa.value ~ '^-?[0-9.]+$'
          AND fa.value::numeric BETWEEN ${m.min} AND ${m.max}
          AND l.accession = ANY($2)
        GROUP BY l.accession
       HAVING count(*) >= ${MIN_PARA_METRICA}`,
      [m.key, accs],
    );
    const con = new Set(rows.map((r) => r.accession));
    const sin = cohorte.filter((c) => !con.has(c.accession));
    const cuenta = new Map(rows.map((r) => [r.accession, Number(r.n)]));
    const share = cohorte.length ? con.size / cohorte.length : 0;
    console.log(
      `  ${m.etiqueta.padEnd(14)} ${`${con.size}/${cohorte.length}`.padStart(8)}   ` +
        `${share >= 0.9 ? "\x1b[32m" : share >= 0.5 ? "\x1b[33m" : "\x1b[31m"}${pct(share).padStart(5)}\x1b[0m` +
        (sin.length > 0 ? `   \x1b[90m${sin.length} sin dato\x1b[0m` : ""),
    );

    /**
     * Las faltantes se nombran SIEMPRE, no solo cuando son pocas.
     *
     * La primera versión las listaba con `sin.length <= 5` y arriba de eso
     * imprimía "7 emisiones". Es el mismo error que venimos persiguiendo en los
     * datos, cometido en el reporte: un resumen que oculta justo lo que hace
     * falta para decidir. Siete nombres no llenan una pantalla, y sin ellos no
     * se puede saber si la falta es aleatoria o estructural.
     */
    if (sin.length > 0 && con.size < cohorte.length) {
      /**
       * Cuántos préstamos tiene REALMENTE, sin el umbral.
       *
       * La primera versión decía "sin dato" y era mentira: el umbral de 10 es
       * lo que decidía, no la ausencia del dato. BANK5 salía sin ocupación en
       * una tabla y 5/5 en la de shelves, porque una exigía diez préstamos y la
       * otra uno. Dos definiciones de "tiene el dato" conviviendo en la misma
       * pantalla, contradiciéndose.
       *
       * Ahora se imprime el conteo crudo contra el pool. "3 de 35" es una
       * afirmación sobre el mundo; "sin dato" era una sobre mi umbral.
       */
      const { rows: crudos } = await query<{ accession: string; n: string }>(
        `SELECT l.accession, count(*)::text AS n
           FROM corpus.facts fa
           JOIN corpus.loans l ON l.id = fa.loan_id
          WHERE fa.metric_key = $1
            AND fa.value ~ '^-?[0-9.]+$'
            AND fa.value::numeric BETWEEN ${m.min} AND ${m.max}
            AND l.accession = ANY($2)
          GROUP BY l.accession`,
        [m.key, sin.map((x) => x.accession)],
      );
      const crudo = new Map(crudos.map((r) => [r.accession, Number(r.n)]));
      for (const x of sin) {
        const n = crudo.get(x.accession) ?? 0;
        console.log(
          `    \x1b[90m· ${x.nombre.slice(0, 42).padEnd(44)} ${String(n).padStart(3)} de ${x.pool}` +
            (n > 0 ? ` \x1b[33m← hay dato, lo corta el umbral de ${MIN_PARA_METRICA}\x1b[0m` : ` \x1b[90mcero\x1b[0m`),
        );
      }
    }
  }

  /**
   * ¿La falta es aleatoria o se agrupa por emisor?
   *
   * Una cobertura del 75% no dice lo mismo según cómo se reparta. Si las 7 sin
   * ocupación están esparcidas, la distribución de la cohorte se arma sobre una
   * submuestra parecida al todo. Si son todas del mismo shelf, la referencia
   * excluye sistemáticamente a un originador y comparar contra ella está
   * sesgado — sin que nada en la salida lo indique.
   *
   * Es la misma pregunta que ya nos costó caro con `property_type`: ahí la
   * cobertura global era 93,7% y tres shelves enteros estaban abajo del umbral.
   */
  const { rows: porShelf } = await query<{ shelf: string; total: string; con_occ: string }>(
    `WITH e AS (
       SELECT f.accession,
              split_part(f.company_name, ' ', 1) AS shelf,
              EXISTS (
                SELECT 1 FROM corpus.facts fa
                  JOIN corpus.loans l ON l.id = fa.loan_id
                 WHERE l.accession = f.accession
                   AND fa.metric_key = 'occupancy'
                   AND fa.value ~ '^-?[0-9.]+$'
              ) AS tiene
         FROM corpus.filings f
        WHERE f.accession = ANY($1)
     )
     SELECT shelf, count(*)::text AS total,
            count(*) FILTER (WHERE tiene)::text AS con_occ
       FROM e GROUP BY shelf HAVING count(*) >= 2 ORDER BY 1`,
    [accs],
  );

  console.log(`\n  Ocupación por shelf — ¿la falta se agrupa?\n`);
  for (const r of porShelf) {
    const tot = Number(r.total);
    const con = Number(r.con_occ);
    console.log(
      `    ${r.shelf.slice(0, 18).padEnd(20)} ${`${con}/${tot}`.padStart(6)}` +
        (con === 0 ? `  \x1b[31m← el shelf entero\x1b[0m` : con < tot ? `  \x1b[33mparcial\x1b[0m` : ""),
    );
  }
  console.log(
    `\n  \x1b[90mEsta tabla pregunta si existe ALGÚN préstamo con el dato, así que casi\x1b[0m`,
  );
  console.log(
    `  \x1b[90msiempre dice que sí: BANK5 sale 5/5 teniendo 6 de 35. La unidad correcta\x1b[0m`,
  );
  console.log(`  \x1b[90mes el préstamo, y es la de abajo.\x1b[0m`);

  /**
   * LA MEDICIÓN QUE HABÍA QUE HACER DESDE EL PRINCIPIO: préstamos, no emisiones.
   *
   * Las dos tablas de arriba cuentan emisiones que pasan un umbral. Pero la
   * mediana de una emisión se calcula sobre PRÉSTAMOS, y una cohorte donde cada
   * deal tiene el dato en 11 de 35 daría 28/28 en la primera tabla y sería una
   * referencia construida sobre un tercio de la población.
   *
   * `CLAUDE.md` dice "la unidad de análisis se elige antes que el método" y acá
   * la elegí después, mirando lo que era fácil de contar.
   *
   * EL CORTE POR TIPO ES EL TEST DECISIVO
   *
   * Quedan dos explicaciones para la ralitud, y predicen cosas distintas:
   *
   *   (a) el dato se informa donde significa algo — la ocupación de un hotel se
   *       mide con RevPAR, la de un self storage rota mensual. Entonces
   *       multifamily/office/retail deberían estar altos y hospitality en cero.
   *
   *   (b) el parser lo pierde — entonces la cobertura es pareja y baja en TODOS
   *       los tipos, porque a la columna no le importa qué hay adentro.
   *
   * Benchmark 2026-B42 con 1 de 62 ya empuja fuerte hacia (b): esa emisión es
   * 42% multifamily, o sea ~26 préstamos donde la ocupación es la métrica
   * central del activo. Pero un caso no decide, y este corte sí.
   */
  const { rows: porTipo } = await query<{
    tipo: string; total: string; con_occ: string;
  }>(
    `SELECT coalesce(l.property_type, '(sin tipo)') AS tipo,
            count(*)::text AS total,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM corpus.facts fa
               WHERE fa.loan_id = l.id AND fa.metric_key = 'occupancy'
                 AND fa.value ~ '^-?[0-9.]+$'
            ))::text AS con_occ
       FROM corpus.loans l
      WHERE l.accession = ANY($1)
      GROUP BY 1 HAVING count(*) >= 10
      ORDER BY count(*) DESC`,
    [accs],
  );

  const totPrest = porTipo.reduce((a, r) => a + Number(r.total), 0);
  const totOcc = porTipo.reduce((a, r) => a + Number(r.con_occ), 0);

  console.log(`\n${"─".repeat(78)}`);
  console.log(`\n  Ocupación a nivel PRÉSTAMO, por tipo de propiedad\n`);
  console.log(`    tipo                  préstamos   con ocupación`);
  console.log(`    ${"─".repeat(52)}`);
  for (const r of porTipo) {
    const tot = Number(r.total);
    const con = Number(r.con_occ);
    const sh = con / tot;
    console.log(
      `    ${r.tipo.slice(0, 20).padEnd(22)} ${String(tot).padStart(9)}   ` +
        `${(sh >= 0.8 ? "\x1b[32m" : sh >= 0.3 ? "\x1b[33m" : "\x1b[31m")}${String(con).padStart(5)} ${pct(sh).padStart(6)}\x1b[0m`,
    );
  }
  console.log(
    `\n    \x1b[1mTotal${String(totPrest).padStart(24)}   ${totOcc} ${pct(totOcc / Math.max(1, totPrest))}\x1b[0m`,
  );

  /**
   * El veredicto se calcula, no se lee a ojo.
   *
   * Si la dispersión entre tipos es chica, la cobertura no depende de qué hay
   * adentro del activo y la explicación "se informa donde significa algo" no se
   * sostiene.
   */
  const shares = porTipo.map((r) => Number(r.con_occ) / Number(r.total));
  const spread = Math.max(...shares) - Math.min(...shares);
  console.log(
    `\n    \x1b[90mDispersión entre tipos: ${pct(spread)} (del ${pct(Math.min(...shares))} al ${pct(Math.max(...shares))}).\x1b[0m`,
  );
  console.log(
    `\n    \x1b[90mEste corte NO decide nada por sí solo: el tipo de propiedad y la emisión\x1b[0m`,
  );
  console.log(
    `    \x1b[90mestán correlacionados. Una emisión rota que sea 42% multifamily hunde la\x1b[0m`,
  );
  console.log(
    `    \x1b[90mfila de multifamily sin que multifamily tenga nada que ver. Ver abajo.\x1b[0m`,
  );

  /**
   * EL TEST DE VERDAD: dentro de cada emisión, no a través de ellas.
   *
   * La versión anterior de este bloque emitía un veredicto ("varía por tipo,
   * luego el dato se informa donde significa algo") a partir de la dispersión
   * entre tipos AGREGADA sobre las 28 emisiones. Estaba confundido.
   *
   * La aritmética de la propia salida lo mostraba: las 7 emisiones sin dato
   * suman 234 préstamos y aportan 15, así que las otras 21 tienen 673 de 675 —
   * el 99,7%. La cobertura no es un gradiente por tipo: es binaria por EMISIÓN.
   * La variación "por tipo" que medí era la composición de las 7 rotas.
   *
   * Es el mismo error que mató la hipótesis de BANK contra BBCMS: agregar a
   * través de la unidad que carga la variación real y leer el resultado como
   * efecto de la variable que uno quería mirar.
   *
   * El test correcto separa las dos poblaciones primero. Dentro de las emisiones
   * que SÍ traen el dato, si la cobertura es pareja entre tipos entonces el
   * formato es lo único que decide y el tipo no juega.
   */
  const { rows: dentro } = await query<{ tipo: string; total: string; con_occ: string }>(
    `WITH sanas AS (
       SELECT l.accession
         FROM corpus.loans l
        WHERE l.accession = ANY($1)
        GROUP BY l.accession
       HAVING count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM corpus.facts fa
                 WHERE fa.loan_id = l.id AND fa.metric_key = 'occupancy'
                   AND fa.value ~ '^-?[0-9.]+$'
              ))::numeric / count(*) > 0.5
     )
     SELECT coalesce(l.property_type, '(sin tipo)') AS tipo,
            count(*)::text AS total,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM corpus.facts fa
               WHERE fa.loan_id = l.id AND fa.metric_key = 'occupancy'
                 AND fa.value ~ '^-?[0-9.]+$'
            ))::text AS con_occ
       FROM corpus.loans l
       JOIN sanas s ON s.accession = l.accession
      GROUP BY 1 HAVING count(*) >= 10
      ORDER BY count(*) DESC`,
    [accs],
  );

  console.log(`\n  Solo dentro de las emisiones que SÍ traen ocupación\n`);
  console.log(`    tipo                  préstamos   con ocupación`);
  console.log(`    ${"─".repeat(52)}`);
  for (const r of dentro) {
    const tot = Number(r.total);
    const con = Number(r.con_occ);
    const sh = con / tot;
    console.log(
      `    ${r.tipo.slice(0, 20).padEnd(22)} ${String(tot).padStart(9)}   ` +
        `${(sh >= 0.8 ? "\x1b[32m" : sh >= 0.3 ? "\x1b[33m" : "\x1b[31m")}${String(con).padStart(5)} ${pct(sh).padStart(6)}\x1b[0m`,
    );
  }

  /**
   * El bucket de nulos NO entra en el veredicto.
   *
   * Tercera versión de esta conclusión, y las tres primeras estuvieron mal por
   * la misma razón: el número de abajo se calculaba sobre un conjunto que
   * incluía algo que no pertenecía. Acá era `(sin tipo)`, que no es un tipo de
   * propiedad sino la ausencia de uno — preguntarle si se comporta como un tipo
   * no tiene sentido, y su 65% inflaba la dispersión a 35 puntos cuando entre
   * los ocho tipos reales es exactamente cero.
   *
   * Los préstamos sin tipo son el agujero de `property_type` que ya está
   * anotado aparte. Se muestran, no se computan.
   */
  const sd = dentro
    .filter((r) => !r.tipo.startsWith("("))
    .map((r) => Number(r.con_occ) / Number(r.total));
  const spreadDentro = sd.length ? Math.max(...sd) - Math.min(...sd) : 0;
  console.log(
    `\n    \x1b[90mDispersión entre los ${sd.length} tipos reales: ${pct(spreadDentro)}` +
      ` (contra ${pct(spread)} agregando entre emisiones).\x1b[0m\n` +
      `    \x1b[90m'(sin tipo)' queda fuera del cálculo: es la ausencia de un tipo, no un tipo.\x1b[0m`,
  );
  console.log(
    spreadDentro < 0.2
      ? `    \x1b[31mEl tipo no juega: donde la emisión trae el dato, lo trae para todos.\x1b[0m\n` +
          `    \x1b[90mNo es formato: los encabezados del Annex A conduit son byte por byte\x1b[0m\n` +
          `    \x1b[90miguales entre emisores. Es el orden de los bloques tras el join, que\x1b[0m\n` +
          `    \x1b[90mdesempata columnas con puntaje igual — arreglado en la taxonomía\x1b[0m\n` +
          `    \x1b[90m2026.08.10 dándole a /leased occ/ el primer patrón. Si vuelve a faltar\x1b[0m\n` +
          `    \x1b[90men alguna emisión, es una recosecha pendiente o un empate nuevo.\x1b[0m`
      : `    \x1b[33mEl tipo sigue jugando aun dentro de emisiones sanas: hay dos causas\x1b[0m\n` +
          `    \x1b[33msuperpuestas y hace falta separarlas antes de usar la métrica.\x1b[0m`,
  );

  /**
   * Los shares de concentración, que decidieron exclusiones sin que nadie
   * mirara el valor. Un 82% y un 98% se excluyen igual con umbral 0,8, pero
   * el primero es una decisión mía y el segundo una propiedad del deal.
   */
  /**
   * ¿Hay emisiones cargadas dos veces?
   *
   * En la lista de faltantes aparecieron dos "Wells Fargo Commercial Mortgage
   * Trust 2026-5" — que puede ser el truncado a 42 caracteres de dos deals
   * distintos, o la misma cosechada dos veces.
   *
   * No es cosmético: la cohorte es el denominador de toda posición ordinal. Una
   * emisión duplicada se cuenta como dos pares, corre la mediana hacia sí misma
   * y desplaza cada "13ª de 25" sin que nada lo indique.
   */
  const { rows: dups } = await query<{ nombre: string; n: string; accs: string; pools: string }>(
    `SELECT f.company_name AS nombre, count(*)::text AS n,
            string_agg(f.accession, ' · ') AS accs,
            string_agg(p.pool::text, ' · ') AS pools
       FROM corpus.filings f
       JOIN (SELECT accession, count(*) AS pool FROM corpus.loans GROUP BY accession) p
         ON p.accession = f.accession
      WHERE f.accession = ANY($1)
      GROUP BY f.company_name HAVING count(*) > 1`,
    [accs],
  );
  /**
   * Las categorías de property_type que hay guardadas.
   *
   * Hasta la taxonomía 2026.08.11, "General Property Type" y "Detailed Property
   * Type" empataban y ganaba la que quedara primero tras el join. Si en alguna
   * emisión ganó la detallada, acá tienen que aparecer categorías finas
   * ("Anchored Retail", "Limited Service") mezcladas con las gruesas.
   *
   * Es el control de que el arreglo sirvió para algo: una lista corta de
   * categorías gruesas significa que ahora todas las emisiones usan la misma
   * taxonomía. Una lista larga con variantes significa que sigue mezclado.
   */
  const { rows: cats } = await query<{ tipo: string; n: string; emisiones: string }>(
    `SELECT coalesce(property_type, '(sin tipo)') AS tipo,
            count(*)::text AS n,
            count(DISTINCT accession)::text AS emisiones
       FROM corpus.loans WHERE accession = ANY($1)
      GROUP BY 1 ORDER BY count(*) DESC`,
    [accs],
  );
  console.log(`\n  Categorías de property_type en la cohorte — ${cats.length} distintas\n`);
  for (const c of cats) {
    console.log(
      `    ${c.tipo.slice(0, 34).padEnd(36)} ${String(c.n).padStart(4)} préstamos` +
        ` \x1b[90men ${c.emisiones} emisiones\x1b[0m` +
        /**
         * Dos marcas, por dos modos de falla distintos.
         *
         * La primera versión solo tenía la de "confinada a una emisión", escrita
         * suponiendo que el riesgo era que distintos emisores usaran taxonomías
         * distintas. El problema real resultó ser otro: una categoría llamada
         * "2", en tres emisiones, que pasó sin marca porque no está confinada.
         *
         * Un tipo de propiedad puramente numérico no es una categoría: es una
         * celda de datos que se coló en la columna. Eso se puede afirmar sin
         * saber de qué documento vino.
         */
        (/^[\d.,\s]+$/.test(c.tipo)
          ? `  \x1b[31m← no es una categoría: valor numérico\x1b[0m`
          : Number(c.emisiones) === 1 && Number(c.n) >= 3
            ? `  \x1b[33m← solo en una: ¿taxonomía distinta?\x1b[0m`
            : ""),
    );
  }

  /**
   * Los préstamos con tipo numérico, con sus campos vecinos.
   *
   * HIPÓTESIS QUE ESTO PONE A PRUEBA
   *
   * `harvest:ties` encontró encabezados con filas de datos pegadas adentro
   * ("# of Properties 3 1", "Loan ID Number 37 37.01 37.02 38"). Si el
   * encabezado quedó mal delimitado, las columnas de esa emisión están
   * corridas, y un property_type de "2" sería el valor de la columna vecina
   * —justamente `# of Properties`— leído en el lugar equivocado.
   *
   * Si es corrimiento, los campos de al lado también van a estar fuera de
   * lugar: un nombre de propiedad donde va el tipo, un tipo donde va el conteo.
   * Si en cambio el resto se ve sano, "2" es una celda sucia aislada y no hay
   * corrimiento — dos causas con arreglos completamente distintos.
   */
  const { rows: sospechosos } = await query<{
    nombre: string; loan_id: string; tipo: string;
    prop_name: string | null; prop_count: string | null; unidad: string | null;
  }>(
    `SELECT f.company_name AS nombre,
            coalesce(l.loan_ref, 'fila ' || l.row_index) AS loan_id,
            l.property_type AS tipo,
            l.property_name AS prop_name,
            max(fa.value) FILTER (WHERE fa.metric_key = 'property_count') AS prop_count,
            max(fa.value) FILTER (WHERE fa.metric_key = 'unit_of_measure') AS unidad
       FROM corpus.loans l
       JOIN corpus.filings f ON f.accession = l.accession
       LEFT JOIN corpus.facts fa ON fa.loan_id = l.id
      WHERE l.accession = ANY($1) AND l.property_type ~ '^[0-9.,[:space:]]+$'
      GROUP BY f.company_name, l.loan_ref, l.row_index, l.property_type, l.property_name
      ORDER BY 1, 2`,
    [accs],
  );

  if (sospechosos.length > 0) {
    console.log(`\n  Préstamos con tipo numérico — ¿están corridas las columnas?\n`);
    for (const x of sospechosos) {
      console.log(`    \x1b[1m${x.nombre.slice(0, 40)}\x1b[0m  préstamo ${x.loan_id}`);
      console.log(
        `      tipo=\x1b[31m${JSON.stringify(x.tipo)}\x1b[0m` +
          `  # props=${JSON.stringify(x.prop_count)}` +
          `  unidad=${JSON.stringify(x.unidad)}`,
      );
      console.log(`      nombre=${JSON.stringify((x.prop_name ?? "").slice(0, 44))}`);
    }
    /**
     * La versión anterior de estas líneas ofrecía dos causas —celda sucia o
     * corrimiento de columnas— como si fueran exhaustivas. La evidencia que
     * imprime justo arriba las descarta a las dos: nombre vacío, conteo nulo y
     * unidad nula no es una celda sucia ni un corrimiento, es una fila que no
     * es un préstamo.
     *
     * La dejé impresa varias corridas después de saber que era falsa. Ahora
     * dice lo que la evidencia sostiene y nombra la tarea donde se arregla.
     */
    console.log(
      `\n    \x1b[90mSin nombre, sin conteo y sin unidad: no son préstamos con el tipo mal,\x1b[0m`,
    );
    console.log(
      `    \x1b[90mson filas que no son préstamos. row_index 0 es la primera fila después\x1b[0m`,
    );
    console.log(
      `    \x1b[90mdel encabezado, que en el Annex A conduit suele numerar las columnas —\x1b[0m`,
    );
    console.log(
      `    \x1b[90my ahí un "2" en la posición del tipo es el número de columna. Tarea #49.\x1b[0m`,
    );
  }

  /**
   * PRÉSTAMOS FANTASMA: filas cargadas como préstamo que no son préstamos.
   *
   * Los 5 con property_type numérico resultaron no tener nombre, ni conteo de
   * propiedades, ni unidad de medida, y 3 de los 5 están en row_index 0 — la
   * primera fila después del encabezado, que en el Annex A suele numerar las
   * columnas. Un "2" en la posición del tipo de propiedad es justo lo que deja
   * esa fila.
   *
   * No era corrimiento de columnas ni celda sucia, que eran las dos causas que
   * yo había planteado como si fueran exhaustivas. Era una tercera.
   *
   * POR QUÉ IMPORTA MÁS QUE LOS 5 CASOS
   *
   * El pool es el denominador de todo lo que hace esta herramienta: la posición
   * ordinal, los porcentajes de composición, y la nota que dice cuánto vale
   * cada préstamo. Una fila fantasma no rompe nada visiblemente — corre los
   * porcentajes un punto y nadie se enteraría.
   *
   * Se cuentan por cantidad de facts porque es la definición operativa: un
   * préstamo real del Annex A conduit tiene decenas de observaciones. Una fila
   * con dos o tres no es un préstamo con pocos datos, es otra cosa.
   */
  const { rows: fantasmas } = await query<{
    nombre: string; pool: string; flacos: string; vacios: string; min_facts: string;
  }>(
    `WITH conteo AS (
       SELECT l.accession, l.id, count(fa.id) AS facts
         FROM corpus.loans l
         LEFT JOIN corpus.facts fa ON fa.loan_id = l.id
        WHERE l.accession = ANY($1)
        GROUP BY l.accession, l.id
     )
     SELECT f.company_name AS nombre,
            count(*)::text AS pool,
            count(*) FILTER (WHERE c.facts <= 5)::text AS flacos,
            count(*) FILTER (WHERE c.facts = 0)::text AS vacios,
            min(c.facts)::text AS min_facts
       FROM conteo c JOIN corpus.filings f ON f.accession = c.accession
      GROUP BY f.company_name
     HAVING count(*) FILTER (WHERE c.facts <= 5) > 0
      ORDER BY count(*) FILTER (WHERE c.facts <= 5) DESC`,
    [accs],
  );

  const totalFlacos = fantasmas.reduce((a, r) => a + Number(r.flacos), 0);
  console.log(
    `\n  Filas con 5 facts o menos — ¿son préstamos?  \x1b[1m${totalFlacos} en ${fantasmas.length} emisiones\x1b[0m\n`,
  );
  for (const r of fantasmas) {
    console.log(
      `    ${r.nombre.slice(0, 40).padEnd(42)} ${String(r.flacos).padStart(3)} de ${String(r.pool).padStart(3)}` +
        `  \x1b[90mmínimo ${r.min_facts} facts\x1b[0m` +
        (Number(r.vacios) > 0 ? `  \x1b[31m${r.vacios} sin ningún fact\x1b[0m` : ""),
    );
  }
  if (totalFlacos > 0) {
    console.log(
      `\n    \x1b[90mUn préstamo real del Annex A conduit tiene decenas de observaciones.\x1b[0m`,
    );
    console.log(
      `    \x1b[90mSi estas filas no son préstamos, el pool está inflado y con él el\x1b[0m`,
    );
    console.log(
      `    \x1b[90mdenominador de cada posición ordinal y de cada porcentaje de\x1b[0m`,
    );
    console.log(`    \x1b[90mcomposición que imprime esta herramienta.\x1b[0m`);
  }

  /**
   * ¿HAY UN HUECO ENTRE LAS DOS POBLACIONES?
   *
   * El pipeline ya descarta filas con menos de 3 observations
   * (`minObservationsPerRow ?? 3` en rowsToObservations). Las 7 filas fantasma
   * tienen exactamente 3: pasan por un fact de margen.
   *
   * Ese 3 no salió de medir nada. Si los préstamos reales del Annex A conduit
   * tienen decenas de observations y las filas fantasma tienen unas pocas, entre
   * las dos poblaciones hay una zona vacía, y el umbral tiene que estar ahí —
   * elegido por dónde está el hueco, no por parecer razonable.
   *
   * Si en cambio la distribución es continua desde 3 hasta 80, no hay dos
   * poblaciones: hay un gradiente de completitud, cualquier umbral corta
   * préstamos reales, y el descarte por conteo es el criterio equivocado.
   *
   * Este histograma decide entre esas dos cosas, y es lo que había que mirar
   * antes de fijar cualquier número.
   */
  /**
   * SOBRE TODO EL CORPUS, NO SOBRE LA COHORTE.
   *
   * La primera versión lo calculaba sobre las 28 emisiones de 2026, pero el
   * umbral que este histograma justifica se aplica en la cosecha de las 233.
   * Elegir un corte corpus-wide mirando el 12% es el mismo error de unidad que
   * ya apareció dos veces hoy: medir donde es cómodo y aplicar donde importa.
   */
  const { rows: histo } = await query<{ tramo: string; n: string }>(
    `WITH conteo AS (
       SELECT l.id, count(fa.id) AS facts
         FROM corpus.loans l
         LEFT JOIN corpus.facts fa ON fa.loan_id = l.id
        GROUP BY l.id
     )
     SELECT CASE
              WHEN facts <= 10 THEN lpad(facts::text, 2, ' ')
              WHEN facts < 20 THEN '11-19'
              WHEN facts < 40 THEN '20-39'
              WHEN facts < 60 THEN '40-59'
              ELSE '60+'
            END AS tramo,
            count(*)::text AS n
       FROM conteo GROUP BY 1 ORDER BY 1`,
  );

  const totalCorpus = histo.reduce((a, h) => a + Number(h.n), 0);
  console.log(
    `\n  Observations por fila en TODO el corpus (${totalCorpus} préstamos) — ¿dos poblaciones?\n`,
  );
  const maxN = Math.max(...histo.map((h) => Number(h.n)));
  for (const h of histo) {
    const n = Number(h.n);
    const barra = "█".repeat(Math.max(1, Math.round((n / maxN) * 44)));
    const chico = /^\s*\d+$/.test(h.tramo) && Number(h.tramo) <= 10;
    console.log(
      `    ${h.tramo.padStart(5)}  ${chico ? "\x1b[31m" : "\x1b[90m"}${barra}\x1b[0m ${n}`,
    );
  }

  /**
   * EL HUECO TIENE QUE SER CONTIGUO Y ESTAR ENTRE LAS DOS POBLACIONES.
   *
   * La versión anterior juntaba todos los tramos vacíos y reportaba mínimo y
   * máximo como si fueran un rango. Sobre el corpus completo los vacíos son
   * {1, 2, 8} y eso imprimió "hay hueco entre 1 y 8, corré el umbral a 8" —
   * falso: entre 3 y 7 hay 51 filas que ese corte habría eliminado.
   *
   * Dos defectos distintos en la misma línea. Los tramos por debajo del mínimo
   * poblado no son un hueco, son el piso de la distribución. Y un solo tramo
   * vacío entre vecinos poblados no separa poblaciones: es ruido de conteo.
   *
   * Es el quinto veredicto de esta sesión calculado sobre un conjunto que no es
   * el que la frase describe. La tabla estuvo bien las cinco veces.
   */
  const presentes = new Set(
    histo.map((h) => h.tramo.trim()).filter((t) => /^\d+$/.test(t)).map(Number),
  );
  const piso = Math.min(...presentes);
  const techo = Math.max(...presentes);

  /** La corrida contigua de tramos vacíos más larga, solo entre piso y techo. */
  let mejor: number[] = [];
  let actual: number[] = [];
  for (let k = piso; k <= techo; k++) {
    if (presentes.has(k)) {
      if (actual.length > mejor.length) mejor = actual;
      actual = [];
    } else actual.push(k);
  }
  if (actual.length > mejor.length) mejor = actual;

  const vacios = [...Array(10).keys()].map((k) => k + 1).filter((k) => !presentes.has(k));
  console.log(
    `\n    \x1b[90mSin filas en: ${vacios.length ? vacios.join(", ") : "ningún conteo de 1 a 10"}.` +
      ` Población más flaca: ${piso} observations.\x1b[0m`,
  );
  /**
   * ESTE HISTOGRAMA YA NO DECIDE UN UMBRAL, Y NO DEBERÍA PARECER QUE LO HACE.
   *
   * Se escribió para elegir un corte por cantidad de observations. La medición
   * sobre las 233 emisiones cerró esa puerta: la distribución es continua desde
   * 3, cualquier corte elimina préstamos reales, y el filtro terminó siendo
   * estructural —una fila sin letras en ninguna celda no es un préstamo—.
   *
   * Después de aplicarlo aparece un hueco contiguo en la cola baja, y la versión
   * anterior de esta línea decía "el umbral puede ir adentro". Es circular: el
   * hueco existe PORQUE el filtro sacó esas filas. Recomendaba como hallazgo lo
   * que era consecuencia del arreglo, y en la dirección que ya habíamos
   * descartado.
   *
   * Ahora solo describe la forma. La cola baja que queda es cobertura parcial
   * —tarea #40— y no filas fantasma.
   */
  const colaBaja = histo
    .filter((h) => /^\s*\d+$/.test(h.tramo) && Number(h.tramo) <= 10)
    .reduce((a, h) => a + Number(h.n), 0);
  console.log(
    `    \x1b[90m${colaBaja} filas con 10 observations o menos sobre ${totalCorpus}.\x1b[0m`,
  );
  console.log(
    `    \x1b[90mNo se descarta por conteo: la distribución es continua desde ${piso} y\x1b[0m`,
  );
  console.log(
    `    \x1b[90mcualquier corte eliminaría préstamos reales. El filtro es estructural\x1b[0m`,
  );
  console.log(
    `    \x1b[90m—una fila sin letras en ninguna celda no es un préstamo— así que lo que\x1b[0m`,
  );
  console.log(
    `    \x1b[90mqueda acá es cobertura parcial, no filas fantasma. Tarea #40.\x1b[0m`,
  );

  console.log(`\n  ¿Emisiones duplicadas? — la cohorte es el denominador de todo\n`);
  if (dups.length === 0) {
    console.log(`    \x1b[32mNinguna: ${cohorte.length} nombres distintos en ${cohorte.length} emisiones.\x1b[0m`);
  } else {
    for (const d of dups) {
      console.log(`    \x1b[33m${d.nombre.slice(0, 46)}\x1b[0m  ×${d.n}  pools ${d.pools}`);
      console.log(`      \x1b[90m${d.accs}\x1b[0m`);
    }
    console.log(
      `\n    \x1b[90mPools distintos = deals distintos con nombre igual. Pools iguales =\x1b[0m`,
    );
    console.log(`    \x1b[90mrevisar si es la misma emisión cosechada dos veces.\x1b[0m`);
  }

  console.log(`\n  Concentración por tipo — el umbral de exclusión es ${pct(CONCENTRACION_TIPO)}:\n`);
  for (const c of [...cohorte].sort(
    (a, b) => b.shareDominante - a.shareDominante,
  ).slice(0, 8)) {
    const sh = c.shareDominante;
    console.log(
      `    ${c.nombre.slice(0, 40).padEnd(42)} ${pct(sh).padStart(5)} ${(c.tipoDominante ?? "").slice(0, 16)}` +
        (sh > CONCENTRACION_TIPO
          ? sh < CONCENTRACION_TIPO + 0.08
            ? `  \x1b[33m← al filo del umbral\x1b[0m`
            : `  \x1b[90mexcluida\x1b[0m`
          : ""),
    );
  }
  console.log();
  await closePool();
  process.exit(0);
}

/**
 * La vista de terminal. Los números salen del módulo; acá solo se eligen
 * colores, anchos y qué se dice al lado de cada cifra.
 */
const b = await calcularBenchmark(BUSQUEDA, candidatas);

if (!b) {
  console.error(`\n✗ No se encontró una emisión que coincida con "${BUSQUEDA}".`);
  console.error(`  Listado:  npm run db:benchmark -- --listar\n`);
  await closePool();
  process.exit(1);
}

const o = b.objetivo;

console.log(`\n${"═".repeat(78)}`);
console.log(`${o.nombre}`);
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  ${o.filed.slice(0, 10)} · ${o.pool} préstamos · cohorte ${o.anada}\x1b[0m`,
);
console.log(
  `  \x1b[90m${b.pares.length} pares comparables` +
    (b.excluidas.length > 0
      ? ` · ${b.excluidas.length} excluida(s) por ser mono-tipo: ` +
        b.excluidas.map((e) => e.nombre.slice(0, 24)).join(", ")
      : "") +
    `\x1b[0m`,
);

/** El rechazo, que es parte de la respuesta y no una pantalla vacía. */
if (!b.evaluable) {
  console.log(
    `\n  \x1b[31mNo se puede evaluar: hacen falta ${MIN_PARES} pares y hay ${b.pares.length}.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mCon menos, "se aparta del mercado" sería una afirmación sobre ${b.pares.length}\x1b[0m`,
  );
  console.log(`  \x1b[90mdocumentos. La respuesta correcta es que no se sabe.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

if (b.objetivoMonoTipo) {
  console.log(
    `\n  \x1b[33mEsta emisión es ${pct(o.shareDominante)} ${o.tipoDominante}:\x1b[0m`,
  );
  console.log(
    `  \x1b[90mno es un conduit diversificado y la comparación contra la cohorte va a\x1b[0m`,
  );
  console.log(`  \x1b[90mmostrar diferencias garantizadas que no significan nada.\x1b[0m`);
}

console.log(`\n${"─".repeat(78)}`);
console.log(`Posición dentro de la cohorte ${o.anada}`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  métrica        esta emisión   cohorte (p25–mediana–p75)      posición`);
console.log(`  ${"─".repeat(72)}`);

for (const m of b.metricas) {
  if (m.valor === null) {
    console.log(
      `  ${m.spec.etiqueta.padEnd(14)} ` +
        `\x1b[90m${m.sinDato === "emision" ? "sin dato en esta emisión" : `solo ${m.paresConDato} pares con dato`}\x1b[0m`,
    );
    continue;
  }
  const f = m.spec.fmt;
  console.log(
    `  ${m.spec.etiqueta.padEnd(14)} ${f(m.valor).padStart(12)}   ` +
      `${f(m.p25!).padStart(8)} ${f(m.p50!).padStart(8)} ${f(m.p75!).padStart(8)}      ` +
      `${m.extremo ? (m.agresivo ? "\x1b[33m" : "\x1b[36m") : "\x1b[90m"}${m.rank}ª de ${m.total}\x1b[0m` +
      (m.agresivo ? "  \x1b[33m← más agresivo\x1b[0m" : ""),
  );
}

console.log(`\n${"─".repeat(78)}`);
console.log("Composición contra la cohorte");
console.log(`${"─".repeat(78)}\n`);
console.log(`  tipo               esta emisión   cohorte    diferencia`);
console.log(`  ${"─".repeat(58)}`);

for (const c of b.composicion) {
  const notable = Math.abs(c.diferencia) > 0.1;
  console.log(
    `  ${c.tipo.padEnd(18)} ${pct(c.propio).padStart(12)}   ${pct(c.cohorte).padStart(7)}    ` +
      `${notable ? "\x1b[33m" : "\x1b[90m"}${(c.diferencia > 0 ? "+" : "") + pct(c.diferencia)}\x1b[0m` +
      `  \x1b[90m${c.prestamos} préstamo(s)\x1b[0m`,
  );
}

/**
 * La resolución, que el porcentaje esconde. Con 25 préstamos cada uno vale 4
 * puntos, así que un "+9%" son dos préstamos.
 */
console.log(
  `\n  \x1b[90mCada préstamo vale ${pct(b.puntoPorPrestamo, 1)} de este pool (${o.pool} préstamos):\x1b[0m`,
);
console.log(
  `  \x1b[90muna diferencia de 9 puntos son ${Math.max(1, Math.round(0.09 / b.puntoPorPrestamo))} préstamos, no una tendencia.\x1b[0m`,
);
console.log(
  `\n  \x1b[90mLa posición es ordinal, no percentil: con ${b.pares.length} pares un percentil\x1b[0m`,
);
console.log(
  `  \x1b[90mtiene resolución de ~${b.resolucionPercentil.toFixed(0)} puntos y presentarlo con decimales\x1b[0m`,
);
console.log(`  \x1b[90msugeriría una precisión que no existe.\x1b[0m`);
console.log(`\n  \x1b[90mLa misma comparación como página:  npm run db:page -- "${BUSQUEDA ?? o.nombre.slice(0, 14)}"\x1b[0m\n`);

await closePool();

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

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

/** Fijados antes de ver nada. */
const MIN_PARES = 15;
const CONCENTRACION_TIPO = 0.8;
/**
 * Mínimo de préstamos con la métrica para que la mediana del pool signifique
 * algo. Con menos, la "mediana de la emisión" es la mediana de un puñado.
 */
const MIN_PARA_METRICA = 10;

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

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

const METRICAS: Array<{
  key: string; etiqueta: string; min: number; max: number;
  fmt: (v: number) => string;
  /** Hacia dónde es "más agresivo": informa cómo leer la posición. */
  agresivo: "alto" | "bajo";
}> = [
  { key: "ltv", etiqueta: "LTV", min: 0.01, max: 2, fmt: (v) => pct(v, 1), agresivo: "alto" },
  { key: "dscr", etiqueta: "DSCR", min: 0.1, max: 20, fmt: (v) => v.toFixed(2), agresivo: "bajo" },
  { key: "debt_yield", etiqueta: "Debt yield", min: 0.01, max: 1, fmt: (v) => pct(v, 1), agresivo: "bajo" },
  { key: "interest_rate", etiqueta: "Tasa", min: 0.001, max: 0.2, fmt: (v) => pct(v, 2), agresivo: "alto" },
  { key: "loan_amount", etiqueta: "Saldo", min: 1e5, max: 1e10, fmt: (v) => `${(v / 1e6).toFixed(1)}M`, agresivo: "alto" },
  { key: "occupancy", etiqueta: "Ocupación", min: 0.1, max: 1.01, fmt: (v) => pct(v, 1), agresivo: "bajo" },
];

/**
 * Las emisiones de la cohorte, con lo que hace falta para decidir si cada una
 * entra al grupo de referencia.
 */
const { rows: candidatas } = await query<{
  accession: string; nombre: string; anada: string; filed: string;
  pool: string; tipo_dominante: string | null; share_dominante: string | null;
}>(
  /**
   * El pool se cuenta APARTE de los tipos.
   *
   * La primera versión unía `corpus.loans` con el CTE de tipos, que tiene una
   * fila por (emisión, tipo). Cada préstamo se contaba una vez por tipo
   * presente: BANK5 2026-5YR24 salió con 315 préstamos en vez de 35, nueve
   * veces inflado.
   *
   * Un fan-out de join no rompe nada visiblemente —el número sigue siendo un
   * número— y acá se detectó solo porque `db:cohort` había dicho 35 diez
   * minutos antes. Contar en un CTE separado y unir por clave única lo hace
   * imposible por construcción en vez de por atención.
   */
  `WITH pools AS (
     SELECT accession, count(*) AS pool FROM corpus.loans GROUP BY accession
   ),
   tipos AS (
     SELECT l.accession, l.property_type AS tipo, count(*) AS n,
            row_number() OVER (PARTITION BY l.accession ORDER BY count(*) DESC) AS rn,
            sum(count(*)) OVER (PARTITION BY l.accession) AS total
       FROM corpus.loans l
      WHERE l.property_type IS NOT NULL
      GROUP BY l.accession, l.property_type
   ),
   dominante AS (
     SELECT accession, tipo, (n::numeric / nullif(total, 0)) AS share
       FROM tipos WHERE rn = 1
   )
   SELECT f.accession, f.company_name AS nombre,
          extract(year FROM f.filed_at)::int::text AS anada,
          f.filed_at::text AS filed,
          p.pool::text,
          d.tipo AS tipo_dominante,
          d.share::text AS share_dominante
     FROM corpus.filings f
     JOIN pools p ON p.accession = f.accession
     LEFT JOIN dominante d ON d.accession = f.accession
    WHERE f.filed_at IS NOT NULL
    ORDER BY f.filed_at DESC`,
);

if (LISTAR) {
  console.log(`\n${"═".repeat(78)}`);
  console.log("Emisiones disponibles (más recientes primero)");
  console.log(`${"═".repeat(78)}\n`);
  for (const c of candidatas.slice(0, 30)) {
    const share = Number(c.share_dominante ?? 0);
    console.log(
      `  ${c.filed.slice(0, 10)}  ${c.nombre.slice(0, 42).padEnd(44)} ${String(c.pool).padStart(4)}` +
        (share > CONCENTRACION_TIPO
          ? `  \x1b[33mmono-tipo (${pct(share)} ${c.tipo_dominante})\x1b[0m`
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
          `    \x1b[90mdesempata columnas con puntaje igual. Las que faltan son emisiones sin\x1b[0m\n` +
          `    \x1b[90mrecosechar con la taxonomía nueva.\x1b[0m`
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
    console.log(
      `\n    \x1b[90mSi el nombre y el conteo se ven sanos, "2" es una celda sucia aislada.\x1b[0m`,
    );
    console.log(
      `    \x1b[90mSi también están fuera de lugar, es corrimiento de columnas y el\x1b[0m`,
    );
    console.log(`    \x1b[90marreglo está en la detección de encabezado, no en el tipo.\x1b[0m`);
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

  /** El hueco: tramos de conteo bajo sin ninguna fila. */
  const presentes = new Set(histo.map((h) => h.tramo.trim()));
  const vacios: number[] = [];
  for (let k = 1; k <= 10; k++) if (!presentes.has(String(k))) vacios.push(k);
  console.log(
    `\n    \x1b[90mSin filas en: ${vacios.length ? vacios.join(", ") : "ningún conteo de 1 a 10"} observations.\x1b[0m`,
  );
  console.log(
    vacios.length >= 3
      ? `    \x1b[32mHay hueco entre ${Math.min(...vacios)} y ${Math.max(...vacios)}.\x1b[0m` +
          ` El umbral actual es 3 y está pegado al borde de\n` +
          `    la población fantasma. Corriéndolo a ${Math.max(...vacios)} se descartan sin tocar\n` +
          `    ninguna fila del otro lado.`
      : `    \x1b[33mSin hueco claro: cualquier umbral por conteo corta en zona poblada.\x1b[0m\n` +
          `    \x1b[33mHabría que descartar por otra señal —fila sin nombre ni saldo— y no\x1b[0m\n` +
          `    \x1b[33mpor cantidad de observations.\x1b[0m`,
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
    (a, b) => Number(b.share_dominante ?? 0) - Number(a.share_dominante ?? 0),
  ).slice(0, 8)) {
    const sh = Number(c.share_dominante ?? 0);
    console.log(
      `    ${c.nombre.slice(0, 40).padEnd(42)} ${pct(sh).padStart(5)} ${(c.tipo_dominante ?? "").slice(0, 16)}` +
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

const objetivo = BUSQUEDA
  ? candidatas.find((c) => c.nombre.toLowerCase().includes(BUSQUEDA.toLowerCase()))
  : candidatas[0];

if (!objetivo) {
  console.error(`\n✗ No se encontró una emisión que coincida con "${BUSQUEDA}".`);
  console.error(`  Listado:  npm run db:benchmark -- --listar\n`);
  await closePool();
  process.exit(1);
}

console.log(`\n${"═".repeat(78)}`);
console.log(`${objetivo.nombre}`);
console.log(`${"═".repeat(78)}`);
console.log(
  `\n\x1b[90m  ${objetivo.filed.slice(0, 10)} · ${objetivo.pool} préstamos · cohorte ${objetivo.anada}\x1b[0m`,
);

/**
 * El grupo de referencia: las OTRAS emisiones del mismo año, sin las mono-tipo.
 *
 * Excluir la propia es obvio pero fácil de olvidar, y con 28 emisiones incluirse
 * a uno mismo corre el percentil casi cuatro puntos.
 */
const pares = candidatas.filter(
  (c) =>
    c.anada === objetivo.anada &&
    c.accession !== objetivo.accession &&
    Number(c.share_dominante ?? 0) <= CONCENTRACION_TIPO,
);

const excluidas = candidatas.filter(
  (c) =>
    c.anada === objetivo.anada &&
    c.accession !== objetivo.accession &&
    Number(c.share_dominante ?? 0) > CONCENTRACION_TIPO,
);

console.log(
  `  \x1b[90m${pares.length} pares comparables` +
    (excluidas.length > 0
      ? ` · ${excluidas.length} excluida(s) por ser mono-tipo: ` +
        excluidas.map((e) => e.nombre.slice(0, 24)).join(", ")
      : "") +
    `\x1b[0m`,
);

/**
 * El rechazo, que es parte de la respuesta y no una pantalla vacía.
 */
if (pares.length < MIN_PARES) {
  console.log(
    `\n  \x1b[31mNo se puede evaluar: hacen falta ${MIN_PARES} pares y hay ${pares.length}.\x1b[0m`,
  );
  console.log(
    `  \x1b[90mCon menos, "se aparta del mercado" sería una afirmación sobre ${pares.length}\x1b[0m`,
  );
  console.log(`  \x1b[90mdocumentos. La respuesta correcta es que no se sabe.\x1b[0m\n`);
  await closePool();
  process.exit(0);
}

if (Number(objetivo.share_dominante ?? 0) > CONCENTRACION_TIPO) {
  console.log(
    `\n  \x1b[33mEsta emisión es ${pct(Number(objetivo.share_dominante))} ${objetivo.tipo_dominante}:\x1b[0m`,
  );
  console.log(
    `  \x1b[90mno es un conduit diversificado y la comparación contra la cohorte va a\x1b[0m`,
  );
  console.log(`  \x1b[90mmostrar diferencias garantizadas que no significan nada.\x1b[0m`);
}

// ---------------------------------------------------------------------------
// Dónde cae cada métrica
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(78)}`);
console.log(`Posición dentro de la cohorte ${objetivo.anada}`);
console.log(`${"─".repeat(78)}\n`);
console.log(`  métrica        esta emisión   cohorte (p25–mediana–p75)      posición`);
console.log(`  ${"─".repeat(72)}`);

const accessionsPares = [objetivo.accession, ...pares.map((p) => p.accession)];

for (const m of METRICAS) {
  const { rows } = await query<{ accession: string; mediana: string }>(
    `SELECT l.accession,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY fa.value::numeric)::text AS mediana
       FROM corpus.facts fa
       JOIN corpus.loans l ON l.id = fa.loan_id
      WHERE fa.metric_key = $1
        AND fa.value ~ '^-?[0-9.]+$'
        AND fa.value::numeric BETWEEN ${m.min} AND ${m.max}
        AND l.accession = ANY($2)
      GROUP BY l.accession
     HAVING count(*) >= ${MIN_PARA_METRICA}`,
    [m.key, accessionsPares],
  );

  const propio = rows.find((r) => r.accession === objetivo.accession);
  const otros = rows
    .filter((r) => r.accession !== objetivo.accession)
    .map((r) => Number(r.mediana))
    .sort((a, b) => a - b);

  if (!propio || otros.length < MIN_PARES) {
    console.log(
      `  ${m.etiqueta.padEnd(14)} ` +
        `\x1b[90m${!propio ? "sin dato en esta emisión" : `solo ${otros.length} pares con dato`}\x1b[0m`,
    );
    continue;
  }

  const v = Number(propio.mediana);
  const q = (p: number) => otros[Math.min(otros.length - 1, Math.floor(p * otros.length))]!;
  const rank = otros.filter((x) => x < v).length + 1;
  const total = otros.length + 1;

  /**
   * "3ª de 28" y no "percentil 11": con 27 pares el percentil tiene una
   * resolución de ~4 puntos, y presentarlo con dos decimales sugiere una
   * precisión que no existe.
   */
  const extremo = rank <= 3 || rank >= total - 2;
  const direccion =
    (m.agresivo === "alto" && rank >= total - 2) || (m.agresivo === "bajo" && rank <= 3);

  console.log(
    `  ${m.etiqueta.padEnd(14)} ${m.fmt(v).padStart(12)}   ` +
      `${m.fmt(q(0.25)).padStart(8)} ${m.fmt(q(0.5)).padStart(8)} ${m.fmt(q(0.75)).padStart(8)}      ` +
      `${extremo ? (direccion ? "\x1b[33m" : "\x1b[36m") : "\x1b[90m"}${rank}ª de ${total}\x1b[0m` +
      (direccion ? "  \x1b[33m← más agresivo\x1b[0m" : ""),
  );
}

// ---------------------------------------------------------------------------
// Composición
// ---------------------------------------------------------------------------

const { rows: mezcla } = await query<{
  tipo: string; propio: string; cohorte: string;
}>(
  `WITH canon AS (
     SELECT l.accession,
            CASE
              WHEN l.property_type ~* 'multifamily|cooperative|garden|low rise|mid rise|student' THEN 'Multifamily'
              WHEN l.property_type ~* 'retail|anchored|single tenant' THEN 'Retail'
              WHEN l.property_type ~* 'office|cbd|suburban|medical' THEN 'Office'
              WHEN l.property_type ~* 'industrial|warehouse|flex' THEN 'Industrial'
              WHEN l.property_type ~* 'storage' THEN 'Self Storage'
              WHEN l.property_type ~* 'hospitality|hotel|service|extended stay' THEN 'Hospitality'
              WHEN l.property_type ~* 'mixed' THEN 'Mixed Use'
              WHEN l.property_type ~* 'manufactured' THEN 'Manufactured'
              ELSE 'Otro'
            END AS tipo
       FROM corpus.loans l
      WHERE l.property_type IS NOT NULL AND l.accession = ANY($1)
   ),
   totales AS (
     SELECT count(*) FILTER (WHERE accession = $2) AS n_propio,
            count(*) FILTER (WHERE accession <> $2) AS n_cohorte
       FROM canon
   )
   SELECT c.tipo,
          (count(*) FILTER (WHERE c.accession = $2)::numeric
            / nullif(t.n_propio, 0))::text AS propio,
          (count(*) FILTER (WHERE c.accession <> $2)::numeric
            / nullif(t.n_cohorte, 0))::text AS cohorte
     FROM canon c CROSS JOIN totales t
    GROUP BY c.tipo, t.n_propio, t.n_cohorte
    ORDER BY count(*) FILTER (WHERE c.accession = $2) DESC`,
  [accessionsPares, objetivo.accession],
);

console.log(`\n${"─".repeat(78)}`);
console.log("Composición contra la cohorte");
console.log(`${"─".repeat(78)}\n`);
console.log(`  tipo               esta emisión   cohorte    diferencia`);
console.log(`  ${"─".repeat(58)}`);

for (const r of mezcla) {
  const p = Number(r.propio ?? 0);
  const c = Number(r.cohorte ?? 0);
  if (p === 0 && c < 0.02) continue;
  const dif = p - c;
  const notable = Math.abs(dif) > 0.1;
  console.log(
    `  ${r.tipo.padEnd(18)} ${pct(p).padStart(12)}   ${pct(c).padStart(7)}    ` +
      `${notable ? "\x1b[33m" : "\x1b[90m"}${(dif > 0 ? "+" : "") + pct(dif)}\x1b[0m`,
  );
}

/**
 * La resolución de la composición, que el porcentaje esconde.
 *
 * Con un pool de 35 préstamos cada uno vale 2,9 puntos. Una diferencia de "+9%"
 * contra la cohorte son TRES préstamos, y presentarla en porcentaje sugiere una
 * granularidad que el pool no tiene.
 *
 * Es el mismo problema que el percentil con 24 pares, en la otra tabla.
 */
const puntoPorPrestamo = 1 / Number(objetivo.pool);
console.log(
  `\n  \x1b[90mCada préstamo vale ${pct(puntoPorPrestamo, 1)} de este pool (${objetivo.pool} préstamos):\x1b[0m`,
);
console.log(
  `  \x1b[90muna diferencia de 9 puntos son ${Math.round(0.09 / puntoPorPrestamo)} préstamos, no una tendencia.\x1b[0m`,
);
console.log(
  `\n  \x1b[90mLa posición es ordinal, no percentil: con ${pares.length} pares un percentil\x1b[0m`,
);
console.log(
  `  \x1b[90mtiene resolución de ~${(100 / (pares.length + 1)).toFixed(0)} puntos y presentarlo con decimales\x1b[0m`,
);
console.log(`  \x1b[90msugeriría una precisión que no existe.\x1b[0m\n`);

await closePool();

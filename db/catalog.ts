/**
 * El índice: las emisiones de una cohorte, y cuál se aparta de verdad.
 *
 *   npm run db:catalog
 *   npm run db:catalog -- --anada 2025
 *
 * QUÉ ORDENA ESTA PÁGINA, Y POR QUÉ ESO Y NO OTRA COSA
 *
 * De todo lo que el proyecto midió, una sola cosa distingue emisiones por encima
 * del azar: la mezcla de propiedades. Sobre la cohorte 2026 el catálogo cuenta
 * 8 de 25 contra 1,3 esperadas por azar, y el test se verificó generando emisiones
 * DESDE la nula antes de usarlo.
 *
 * TRES NÚMEROS PARA LA MISMA PREGUNTA, Y NINGUNO ESTABA MAL
 *
 * "Cuántas emisiones de 2026 tienen mezcla distinta" tiene tres respuestas en este
 * repo: 10, 13 y 8. No es que dos estén equivocadas — son tres cantidades distintas
 * con el mismo nombre:
 *
 *   db:composition-signal usa como referencia TODAS las emisiones de la añada,
 *   incluidas las mono-tipo, y cuenta significativas al 5% con una ponderación.
 *
 *   db:catalog excluye las mono-tipo de la referencia —no son conduits, y meterlas
 *   corre la mezcla "de mercado" hacia su tipo— y además exige que las dos
 *   ponderaciones coincidan. Las que discrepan van a "al filo" en vez de contarse.
 *
 * Cada filtro saca emisiones, así que el conteo baja. El agregado no cambia de
 * signo: 8 o 13 contra 1,3 esperadas es abrumador en las dos versiones.
 *
 * Lo que sí es un error es citar uno de los tres sin decir cuál, que es lo que
 * hacían estos comentarios. El número que vale para el producto es el que el
 * producto calcula, y por eso el HTML lo imprime en vez de tenerlo escrito.
 *
 * Las seis métricas de términos no se ordenan acá. Rastrean lo mismo más
 * débilmente (rho = 0,59 contra la distancia de composición) porque son su
 * consecuencia: los hoteles se suscriben distinto que los departamentos. Ordenar
 * por DSCR sería ordenar por una vista borrosa de la columna que ya está.
 *
 * LO QUE UN ÍNDICE HACE MAL POR DEFECTO
 *
 * Una lista ordenada dice "el primero es el más X", y con estos tamaños de pool
 * eso es falso para las posiciones vecinas. Tres decisiones para no mentir con el
 * orden:
 *
 *   Se ordena por el EXCESO sobre el azar (distancia − nulo), no por la distancia
 *   cruda. Ordenar por distancia cruda pondría arriba a los pools chicos, que se
 *   apartan más por muestreo y no por composición.
 *
 *   Las bandas son el mensaje, no la posición. "Distinta", "al filo" e
 *   "indistinguible" se leen; que una emisión esté 3ª y otra 6ª no se lee, porque
 *   no significa nada.
 *
 *   Se imprime cuánta distancia vale UN préstamo en el pool más chico. Dos
 *   emisiones separadas por menos que eso no están ordenadas: están empatadas y
 *   el orden lo puso el redondeo.
 *
 * LAS MONO-TIPO VAN APARTE, NO ARRIBA
 *
 * Una emisión que es 100% hotelería se aparta de la cohorte por definición, no
 * por cómo se armó. Si entrara al mismo ranking coparía los primeros puestos con
 * una tautología. Van en su propia sección, sin veredicto.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { closePool, ping } from "./client.js";
import { calcularBenchmark, cargarCandidatas, pct, type Benchmark } from "./cohortBenchmark.js";
import { esc, render } from "./pageRender.js";
import { estadoCorpus, estampa } from "./procedencia.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const args = process.argv.slice(2);
const iA = args.indexOf("--anada");
const ANADA = iA === -1 ? String(new Date().getFullYear()) : args[iA + 1]!;

const dir = new URL("../out/", import.meta.url).pathname;
const slugDe = (nombre: string) =>
  nombre.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

const candidatas = await cargarCandidatas();
const cohorte = candidatas.filter((c) => c.anada === ANADA);

if (cohorte.length === 0) {
  console.log(`\n  Sin emisiones en ${ANADA}.\n`);
  await closePool();
  process.exit(0);
}

await mkdir(dir, { recursive: true });

/** Se genera todo de una: el índice no puede enlazar páginas que no existen. */
const fichas: Array<{ b: Benchmark; slug: string }> = [];
for (const c of cohorte) {
  const b = await calcularBenchmark(c.nombre, candidatas);
  if (!b) continue;
  const slug = slugDe(c.nombre);
  await writeFile(`${dir}${slug}.html`, render(b), "utf8");
  fichas.push({ b, slug });
}

const estado = await estadoCorpus();
await closePool();

/**
 * Tres grupos que no se pueden mezclar en una tabla.
 *
 * Mono-tipo: se apartan por definición. No evaluables: no hay pares suficientes y
 * la respuesta es "no se sabe", que es distinta de "no se aparta".
 */
const evaluables = fichas.filter((f) => f.b.evaluable && !f.b.objetivoMonoTipo);
const monoTipo = fichas.filter((f) => f.b.objetivoMonoTipo);
const sinEvaluar = fichas.filter((f) => !f.b.evaluable && !f.b.objetivoMonoTipo);

const exceso = (b: Benchmark) => b.distancia - b.distanciaNulo;
evaluables.sort((x, y) => exceso(y.b) - exceso(x.b));

type Banda = "distinta" | "filo" | "igual";
const bandaDe = (b: Benchmark): Banda =>
  !b.robusto ? "filo" : b.pValor < 0.05 ? "distinta" : "igual";

const distintas = evaluables.filter((f) => bandaDe(f.b) === "distinta").length;
const alFilo = evaluables.filter((f) => bandaDe(f.b) === "filo").length;
const esperadasPorAzar = evaluables.length * 0.05;

/**
 * La resolución del orden, en las unidades del propio ranking.
 *
 * `puntoPorPrestamo` es cuánto de la composición vale un préstamo. El pool más
 * chico define el grano más grueso: dos emisiones separadas por menos que eso
 * están empatadas.
 */
const grano = Math.max(...evaluables.map((f) => f.b.puntoPorPrestamo), 0);

const ETIQUETA: Record<Banda, string> = {
  distinta: "distinta",
  filo: "al filo",
  igual: "de mercado",
};

const barraExceso = (b: Benchmark) => {
  const maxExc = Math.max(...evaluables.map((f) => exceso(f.b)), 0.01);
  const w = Math.max(0, (exceso(b) / maxExc) * 100);
  return `<div class="xb"><i style="width:${w.toFixed(1)}%"></i></div>`;
};

const fila = (f: { b: Benchmark; slug: string }) => {
  const b = f.b;
  const o = b.objetivo;
  const banda = bandaDe(b);
  /**
   * El tipo que más se aparta, no el más grande.
   *
   * "Qué tiene de distinto" es la diferencia contra la cohorte; el tipo dominante
   * ya está en casi todas y no distingue. Se omite si la diferencia no llega a un
   * préstamo: ahí no hay nada que nombrar.
   */
  const top = [...b.composicion]
    .filter((c) => !c.bajoResolucion)
    .sort((x, y) => Math.abs(y.diferencia) - Math.abs(x.diferencia))[0];
  return `<tr class="b-${banda}" data-exc="${exceso(b).toFixed(5)}" data-pool="${o.poolTipado}" data-nombre="${esc(o.nombre)}">
    <th><a href="${f.slug}.html">${esc(o.nombre)}</a></th>
    <td class="n">${o.poolTipado}${
      o.poolTipado < o.pool ? `<span class="muted"> / ${o.pool}</span>` : ""
    }</td>
    <td class="viz">${barraExceso(b)}</td>
    <td class="n">${pct(b.distancia)}<span class="muted"> vs ${pct(b.distanciaNulo)}</span></td>
    <td><span class="pill ${banda}">${ETIQUETA[banda]}</span></td>
    <td class="muted sm">${
      top
        ? `${top.diferencia > 0 ? "+" : "−"}${pct(Math.abs(top.diferencia))} ${esc(top.tipo)}` +
          ` <span class="muted">(${top.prestamosDif} préstamo${top.prestamosDif === 1 ? "" : "s"})</span>`
        : "nada por encima de un préstamo"
    }</td>
  </tr>`;
};

const html = `<!doctype html>
<meta charset="utf-8">
<title>Emisiones ${esc(ANADA)} — qué compró cada una</title>
<style>
  :root { --fg:#1a1a1a; --muted:#6b6b6b; --line:#e4e4e4; --bg:#fff;
          --dot:#2b5fa8; --agr:#b8791a; --ok:#2f7d43; }
  * { box-sizing:border-box }
  body { margin:0; padding:40px 28px 64px; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif }
  main { max-width:1040px; margin:0 auto }
  h1 { font-size:23px; margin:0 0 4px; letter-spacing:-.01em }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.06em;
       color:var(--muted); margin:36px 0 12px; font-weight:600 }
  .sub { color:var(--muted); font-size:13.5px; margin:0 0 20px }
  .verdict { font-size:15.5px; margin:0 0 10px; padding:12px 14px; border-radius:6px;
             background:#f0f7f1; border:1px solid #d6e8d9 }
  table { width:100%; border-collapse:collapse }
  thead th { font-size:11.5px; text-transform:uppercase; letter-spacing:.05em;
             color:var(--muted); font-weight:600; text-align:left;
             padding:0 10px 8px; border-bottom:1px solid var(--line) }
  thead th.s { cursor:pointer; user-select:none }
  thead th.s:hover { color:var(--fg) }
  thead th.n, td.n { text-align:right }
  tbody th { text-align:left; font-weight:500; padding:11px 10px; white-space:nowrap }
  td, tbody th { border-top:1px solid var(--line); padding:11px 10px;
                 font-variant-numeric:tabular-nums }
  a { color:var(--dot); text-decoration:none }
  a:hover { text-decoration:underline }
  .viz { width:150px }
  .xb { height:8px; background:#f0f0f0; border-radius:4px; overflow:hidden }
  .xb i { display:block; height:100%; background:#c3ccda }
  tr.b-distinta .xb i { background:var(--dot) }
  tr.b-filo .xb i { background:var(--agr) }
  .pill { font-size:11.5px; text-transform:uppercase; letter-spacing:.04em;
          font-weight:600; padding:3px 8px; border-radius:20px;
          background:#f0f0f0; color:var(--muted); white-space:nowrap }
  .pill.distinta { background:#e8f1e9; color:var(--ok) }
  .pill.filo { background:#fdf3e3; color:#8a6410 }
  .muted { color:var(--muted) }
  .sm { font-size:13px }
  .note { font-size:13px; color:var(--muted); margin:14px 0 0; padding-left:10px;
          border-left:2px solid var(--line) }
  footer { margin-top:44px; padding-top:20px; border-top:1px solid var(--line);
           font-size:12.5px; color:var(--muted) }
  footer code { font-size:12px }
</style>
<main>
  <h1>Emisiones de ${esc(ANADA)}</h1>
  <p class="sub">${fichas.length} emisiones cosechadas · ${evaluables.length} conduits comparables entre sí</p>

  <p class="verdict"><b>${distintas} de ${evaluables.length}</b> tienen una mezcla de propiedades
  más distinta de lo que produce el azar, cuando por azar se esperarían
  <b>${esperadasPorAzar.toFixed(1)}</b>${alFilo > 0 ? `, y ${alFilo} quedan al filo` : ""}.
  Ese agregado es sólido; el veredicto de una emisión individual cerca del borde no lo es.</p>

  <table>
    <thead><tr>
      <th class="s" data-k="nombre">emisión</th>
      <th class="s n" data-k="pool">pool con tipo</th>
      <th class="s" data-k="exc" colspan="2">cuánto se aparta · observado vs azar</th>
      <th></th>
      <th>qué tiene de distinto</th>
    </tr></thead>
    <tbody id="t">${evaluables.map(fila).join("")}</tbody>
  </table>

  <p class="note">Se ordena por el <b>exceso sobre el azar</b>, no por la distancia cruda:
  un pool chico se aparta más por muestreo, y ordenar por distancia pondría arriba a los
  pools chicos por ser chicos. Un préstamo vale hasta <b>${pct(grano, 1)}</b> de composición
  en el pool más chico de esta cohorte, así que dos emisiones separadas por menos que eso
  están empatadas y el orden lo puso el redondeo.</p>

  ${
    monoTipo.length > 0
      ? `<h2>Mono-tipo — no entran a la comparación</h2>
         <table><tbody>${monoTipo
           .map(
             (f) => `<tr><th><a href="${f.slug}.html">${esc(f.b.objetivo.nombre)}</a></th>
               <td class="n">${f.b.objetivo.poolTipado}${
                 f.b.objetivo.poolTipado < f.b.objetivo.pool
                   ? `<span class="muted"> / ${f.b.objetivo.pool}</span>`
                   : ""
               }</td>
               <td class="muted sm">${pct(f.b.objetivo.shareDominante)} ${esc(f.b.objetivo.tipoDominante ?? "")}</td></tr>`,
           )
           .join("")}</tbody></table>
         <p class="note">Una emisión de un solo tipo de propiedad se aparta de la cohorte
         por definición, no por cómo se armó. Meterla al ranking sería coparlo con una
         tautología.</p>`
      : ""
  }

  ${
    sinEvaluar.length > 0
      ? `<h2>Sin evaluar — no alcanzan los pares</h2>
         <table><tbody>${sinEvaluar
           .map(
             (f) => `<tr><th><a href="${f.slug}.html">${esc(f.b.objetivo.nombre)}</a></th>
               <td class="muted sm">${f.b.pares.length} comparables</td></tr>`,
           )
           .join("")}</tbody></table>
         <p class="note">"No se sabe" no es lo mismo que "no se aparta", así que van
         separadas en vez de al fondo de la tabla con un guion.</p>`
      : ""
  }

  <footer>
    El orden usa lo único que el corpus mostró que distingue emisiones por encima del
    azar: la mezcla de propiedades. Los términos —DSCR, LTV, debt yield— rastrean lo
    mismo más débilmente (rho = 0,59) porque son su consecuencia, y están en la página
    de cada emisión.
    <br><br>
    "Al filo" significa que el veredicto cambia según se pondere la referencia por
    préstamo o por emisión. Cuando las dos ponderaciones caen a distinto lado del 5%,
    se dice eso en vez de elegir una.
    <br><br>
    Datos de los FWP / Annex A publicados en SEC EDGAR. Generado por
    <code>npm run db:catalog</code>. ${esc(estampa(estado))}
  </footer>
</main>
<script>
  // Ordenar sin dependencias. El default es por exceso, que es el que tiene sentido.
  const tb = document.getElementById("t");
  let dir = -1, ult = "exc";
  document.querySelectorAll("thead th.s").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      dir = k === ult ? -dir : -1;
      ult = k;
      const filas = [...tb.querySelectorAll("tr")];
      filas.sort((a, b) => {
        const x = a.dataset[k], y = b.dataset[k];
        const n = k !== "nombre";
        return (n ? (+y - +x) : y.localeCompare(x)) * (dir === -1 ? 1 : -1);
      });
      filas.forEach((f) => tb.appendChild(f));
    });
  });
</script>
`;

await writeFile(`${dir}index.html`, html, "utf8");

console.log(`\n${"═".repeat(78)}`);
console.log(`Índice de la cohorte ${ANADA}`);
console.log(`${"═".repeat(78)}\n`);
console.log(
  `  ${fichas.length} páginas + índice en \x1b[1mout/index.html\x1b[0m`,
);
console.log(
  `  ${evaluables.length} conduits comparables · ${monoTipo.length} mono-tipo · ${sinEvaluar.length} sin evaluar\n`,
);
console.log(`  emisión                              con tipo  exceso    veredicto`);
console.log(`  ${"─".repeat(70)}`);
for (const f of evaluables) {
  const banda = bandaDe(f.b);
  const color = banda === "distinta" ? "\x1b[32m" : banda === "filo" ? "\x1b[33m" : "\x1b[90m";
  console.log(
    `  ${f.b.objetivo.nombre.slice(0, 34).padEnd(36)} ` +
      `${String(f.b.objetivo.poolTipado).padStart(5)}${
        f.b.objetivo.poolTipado < f.b.objetivo.pool
          ? `\x1b[90m/${f.b.objetivo.pool}\x1b[0m`
          : "   "
      } ` +
      `${pct(exceso(f.b), 1).padStart(6)}    ${color}${ETIQUETA[banda]}\x1b[0m`,
  );
}
console.log(
  `\n  \x1b[1m${distintas} de ${evaluables.length}\x1b[0m se apartan, contra ${esperadasPorAzar.toFixed(1)} esperadas por azar` +
    (alFilo > 0 ? ` \x1b[33m(+${alFilo} al filo)\x1b[0m` : ""),
);
console.log(
  `  \x1b[90mUn préstamo vale hasta ${pct(grano, 1)} de composición: por debajo de eso el orden` +
    ` es redondeo.\x1b[0m`,
);
console.log(`\n\x1b[90m  ${estampa(estado)}\x1b[0m\n`);

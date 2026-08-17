/**
 * La página de una emisión: el benchmark con forma de algo que alguien lee.
 *
 *   npm run db:page                  # la más reciente
 *   npm run db:page -- BNK52
 *   npm run db:page -- BNK52 --abrir
 *
 * QUÉ CAMBIA RESPECTO DE `db:benchmark`
 *
 * Los números son los mismos —salen de `cohortBenchmark.ts`, que es el único
 * lugar donde se calculan— y lo que cambia es a quién le habla. La terminal le
 * habla a quien construye; esto le habla a alguien mirando un deal.
 *
 * LA DECISIÓN DE CONTENIDO QUE IMPORTA
 *
 * Las advertencias de resolución no van en letra chica al pie. Van al lado del
 * número que califican.
 *
 * Con un pool de 25 préstamos cada uno vale 4 puntos de composición, así que un
 * "+9%" son dos préstamos. Con 24 pares, la diferencia entre la posición 12ª y
 * la 14ª es un documento. Un producto que muestra "+9%" y "12ª de 25" sin eso al
 * lado no está informando: está sugiriendo una precisión que los datos no
 * tienen, y esta sesión mostró cuatro veces lo fácil que es creerle a un número
 * bien formateado.
 *
 * NO HAY DEPENDENCIAS
 *
 * Un HTML con el CSS adentro. Se abre haciendo doble clic, se manda por mail, no
 * necesita servidor. Si más adelante hay una web app, este archivo es la
 * plantilla de la página de detalle.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { closePool, ping } from "./client.js";
import {
  calcularBenchmark, cargarCandidatas, MIN_PARES, pct,
  type Benchmark, type Composicion, type MetricaResultado,
} from "./cohortBenchmark.js";

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

const args = process.argv.slice(2);
const BUSQUEDA = args.find((a) => !a.startsWith("--")) ?? null;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * La posición dentro del rango de la cohorte, como una barra.
 *
 * Se dibuja el rango p25–p75 y un punto donde cae esta emisión. Un punto adentro
 * de la caja dice "de mercado" mucho más rápido que "13ª de 25", y los dos
 * números están igual.
 *
 * El punto se recorta al 0–100% del ancho: una emisión más extrema que el p25 o
 * el p75 queda en el borde en vez de salirse del dibujo, y el "13ª de 25" al
 * lado dice cuán afuera está.
 */
function barra(m: MetricaResultado): string {
  if (m.valor === null || m.p25 === null || m.p75 === null || m.p50 === null) return "";
  const lo = Math.min(m.p25, m.valor);
  const hi = Math.max(m.p75, m.valor);
  const span = hi - lo || 1;
  const x = (v: number) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  return `<div class="bar">
      <div class="box" style="left:${x(m.p25).toFixed(1)}%;width:${(x(m.p75) - x(m.p25)).toFixed(1)}%"></div>
      <div class="med" style="left:${x(m.p50).toFixed(1)}%"></div>
      <div class="dot${m.agresivo ? " agr" : ""}" style="left:${x(m.valor).toFixed(1)}%"></div>
    </div>`;
}

function filaMetrica(m: MetricaResultado): string {
  if (m.valor === null) {
    const motivo =
      m.sinDato === "emision"
        ? "esta emisión no publica el dato"
        : `solo ${m.paresConDato} pares con dato — hacen falta ${MIN_PARES}`;
    return `<tr class="nd">
      <th>${esc(m.spec.etiqueta)}</th>
      <td colspan="4"><span class="muted">Sin evaluar: ${esc(motivo)}</span></td>
    </tr>`;
  }
  const f = m.spec.fmt;
  return `<tr>
    <th>${esc(m.spec.etiqueta)}</th>
    <td class="val">${esc(f(m.valor))}</td>
    <td class="coh">${esc(f(m.p25!))} · <b>${esc(f(m.p50!))}</b> · ${esc(f(m.p75!))}</td>
    <td class="viz">${barra(m)}</td>
    <td class="pos${m.extremo ? (m.agresivo ? " agr" : " ext") : ""}">${m.rank}ª<span class="muted"> de ${m.total}</span>${
      m.agresivo ? '<div class="tag">más agresivo</div>' : ""
    }</td>
  </tr>`;
}

function filaComposicion(c: Composicion, punto: number): string {
  const notable = Math.abs(c.diferencia) > 0.1;
  const w = (v: number) => Math.min(100, v * 100 * 2.2).toFixed(1);
  return `<tr${notable ? ' class="notable"' : ""}>
    <th>${esc(c.tipo)}</th>
    <td class="mini"><div class="mb"><i style="width:${w(c.propio)}%"></i></div>${pct(c.propio)}</td>
    <td class="mini"><div class="mb coh"><i style="width:${w(c.cohorte)}%"></i></div>${pct(c.cohorte)}</td>
    <td class="dif">${c.diferencia > 0 ? "+" : ""}${pct(c.diferencia)}</td>
    <td class="muted sm">${c.prestamos} préstamo${c.prestamos === 1 ? "" : "s"}${
      notable
        ? ` · la diferencia son ${Math.max(1, Math.round(Math.abs(c.diferencia) / punto))}`
        : ""
    }</td>
  </tr>`;
}

function render(b: Benchmark): string {
  const o = b.objetivo;
  const cuerpo = !b.evaluable
    ? /**
       * El rechazo es una respuesta, no una pantalla vacía.
       *
       * Decir "no se sabe" con el motivo es más útil que un tablero en cero, y
       * es la diferencia entre una herramienta que se puede creer y una que
       * siempre contesta algo.
       */
      `<section class="refuse">
        <h2>No se puede evaluar</h2>
        <p>Hacen falta ${MIN_PARES} emisiones comparables en la cohorte ${esc(o.anada)} y hay
        ${b.pares.length}. Con menos, decir que esta emisión "se aparta del mercado" sería
        una afirmación sobre ${b.pares.length} documentos.</p>
        <p class="muted">La respuesta correcta acá es que no se sabe.</p>
      </section>`
    : `${
        b.objetivoMonoTipo
          ? `<section class="warn"><h2>Esta emisión es ${pct(o.shareDominante)} ${esc(o.tipoDominante ?? "")}</h2>
             <p>No es un conduit diversificado, así que la comparación contra la cohorte va a
             mostrar diferencias garantizadas que no significan nada sobre cómo se suscribió.</p></section>`
          : ""
      }
      <section>
        <h2>Posición dentro de la cohorte ${esc(o.anada)}</h2>
        <table class="m">
          <thead><tr>
            <th></th><th>esta emisión</th><th>cohorte (p25 · mediana · p75)</th><th></th><th>posición</th>
          </tr></thead>
          <tbody>${b.metricas.map(filaMetrica).join("")}</tbody>
        </table>
        <p class="note">La posición es <b>ordinal, no percentil</b>. Con ${b.pares.length} pares
        un percentil tendría una resolución de ~${b.resolucionPercentil.toFixed(0)} puntos, así que
        mostrarlo con decimales sugeriría una precisión que no existe. La diferencia entre
        dos puestos contiguos es una emisión.</p>
      </section>

      <section>
        <h2>Composición contra la cohorte</h2>
        <table class="c">
          <thead><tr>
            <th></th><th>esta emisión</th><th>cohorte</th><th>dif.</th><th></th>
          </tr></thead>
          <tbody>${b.composicion.map((c) => filaComposicion(c, b.puntoPorPrestamo)).join("")}</tbody>
        </table>
        <p class="note">Cada préstamo vale <b>${pct(b.puntoPorPrestamo, 1)}</b> de este pool
        (${o.pool} préstamos). Una diferencia de 9 puntos son
        ${Math.max(1, Math.round(0.09 / b.puntoPorPrestamo))} préstamos, no una tendencia.</p>
      </section>`;

  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(o.nombre)} — benchmark de cohorte</title>
<style>
  :root { --fg:#1a1a1a; --muted:#6b6b6b; --line:#e4e4e4; --bg:#fff;
          --box:#dfe7f3; --dot:#2b5fa8; --agr:#b8791a; --warn:#fff8e6; }
  * { box-sizing:border-box }
  body { margin:0; padding:40px 28px 64px; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width:920px; margin:0 auto }
  h1 { font-size:23px; margin:0 0 4px; letter-spacing:-.01em }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.06em;
       color:var(--muted); margin:0 0 12px; font-weight:600 }
  .sub { color:var(--muted); font-size:13.5px; margin:0 0 6px }
  .peers { color:var(--muted); font-size:13px; margin:0 0 32px; padding-bottom:24px;
           border-bottom:1px solid var(--line) }
  section { margin:0 0 40px }
  table { width:100%; border-collapse:collapse }
  thead th { font-size:11.5px; text-transform:uppercase; letter-spacing:.05em;
             color:var(--muted); font-weight:600; text-align:right;
             padding:0 10px 8px; border-bottom:1px solid var(--line) }
  thead th:first-child, tbody th { text-align:left }
  tbody th { font-weight:500; padding:11px 10px; white-space:nowrap }
  td { padding:11px 10px; text-align:right; border-top:1px solid var(--line);
       font-variant-numeric:tabular-nums }
  tbody th { border-top:1px solid var(--line) }
  .val { font-weight:600; font-size:16px }
  .coh { color:var(--muted); font-size:13.5px; white-space:nowrap }
  .viz { width:160px }
  .bar { position:relative; height:20px }
  .bar:before { content:""; position:absolute; left:0; right:0; top:9px; height:2px; background:var(--line) }
  .box { position:absolute; top:5px; height:10px; background:var(--box); border-radius:2px }
  .med { position:absolute; top:3px; width:1px; height:14px; background:#a9b6c9 }
  .dot { position:absolute; top:5px; width:10px; height:10px; margin-left:-5px;
         border-radius:50%; background:var(--dot) }
  .dot.agr { background:var(--agr) }
  .pos { white-space:nowrap; color:var(--muted) }
  .pos.ext { color:var(--dot); font-weight:600 }
  .pos.agr { color:var(--agr); font-weight:600 }
  .tag { font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; font-weight:600 }
  .nd th, .nd td { color:var(--muted) }
  .muted { color:var(--muted) }
  .sm { font-size:12.5px }
  .mini { white-space:nowrap; font-size:13.5px }
  .mb { display:inline-block; width:74px; height:7px; background:#f0f0f0;
        border-radius:4px; overflow:hidden; margin-right:8px; vertical-align:middle }
  .mb i { display:block; height:100%; background:var(--dot) }
  .mb.coh i { background:#b9c4d4 }
  .dif { font-weight:500 }
  tr.notable .dif { color:var(--agr); font-weight:700 }
  .note { font-size:13px; color:var(--muted); margin:14px 0 0; padding-left:10px;
          border-left:2px solid var(--line) }
  .refuse, .warn { background:var(--warn); border:1px solid #f0e2bc;
                   border-radius:6px; padding:18px 20px }
  .refuse h2, .warn h2 { color:#8a6410; text-transform:none; font-size:15px;
                         letter-spacing:0; margin-bottom:6px }
  .refuse p, .warn p { margin:0 0 8px; font-size:14px }
  footer { margin-top:44px; padding-top:20px; border-top:1px solid var(--line);
           font-size:12.5px; color:var(--muted) }
  footer code { font-size:12px }
</style>
<main>
  <h1>${esc(o.nombre)}</h1>
  <p class="sub">${esc(o.filed.slice(0, 10))} · ${o.pool} préstamos · cohorte ${esc(o.anada)}</p>
  <p class="peers">${b.pares.length} emisiones comparables${
    b.excluidas.length > 0
      ? ` · ${b.excluidas.length} excluida${b.excluidas.length === 1 ? "" : "s"} por ser
         mono-tipo: ${esc(b.excluidas.map((e) => e.nombre.slice(0, 34)).join(", "))}`
      : ""
  }</p>
  ${cuerpo}
  <footer>
    Comparación contra las otras emisiones del mismo año, no contra la historia:
    entre 2020 y 2024 la tasa pasó de ~3,5% a ~7% y eso arrastra el DSCR y el debt
    yield por construcción. Una referencia que junte añadas mide el ciclo, no la emisión.
    <br><br>
    Se compara la <b>mediana del pool</b> contra la distribución de las medianas de los
    pares. Las emisiones de un solo tipo de propiedad se excluyen del grupo de referencia:
    no son conduits diversificados.
    <br><br>
    Datos de los FWP / Annex A publicados en SEC EDGAR. Generado por
    <code>npm run db:page</code>.
  </footer>
</main>
`;
}

// ---------------------------------------------------------------------------

const candidatas = await cargarCandidatas();
const b = await calcularBenchmark(BUSQUEDA, candidatas);

if (!b) {
  console.error(`\n✗ No se encontró una emisión que coincida con "${BUSQUEDA}".`);
  console.error(`  Listado:  npm run db:benchmark -- --listar\n`);
  await closePool();
  process.exit(1);
}

const slug = b.objetivo.nombre
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 60);

const dir = new URL("../out/", import.meta.url).pathname;
await mkdir(dir, { recursive: true });
const ruta = `${dir}${slug}.html`;
await writeFile(ruta, render(b), "utf8");

console.log(`\n  ${b.objetivo.nombre}`);
console.log(
  `  \x1b[90m${b.objetivo.pool} préstamos · ${b.pares.length} pares · ` +
    `${b.evaluable ? `${b.metricas.filter((m) => m.valor !== null).length} de ${b.metricas.length} métricas evaluadas` : "no evaluable"}\x1b[0m`,
);
console.log(`\n  → ${ruta}\n`);

await closePool();

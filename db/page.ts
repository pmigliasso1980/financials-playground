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

function filaComposicion(c: Composicion): string {
  const notable = Math.abs(c.diferencia) > 0.1;
  const w = (v: number) => Math.min(100, v * 100 * 2.2).toFixed(1);
  /**
   * Una diferencia menor a un préstamo se muestra como "—", no como "+0%".
   *
   * El porcentaje redondeado hacía parecer un error de cálculo lo que en
   * realidad era una diferencia por debajo de la resolución del pool: con 35
   * préstamos, 0,4 puntos son 0,14 préstamos.
   */
  const dif = c.bajoResolucion
    ? `<span class="muted">—</span>`
    : `${c.diferencia > 0 ? "+" : ""}${pct(c.diferencia)}`;
  /**
   * Y la columna de la derecha dice cuántos préstamos son LA DIFERENCIA, no
   * cuántos tiene la emisión. La versión anterior mostraba "-13% · 5 préstamos"
   * y esos 5 eran el multifamily de BANK5, no la brecha contra la cohorte: dos
   * números distintos leídos como uno.
   */
  const detalle = c.bajoResolucion
    ? `menos de un préstamo de diferencia`
    : `${c.prestamosDif} préstamo${c.prestamosDif === 1 ? "" : "s"} de diferencia` +
      ` · esta emisión tiene ${c.prestamos}`;
  return `<tr${notable ? ' class="notable"' : ""}>
    <th>${esc(c.tipo)}</th>
    <td class="mini"><div class="mb"><i style="width:${w(c.propio)}%"></i></div>${pct(c.propio)}</td>
    <td class="mini"><div class="mb coh"><i style="width:${w(c.cohorte)}%"></i></div>${pct(c.cohorte)}</td>
    <td class="dif">${dif}</td>
    <td class="muted sm">${esc(detalle)}</td>
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
        <h2>Qué compró esta emisión</h2>
        <table class="c">
          <thead><tr>
            <th></th><th>esta emisión</th><th>cohorte</th><th>dif.</th><th></th>
          </tr></thead>
          <tbody>${b.composicion.map(filaComposicion).join("")}</tbody>
        </table>
        <p class="note">Cada préstamo vale <b>${pct(b.puntoPorPrestamo, 1)}</b> de este pool
        (${o.pool} préstamos), así que una diferencia de 9 puntos son
        ${Math.max(1, Math.round(0.09 / b.puntoPorPrestamo))} préstamos.
        Hay que mover el <b>${pct(b.distancia)}</b> del pool para llegar a la mezcla de la
        cohorte; sacando ${o.pool} préstamos al azar del universo de los pares se esperaría
        mover ${pct(b.distanciaNulo)}.</p>
      </section>

      <section>
        <h2>Términos</h2>
        <p class="lead">${
          b.metricas.filter((m) => m.valor !== null).length === 0
            ? "Sin métricas evaluables."
            : `En línea con la cohorte: ` +
              b.metricas
                .filter((m) => m.valor !== null)
                .map((m) => `${esc(m.spec.etiqueta)} ${esc(m.spec.fmt(m.valor!))}`)
                .join(" · ")
        }</p>
        <p class="note">Estos seis números rastrean lo mismo que la mezcla, más débilmente.
        Sobre las 28 emisiones de la cohorte, cuántas métricas se apartan del rango
        intercuartil correlaciona con cuánto se aparta la composición (rho = 0,59, t = 3,7):
        una emisión con mucha hotelería tiene DSCR y debt yield distintos <i>porque</i> los
        hoteles se suscriben distinto. La causa es la mezcla; los términos son su
        consecuencia. Van abajo porque cada métrica por separado es una prueba débil de lo
        que la composición mide de una vez.</p>
        <details>
          <summary>Ver la posición de cada métrica</summary>
          <table class="m">
            <thead><tr>
              <th></th><th>esta emisión</th><th>cohorte (p25 · mediana · p75)</th><th></th><th>posición</th>
            </tr></thead>
            <tbody>${b.metricas.map(filaMetrica).join("")}</tbody>
          </table>
          <p class="note">La posición es <b>ordinal, no percentil</b>: con ${b.pares.length}
          pares un percentil tendría resolución de ~${b.resolucionPercentil.toFixed(0)} puntos.</p>
        </details>
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
  .verdict { font-size:15.5px; margin:0 0 18px; padding:12px 14px; border-radius:6px;
             background:#f4f6fa; border:1px solid #e2e8f2 }
  .verdict.sig { background:#f0f7f1; border-color:#d6e8d9 }
  .verdict.filo { background:#fdf6ec; border-color:#f0e2bc }
  .lead { font-size:15px; margin:0 0 10px; font-variant-numeric:tabular-nums }
  details { margin-top:14px }
  summary { cursor:pointer; font-size:13px; color:var(--muted); padding:6px 0 }
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
  ${
    b.evaluable
      ? !b.robusto
        ? /**
           * Las dos ponderaciones discrepan: se dice eso, no se elige una.
           *
           * Medido sobre 2026: por préstamo salen 13 emisiones con mezcla
           * distinta y por emisión 15, coincidiendo en 13. El agregado es
           * robusto pero dos emisiones cambian de lado, y una es BANK5
           * 2026-5YR24 — que con una ponderación es "indistinguible" y con la
           * otra "distinta".
           *
           * Afirmar cualquiera de las dos sería afirmar más de lo que sabemos.
           */
          `<p class="verdict filo">Mezcla <b>al filo</b> — hay que mover el ${pct(b.distancia)}
           del pool para igualar la cohorte, contra ${pct(b.distanciaNulo)} esperado por azar
           con ${o.pool} préstamos. Que eso cuente como "distinta" depende de cómo se pondere
           la referencia: contando todos los préstamos de los pares da p = ${b.pValor.toFixed(3)},
           y dando el mismo peso a cada emisión da p = ${b.pValorPorEmision.toFixed(3)}.
           Con las dos a distinto lado del 5%, la respuesta honesta es que está en el borde.</p>`
        : `<p class="verdict ${b.pValor < 0.05 ? "sig" : ""}">${
            b.pValor < 0.05
              ? `Mezcla de propiedades <b>distinta de su cohorte</b> — hay que mover el
                 ${pct(b.distancia)} del pool para igualarla, contra ${pct(b.distanciaNulo)}
                 que se esperaría por azar con ${o.pool} préstamos (p = ${b.pValor.toFixed(4)},
                 y da lo mismo con las dos ponderaciones de la referencia).`
              : `Mezcla de propiedades <b>indistinguible de su cohorte</b> — la distancia de
                 ${pct(b.distancia)} está dentro de lo que produce el muestreo con ${o.pool}
                 préstamos (${pct(b.distanciaNulo)} esperado, p = ${b.pValor.toFixed(2)}).`
          }</p>`
      : ""
  }
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
const dir = new URL("../out/", import.meta.url).pathname;

const slugDe = (nombre: string) =>
  nombre.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * `--todas`: genera la página de cada emisión de la cohorte y mide algo que la
 * página sola no puede mostrar.
 *
 * LA PREGUNTA DE PRODUCTO
 *
 * En BANK5 2026-5YR24, cinco de las seis métricas caen dentro del rango
 * intercuartil de la cohorte. Si eso pasa en las 28, la tabla de métricas —que
 * es la mitad de la página— no informa nada y lo único que distingue a una
 * emisión es su mezcla de propiedades. Si pasa en 10 de 28, informa bastante.
 *
 * Son dos productos distintos y la diferencia es un número que nadie midió.
 * Ahora cuesta poco medirlo porque el cálculo está en un módulo.
 */
if (args.includes("--todas")) {
  const anada = String(new Date().getFullYear());
  const cohorte = candidatas.filter((c) => c.anada === anada);
  await mkdir(dir, { recursive: true });

  console.log(`\n${"═".repeat(78)}`);
  console.log(`¿Informa la tabla de métricas? — cohorte ${anada}`);
  console.log(`${"═".repeat(78)}\n`);
  console.log(`  emisión                              pool   evaluadas   fuera del p25-p75`);
  console.log(`  ${"─".repeat(74)}`);

  let totalEval = 0;
  let totalFuera = 0;
  const fueraPorMetrica = new Map<string, { fuera: number; eval: number }>();
  /**
   * Para la pregunta que me faltó medir: ¿las métricas fuera de rango predicen
   * que la mezcla sea distinta?
   *
   * Afirmé que la coincidencia entre "5 de 6 fuera" y "mezcla significativa" era
   * ruido, sin medirla, en el mismo párrafo donde criticaba hacer eso. Si las dos
   * cifras correlacionan, la tabla de métricas no es decorativa: es una vista
   * redundante de la misma señal, y eso cambia por qué se la degrada.
   */
  const pares_: Array<{ fuera: number; d: number }> = [];

  for (const c of cohorte) {
    const bm = await calcularBenchmark(c.nombre, candidatas);
    if (!bm) continue;
    await writeFile(`${dir}${slugDe(c.nombre)}.html`, render(bm), "utf8");

    if (!bm.evaluable) {
      console.log(`  ${c.nombre.slice(0, 34).padEnd(36)} ${String(c.pool).padStart(5)}   \x1b[90mno evaluable\x1b[0m`);
      continue;
    }

    /**
     * "Fuera" es fuera del rango intercuartil, no la posición ordinal.
     *
     * La posición dice dónde cae; el rango dice si eso es distinguible del
     * medio del mercado. Una emisión puede ser 19ª de 25 y estar adentro de la
     * caja: es la mitad superior, pero no se aparta.
     */
    const conDato = bm.metricas.filter((m) => m.valor !== null);
    const fuera = conDato.filter((m) => m.valor! < m.p25! || m.valor! > m.p75!);
    totalEval += conDato.length;
    totalFuera += fuera.length;
    for (const m of conDato) {
      const e = fueraPorMetrica.get(m.spec.etiqueta) ?? { fuera: 0, eval: 0 };
      e.eval++;
      if (m.valor! < m.p25! || m.valor! > m.p75!) e.fuera++;
      fueraPorMetrica.set(m.spec.etiqueta, e);
    }

    pares_.push({ fuera: fuera.length, d: bm.distancia - bm.distanciaNulo });

    console.log(
      `  ${c.nombre.slice(0, 34).padEnd(36)} ${String(c.pool).padStart(5)}   ` +
        `${String(conDato.length).padStart(9)}   ` +
        `${fuera.length === 0 ? "\x1b[90m" : fuera.length >= 3 ? "\x1b[33m" : ""}${fuera.length}\x1b[0m` +
        (fuera.length > 0 ? `  \x1b[90m${fuera.map((m) => m.spec.etiqueta).join(", ")}\x1b[0m` : ""),
    );
  }

  console.log(`\n${"─".repeat(78)}`);

  /**
   * EL VALOR NULO ES 50%, NO CERO.
   *
   * El rango intercuartil contiene el 50% de una distribución por definición. Si
   * esta emisión es intercambiable con sus pares, la probabilidad de caer afuera
   * del rango de los otros es 50%. Un 50% observado no es señal: es exactamente
   * lo que predice el azar.
   *
   * La primera versión comparaba contra 0,25 —un umbral que escribí antes de
   * medir, sin preguntarme cuál era el valor esperado bajo la nula— e imprimió
   * "la tabla distingue" ante el resultado que significa justo lo contrario.
   * Sexto veredicto de esta sesión calculado contra la referencia equivocada.
   *
   * Ahora el contraste es contra 50% con su error estándar. Con n emisiones,
   * SE = sqrt(0,25/n): con 28 son 9,4 puntos, así que hace falta salirse de
   * 50 ± 19 para afirmar algo con dos errores estándar.
   */
  const share = totalEval ? totalFuera / totalEval : 0;
  const n = cohorte.length;
  const se = Math.sqrt(0.25 / Math.max(1, n));
  const z = (share - 0.5) / se;

  console.log(
    `\n  \x1b[1m${totalFuera} de ${totalEval} mediciones fuera del rango (${pct(share)})\x1b[0m`,
  );
  /**
   * ESTA MEDICIÓN NO TIENE POTENCIA. SE DEJA PARA QUE NO SE VUELVA A CITAR.
   *
   * Cada emisión se compara contra el rango intercuartil de las OTRAS del mismo
   * conjunto. Por intercambiabilidad la tasa marginal es 50% exista o no señal:
   * si todas las emisiones fueran idénticas daría 50%, y si fueran radicalmente
   * distintas también. No hay referencia externa — el conjunto se mide contra sí
   * mismo.
   *
   * O sea que el nulo y el observado coinciden por construcción, y "z = 0,00" no
   * es evidencia de nada. Yo lo presenté como hallazgo negativo y reordené la
   * página apoyándome en él.
   *
   * Lo que sí decide está abajo: la correlación entre cuántas métricas se apartan
   * y cuánto se aparta la mezcla. Ahí sí hay dos cantidades independientes que
   * pueden o no ir juntas, y van (rho = 0,59).
   */
  console.log(
    `  \x1b[31mEste número no mide nada:\x1b[0m cada emisión se compara contra el rango de las`,
  );
  console.log(
    `  otras del mismo conjunto, así que por intercambiabilidad la tasa marginal es`,
  );
  console.log(
    `  50% exista o no señal. El nulo y el observado coinciden por construcción.`,
  );
  console.log(
    `  \x1b[90mSE = ${pct(se, 1)} con ${n} emisiones, z = ${z.toFixed(2)} — y ese z no podía ser otro.\x1b[0m`,
  );

  console.log(`\n  Por métrica (mismo problema, se listan para comparar):\n`);
  for (const [etiqueta, e] of fueraPorMetrica) {
    const sh = e.eval ? e.fuera / e.eval : 0;
    const seM = Math.sqrt(0.25 / Math.max(1, e.eval));
    const zM = (sh - 0.5) / seM;
    /**
     * Sin veredicto por métrica: el z hereda el problema del agregado.
     *
     * Decía "indistinguible del azar", que es la conclusión del test sin
     * potencia. El z no podía ser otro, así que llamarlo indistinguible le
     * atribuye a los datos algo que fija la construcción.
     */
    console.log(
      `    ${etiqueta.padEnd(14)} ${String(e.fuera).padStart(3)} de ${String(e.eval).padStart(3)}   ` +
        `${pct(sh).padStart(4)}   \x1b[90mz = ${zM >= 0 ? "+" : ""}${zM.toFixed(2)}\x1b[0m`,
    );
  }

  /**
   * Correlación de Spearman entre "métricas fuera de rango" y "cuánto se aparta
   * la mezcla por encima del nulo".
   *
   * Spearman y no Pearson: la cantidad de métricas fuera va de 0 a 6 y la
   * distancia es continua y sesgada; el orden es lo único comparable.
   *
   * El exceso sobre el nulo (d - nulo) y no d crudo: d crece cuando el pool es
   * chico, y la cantidad de métricas fuera también, así que correlacionarlos
   * directo mediría el tamaño del pool en las dos puntas.
   */
  if (pares_.length >= 10) {
    const rank = (xs: number[]) => {
      const orden = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
      const r = new Array(xs.length).fill(0);
      for (let k = 0; k < orden.length; ) {
        let j = k;
        while (j + 1 < orden.length && orden[j + 1]!.v === orden[k]!.v) j++;
        const medio = (k + j) / 2 + 1;
        for (let m = k; m <= j; m++) r[orden[m]!.i] = medio;
        k = j + 1;
      }
      return r;
    };
    const rx = rank(pares_.map((p) => p.fuera));
    const ry = rank(pares_.map((p) => p.d));
    const n2 = pares_.length;
    const mx = rx.reduce((a, b) => a + b, 0) / n2;
    const my = ry.reduce((a, b) => a + b, 0) / n2;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n2; i++) {
      num += (rx[i]! - mx) * (ry[i]! - my);
      dx += (rx[i]! - mx) ** 2;
      dy += (ry[i]! - my) ** 2;
    }
    const rho = num / Math.sqrt(dx * dy);
    /** t de Student con n-2 grados: el umbral de |t| ≈ 2 para 26 gl. */
    const t = rho * Math.sqrt((n2 - 2) / Math.max(1e-9, 1 - rho * rho));

    console.log(`\n${"─".repeat(78)}\n`);
    console.log(
      `  \x1b[1mMétricas fuera de rango contra exceso de distancia: rho = ${rho.toFixed(3)}\x1b[0m` +
        ` \x1b[90m(t = ${t.toFixed(2)}, ${n2 - 2} gl)\x1b[0m`,
    );
    console.log(
      Math.abs(t) >= 2
        ? `\n  \x1b[33mCorrelacionan.\x1b[0m La tabla de métricas no es decorativa: es una vista\n` +
            `  redundante de la misma señal que la composición. Degradarla sigue siendo\n` +
            `  correcto —dice lo mismo peor— pero por una razón distinta de la que dije.`
        : `\n  \x1b[32mNo correlacionan.\x1b[0m Que BNK52 tenga 5 métricas fuera y mezcla distinta,\n` +
            `  y BANK5 ninguna y mezcla normal, es coincidencia de dos casos. Con 6 métricas\n` +
            `  por emisión, tener 5 afuera pasa seguido por azar.`,
    );
  }

  console.log(`\n  ${cohorte.length} páginas en ${dir}\n`);
  await closePool();
  process.exit(0);
}

const b = await calcularBenchmark(BUSQUEDA, candidatas);

if (!b) {
  console.error(`\n✗ No se encontró una emisión que coincida con "${BUSQUEDA}".`);
  console.error(`  Listado:  npm run db:benchmark -- --listar\n`);
  await closePool();
  process.exit(1);
}

await mkdir(dir, { recursive: true });
const ruta = `${dir}${slugDe(b.objetivo.nombre)}.html`;
await writeFile(ruta, render(b), "utf8");

console.log(`\n  ${b.objetivo.nombre}`);
console.log(
  `  \x1b[90m${b.objetivo.pool} préstamos · ${b.pares.length} pares · ` +
    `${b.evaluable ? `${b.metricas.filter((m) => m.valor !== null).length} de ${b.metricas.length} métricas evaluadas` : "no evaluable"}\x1b[0m`,
);
console.log(`\n  → ${ruta}\n`);

await closePool();

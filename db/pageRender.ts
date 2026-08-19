/**
 * El HTML de una emisión: la plantilla, separada de quien la invoca.
 *
 * POR QUÉ SE SEPARÓ
 *
 * Vivía adentro de `page.ts`, que es un script con `await` en el nivel superior:
 * importarlo desde otro lado lo ejecuta. Cuando apareció el índice —que necesita
 * generar las mismas páginas— la alternativa era duplicar 280 líneas de plantilla
 * y CSS, y dos copias de un HTML divergen en la primera corrección que se hace en
 * una sola.
 *
 * Es la misma razón por la que existe `cohortBenchmark.ts`: un cálculo o una
 * plantilla que dos comandos comparten vive en un módulo, no en el script que la
 * necesitó primero.
 */

import {
  MIN_PAIRS, pct,
  type Benchmark, type Composition, type CohortMetricResult,
} from "./cohortBenchmark.js";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * La posición dentro del rango de la cohort, como una barra.
 *
 * Se dibuja el rango p25–p75 y un punto donde cae esta emisión. Un punto adentro
 * de la caja dice "de mercado" mucho más rápido que "13ª de 25", y los dos
 * números están igual.
 *
 * El punto se recorta al 0–100% del ancho: una emisión más extrema que el p25 o
 * el p75 queda en el borde en vez de salirse del dibujo, y el "13ª de 25" al
 * lado dice cuán afuera está.
 */
function barra(m: CohortMetricResult): string {
  if (m.value === null || m.p25 === null || m.p75 === null || m.p50 === null) return "";
  const lo = Math.min(m.p25, m.value);
  const hi = Math.max(m.p75, m.value);
  const span = hi - lo || 1;
  const x = (v: number) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  return `<div class="bar">
      <div class="box" style="left:${x(m.p25).toFixed(1)}%;width:${(x(m.p75) - x(m.p25)).toFixed(1)}%"></div>
      <div class="med" style="left:${x(m.p50).toFixed(1)}%"></div>
      <div class="dot${m.aggressive ? " agr" : ""}" style="left:${x(m.value).toFixed(1)}%"></div>
    </div>`;
}

function filaMetrica(m: CohortMetricResult): string {
  if (m.value === null) {
    const motivo =
      m.noData === "issuance"
        ? "esta emisión no publica el dato"
        : `solo ${m.pairsWithData} pares con dato — hacen falta ${MIN_PAIRS}`;
    return `<tr class="nd">
      <th>${esc(m.spec.label)}</th>
      <td colspan="4"><span class="muted">Sin evaluar: ${esc(motivo)}</span></td>
    </tr>`;
  }
  const f = m.spec.fmt;
  return `<tr>
    <th>${esc(m.spec.label)}</th>
    <td class="val">${esc(f(m.value))}</td>
    <td class="coh">${esc(f(m.p25!))} · <b>${esc(f(m.p50!))}</b> · ${esc(f(m.p75!))}</td>
    <td class="viz">${barra(m)}</td>
    <td class="pos${m.extreme ? (m.aggressive ? " agr" : " ext") : ""}">${m.rank}ª<span class="muted"> de ${m.total}</span>${
      m.aggressive ? '<div class="tag">más agresivo</div>' : ""
    }</td>
  </tr>`;
}

function filaComposicion(c: Composition): string {
  const notable = Math.abs(c.difference) > 0.1;
  const w = (v: number) => Math.min(100, v * 100 * 2.2).toFixed(1);
  /**
   * Una diferencia menor a un préstamo se muestra como "—", no como "+0%".
   *
   * El porcentaje redondeado hacía parecer un error de cálculo lo que en
   * realidad era una diferencia por debajo de la resolución del pool: con 35
   * préstamos, 0,4 puntos son 0,14 préstamos.
   */
  const dif = c.belowResolution
    ? `<span class="muted">—</span>`
    : `${c.difference > 0 ? "+" : ""}${pct(c.difference)}`;
  /**
   * Y la columna de la derecha dice cuántos préstamos son LA DIFERENCIA, no
   * cuántos tiene la emisión. La versión anterior mostraba "-13% · 5 préstamos"
   * y esos 5 eran el multifamily de BANK5, no la brecha contra la cohort: dos
   * números distintos leídos como uno.
   */
  const detalle = c.belowResolution
    ? `menos de un préstamo de diferencia`
    : `${c.loansOfDifference} préstamo${c.loansOfDifference === 1 ? "" : "s"} de diferencia` +
      ` · esta emisión tiene ${c.loans}`;
  return `<tr${notable ? ' class="notable"' : ""}>
    <th>${esc(c.type)}</th>
    <td class="mini"><div class="mb"><i style="width:${w(c.own)}%"></i></div>${pct(c.own)}</td>
    <td class="mini"><div class="mb coh"><i style="width:${w(c.cohort)}%"></i></div>${pct(c.cohort)}</td>
    <td class="dif">${dif}</td>
    <td class="muted sm">${esc(detalle)}</td>
  </tr>`;
}

export function render(b: Benchmark): string {
  const o = b.target;
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
        <p>Hacen falta ${MIN_PAIRS} emisiones comparables en la cohort ${esc(o.vintage)} y hay
        ${b.pairs.length}. Con menos, decir que esta emisión "se aparta del mercado" sería
        una afirmación sobre ${b.pairs.length} documentos.</p>
        <p class="muted">La respuesta correcta acá es que no se sabe.</p>
      </section>`
    : `${
        b.targetSingleType
          ? `<section class="warn"><h2>Esta emisión es ${pct(o.dominantShare)} ${esc(o.dominantType ?? "")}</h2>
             <p>No es un conduit diversificado, así que la comparación contra la cohort va a
             mostrar diferencias garantizadas que no significan nada sobre cómo se suscribió.</p></section>`
          : ""
      }
      <section>
        <h2>Qué compró esta emisión</h2>
        <table class="c">
          <thead><tr>
            <th></th><th>esta emisión</th><th>cohort</th><th>dif.</th><th></th>
          </tr></thead>
          <tbody>${b.composition.map(filaComposicion).join("")}</tbody>
        </table>
        <p class="note">Cada préstamo vale <b>${pct(b.pointPerLoan, 1)}</b> de este pool
        (${o.typedPool} con tipo), así que una diferencia de 9 puntos son
        ${Math.max(1, Math.round(0.09 / b.pointPerLoan))} préstamos.
        Hay que mover el <b>${pct(b.distance)}</b> del pool para llegar a la mezcla de la
        cohort; sacando ${o.typedPool} préstamos al azar del universo de los pares se esperaría
        mover ${pct(b.nullDistance)}.</p>
      </section>

      <section>
        <h2>Términos</h2>
        <p class="lead">${
          b.metrics.filter((m) => m.value !== null).length === 0
            ? "Sin métricas evaluables."
            : `En línea con la cohort: ` +
              b.metrics
                .filter((m) => m.value !== null)
                .map((m) => `${esc(m.spec.label)} ${esc(m.spec.fmt(m.value!))}`)
                .join(" · ")
        }</p>
        <p class="note">Estos seis números rastrean lo mismo que la mezcla, más débilmente.
        Sobre las 28 emisiones de la cohort, cuántas métricas se apartan del rango
        intercuartil correlaciona con cuánto se aparta la composición (rho = 0,59, t = 3,7):
        una emisión con mucha hotelería tiene DSCR y debt yield distintos <i>porque</i> los
        hoteles se suscriben distinto. La causa es la mezcla; los términos son su
        consecuencia. Van abajo porque cada métrica por separado es una prueba débil de lo
        que la composición mide de una vez.</p>
        <details>
          <summary>Ver la posición de cada métrica</summary>
          <table class="m">
            <thead><tr>
              <th></th><th>esta emisión</th><th>cohort (p25 · mediana · p75)</th><th></th><th>posición</th>
            </tr></thead>
            <tbody>${b.metrics.map(filaMetrica).join("")}</tbody>
          </table>
          <p class="note">La posición es <b>ordinal, no percentil</b>: con ${b.pairs.length}
          pares un percentil tendría resolución de ~${b.percentileResolution.toFixed(0)} puntos.</p>
        </details>
      </section>`;

  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(o.name)} — benchmark de cohort</title>
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
  <h1>${esc(o.name)}</h1>
  <p class="sub">${esc(o.filed.slice(0, 10))} · ${o.pool} préstamos${
    o.typedPool < o.pool
      ? `<span class="muted"> (${o.typedPool} con tipo de propiedad — la mezcla se mide sobre esos)</span>`
      : ""
  } · cohort ${esc(o.vintage)}</p>
  ${
    b.evaluable
      ? !b.robust
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
          `<p class="verdict filo">Mezcla <b>al filo</b> — hay que mover el ${pct(b.distance)}
           del pool para igualar la cohort, contra ${pct(b.nullDistance)} esperado por azar
           con ${o.typedPool} préstamos. Que eso cuente como "distinta" depende de cómo se pondere
           la referencia: contando todos los préstamos de los pares da p = ${b.pValue.toFixed(3)},
           y dando el mismo peso a cada emisión da p = ${b.pValueByIssuance.toFixed(3)}.
           Con las dos a distinto lado del 5%, la respuesta honesta es que está en el borde.</p>`
        : `<p class="verdict ${b.pValue < 0.05 ? "sig" : ""}">${
            b.pValue < 0.05
              ? `Mezcla de propiedades <b>distinta de su cohort</b> — hay que mover el
                 ${pct(b.distance)} del pool para igualarla, contra ${pct(b.nullDistance)}
                 que se esperaría por azar con ${o.typedPool} préstamos (p = ${b.pValue.toFixed(4)},
                 y da lo mismo con las dos ponderaciones de la referencia).`
              : `Mezcla de propiedades <b>indistinguible de su cohort</b> — la distancia de
                 ${pct(b.distance)} está dentro de lo que produce el muestreo con ${o.typedPool}
                 préstamos (${pct(b.nullDistance)} esperado, p = ${b.pValue.toFixed(2)}).`
          }</p>`
      : ""
  }
  <p class="peers">${b.pairs.length} emisiones comparables${
    b.excluded.length > 0
      ? ` · ${b.excluded.length} excluida${b.excluded.length === 1 ? "" : "s"} por ser
         mono-tipo: ${esc(b.excluded.map((e) => e.name.slice(0, 34)).join(", "))}`
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

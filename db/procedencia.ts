/**
 * Contra qué corpus se emitió este veredicto, y si caducó.
 *
 * POR QUÉ EXISTE, Y LA HISTORIA CORREGIDA
 *
 * La primera versión de este comentario decía que el veredicto de `db:power` había
 * caducado: que el MDE superaba al efecto afirmado y se dio vuelta al crecer el
 * corpus. Eso es falso — el MDE era 6,6% cuando se escribió el documento y es 6,7%
 * hoy, y `docs/hallazgo-suscripcion.md` ya lo decía bien en una sección titulada
 * "Qué NO explica el fracaso".
 *
 * Lo que pasó de verdad es más simple y más incómodo: los resúmenes de trabajo que
 * se escribieron alrededor del documento afirmaban que las hipótesis murieron "por
 * falta de potencia", cuando el documento decía lo contrario. Y al auditarlo se
 * inventó una historia de caducidad para explicar la discrepancia, sin haber leído
 * la sección que la resolvía.
 *
 * Así que el módulo sigue valiendo, por una razón distinta de la que decía:
 *
 * Un número que depende de la muestra y se cita sin decir contra qué muestra se
 * midió no se puede verificar. Nadie podía chequear "MDE 6,7%" sin volver a
 * correrlo, y esa fricción es la que permitió que un resumen dijera una cosa y el
 * documento otra durante semanas. La estampa no evita el error de lectura, pero lo
 * hace comprobable en una línea.
 *
 * Y el registro de umbrales resuelve un problema real distinto: hay seis números
 * arbitrarios repartidos en cinco archivos, con tres tipos de justificación muy
 * distinta, y hasta ahora eso no estaba escrito en ningún lado.
 *
 * QUÉ HACE, Y QUÉ NO
 *
 * Dos cosas chicas:
 *
 *   1. Una estampa con el estado del corpus, para imprimir al pie de cualquier
 *      conclusión. Sin eso, citar "MDE 6,7%" en un documento no dice sobre qué
 *      muestra se midió.
 *
 *   2. Un registro de umbrales con el corpus contra el que se justificaron, y un
 *      aviso cuando el corpus creció lo suficiente para que valga releerlos.
 *
 * NO revalida nada. Un aviso de que un umbral puede haber caducado no dice que
 * esté mal; dice que la justificación se escribió contra otra muestra. Confundir
 * las dos cosas sería el mismo error de siempre en versión nueva.
 */

import { query } from "./client.js";

export interface EstadoCorpus {
  emisiones: number;
  prestamos: number;
  observations: number;
  conDesempeno: number;
  taxonomia: string;
  /**
   * Cuántas versiones de taxonomía conviven en el corpus.
   *
   * Más de una significa que parte quedó sin recosechar, y entonces una
   * conclusión sobre el corpus entero mezcla dos mapeos distintos. Hoy eso
   * importa concretamente: entre 2026.08.9 y 2026.08.13 cambiaron la ocupación,
   * las claves de EGI y gastos, property_type y el filtro de filas fantasma.
   */
  versiones: number;
}

export async function estadoCorpus(): Promise<EstadoCorpus> {
  const { rows } = await query<{
    emisiones: string; prestamos: string; observations: string;
    con_desempeno: string; taxonomia: string | null; versiones: string;
  }>(
    `SELECT (SELECT count(*) FROM corpus.filings)::text AS emisiones,
            (SELECT count(*) FROM corpus.loans)::text AS prestamos,
            (SELECT count(*) FROM corpus.facts)::text AS observations,
            (SELECT count(DISTINCT loan_id) FROM corpus.performance)::text AS con_desempeno,
            -- La versión del mapeo vive dentro de stats, no en su propia
            -- columna. Se toma el máximo y también se cuenta cuántas distintas
            -- hay: si hay más de una, parte del corpus quedó sin recosechar y
            -- cualquier conclusión mezcla dos mapeos.
            (SELECT max(stats->>'taxonomyVersion') FROM corpus.filings) AS taxonomia,
            (SELECT count(DISTINCT stats->>'taxonomyVersion') FROM corpus.filings)::text AS versiones`,
  );
  const r = rows[0]!;
  return {
    emisiones: Number(r.emisiones),
    prestamos: Number(r.prestamos),
    observations: Number(r.observations),
    conDesempeno: Number(r.con_desempeno),
    taxonomia: r.taxonomia ?? "?",
    versiones: Number(r.versiones),
  };
}

/** La línea que va al pie de cualquier conclusión que dependa de la muestra. */
export function estampa(e: EstadoCorpus): string {
  const n = (x: number) => x.toLocaleString("en-US");
  return (
    `Medido contra ${n(e.emisiones)} emisiones · ${n(e.prestamos)} préstamos · ` +
    `${n(e.conDesempeno)} con desempeño · taxonomía ${e.taxonomia}` +
    (e.versiones > 1
      ? ` — ATENCIÓN: ${e.versiones} versiones de taxonomía conviven, parte del corpus sin recosechar`
      : "")
  );
}

/**
 * Los umbrales del proyecto y el corpus contra el que se justificó cada uno.
 *
 * `prestamos` es el tamaño del corpus cuando se eligió el número. No es
 * decoración: si hoy el corpus es mucho mayor, la justificación se escribió sobre
 * otra muestra y conviene releerla.
 *
 * SOBRE POR QUÉ ALGUNOS DICEN "sin referencia empírica"
 *
 * Un umbral puede ser arbitrario sin ser incorrecto, pero conviene que la
 * distinción esté escrita. `EXCESO_MAXIMO` de db:cohort marca 4 de 7 añadas, y
 * cuando un criterio marca a la mayoría lo probable es que esté por debajo del
 * valor natural — se compara contra el piso de pools iguales y los pools reales
 * van de 15 a 70 préstamos.
 */
export const UMBRALES: Array<{
  script: string;
  nombre: string;
  valor: string;
  prestamos: number;
  nota: string;
}> = [
  {
    script: "db:power",
    nombre: "EFECTO_AFIRMADO",
    valor: "10,5%",
    prestamos: 8935,
    nota: "referencia externa: el efecto que declaraba el hallazgo. No caduca con el corpus, pero el MDE contra el que se compara sí — y ya se dio vuelta una vez.",
  },
  {
    script: "db:cohort",
    nombre: "EXCESO_MAXIMO",
    valor: "1,6x el piso",
    prestamos: 9694,
    nota: "SIN referencia empírica. Marca 4 de 7 añadas usables. Falta simular qué vale el cociente cuando los pools varían como los reales.",
  },
  {
    script: "db:cohort / cohortBenchmark",
    nombre: "MIN_PARES",
    valor: "15",
    prestamos: 8935,
    nota: "cuenta a priori: diez pares para hablar de deciles, quince para que el decil no dependa de un documento. No depende del corpus.",
  },
  {
    script: "cohortBenchmark",
    nombre: "CONCENTRACION_TIPO",
    valor: "0,8",
    prestamos: 9694,
    nota: "verificado inerte: los conduits llegan a 63% y las mono-tipo a 100%, sin nada en el medio. Cualquier valor entre 0,64 y 0,99 da lo mismo.",
  },
  {
    script: "cohortBenchmark",
    nombre: "MIN_PARA_METRICA",
    valor: "10 préstamos",
    prestamos: 9694,
    nota: "decidió qué emisiones aparecían 'sin dato' de ocupación cuando el problema era otro. Conviene recordar que este umbral tiene consecuencias visibles.",
  },
  {
    script: "annexStructure",
    nombre: "MAX_PHANTOM_SHARE",
    valor: "15%",
    prestamos: 9694,
    nota: "guarda de abstención del filtro estructural. Con pools de 25-70 préstamos y 1-2 filas fantasma, el margen es amplio.",
  },
];

/**
 * Avisa qué umbrales se justificaron contra un corpus notablemente más chico.
 *
 * El 25% no es un umbral estadístico: es cuándo vale la pena releer. Un corpus un
 * 5% mayor no cambia ninguna conclusión; uno un 40% mayor puede dar vuelta un MDE,
 * como ya pasó.
 */
export function avisosDeCaducidad(e: EstadoCorpus, crecimientoMinimo = 0.25): string[] {
  const avisos: string[] = [];
  for (const u of UMBRALES) {
    const crecio = (e.prestamos - u.prestamos) / Math.max(1, u.prestamos);
    if (crecio >= crecimientoMinimo) {
      avisos.push(
        `${u.script} · ${u.nombre} = ${u.valor} — justificado con ${u.prestamos.toLocaleString("en-US")} préstamos, ` +
          `hoy hay ${e.prestamos.toLocaleString("en-US")} (+${(crecio * 100).toFixed(0)}%)`,
      );
    }
  }
  return avisos;
}

/** Los que están marcados como sin referencia empírica, crezca o no el corpus. */
export function sinReferencia(): string[] {
  return UMBRALES.filter((u) => /SIN referencia/i.test(u.nota)).map(
    (u) => `${u.script} · ${u.nombre} = ${u.valor} — ${u.nota}`,
  );
}

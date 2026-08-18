/**
 * El servidor. Transporte y nada más.
 *
 *   npm run api          → http://localhost:8787
 *
 * POR QUÉ SIN FRAMEWORK
 *
 * Cuatro rutas y un envelope no justifican una dependencia. El proyecto ya tiene
 * la regla en otro lado —las páginas HTML no tienen dependencias y por eso se
 * abren con doble clic— y vale igual acá: `node:http` alcanza, y si algún día
 * hacen falta middlewares de verdad, migrar cuatro handlers es una tarde.
 *
 * QUÉ HACE Y QUÉ NO
 *
 * No decide nada. Toda la lógica vive en `api/comps.ts` y en los módulos de `db/`,
 * así que el servidor se puede tirar y reescribir sin tocar una regla de negocio.
 *
 * EL ENVELOPE, QUE CUESTA UNA LÍNEA
 *
 * `request_id` + `timestamp` + `data` en toda respuesta. Sale de la emulación
 * anterior (ver `docs/arquitectura-propia.md` §7) y resultó lo más útil de aquel
 * contrato: cuando alguien reporta "me dio mal", el request_id es lo único que
 * permite encontrar la corrida.
 *
 * LO QUE NO ESTÁ Y HAY QUE DECIR
 *
 * No hay auth. El corpus sale de documentos públicos de EDGAR, así que puede que
 * no haga falta nunca; pero mientras no se decida, esto NO se expone a internet.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { closePool, ping } from "../db/client.js";
import { estadoCorpus, estampa } from "../db/procedencia.js";
import { buscarComparables, MIN_COMPARABLES, TIPOS, type Tipo } from "./comps.js";

const PUERTO = Number(process.env.PORT ?? 8787);

const health = await ping();
if (!health.ok) {
  console.error(`\n✗ ${health.message.split("\n").join("\n  ")}\n`);
  await closePool();
  process.exit(1);
}

interface Fallo {
  codigo: string;
  mensaje: string;
  /** Qué mandar para que ande. Un error sin esto obliga a leer el código. */
  esperado?: string;
}

/**
 * La validación devuelve el error COMPLETO, no el primero.
 *
 * Un cliente que manda tres parámetros mal y recibe un error por vez hace tres
 * viajes para descubrir lo que se podía decir de una.
 */
function validarComps(q: URLSearchParams): { ok: true; v: Parametros } | { ok: false; fallos: Fallo[] } {
  const fallos: Fallo[] = [];

  const estado = (q.get("state") ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(estado)) {
    fallos.push({
      codigo: "estado_invalido",
      mensaje: `state="${q.get("state") ?? ""}" no es un código de dos letras`,
      esperado: "state=GA",
    });
  }

  const tipo = (q.get("type") ?? "").trim();
  if (!TIPOS.includes(tipo as Tipo)) {
    fallos.push({
      codigo: "tipo_invalido",
      mensaje: `type="${tipo}" no es un tipo del corpus`,
      esperado: TIPOS.join(" | "),
    });
  }

  const monto = Number(q.get("amount"));
  if (!Number.isFinite(monto) || monto <= 0) {
    fallos.push({
      codigo: "monto_invalido",
      mensaje: `amount="${q.get("amount") ?? ""}" no es un número positivo`,
      esperado: "amount=28000000 (en dólares)",
    });
  }

  const banda = q.has("band") ? Number(q.get("band")) : undefined;
  if (banda != null && (!Number.isFinite(banda) || banda <= 0 || banda > 3)) {
    fallos.push({ codigo: "banda_invalida", mensaje: "band fuera de (0, 3]", esperado: "band=0.5" });
  }

  const meses = q.has("months") ? Number(q.get("months")) : undefined;
  if (meses != null && (!Number.isInteger(meses) || meses < 1 || meses > 240)) {
    fallos.push({ codigo: "meses_invalidos", mensaje: "months fuera de [1, 240]", esperado: "months=18" });
  }

  /**
   * El LTV se acepta como fracción (0,70) y como porcentaje (70) porque un broker
   * escribe las dos, y adivinar mal cambia la respuesta sin avisar. Se normaliza
   * y se devuelve normalizado en `criterios` para que se vea qué se entendió.
   */
  let ltvObjetivo: number | undefined;
  if (q.has("target_ltv")) {
    const raw = Number(q.get("target_ltv"));
    if (!Number.isFinite(raw) || raw <= 0 || raw > 100) {
      fallos.push({ codigo: "ltv_invalido", mensaje: "target_ltv fuera de rango", esperado: "target_ltv=0.70 o 70" });
    } else {
      ltvObjetivo = raw > 2 ? raw / 100 : raw;
    }
  }

  if (fallos.length > 0) return { ok: false, fallos };
  return {
    ok: true,
    v: {
      estado, tipo: tipo as Tipo, monto, banda, meses, ltvObjetivo,
      /**
       * El alcance nacional se pide, no se cae en él. Ver el comentario de
       * `Alcance` en comps.ts: automatizarlo mató la negativa.
       */
      nacional: q.get("nacional") === "1" || q.get("nacional") === "true",
    },
  };
}

interface Parametros {
  estado: string; tipo: Tipo; monto: number;
  banda?: number; meses?: number; ltvObjetivo?: number; nacional?: boolean;
}

const server = createServer(async (req, res) => {
  const requestId = randomUUID();
  const url = new URL(req.url ?? "/", `http://localhost:${PUERTO}`);
  const responder = (status: number, data: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
    });
    res.end(JSON.stringify({ request_id: requestId, timestamp: new Date().toISOString(), data }, null, 2));
  };

  try {
    if (req.method !== "GET") return responder(405, { error: { codigo: "metodo_no_permitido" } });

    /**
     * La pantalla se sirve desde el mismo proceso.
     *
     * Un archivo suelto que hay que abrir con file:// no puede llamar a la API por
     * CORS, y montar un segundo servidor para un HTML es infraestructura sin
     * motivo. Se lee del disco en cada request: son 8 KB y así se puede editar sin
     * reiniciar.
     */
    /**
     * Dos pantallas, dos públicos.
     *
     * `/` es para alguien con un deal concreto. `/casos` corre los doce escenarios
     * de una y es para nosotros: sirve para ver de un vistazo qué puede y qué no
     * puede contestar el corpus. Mezclarlas obligaría a un broker a mirar once
     * filas que no le importan.
     */
    const PANTALLAS: Record<string, string> = {
      "/": "ui.html",
      "/index.html": "ui.html",
      "/casos": "casos.html",
    };
    const pantalla = PANTALLAS[url.pathname];
    if (pantalla) {
      const html = await readFile(new URL(`./${pantalla}`, import.meta.url), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-request-id": requestId });
      return res.end(html);
    }

    if (url.pathname === "/health") {
      return responder(200, { ok: true });
    }

    if (url.pathname === "/corpus") {
      const e = await estadoCorpus();
      return responder(200, { ...e, estampa: estampa(e), tipos: TIPOS });
    }

    if (url.pathname === "/comps") {
      const p = validarComps(url.searchParams);
      if (!p.ok) return responder(422, { error: { codigo: "parametros_invalidos", fallos: p.fallos } });
      const r = await buscarComparables(p.v);
      /**
       * "No hay suficientes comparables" es 200, no 404 ni 422.
       *
       * Es el estado del conocimiento, no una falla: el cliente tiene que poder
       * distinguirlo de un servidor caído o de una consulta mal armada, porque la
       * acción que sigue es distinta —ampliar el criterio, no reintentar—.
       */
      return responder(200, r);
    }

    return responder(404, {
      error: {
        codigo: "no_encontrado",
        rutas: ["/", "/casos", "/health", "/corpus", "/comps?state=GA&type=Multifamily&amount=28000000"],
      },
    });
  } catch (err) {
    console.error(`[${requestId}]`, err);
    return responder(500, { error: { codigo: "error_interno", request_id: requestId } });
  }
});

server.listen(PUERTO, () => {
  const e = `http://localhost:${PUERTO}`;
  console.log(`\n  API escuchando en \x1b[1m${e}\x1b[0m\n`);
  console.log(`  \x1b[90m${e}/casos  → los doce escenarios de una\x1b[0m\n`);
  console.log(`  \x1b[90mO por consola:\x1b[0m`);
  console.log(`    curl "${e}/corpus"`);
  console.log(`    curl "${e}/comps?state=GA&type=Multifamily&amount=28000000&target_ltv=0.70"`);
  console.log(
    `\n  \x1b[90mSin auth: no exponer a internet hasta decidirlo. Mínimo ${MIN_COMPARABLES} comparables` +
      ` para dar un rango.\x1b[0m\n`,
  );
});

for (const s of ["SIGINT", "SIGTERM"] as const) {
  process.on(s, () => {
    server.close(() => closePool().then(() => process.exit(0)));
  });
}

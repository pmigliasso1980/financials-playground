# Roadmap

> Esto no es la tabla de factibilidad. Aquella ordenaba por lo que cuesta menos;
> ésta ordena por lo que hay que **averiguar**. Hacer lo fácil primero porque es
> fácil es como se construyen productos que nadie pidió.
>
> Cada fase termina en una **pregunta contestada**, no en una lista de tareas
> tachadas. Si una fase no cambia lo que hacemos después, no debería estar acá.

## Hecho

| | |
|---|---|
| Corpus | 9.694 préstamos de 233 emisiones, con procedencia celda por celda |
| `/comps` | escalera geográfica estado → región → país, mínimo de 10, se niega antes que inventar |
| Pantalla | `localhost:8787`, casos de uso en el estado vacío, `/casos` para los doce juntos |
| MCP | el corpus como herramienta de un asistente |
| Monitor | vigilancia semanal automática, avisa solo si algo cambió |

Doce escenarios corridos contra el corpus real. Ocho respondidos, dos negativas
correctas, dos que la escalera geográfica debería arreglar.

---

## Fase 1 · ¿Le sirve a alguien? · días

**Casi nada de esto es código.**

- Correr `api:casos` después de la escalera y confirmar que los dos fracasos se
  resolvieron.
- **Mostrárselo a tres brokers.** No una demo: pedirles un deal real que tengan
  hoy sobre la mesa y buscarlo delante de ellos.
- Anotar qué preguntan que la herramienta no contesta. Eso —y no nuestra
  intuición— es lo que define la fase 2.

**La pregunta:** ¿alguien cambia una decisión por lo que ve acá?

**Si la respuesta es no**, el resto de este documento no importa y hay que volver
a la pregunta de qué construir. Es el resultado más valioso posible en esta fase
porque es el único que evita meses de trabajo equivocado.

---

## Fase 2 · Depende de lo que digan · semanas

Dos ramas excluyentes. **La elige el usuario, no nosotros.**

### Rama A — "esto me sirve pero mis deals no son conduit"

Ingesta de rent roll y T-12 reusando el harvester. Es el activo más defendible que
tenemos: un normalizador de documentos financieros tabulares con 214 tests, que
resultó ser lo valioso y no el corpus de CMBS. El corpus fue el campo de
entrenamiento.

También es el primer paso del flujo de Lev, y ahí ya tenemos construida la parte
difícil.

### Rama B — "esto me sirve pero necesito mandarlo a alguien"

Objeto deal, pipeline, compartir. Es CRUD y es donde vive el producto de Lev.
Técnicamente fácil, inútil sin usuarios — por eso está detrás de la fase 1 y no
antes.

---

## Fase 3 · Dejar de ser una feature · meses

El riesgo real de todo esto es que "comparables de conduit CMBS" sea una pestaña
adentro de Lev o de CompStak antes que una empresa.

Lo que lo evita no es agregar pantallas: es que el dato sea **la infraestructura
que otros consumen**. API, MCP, y eventualmente el corpus publicado. Por eso el
MCP se construyó en la fase cero y no acá — es barato y define qué somos.

---

## Lo que no está en el roadmap, y por qué

| | |
|---|---|
| **Matching con prestamistas** | 3.500 relaciones comerciales. No se programa. |
| **Score de riesgo** | Quince ataques, ninguno sobrevivió. Está documentado en `hallazgo-suscripcion.md`. Si aparece en un pitch, es mentira. |
| **Machine learning** | 206 eventos en todo el corpus y un efecto mínimo detectable de 1,74x. No hay con qué entrenar. |
| **Cosechar más CMBS** | El 96% de lo que falta son añadas sin eventos: cosecharlas empeora la potencia. Medido en `db:growth`. |
| **CRM** | Fase 2 rama B, y solo si un usuario lo pide. |

---

## La señal de alarma

**Si en algún momento todos los ítems del roadmap son código, algo está mal.**

El cuello de botella hoy no es técnico. Es que no hay usuarios, y ninguna cantidad
de endpoints lo resuelve. La fase 1 es casi enteramente conversaciones, y es la
única que puede invalidar todo lo demás.

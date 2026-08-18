# El contrato de la API

> Estado: propuesta. Ninguna ruta está implementada todavía. Este documento se
> escribe **antes** del código a propósito: la parte difícil de esta API no es
> HTTP, es que tiene que poder decir "no se sabe" sin parecer un error, y eso se
> decide en el contrato o no se decide nunca.

## Por qué este contrato y no uno genérico

Un lector de este repositorio puede razonablemente preguntar por qué una API sobre
un corpus de CMBS necesita decisiones de diseño propias. La respuesta es que
quince ataques contra los datos dejaron cuatro hechos que un contrato genérico
borraría, y borrarlos convierte al producto en algo que afirma de más:

1. **Con pools de 15 a 70 préstamos, la mayoría de las diferencias no son
   diferencias.** Un préstamo vale hasta 7,1% de la composición de una emisión, así
   que "+4%" es medio préstamo: ruido de redondeo con cara de dato.

2. **Un veredicto tiene tres estados, no dos.** Hay emisiones donde el resultado
   cambia según cómo se pondere la referencia. Forzarlas a "distinta" o "igual" es
   elegir por el usuario sin decírselo.

3. **"No se puede evaluar" es una respuesta, no una falla.** Una emisión con menos
   de 15 pares comparables no tiene benchmark. Eso no es un 404 ni un error del
   servidor: es el estado del conocimiento.

4. **La suscripción por originador NO es medible con este corpus.** Está
   documentado en `hallazgo-suscripcion.md`: quince ataques, ningún originador
   citable, y el techo calculado —hacen falta 50 eventos donde hay 27—. Cualquier
   endpoint que devuelva un "score de riesgo" estaría vendiendo lo que el propio
   proyecto demostró que no puede sostener.

Los cuatro se traducen en reglas concretas más abajo.

---

## Reglas transversales

### R1 · Toda medición viaja con su resolución

Nunca un número solo. Siempre el número y cuánto vale la unidad mínima que lo
compone.

```json
{ "valor": 0.28, "grano": 0.029, "unidad": "share", "base": 34 }
```

`grano` es `1 / base`: con 34 préstamos tipados, un préstamo son 2,9 puntos. Un
cliente que muestre "28%" al lado de "26%" sin mirar `grano` está dibujando una
diferencia de menos de un préstamo.

Esto no es decoración defensiva: el índice de esta misma sesión reordenó cuatro
emisiones al corregir un defecto de 0,3 puntos, y todos los saltos quedaron por
debajo del grano. Sin `grano` publicado, ese reordenamiento parece inestabilidad
del producto en vez de lo que es: ruido adentro de la resolución declarada.

### R2 · Todo estadístico viaja con su nulo

```json
{ "distancia": 0.31, "nulo": 0.17, "p": 0.0005 }
```

Nunca `distancia` sola. Una distancia de 0,31 es enorme en un pool de 70 y
esperable en uno de 15 — el nulo es lo que hace legible al observado. El proyecto
leyó cuatro veces un valor nulo como si fuera señal antes de imponerse esta regla.

### R3 · El ranking viaja como banda, no como posición

La respuesta trae `banda: "distinta" | "al filo" | "de mercado"` y el valor
numérico. **No trae "puesto 3 de 25".** Un cliente puede ordenar si quiere, pero la
API no regala una posición ordinal que con estos tamaños de pool no significa nada
entre vecinos.

### R4 · Procedencia obligatoria en toda respuesta

```json
"corpus": {
  "emisiones": 233, "prestamos": 9694, "conDesempeno": 2231,
  "taxonomia": "2026.08.13"
}
```

Un número que depende de la muestra y se cita sin decir contra qué muestra se midió
no se puede verificar. Además le da al cliente la clave de invalidación de caché:
si cambia `taxonomia`, los números cambiaron aunque el contrato no.

### R5 · Lo excluido se declara, no se omite

```json
"pool": { "total": 35, "conTipo": 34,
          "excluidos": [{ "motivo": "sin_tipo_de_propiedad", "n": 1 }] }
```

Si la API devuelve solo `34`, el cliente calcula porcentajes sobre una base que no
sabe que fue recortada. Hoy hay 362 préstamos sin tipo en el corpus —de los cuales
~70% son carteras multi-propiedad que genuinamente no tienen uno— y esa distinción
tiene que llegar al cliente.

---

## Recursos

### `GET /cohorts/{anada}`

El índice de una añada. Equivale a `db:catalog`.

```json
{
  "anada": "2026",
  "emisiones": 28,
  "comparables": 25,
  "agregado": { "distintas": 8, "esperadasPorAzar": 1.25, "alFilo": 1 },
  "grano": 0.071,
  "items": [ /* ver más abajo */ ],
  "apartadas": {
    "monoTipo": [ /* se apartan por definición: no entran al conteo */ ],
    "sinEvaluar": [ /* no alcanzan los pares */ ]
  },
  "corpus": { … }
}
```

`monoTipo` y `sinEvaluar` van en su propia clave y **no** en `items`. Mezclarlas
sería contar como hallazgo una tautología (una emisión 100% hotelería se aparta de
la cohorte por definición) y como "no se aparta" un "no se sabe".

### `GET /issuances/{id}`

Una emisión. Equivale a `db:page`.

```json
{
  "id": "0001234567-26-000123",
  "nombre": "BANK 2026-BNK52",
  "anada": "2026",
  "pool": { "total": 70, "conTipo": 70, "excluidos": [] },
  "evaluable": true,
  "veredicto": {
    "banda": "distinta",
    "distancia": 0.378, "nulo": 0.122,
    "p": 0.0005, "pPorEmision": 0.0007,
    "robusto": true
  },
  "composicion": [
    { "tipo": "Hospitality", "propio": 0.20, "cohorte": 0.09,
      "diferencia": 0.11, "prestamosDif": 8, "bajoResolucion": false }
  ],
  "terminos": [ /* DSCR, LTV, debt yield… */ ],
  "pares": 24,
  "corpus": { … }
}
```

**`evaluable: false` es un 200.** Con el motivo:

```json
{ "evaluable": false,
  "motivo": { "codigo": "pares_insuficientes", "pares": 9, "minimo": 15 },
  "veredicto": null }
```

Un 404 significa "esta emisión no está en el corpus". Un 422 significa "pediste
algo mal formado". Que no haya suficientes pares no es ninguna de las dos: es una
propiedad del mundo, y el cliente tiene que poder distinguirla de una caída.

### `GET /issuances/{id}/loans`

Las filas del Annex A normalizadas, con su provenance. Es el activo más sólido del
proyecto y el que menos depende de que alguna conclusión sobreviva.

### `GET /corpus`

El estado del corpus: qué añadas, cuántas emisiones, cobertura por métrica, versión
de taxonomía. Sin esto un cliente no puede saber si la ausencia de un dato es del
documento o del harvester.

---

## Lo que la API NO expone, y por qué

| No expone | Por qué |
|---|---|
| Score de riesgo por préstamo o emisión | Quince ataques y ningún originador citable. El corpus tiene un MDE de SIR 1,74 y los efectos reales están en 1,5. Publicar un score sería vender precisión inexistente. |
| Ranking de originadores | Mismo motivo. `db:seller` existe como herramienta de análisis, no como producto. |
| Predicción de default | El corpus mide "había transferido a la fecha del único 10-D cosechado", con ventanas de exposición que varían entre 1,2 y 4,3 años dentro de la misma añada. No es una variable de supervivencia bien definida. |
| Percentiles de las métricas | Con 24 pares un percentil tiene resolución de ~4 puntos. Se expone la posición ordinal y el rango intercuartil, que es lo que los datos aguantan. |

Esta tabla es parte del contrato, no una nota al pie. Es la diferencia entre una
herramienta que se puede creer y una que siempre contesta algo.

---

## Convenciones que se reusan del trabajo anterior

De `lev-referencia-tecnica.md` §5 y de la emulación que se borró, lo que resultó
útil al implementarlo y no solo elegante en el papel:

- **Sobre `request_id` / `timestamp` / `data`.** Cuesta una línea y hace
  depurable cualquier reporte de un usuario.
- **Errores con `codigo` legible además del status HTTP.** `pares_insuficientes`
  se puede ramificar en el cliente; un 422 pelado no.
- **Paginación por cursor.** Con offset, una recosecha entre dos páginas
  duplica o saltea filas.

---

## Lo que falta decidir antes de escribir código

| Decisión | Por qué bloquea |
|---|---|
| ¿Auth? | Si el corpus es público —son documentos de EDGAR— puede no hacer falta. Cambia todo el middleware. |
| ¿Se sirve el HTML desde acá o queda aparte? | Hoy `db:catalog` genera archivos sueltos que se abren con doble clic. Es una virtud, no una carencia. |
| ¿Snapshot o vivo? | Si la taxonomía cambia, los números cambian. Una API que sirve el estado actual no es reproducible; una que sirve snapshots versionados sí, y es más trabajo. |

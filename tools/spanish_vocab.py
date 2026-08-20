#!/usr/bin/env python3
"""
One definition of "this line looks Spanish", imported by every tool that asks.

WHY THIS MODULE EXISTS

The vocabulary and the matching rules lived in three files: find-spanish.py
(the gate), es-blocks.py (which picks the lines to translate) and
find-spanish-idents.py (identifiers). They drifted, twice, and each time the
splice tool was the weaker one — so it handed over fewer lines than the gate
demanded and the file came back "done" while still failing:

  - es-blocks.py kept the accent-only rule after find-spanish.py moved to
    function words, and benchmark.ts got half-translated comment blocks.
  - es-blocks.py answered "(no Spanish)" for db/delinquency.ts while the gate
    reported 74 lines, because it had not gained the content-stem rule.
  - es-blocks.py answered "(no Spanish)" for db/conformance.test.ts while the
    gate reported 5, because it had not gained the high-signal rule.

I fixed the first two by copying the new rule across. That is what produced
the third. Copying is the defect; the tools have to share the code, not agree
to keep the same code.

THE THREE RULES, AND WHY EACH EXISTS

  1. accents        á é í ó ú ñ ¿ ¡ — unambiguous, one is enough.
  2. two function   `de`, `la`, `que`... Common enough in code by accident that
     words          one means nothing; two distinct on a line means Spanish.
  3. one content    `saldo`, `morosidad`, `emision`... These do not turn up in
     stem           English by accident, so one is enough. Added when the gate
                    passed `console.log("Morosidad y special servicing")`.
  4. one high-      `de`, `en`, `los`, `del`, `dentro`. The glue that SURVIVES
     signal word    an identifier rename: renaming `eventos`->`events` removed
                    the stem that had been flagging the prose around it, and
                    the file went to zero while still printing Spanish.

Rule 4 has exactly two false positives in this repo, both masked below.
"""
import re

ACCENT = re.compile(r'[áéíóúüñÁÉÍÓÚÜÑ¿¡]')

FUNCTION_WORDS = """de la el los las del que para con por una uno un es son no
al su sus como pero si ya hay este esta esto estos estas cuando donde porque
entre sobre sin desde hasta cada todo toda todos todas otro otra otros otras
mismo misma ser esta estan hace tiene tienen puede pueden emision emisiones
prestamo prestamos saldo cosecha cosechar cosechado encabezado encabezados
consulta consultas veredicto mapeo archivo columna columnas fila filas dato
datos numero numeros nada algo solo tambien asi aunque mientras entonces ademas
cual cuales quien cuanto cuantos""".split()

# `lo` and `se` are deliberately absent: they are also lo/hi bounds and `se`
# (standard error) in English statistics code, and together they tripped the
# two-word threshold on analysis/power.ts with no Spanish in it. Removing them
# costs almost nothing on files that really are Spanish, because those lines
# carry other words too.

# The last block of stems was added after `${failed} fallidos` shipped in EIGHT
# files, including db/conformance.test.ts which I had already reported clean. A
# single Spanish word inside an otherwise-English template string reaches
# neither threshold: it is one content word, and none of these were in the list.
# They are always summary lines, status labels or units — the last words to get
# translated because they read as punctuation.
#
# My first attempt put this comment INSIDE the triple-quoted list, so every
# English word in it became a Spanish stem and the detector reported 636 suspect
# lines in columnMap.ts. Caught by checking files already verified clean before
# trusting the new list, which is the only reason it did not become the baseline.
#
# `version`, `fila`, `celda`, `linea`, `salida` and `entrada` were in that first
# attempt and are deliberately NOT here: `version` is English, and the others
# already appear in the list above.
CONTENT_STEMS = """
saldo saldos prestamo prestamos emision emisiones cosecha cosechas cosechado
anada anadas mediana medianas promedio vendedor vendedores comprador
subtipo subtipos tipo tipos estrato estratos recorte recortes recortado
veredicto veredictos hallazgo hallazgos mapeo mapeos encabezado encabezados
consulta consultas archivo archivos columna columnas fila filas dato datos
numero numeros nulo nulos vacio vacios todos todas cuantos cuantas
etiqueta etiquetas extraer permutar mezcla mezclar mezclado semilla
plazo plazos meses mes dias dia anio anios fecha fechas
reserva reservas evento eventos morosidad procedencia estampa
alcance peldano escalera muestra muestras suficiente encontrados
objetivo objetivos criterio criterios respuesta respuestas caso casos
inicio fin comienzo primero segundo tercero ultimo ultima
tamano tamanos ancho alto largo corto grande chico chicos
banda bandas ruido piso techo umbral
parcial parciales asignado asignados grupo grupos
razon razones motivo motivos causa causas
guardar leer escribir borrar buscar contar sumar restar
sinesta conteo conteos calculo calculos medicion mediciones
desempeno ocupacion suscripcion suscrito distribucion
ciudad ciudades incidencia transferencia transferencias cobertura
fallido fallidos fallar fallo fallos cosechado cosechados cosechar
descartado descartados descartada descartadas guardado guardados
encontrado encontrados encontrada encontradas revisado revisados
esperado esperados esperada esperadas obtenido obtenidos
listo listos correcto correctos incorrecto incorrectos
vacia vacias lleno llenos roto rotas rotos sano sanos
prueba pruebas corrida corridas mapeada mapeadas mapeado mapeados
mapear mapeo faltante faltantes ninguna ninguno
""".split()

HIGH_SIGNAL = """de del los las para con por una que en dentro sin cierran
incidencia transferencias primeros menos cobertura diferencia relevante peor
mejor aunque mientras cuando donde porque entre desde hasta cada entonces
segun ciudad sigue arriba abajo acerca cualquier ninguna ninguno tampoco
todavia siempre nunca antes despues luego ademas asimismo""".split()

# The two real false positives for rule 4, measured on files verified clean:
#   "en-US"  — toLocaleString locale tags, in every print helper
#   "DE"     — Delaware, in the census-division state lists in api/comps.ts
MASK = re.compile(r'"[a-z]{2}-[A-Z]{2}"|\b[A-Z]{2}\b')

_WORD = re.compile(r'\b(' + '|'.join(sorted(set(FUNCTION_WORDS))) + r')\b', re.I)
_STEM = re.compile(r'\b(' + '|'.join(sorted(set(CONTENT_STEMS))) + r')\b', re.I)
_HIGH = re.compile(r'\b(' + '|'.join(sorted(set(HIGH_SIGNAL))) + r')\b', re.I)


def why(line: str) -> str | None:
    """The reason this line looks Spanish, or None. Every tool asks this."""
    if ACCENT.search(line):
        return "accent"
    hits = {m.group(1).lower() for m in _WORD.finditer(line)}
    if len(hits) >= 2:
        return ",".join(sorted(hits)[:4])
    stems = {m.group(1).lower() for m in _STEM.finditer(line)}
    if stems:
        return ",".join(sorted(stems)[:4])
    high = {m.group(1).lower() for m in _HIGH.finditer(MASK.sub(" ", line))}
    if high:
        return ",".join(sorted(high)[:4])
    return None


def is_spanish(line: str) -> bool:
    return why(line) is not None

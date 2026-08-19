"""Prints the contiguous regions of a file that contain Spanish, with line numbers.

Used for the migration to English: reading a whole 900-line file to translate the
130 lines that need it is wasteful, and a replacement list built from grep output
loses the surrounding block. This groups adjacent Spanish lines into regions and
prints each one whole, so a comment block arrives intact.

  python3 tools/es-blocks.py db/identities.ts [gap]

`gap` is how many clean lines may sit inside a region before it is split (default
2), so a comment block with one English line in the middle stays in one piece.
"""
import re, sys, pathlib

# Same detection as find-spanish.py, and for the same reason: an accent-only
# regex stops a region short of any Spanish line that happens to have no accented
# character, so the block arrives truncated and half of it stays untranslated.
# That happened on db/benchmark.ts.
ACCENT = re.compile(r'[áéíóúüñÁÉÍÓÚÜÑ¿¡]')
_W = """de la el los las del que para con por una uno un es son no al su sus
como pero si ya hay este esta esto estos estas cuando donde porque entre sobre sin desde
hasta cada todo toda todos todas otro otra otros otras mismo misma ser esta estan hace
tiene tienen puede pueden emision emisiones prestamo prestamos saldo cosecha cosechar
cosechado encabezado encabezados consulta consultas veredicto mapeo archivo columna
columnas fila filas dato datos numero numeros nada algo solo tambien asi aunque
mientras entonces ademas cual cuales quien cuanto cuantos"""
WORD = re.compile(r'\b(' + '|'.join(_W.split()) + r')\b', re.I)

# The same content stems find-spanish.py reads, from the same single source.
#
# This tool decides WHICH LINES I hand over for translation. find-spanish.py
# decides whether the file is done. When the two disagree, the second one is
# right and the first one has already silently skipped a block — which is how
# benchmark.ts ended up with half-translated comments earlier in this
# migration, and how db/delinquency.ts came back "(no Spanish)" from here while
# the gate reported 74 lines.
#
# A splice tool with a weaker detector than the gate cannot finish a file. They
# read one list.
def _stems() -> set[str]:
    src = (pathlib.Path(__file__).parent / "find-spanish-idents.py").read_text()
    return set(src.split('STEMS = """')[1].split('""".split()')[0].split())

# NOT wrapped in try/except any more.
#
# It was, and that made this file degrade in silence: if find-spanish-idents.py
# could not be read, STEM became None, the content-stem rule switched itself
# off, and the tool went on reporting a confident total computed with a weaker
# rule than the one it documents. Running a copy of this file from /tmp gave
# 3,764 where the real answer is 4,557 — no warning, no error, just a smaller
# number. A checker allowed to quietly become a weaker checker is the same
# failure this whole gate exists to catch.
try:
    STEM = re.compile(r'\b(' + '|'.join(sorted(_stems())) + r')\b', re.I)
except Exception as e:
    raise SystemExit(
        f"tools/es-blocks.py: cannot load the shared vocabulary from find-spanish-idents.py"
        f" ({e}).\nRefusing to run with a weaker rule than advertised."
    )


class ES:
    @staticmethod
    def search(line):
        if ACCENT.search(line):
            return True
        if len({m.group(1).lower() for m in WORD.finditer(line)}) >= 2:
            return True
        return STEM is not None and STEM.search(line) is not None
path = pathlib.Path(sys.argv[1])
gap = int(sys.argv[2]) if len(sys.argv) > 2 else 2
lines = path.read_text().split("\n")

hits = [i for i, l in enumerate(lines) if ES.search(l)]
if not hits:
    print("(no Spanish)"); sys.exit(0)

regions = []
start = prev = hits[0]
for i in hits[1:]:
    if i - prev > gap + 1:
        regions.append((start, prev)); start = i
    prev = i
regions.append((start, prev))

for a, b in regions:
    print(f"@@ {a+1}-{b+1}")
    for i in range(a, b + 1):
        print(lines[i])
    print()

"""Finds Spanish text, by words and not only by accents.

WHY IT REPLACED THE GREP

The whole English migration was being checked with grep for [áéíóúñ¿¡]. That
detector is wrong in a way that reads as success: a line like

    console.log(`${pool.length} de ${evaluadas} emisiones no suman 100%`)

has no accented character in it, so the grep reported the file clean. Every "0
Spanish left" measured accents, not Spanish — the same class of error as the
monitor summing its own LIMIT and the fixture proxy measuring the wrong
subtraction.

HOW IT DECIDES

Accented characters still count on their own. Beyond that, a line needs at least
two distinct Spanish function words, because single tokens like "no", "un" or
"para" appear legitimately in English code and identifiers. Two together
essentially do not.

  python3 tools/find-spanish.py [paths...]     # default: the source tree
"""
import re, sys, pathlib

ACCENT = re.compile(r'[áéíóúüñÁÉÍÓÚÜÑ¿¡]')
WORDS = r"""de la el los las del que para con por una uno un es son se no al lo su sus
como pero si ya hay este esta esto estos estas cuando donde porque entre sobre sin desde
hasta cada todo toda todos todas otro otra otros otras mismo misma ser esta estan hace
tiene tienen puede pueden emision emisiones prestamo prestamos saldo cosecha cosechar
cosechado encabezado encabezados consulta consultas veredicto mapeo archivo columna
columnas fila filas dato datos numero numeros nada algo solo tambien asi aunque
mientras entonces ademas cual cuales quien cuanto cuantos"""
WORD_RE = re.compile(r'\b(' + '|'.join(WORDS.split()) + r')\b', re.I)

def scan(path: pathlib.Path):
    out = []
    for n, line in enumerate(path.read_text(errors="ignore").split("\n"), 1):
        if ACCENT.search(line):
            out.append((n, line, "accent")); continue
        hits = {m.group(1).lower() for m in WORD_RE.finditer(line)}
        if len(hits) >= 2:
            out.append((n, line, ",".join(sorted(hits)[:4])))
    return out

paths = [pathlib.Path(a) for a in sys.argv[1:]]
if not paths:
    root = pathlib.Path(".")
    pats = ["db/*.ts", "db/migrations/*.sql", "api/*.ts", "api/*.html", "mcp/*.ts",
            "analysis/*.ts", "harvest/*.ts", "harvest/*/*.ts", "docs/*.md", "*.md"]
    # tools/ is excluded from the default sweep: these two files contain the
    # Spanish vocabulary the detector matches on, so scanning them reports the
    # word list as a finding. Pass them explicitly if you want to check them.
    paths = sorted({p for g in pats for p in root.glob(g)})

total = 0
for p in paths:
    hits = scan(p)
    if hits:
        total += len(hits)
        print(f"{len(hits):5d}  {p}")
print(f"\n{total} suspect lines across {sum(1 for p in paths if scan(p))} files"
      f" (of {len(paths)} scanned)")

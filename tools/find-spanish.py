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
import re, subprocess, sys, pathlib

ACCENT = re.compile(r'[áéíóúüñÁÉÍÓÚÜÑ¿¡]')
WORDS = r"""de la el los las del que para con por una uno un es son no al su sus
como pero si ya hay este esta esto estos estas cuando donde porque entre sobre sin desde
hasta cada todo toda todos todas otro otra otros otras mismo misma ser esta estan hace
tiene tienen puede pueden emision emisiones prestamo prestamos saldo cosecha cosechar
cosechado encabezado encabezados consulta consultas veredicto mapeo archivo columna
columnas fila filas dato datos numero numeros nada algo solo tambien asi aunque
mientras entonces ademas cual cuales quien cuanto cuantos"""
# `lo` and `se` were removed from this list on purpose. They are common Spanish
# words, but they are also `lo`/`hi` bounds and `se` (standard error) in English
# statistics code, and together they were enough to trip the two-word threshold.
# analysis/power.ts reported 3 suspect lines with none of them Spanish. Removing
# them costs almost nothing on the files that really are Spanish (sellerEffect
# 311->309, columnMap 376->375, test.ts 173->171): those lines carry other words
# too, and any line with an accent is caught regardless.
WORD_RE = re.compile(r'\b(' + '|'.join(WORDS.split()) + r')\b', re.I)

# The content-word half of the vocabulary, borrowed from find-spanish-idents.py
# so there is ONE list to maintain rather than two that drift.
#
# WHY THIS WAS ADDED, THIRD BLIND SPOT OF THE DAY
#
# The two-function-word threshold cannot see a line whose Spanish is made of
# content words. db/delinquency.ts had `console.log("Morosidad y special
# servicing")` —a user-facing heading— plus a section header `DOS EVENTOS
# DISTINTOS` and a printed `(umbral ...)`, and this tool returned 0 for the
# file. None of morosidad, eventos, distintos or umbral is a function word, and
# `${cierra} de ${n} cierran dentro de ±...` has `de` twice but only ONE
# distinct function word, so it missed that too.
#
# A single content stem is enough to flag: unlike `de` or `la`, a word like
# `morosidad` or `saldo` does not appear in English by accident.
def _stems() -> set[str]:
    src = (pathlib.Path(__file__).parent / "find-spanish-idents.py").read_text()
    body = src.split('STEMS = """')[1].split('""".split()')[0]
    return set(body.split())

# NOT wrapped in try/except any more.
#
# It was, and that made this file degrade in silence: if find-spanish-idents.py
# could not be read, STEM_RE became None, the content-stem rule switched itself
# off, and the tool went on reporting a confident total computed with a weaker
# rule than the one it documents. Running a copy of this file from /tmp gave
# 3,764 where the real answer is 4,557 — no warning, no error, just a smaller
# number. A checker allowed to quietly become a weaker checker is the same
# failure this whole gate exists to catch.
try:
    STEM_RE = re.compile(r'\b(' + '|'.join(sorted(_stems())) + r')\b', re.I)
except Exception as e:
    raise SystemExit(
        f"tools/find-spanish.py: cannot load the shared vocabulary from find-spanish-idents.py"
        f" ({e}).\nRefusing to run with a weaker rule than advertised."
    )

# Words that do not stand alone in English source, so ONE is enough.
#
# WHY A THIRD RULE
#
# Sweeping identifiers in db/delinquency.ts took `eventos` to `events` and both
# detectors went to zero for the file — while it still printed "Incidencia a
# edad fija: transferencias en los primeros N meses" to the terminal. The
# rename had removed the very stem that was flagging the surrounding prose. So
# the sweep can make Spanish INVISIBLE to the gate, which is the worst possible
# direction for a tool whose job is to say when the job is done.
#
# What survived the rename is the glue: `de`, `en`, `los`, `del`, `dentro`.
# Those never reach two distinct words on a line, but they also never appear
# alone in English code — with two exceptions that are masked below.
HIGH_SIGNAL = """de del los las para con por una que en dentro sin cierran
incidencia transferencias primeros menos cobertura diferencia relevante peor
mejor aunque mientras cuando donde porque entre desde hasta cada entonces
segun entre entonces""".split()
HIGH_RE = re.compile(r'\b(' + '|'.join(sorted(set(HIGH_SIGNAL))) + r')\b', re.I)

# The two real false positives, measured on files already verified clean:
#   "en-US"  — Number.toLocaleString locale tags, all over the print helpers
#   "DE"     — Delaware, in the census-division state lists in api/comps.ts
# Masked rather than removed from the list, because `en` and `de` are exactly
# the words that survive an identifier rename and are worth catching.
MASK = re.compile(r'"[a-z]{2}-[A-Z]{2}"|\b[A-Z]{2}\b')


def scan(path: pathlib.Path):
    out = []
    for n, line in enumerate(path.read_text(errors="ignore").split("\n"), 1):
        if ACCENT.search(line):
            out.append((n, line, "accent")); continue
        hits = {m.group(1).lower() for m in WORD_RE.finditer(line)}
        if len(hits) >= 2:
            out.append((n, line, ",".join(sorted(hits)[:4]))); continue
        # One content stem is enough. `morosidad` and `saldo` do not turn up in
        # English prose the way `de` and `la` turn up in code.
        if STEM_RE is not None:
            stems = {m.group(1).lower() for m in STEM_RE.finditer(line)}
            if stems:
                out.append((n, line, ",".join(sorted(stems)[:4]))); continue
        high = {m.group(1).lower() for m in HIGH_RE.finditer(MASK.sub(" ", line))}
        if high:
            out.append((n, line, ",".join(sorted(high)[:4])))
    return out

# package-lock.json is generated and enormous; scanning it says nothing.
SKIP = {"package-lock.json"}

paths = [pathlib.Path(a) for a in sys.argv[1:]]
if not paths:
    # THE FILE LIST WAS THE WEAK POINT, TWICE.
    #
    # This used to be a list of glob patterns of what to include. Pablo found
    # package.json in Spanish, so json/yml/sh were added; then he found
    # .env.example, which is a dotfile and matched none of them. Both times the
    # detector was right about every file it read and wrong about which files
    # those were.
    #
    # An include list has to be right about everything that exists now and
    # everything added later. An exclude list only has to be right about the few
    # things that genuinely should not be scanned. So it now walks what git
    # tracks and skips a short, explicit list — and anything new is covered by
    # default rather than by remembering.
    tracked = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=True
    ).stdout.split("\n")

    def skip(f: str) -> bool:
        if not f:
            return True
        # Real SEC documents used as parsing fixtures. They are source data:
        # translating them would destroy the thing the tests verify against.
        if f.startswith("harvest/fixtures/"):
            return True
        # Generated and enormous.
        if f == "package-lock.json":
            return True
        # These carry the Spanish vocabulary the detectors match on, so scanning
        # them reports the word list itself as a finding. find-spanish-idents.py
        # was missing from this set and showed up as 4 suspect lines in its own
        # report — the detector flagging its own dictionary.
        if f in {"tools/find-spanish.py", "tools/find-spanish-idents.py",
                 "tools/es-blocks.py"}:
            return True
        # git ls-files still lists a file deleted in the working tree until the
        # deletion is committed.
        if not pathlib.Path(f).exists():
            return True
        return False

    paths = [pathlib.Path(f) for f in tracked if not skip(f)]

total = 0
for p in paths:
    hits = scan(p)
    if hits:
        total += len(hits)
        print(f"{len(hits):5d}  {p}")
print(f"\n{total} suspect lines across {sum(1 for p in paths if scan(p))} files"
      f" (of {len(paths)} scanned)")

# Exit nonzero when anything is found.
#
# This printed its report and exited 0 for the whole migration, so wiring it
# into a pre-push hook would have gated on nothing: `set -e` never fired and
# the push went through with 3,764 suspect lines on screen. A checker that
# reports without failing is a checker you have to remember to read, which is
# the same failure this project keeps re-committing in different clothes.
sys.exit(1 if total else 0)

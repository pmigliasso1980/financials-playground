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

# The vocabulary and the three matching rules live in tools/spanish_vocab.py.
#
# They used to live here, and be copied into es-blocks.py by hand. They drifted
# three times, and every time the SPLICE tool was the weaker one — so it handed
# over fewer lines than this gate demanded, and files came back "translated"
# while still failing. Copying was the defect; sharing the code is the fix.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from spanish_vocab import why  # noqa: E402


def scan(path: pathlib.Path):
    out = []
    for n, line in enumerate(path.read_text(errors="ignore").split("\n"), 1):
        r = why(line)
        if r:
            out.append((n, line, r))
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

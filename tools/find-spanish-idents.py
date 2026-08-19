#!/usr/bin/env python3
"""
The blind spot of find-spanish.py, as its own instrument.

find-spanish.py works on PROSE: it needs two Spanish function words on a line
before it flags anything. That threshold is what keeps it from screaming at
English code, and it is also why it returned 0 for analysis/mechanism.ts while
six SQL column aliases (anada, subtipo, evento, io_meses, plazo, reserva_rep)
were still Spanish. An identifier is one word on a line of English code. It
never reaches the threshold, so it is invisible to that tool by construction —
not by accident, and no amount of tuning the word list fixes it.

So this scans IDENTIFIERS instead. It splits camelCase and snake_case into
words and looks each word up in a list of Spanish stems that are not also
English words.

WHY THE LIST IS STEMS AND NOT WHOLE WORDS

`saldo`, `saldos`, `saldoTotal`, `loan_saldo` all have to be caught, and
enumerating inflections is how a list like this rots. Matching a stem as a
whole split-word catches the family.

WHAT IT WILL NOT CATCH, SAID OUT LOUD

Spanish words that are also English words, or that look like English
abbreviations: `no`, `total`, `real`, `base`, `local`, `error`, `final`, `id`.
Those are in neither list and this tool is silent about them. It narrows the
reading you still have to do; it does not replace it.

  python3 tools/find-spanish-idents.py [paths...]     # default: tracked files
"""
import re, subprocess, sys, pathlib
from collections import Counter

# Spanish stems that are not English words. Deliberately conservative: a stem
# that is also English (total, real, base, error, local, final, no, id, mas)
# is left out, because a checker that cries wolf gets muted.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from spanish_vocab import CONTENT_STEMS as STEMS  # noqa: E402
STEM_SET = set(STEMS)

# Split camelCase, PascalCase, snake_case, SCREAMING_CASE into lowercase words.
IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
SPLIT = re.compile(r'[_\s]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])')

def words_of(ident: str):
    return [w.lower() for w in SPLIT.split(ident) if w]

def skip(f: str) -> bool:
    if not f: return True
    if f.startswith("harvest/fixtures/"): return True     # real SEC docs
    if f == "package-lock.json": return True              # generated
    # The whole tools/ directory: these files carry the vocabulary they match
    # on and quote Spanish examples to document each rule. Naming them one at a
    # time is what let this very file slip through and flag itself. Verified
    # before widening: every accented character under tools/ is English prose
    # quoting an example.
    if f.startswith("tools/"): return True
    if not pathlib.Path(f).exists(): return True
    return False

CODE = {".ts", ".tsx", ".js", ".mjs", ".mts", ".sql", ".json", ".py", ".sh", ".html"}

def scan(f: str):
    hits = Counter()
    try:
        text = pathlib.Path(f).read_text(errors="ignore")
    except Exception:
        return hits
    for line_no, line in enumerate(text.split("\n"), 1):
        for m in IDENT.finditer(line):
            ident = m.group(0)
            for w in words_of(ident):
                if w in STEM_SET:
                    hits[(ident, w)] += 1
    return hits

args = [a for a in sys.argv[1:] if not a.startswith("-")]
if args:
    files = args
else:
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout
    files = [f for f in out.split("\n") if not skip(f)]
files = [f for f in files if pathlib.Path(f).suffix in CODE]

total = 0
for f in sorted(files):
    hits = scan(f)
    if not hits: continue
    total += sum(hits.values())
    shown = ", ".join(f"{i}" for (i, _), _ in hits.most_common(8))
    print(f"{sum(hits.values()):5}  {f}")
    print(f"       {shown}")

print(f"\n{total} Spanish-looking identifier uses across {len(files)} code files scanned")
sys.exit(1 if total else 0)

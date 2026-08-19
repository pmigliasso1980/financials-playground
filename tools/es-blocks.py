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
# Same module as the gate, on purpose. See tools/spanish_vocab.py: when this
# tool's rule was weaker than find-spanish.py's, it silently handed over fewer
# lines to translate and the file passed review while still printing Spanish.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from spanish_vocab import is_spanish  # noqa: E402


class ES:
    @staticmethod
    def search(line):
        return is_spanish(line)


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

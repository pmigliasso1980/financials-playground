"""Replaces line ranges in a file, applying from the bottom up.

USE ONE CALL PER FILE. Line numbers come from es-blocks.py reading the file as it
is now; the moment a splice runs, every range after it shifts. Splitting a file's
ranges across two invocations silently writes the second batch to the wrong lines
— which is what happened to db/delinquency.ts and cost a revert.

Companion to es-blocks.py for the migration to English. Reads a JSON object of
{"start-end": "replacement text"} from stdin and splices each range into the
file. Bottom-up so earlier replacements do not shift the line numbers of later
ones — which is the bug this exists to avoid, and the same off-by-one class that
already cost a silent misalignment in toProperties.

  python3 tools/splice.py db/identities.ts < ranges.json
"""
import json, sys, pathlib

path = pathlib.Path(sys.argv[1])
lines = path.read_text().split("\n")
ranges = json.load(sys.stdin)

parsed = []
for k, v in ranges.items():
    a, b = k.split("-")
    parsed.append((int(a), int(b), v))
parsed.sort(key=lambda r: r[0], reverse=True)

# Overlap check: two ranges touching the same line means one silently wins.
seen = set()
for a, b, _ in parsed:
    span = set(range(a, b + 1))
    if span & seen:
        print(f"! ranges overlap at {sorted(span & seen)[:5]} — refusing", file=sys.stderr)
        sys.exit(2)
    seen |= span

for a, b, v in parsed:
    lines[a - 1:b] = v.split("\n")

path.write_text("\n".join(lines))
print(f"spliced {len(parsed)} ranges into {path.name}")

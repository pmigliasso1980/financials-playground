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

# EDGE CHECK: does the range stop in the middle of a sentence?
#
# es-blocks.py reports the lines that LOOK Spanish, and the last line of a
# sentence often does not: a trailing fragment like " * sigue arriba?" has no
# word the detector carries, so the block ends one line early. Splicing that
# range leaves the fragment behind, attached to a now-English sentence, and
# BOTH detectors report the file clean — the tail is invisible to the same
# blind spot that truncated it.
#
# This has happened three times: db/identities.ts left four sentences ending
# mid-thought, analysis/stability.ts left an orphan line, and
# analysis/challenge.ts left " * sigue arriba?" hanging off a paragraph the
# gate then certified as translated.
#
# The signal is cheap: if the replacement's last line does not end a sentence,
# and the line AFTER the range continues one (a comment body, or lowercase
# text), the range probably stopped too soon. Warn, do not refuse — sometimes
# a comment genuinely wraps.
# A trailing comma means opposite things in the two contexts. On a code line it
# closes an argument and is fine; inside a comment it is exactly the sign the
# sentence keeps going. My first version listed "," as sentence-ending for both
# and therefore stayed silent on the case it was written for.
CODE_ENDS = (".", ";", ":", "{", "}", ")", ",", "?", "!", "`", "+", "*/")
COMMENT_ENDS = (".", "?", "!", ":", "*/")
warnings = []
for a, b, v in parsed:
    tail = v.rstrip().split("\n")[-1].rstrip()
    after = lines[b].strip() if b < len(lines) else ""
    is_comment = tail.lstrip().startswith(("*", "//", "#"))
    if tail.endswith(COMMENT_ENDS if is_comment else CODE_ENDS):
        continue
    if not after:
        continue
    body = after.lstrip("*/ ").strip()
    if body and (body[0].islower() or after.startswith("*")):
        warnings.append((a, b, after[:64]))

for a, b, v in parsed:
    lines[a - 1:b] = v.split("\n")

path.write_text("\n".join(lines))
print(f"spliced {len(parsed)} ranges into {path.name}")
for a, b, after in warnings:
    print(f"! range {a}-{b} may stop mid-sentence; next line reads: {after}",
          file=sys.stderr)
if warnings:
    print(f"! {len(warnings)} range(s) to re-read — the detectors cannot see a"
          f" trailing fragment", file=sys.stderr)

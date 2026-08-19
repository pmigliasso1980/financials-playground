#!/usr/bin/env python3
"""
Do the gate and the splice tool report the same lines for a file?

They are supposed to, now that both call spanish_vocab.why(). They were
supposed to before as well, three separate times, and each time they diverged
in the same direction: es-blocks.py weaker than find-spanish.py, so it offered
fewer lines to translate than the gate demanded and files passed review while
still printing Spanish to the terminal.

This runs BOTH TOOLS AS SUBPROCESSES and compares what they actually print.
Importing the shared function and comparing it to itself would prove nothing —
that was the first version of this file, and it was worthless.

  python3 tools/agree.py [paths...]
"""
import pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"


def gate_lines(f: str) -> set[int]:
    """find-spanish.py with -v prints `NNN: line`; fall back to counting."""
    r = subprocess.run([sys.executable, str(TOOLS / "find-spanish.py"), f],
                       capture_output=True, text=True, cwd=ROOT)
    m = re.search(r"^\s*(\d+)\s+" + re.escape(f), r.stdout, re.M)
    return int(m.group(1)) if m else 0


def block_lines(f: str) -> int:
    """es-blocks.py prints `@@ start-end` headers; sum the ranges."""
    r = subprocess.run([sys.executable, str(TOOLS / "es-blocks.py"), f, "0"],
                       capture_output=True, text=True, cwd=ROOT)
    total = 0
    for a, b in re.findall(r"^@@ (\d+)-(\d+)$", r.stdout, re.M):
        total += int(b) - int(a) + 1
    return total


args = sys.argv[1:]
if not args:
    tracked = subprocess.run(["git", "ls-files"], capture_output=True, text=True,
                             cwd=ROOT).stdout.split("\n")
    args = [f for f in tracked
            if f.endswith((".ts", ".py", ".sql", ".html", ".md"))
            and not f.startswith("harvest/fixtures/")
            and not f.startswith("tools/find-spanish")
            and f not in {"tools/es-blocks.py", "tools/spanish_vocab.py",
                          "tools/agree.py"}
            and (ROOT / f).exists()]

bad = []
for f in args:
    g, b = gate_lines(f), block_lines(f)
    if g != b:
        bad.append((f, g, b))
        print(f"  ✗ {f}: gate says {g} lines, es-blocks offers {b}")

print(f"\n{'✓' if not bad else '✗'} {len(args) - len(bad)} of {len(args)}"
      f" files: gate and splice tool agree")
if bad:
    print("  The splice tool cannot finish a file the gate will not pass.")
sys.exit(1 if bad else 0)

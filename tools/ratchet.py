#!/usr/bin/env python3
"""
Block regressions, not work in progress.

The pre-push hook went in while ~4,300 Spanish lines were still on the tree,
so it did what it was told and refused every push. That is the correct verdict
and a useless gate: a check that cannot go green until a multi-day migration
finishes is a check people disable on day one, and then it is not a gate at
all.

So the numbers are RATCHETED. tools/spanish-baseline.json records the current
counts. The hook fails only if a count goes UP. When it goes down —which is
what translating a file does— the baseline is rewritten and the new, lower
number becomes the ceiling. The migration proceeds, every push is allowed, and
the day someone reintroduces Spanish the push stops.

The failure mode this accepts, said out loud: it cannot tell "translated one
file" from "deleted one file". Both lower the count. It is a regression alarm,
not a proof of progress, and `git show` is what tells the difference.

  python3 tools/ratchet.py            # check, and lower the baseline if better
  python3 tools/ratchet.py --set      # accept current counts as the baseline
"""
import hashlib, json, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASELINE = ROOT / "tools" / "spanish-baseline.json"


def count(script: str) -> int:
    """The tools print their total on the last line; parse the leading integer."""
    r = subprocess.run([sys.executable, str(ROOT / "tools" / script)],
                       capture_output=True, text=True, cwd=ROOT)
    tail = [l for l in r.stdout.strip().split("\n") if l.strip()]
    if not tail:
        print(f"ratchet: {script} produced no output — refusing to guess")
        sys.exit(2)
    try:
        return int(tail[-1].split()[0])
    except (ValueError, IndexError):
        print(f"ratchet: could not read a total from {script}: {tail[-1]!r}")
        sys.exit(2)


def fingerprint() -> str:
    """
    A hash of the detectors themselves.

    Without this the ratchet compares numbers produced by two different rules
    and calls the difference a regression. It happened on the first real use:
    find-spanish.py gained a third rule, the tree count went 4,303 -> 4,557
    with not one word of Spanish added, and the hook reported "Spanish was
    reintroduced". The tree had not changed; the question had.

    So the baseline records which detectors produced it. When they change, the
    old ceiling is meaningless and the tool says so instead of accusing you.
    """
    h = hashlib.sha256()
    for f in ("find-spanish.py", "find-spanish-idents.py"):
        h.update((ROOT / "tools" / f).read_bytes())
    return h.hexdigest()[:16]


now = {"prose": count("find-spanish.py"),
       "idents": count("find-spanish-idents.py"),
       "detectors": fingerprint()}

if "--set" in sys.argv or not BASELINE.exists():
    BASELINE.write_text(json.dumps(now, indent=2) + "\n")
    print(f"ratchet: baseline set to prose={now['prose']} idents={now['idents']}")
    sys.exit(0)

was = json.loads(BASELINE.read_text())

if was.get("detectors") != now["detectors"]:
    print("ratchet: \033[33mthe detectors changed since this baseline was set.\033[0m")
    print(f"  baseline: prose={was.get('prose')} idents={was.get('idents')}")
    print(f"  now:      prose={now['prose']} idents={now['idents']}")
    print("\nThese numbers answer different questions and are not comparable.")
    print("Read the diff to tools/, confirm the change was intended, then:")
    print("  python3 tools/ratchet.py --set")
    sys.exit(1)

worse = {k: (was.get(k, 0), v) for k, v in now.items()
         if k != "detectors" and v > was.get(k, 0)}

if worse:
    for k, (old, new) in worse.items():
        print(f"ratchet: \033[31m{k} went UP: {old} -> {new}\033[0m")
    print("\nSpanish was reintroduced. Run the detector to see where:")
    print("  npm run check:spanish")
    print("If this is deliberate, accept it with: python3 tools/ratchet.py --set")
    sys.exit(1)

better = {k: (was.get(k, 0), v) for k, v in now.items()
          if k != "detectors" and v < was.get(k, 0)}
if better:
    for k, (old, new) in better.items():
        print(f"ratchet: \033[32m{k} {old} -> {new}\033[0m")
    BASELINE.write_text(json.dumps(now, indent=2) + "\n")
    print("ratchet: baseline lowered — commit tools/spanish-baseline.json")
else:
    print(f"ratchet: no change (prose={now['prose']} idents={now['idents']})")
sys.exit(0)

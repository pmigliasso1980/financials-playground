#!/usr/bin/env python3
"""
Substitute real numbers into a commit message. Reads stdin, writes stdout.

WHY THIS EXISTS

Four commit messages in this migration quoted Spanish counts I typed before
running the tool that produces them. Every one was wrong. I amended two,
promised in the second amendment that "numbers go in the message after the tool
prints them, not before" — and then did it again in the next commit but one.

Remembering is not working, so the numbers get substituted from
tools/spanish-baseline.json instead of typed:

    Ratchet: prose {PROSE}, idents {IDENTS}.

Any {PROSE}/{IDENTS}/{DETECTORS} placeholder is replaced. If a message contains
no placeholder it passes through untouched — this does not stop me typing a
number by hand, it just makes the honest path the easy one.

    python3 tools/ratchet.py
    python3 tools/commit-msg.py < msg.txt | git commit -F -
"""
import json, pathlib, sys

BASE = pathlib.Path(__file__).resolve().parent / "spanish-baseline.json"
b = json.loads(BASE.read_text())
msg = sys.stdin.read()
for key, val in (("{PROSE}", b["prose"]), ("{IDENTS}", b["idents"]),
                 ("{DETECTORS}", b.get("detectors", "?"))):
    msg = msg.replace(key, f"{val:,}" if isinstance(val, int) else str(val))
sys.stdout.write(msg)

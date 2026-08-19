"""Checks that the HTML pages read fields the API actually returns.

WHY IT EXISTS

api/ui.html and api/scenarios.html read the /comps response by field name, in
plain browser JavaScript. Nothing typechecks that: renaming a field in
api/comps.ts and forgetting it in the HTML produces a page that renders
"undefined" with no error anywhere.

That already happened during the migration to English. `estampa` became
`provenanceStamp` in the db pass, the HTML kept reading `estampa`, and the footer
silently printed nothing for several commits before anyone looked.

WHAT IT DOES

Collects the field names declared in comps.ts's response types and the ones the
HTML reads off `d.` / `r.data.`, and reports any the HTML expects that the API
does not produce.

THE FIRST VERSION COULD NOT FAIL

It matched only `d.field` and `r.data.field`, one level deep. The bug it was built
for —`r.data.corpus.estampa`— is two levels deep, so the checker captured "corpus"
and never looked at "estampa". Reintroducing the exact bug produced a green result.

A verification tool that passes on the defect it was written to catch is the
defect. It now walks the whole dotted chain and checks every segment.

WHAT IT DOES NOT DO

It does not run the page. A field can exist and still be wrong. This only catches
the class of error above — a name on one side and not the other.

  python3 tools/check-html-contract.py
"""
import re, sys, pathlib

comps = pathlib.Path("api/comps.ts").read_text()

# Every `name:` in comps.ts and server.ts — type members, inline object types and
# object literals alike. Deliberately generous: the question is only whether a name
# exists on the API side at all, so a false "exists" is safer than a false alarm.
# Line-anchored patterns missed `channel`, which is declared inline in
# `{ provenanceStamp: string; channel: string }`.
declared = set(re.findall(r'([a-zA-Z][a-zA-Z0-9_]*)\s*\??:', comps))
declared |= set(re.findall(r'([a-zA-Z][a-zA-Z0-9_]*)\s*\??:', pathlib.Path("api/server.ts").read_text()))
declared |= {"data", "error", "request_id", "timestamp", "status"}

# Array/string/object members that appear mid-chain and are not API fields.
BUILTIN = {
    "map", "join", "filter", "find", "slice", "length", "toFixed", "reduce",
    "some", "every", "split", "replace", "trim", "toLocaleString", "then",
    "forEach", "includes", "concat", "sort", "push", "keys", "values", "entries",
    "toUpperCase", "toLowerCase", "startsWith", "endsWith", "padStart", "padEnd",
}

CHAIN = re.compile(r'\b(?:d|r\.data)((?:\.[a-zA-Z_][a-zA-Z0-9_]*)+)')

bad = 0
for page in ["api/ui.html", "api/scenarios.html"]:
    html = pathlib.Path(page).read_text()
    used = set()
    for chain in CHAIN.findall(html):
        for seg in chain.lstrip(".").split("."):
            if seg not in BUILTIN:
                used.add(seg)
    missing = sorted(u for u in used if u not in declared)
    if missing:
        print(f"  ✗ {page} reads fields the API does not declare: {', '.join(missing)}")
        bad += 1
    else:
        print(f"  ✓ {page}: {len(used)} fields, all declared by the API")

sys.exit(1 if bad else 0)

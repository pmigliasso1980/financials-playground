#!/usr/bin/env python3
"""
Do the TS row types match the SQL column aliases?

`query<{ suma: string }>("... AS value_sum")` compiles clean and returns
undefined at runtime. tsc cannot catch it: the type parameter is an assertion
about the database, not about anything TypeScript can see. check-sql.py cannot
catch it either — it parses SQL, and on this repo 8 of the 10 queries in
db/identities.ts are NOT VERIFIED because they interpolate fragments.

That gap matters right now because the English migration is RENAMING ALIASES.
`AS anada` -> `AS vintage` with the type left at `anada` is a silent break, and
it is the same shape as the api/ui.html footer bug: renamed on one side of a
boundary the compiler does not police.

WHAT IT CHECKS

For each `query<{ ...fields... }>(`sql`)`, every field of the type must appear
as an alias or a bare selected column in that SQL, and vice versa.

WHAT IT CANNOT CHECK, SAID PLAINLY

Queries built from interpolated fragments, where the column list is not
literally present. Those are reported as NOT VERIFIED rather than passed.

  python3 tools/check-query-types.py [paths...]
"""
import pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# query<{ a: string; b: number | null }>(  `...sql...`
CALL = re.compile(r'query<\{(?P<type>[^}]*)\}>\(\s*(?P<sql>`(?:[^`\\]|\\.)*`)', re.S)
FIELD = re.compile(r'(\w+)\s*:')
ALIAS = re.compile(r'\bAS\s+"?(\w+)"?', re.I)
# Qualified columns: `p.loan_id`
BARE = re.compile(r'\b(\w+)\.(\w+)\b')
# Unqualified select-list columns: `SELECT header FROM ...`. Without this the
# checker flagged db/monitor.ts, which is correct code — a false positive that
# would have got the whole tool ignored.
PLAIN = re.compile(r'\bSELECT\s+(.*?)\s+FROM\b', re.I | re.S)


def check(path: pathlib.Path) -> int:
    src = path.read_text(errors="ignore")
    bad = unver = ok = 0
    for m in CALL.finditer(src):
        fields = set(FIELD.findall(m.group("type")))
        sql = m.group("sql")
        if "${" in sql:
            unver += 1
            continue
        # Aliases and qualified columns ONLY.
        #
        # The first version added every word in the SQL to this set, which made
        # the check incapable of finding anything missing: planting the real
        # `suma`/`value_sum` mismatch produced a green tick. It is the same
        # mistake as the HTML contract checker that matched one level of a
        # dotted chain — a checker written to pass.
        aliases = {a.lower() for a in ALIAS.findall(sql)}
        aliases |= {b.lower() for _, b in BARE.findall(sql)}
        for sel in PLAIN.findall(sql):
            aliases |= {w.lower() for w in re.findall(r'\b(\w+)\b', sel)}
        missing = {f for f in fields if f.lower() not in aliases}
        if missing:
            line = src[:m.start()].count("\n") + 1
            print(f"  ✗ {path.name}:{line}: type declares {sorted(missing)}"
                  f" — not selected by the query")
            bad += 1
        else:
            ok += 1
    if unver:
        print(f"  ? {path.name}: {unver} queries NOT VERIFIED (interpolated)")
    if ok and not bad:
        print(f"  ✓ {path.name}: {ok} queries, every type field is selected")
    return bad


args = sys.argv[1:]
if not args:
    tracked = subprocess.run(["git", "ls-files"], capture_output=True, text=True,
                             cwd=ROOT).stdout.split("\n")
    args = [f for f in tracked if f.endswith(".ts") and (ROOT / f).exists()
            and "query<" in (ROOT / f).read_text(errors="ignore")]
    if not args:
        print("check-query-types: found no query<...> calls — refusing to pass")
        sys.exit(1)

sys.exit(1 if sum(check(ROOT / a) for a in args) else 0)

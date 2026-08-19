"""Checks the SQL inside the TypeScript scripts with the real Postgres parser.

WHY IT LIVES IN THE REPO NOW

It was a throwaway in /tmp. The sandbox restarted, /tmp was wiped, and a run
with `2>/dev/null` printed nothing — which I read as "no findings" when it
actually meant "the checker does not exist". A verification tool that cannot
distinguish "clean" from "absent" is the same defect it exists to catch.

WHAT IT SEES: syntax errors, and SELECTs with no FROM that reference columns.
WHAT IT DOES NOT: whether a column exists, whether an ORDER BY points where you
think, whether a JOIN duplicates rows. Only a real database catches those.

It also refuses to run on files whose `${...}` interpolations carry SQL
fragments rather than values — substituting a literal there produces false
syntax errors, which is why this is not a repo-wide lint.

  python3 tools/check-sql.py db/monitor.ts [...]
"""
import re, sys, pathlib
from pglast import parse_sql
from pglast.visitors import Skip, Visitor
import pglast.ast as A


def literals(src: str) -> list[str]:
    """Each `query<...>(\\`SQL\\`)`, skipping the generic by depth counting.

    Written three times. The first two were regexes — one broke on the first `>`
    of a nested generic, the other on the `;` inside an inline type — and both
    reported "no problems" over the subset they had managed to see.
    """
    out, i = [], 0
    while (i := src.find("query", i)) != -1:
        j = i + 5
        if i > 0 and (src[i - 1].isalnum() or src[i - 1] in "_$"):
            i = j
            continue
        if j < len(src) and src[j] == "<":
            d = 0
            while j < len(src):
                if src[j] == "<":
                    d += 1
                elif src[j] == ">":
                    d -= 1
                    if d == 0:
                        j += 1
                        break
                j += 1
        while j < len(src) and src[j] in " \n\t":
            j += 1
        if j >= len(src) or src[j] != "(":
            i = i + 5
            continue
        j += 1
        while j < len(src) and src[j] in " \n\t":
            j += 1
        # Backticks only. Accepting quoted strings too made the extractor pick
        # up non-query literals and over-count, which is worse than missing the
        # one double-quoted query in client.ts: an over-count makes the file
        # unverifiable, and a wrong count is exactly what this guard is for.
        if j < len(src) and src[j] == "`":
            k = src.find("`", j + 1)
            if k != -1:
                out.append(src[j + 1:k])
        i = j
    return out


def check(path: pathlib.Path) -> int:
    src = path.read_text()
    sqls = literals(src)
    expected = len(re.findall(r"\bawait query\b", src))
    if len(sqls) != expected:
        print(f"  ? {path.name}: NOT VERIFIED — extractor saw {len(sqls)} of {expected} queries")
        return 0
    if not sqls:
        print(f"  · {path.name}: no queries")
        return 0

    const = {m.group(1): m.group(2) for m in re.finditer(r"^const (\w+) = `([^`]*)`;", src, re.M)}
    bad = 0
    for n, sql in enumerate(sqls, 1):
        s = sql
        for k, v in const.items():
            s = s.replace("${" + k + "}", v)
        s = re.sub(r"\$\{[^}]*\}", "'x'", s)
        s = re.sub(r"\$(\d+)", r"'p\1'", s)
        try:
            tree = parse_sql(s)
        except Exception as e:
            # A file whose ${...} interpolations carry SQL fragments rather than
            # values cannot be checked this way: substituting a literal produces
            # a syntax error that says nothing about the real query. Reported as
            # unverified, not as a finding.
            if "'x'" in str(e):
                print(f"  ? {path.name}: NOT VERIFIED — interpolates SQL fragments, not values")
                return 0
            print(f"  ✗ {path.name} query {n}: {e}")
            bad += 1
            continue

        found: list[str] = []

        class V(Visitor):
            def visit_SelectStmt(self, anc, node):
                if node.fromClause:
                    return
                refs: list[str] = []

                class W(Visitor):
                    def visit_ColumnRef(self, a, x):
                        refs.append(".".join(f.sval for f in x.fields if isinstance(f, A.String)))

                    def visit_SelectStmt(self, a, x):
                        """Do not descend into subqueries.

                        `SELECT (SELECT count(*) FROM t) AS n` has no FROM of its
                        own and that is perfectly valid: the columns belong to the
                        inner query, which does have one. Without this the rule
                        flags db/provenance.ts, which is correct code.
                        """
                        return Skip

                # pglast's visitor takes a node, not a tuple, and A.List does not
                # exist in every version. Walking each element is version-proof.
                for part in (node.targetList, node.whereClause, node.groupClause, node.havingClause):
                    if part is None:
                        continue
                    for item in (part if isinstance(part, tuple) else (part,)):
                        W()(item)
                if refs:
                    found.append(f"SELECT with no FROM using {sorted(set(refs))}")

        for stmt in tree:
            V()(stmt.stmt if hasattr(stmt, "stmt") else stmt)
        if found:
            for f in found:
                print(f"  ✗ {path.name} query {n}: {f}")
            bad += 1
    if bad == 0:
        print(f"  ✓ {path.name}: {len(sqls)} queries, syntax ok, no SELECT without FROM")
    return bad


sys.exit(sum(check(pathlib.Path(a)) for a in sys.argv[1:]))

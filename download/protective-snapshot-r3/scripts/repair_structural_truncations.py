#!/usr/bin/env python3
"""
Corpus repair for GLM-OCR markdown structural truncations.

Two loss classes (both make the canonical parser swallow question content):

  1. UNCLOSED <table>: a line containing '<table' with no '</table>' anywhere
     before the next structural line (heading / div / new table). The parser's
     table scan consumes everything up to the first '</table>' — often a
     different table dozens of lines later (e.g. the truncated periodic-table
     page swallows questions 1..9).

  2. UNBALANCED $$ display-math fences: the OCR opens '$$' for an equation and
     the closer is lost. The parser greedily pairs that '$$' with the next
     block's opener, swallowing the span between as one bogus equation
     (e.g. 2016-Jun-R: questions 3-5 and 7-10 vanish).

Repair (deterministic, idempotent): when a pathological open is detected,
insert the missing closer ('</table>' or '$$') immediately before the first
structural line inside the swallowed span, then RE-SIMULATE from scratch
(fence pairing cascades). Repeat until no pathology remains (max 12 passes).

Structural lines (can never be table-cell / equation content in this corpus):
  - '#'-headings, lines starting '<div', '<img'/'<div style', '<table'
  - part labels '(a) ' / roman '(i) ', question stems 'N <Capital>',
    '(Total for Question'.
  NOTE: bare MCQ option lines ('A solid') are NOT structural — chemistry
  content legitimately starts with element symbols ('C = 60.00 %') and MS
  notes ('A is not correct because...'); option lines are always accompanied
  by part labels/question stems/headings anyway.
"""
import re
import sys
from pathlib import Path

REPO = Path("/home/z/my-project/repos/Past-Papers")
APPLY = "--apply" in sys.argv

TABLE_CLOSE = "</table>"
MATH_FENCE = "$$"

PART = re.compile(r"^\([a-h]\)\s")
ROMAN = re.compile(r"^\([ivx]+\)\s")
QSTEM = re.compile(r"^\d{1,2}\s+[A-Za-z]{3,}")
TOTAL = re.compile(r"^\(?\s*Total for (Question|question|paper)", re.I)
CELL_HTML = re.compile(r"<t[dhr]\b|</t[dhr]>")
EQ_OPS = re.compile(r"[+=]|\\rightarrow|\\quad|\\mathrm|\\%")

def decisive(line: str) -> bool:
    """Decisive structural markers — certain content loss inside a swallowed span:
    headings, figure wrappers, center blocks, new tables."""
    s = line.strip()
    if not s:
        return False
    return (s.startswith("#") or s.startswith("<div")
            or s.startswith("<table") or "<img" in s)

def structural(line: str) -> bool:
    """Structural markers usable inside MATH spans (equations never look like
    part labels / question stems / totals; EQ_OPS guards the reverse)."""
    s = line.strip()
    if not s:
        return False
    if CELL_HTML.search(s):   # table-cell content is never structural
        return False
    if decisive(s):
        return True
    if EQ_OPS.search(s):      # equations/operators -> not a stem/part line
        return False
    return bool(PART.match(s) or ROMAN.match(s) or QSTEM.match(s)
                or TOTAL.match(s))

def simulate(lines):
    """Greedy parse simulation. Returns list of (kind, open_idx, fix_before_idx, reason)."""
    pathologies = []
    i, n = 0, len(lines)
    while i < n:
        s = lines[i].strip()
        if "<table" in s and "</table>" not in s:
            j = i + 1
            closed = False
            hit = None
            while j < n:
                if "</table>" in lines[j]:
                    closed = True
                    break
                if decisive(lines[j]):
                    hit = j
                    break
                j += 1
            if not closed:
                if hit is not None:
                    pathologies.append(("table", i, hit, lines[hit][:45]))
                else:
                    pathologies.append(("table", i, n, "<EOF>"))
            i = (hit + 1) if hit is not None else j
            continue
        if s == MATH_FENCE:
            j = i + 1
            closed = False
            hit = None
            while j < n:
                if lines[j].strip() == MATH_FENCE:
                    closed = True
                    break
                if structural(lines[j]):
                    hit = j
                    break
                j += 1
            if not closed:
                if hit is not None:
                    pathologies.append(("math", i, hit, lines[hit][:45]))
                else:
                    pathologies.append(("math", i, n, "<EOF>"))
            i = (hit + 1) if hit is not None else (j + 1 if j < n else n)
            continue
        i += 1
    return pathologies

def repair_lines(lines):
    """repair a mutable list; returns number of insertions"""
    fixes = 0
    for _ in range(12):
        path = simulate(lines)
        if not path:
            break
        kind, _, fix_before, _why = path[0]
        lines.insert(fix_before, TABLE_CLOSE if kind == "table" else MATH_FENCE)
        fixes += 1
    return fixes

def repair_file(md: Path):
    lines = md.read_text(encoding="utf-8").split("\n")
    fixes = repair_lines(lines)
    if APPLY and fixes:
        md.write_text("\n".join(lines), encoding="utf-8")
    return fixes

grand = 0
for paper in ("paper 1", "paper 2"):
    for md in sorted(REPO.glob(f"{paper}/*/[QM]*.md")):
        pre = simulate(md.read_text(encoding="utf-8").split("\n"))
        if not pre:
            continue
        print(f"\n{paper}/{md.parent.name}/{md.name}: {len(pre)} pathology span(s) initially:")
        for kind, o, f, why in pre[:8]:
            print(f"    [{kind}] open@{o+1} -> fix before {f+1} ({why})")
        fixes = repair_file(md)
        grand += fixes
        if APPLY and fixes:
            post = simulate(md.read_text(encoding="utf-8").split("\n"))
            print(f"    -> APPLIED fixes={fixes}, residual pathologies={len(post)}")
            if post:
                print("    !! STILL PATHOLOGICAL AFTER REPAIR:", post[:3])
        else:
            print(f"    -> DRY fixes={fixes}")

print(f"\n{'[APPLIED]' if APPLY else '[DRY-RUN]'} total insertions: {grand}")

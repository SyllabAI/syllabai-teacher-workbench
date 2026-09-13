#!/usr/bin/env python3
"""
Detect + repair UNCLOSED <table> blocks in GLM-OCR markdown (parser-faithful).

The parser (canonical.py) opens a table on a line containing '<table' and
consumes lines until one contains '</table>'. If the OCR emitted a truncated
table (e.g. the periodic-table page), the scan swallows structural content
(headings, figures, divs, subsequent tables) — questions vanish from the
canonical doc and extraction counts collapse.

Pathology (faithful to parser): after a '<table' line with no '</table>' on it,
if a line appears that (a) starts with '#' (heading), (b) starts with '<div'
(figure wrapper / center block), or (c) contains '<table' (new table) BEFORE
any '</table>' close, the table is unclosed -> content loss. EOF without close
counts too.

Repair: insert a '</table>' line immediately before the first offending
structural line (or at EOF). Idempotent; reports per-file fixes.

Usage: fix_unclosed_tables.py [--apply]
"""
import sys
from pathlib import Path

REPO = Path("/home/z/my-project/repos/Past-Papers")
APPLY = "--apply" in sys.argv

def is_structural(line: str) -> bool:
    s = line.strip()
    return (s.startswith("#")
            or s.startswith("<div")
            or "<table" in s)

def find_pathologies(lines):
    """returns list of (insert_before_index, reason) — indices into lines"""
    fixes = []
    i, n = 0, len(lines)
    while i < n:
        if "<table" in lines[i] and "</table>" not in lines[i]:
            j = i + 1
            reason = None
            while j < n:
                if "</table>" in lines[j]:
                    break
                if is_structural(lines[j]):
                    reason = ("structural:" + lines[j][:40].strip())
                    break
                j += 1
            else:
                reason = "eof"
                j = n
            if reason:
                fixes.append((j, reason))
            i = j  # continue scanning after close/fix point
        else:
            i += 1
    return fixes

total_files, total_fixes = 0, 0
for paper in ("paper 1", "paper 2"):
    for md in sorted(REPO.glob(f"{paper}/*/[QM]*.md")):
        lines = md.read_text(encoding="utf-8").split("\n")
        fixes = find_pathologies(lines)
        if not fixes:
            continue
        total_files += 1
        total_fixes += len(fixes)
        print(f"{paper}/{md.parent.name}/{md.name}: {len(fixes)} unclosed table(s)")
        for idx, reason in fixes:
            prev = lines[idx - 1][:50] if idx else "<start>"
            nxt = lines[idx][:60] if idx < len(lines) else "<EOF>"
            print(f"    insert </table> before line {idx+1} ({reason})")
            print(f"      after: ...{prev}")
            print(f"      before: {nxt}")
        if APPLY:
            # insert from bottom to keep indices valid
            for idx, _ in sorted(fixes, reverse=True):
                lines.insert(idx, "</table>")
            md.write_text("\n".join(lines), encoding="utf-8")

print(f"\n{'[APPLIED]' if APPLY else '[DRY-RUN]'} files to fix: {total_files}, insertions: {total_fixes}")

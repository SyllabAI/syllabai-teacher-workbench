#!/usr/bin/env python3
"""Refresh MANIFEST.json QP/MS sha256 after structural repairs + add provenance note."""
import datetime
import hashlib
import json
from pathlib import Path

REPO = Path("/home/z/my-project/repos/Past-Papers")

def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

for paper in ("paper 1", "paper 2"):
    mp = REPO / paper / "MANIFEST.json"
    m = json.loads(mp.read_text(encoding="utf-8"))
    updated = []
    for sname, sd in m["sessions"].items():
        for doc in sd.get("documents", {}).values():
            f = REPO / paper / sname / doc["path"]
            if f.exists():
                new = sha256_of(f)
                if new != doc.get("sha256"):
                    doc["sha256"] = new
                    updated.append(f"{sname}/{doc['path']}")
    note = ("Structural repair pass (deterministic, scripted): GLM-OCR emitted a small number of "
            "truncated HTML <table> blocks and unbalanced $$ display-math fences; the canonical "
            "parser's greedy consumption swallowed question content following them. Missing "
            "closers (</table> / $$) were inserted at deterministic structural boundaries "
            "(11 files, 13 insertions: paper 1 - 2013-Jan/QP, 2013-Jun/QP x2, 2014-Jun/MS, "
            "2016-Jun-R/QP x2, 2017-Jan/QP, 2020-Jun/QP, 2022-Jun/QP; paper 2 - 2011-Jun/QP, "
            "2014-Jan/QP, 2015-Jun/QP, 2020-Jan-R/QP). Affected QP/MS sha256 recomputed.")
    notes = m.get("notes", [])
    if not any("Structural repair pass" in n for n in notes):
        notes.append(note)
    m["notes"] = notes
    m["structural_repair"] = {
        "date_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "files_updated": len(updated),
        "updated": updated,
    }
    mp.write_text(json.dumps(m, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{paper}: {len(updated)} document checksums refreshed")
    for u in updated: print("  ", u)

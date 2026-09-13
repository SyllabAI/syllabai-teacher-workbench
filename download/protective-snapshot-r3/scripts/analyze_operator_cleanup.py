#!/usr/bin/env python3
"""
Post-operator-cleanup analysis (user deleted 558 images from paper 2, added 176).
Reports:
  1. md references -> missing files (broken by operator deletions), per session
  2. files on disk -> unreferenced (orphans), incl. the 176 additions
  3. byte-level dup check: are added files identical to existing referenced ones?
"""
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path

REPO = Path("/home/z/my-project/repos/Past-Papers")
MD_IMG = re.compile(r'!\[[^\]]*\]\(([^)\s]+)\)')
IMG_TAG = re.compile(r"<img[^>]+src=['\"]([^'\"]+)['\"]", re.IGNORECASE)

def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

report = {}
for paper in ("paper 1", "paper 2"):
    pdir = REPO / paper
    broken = defaultdict(list)      # session -> [(mdfile, ref)]
    referenced = set()              # (session, filename)
    for sess in sorted(d for d in pdir.iterdir() if d.is_dir()):
        for md in sorted(sess.glob("*.md")):
            text = md.read_text(encoding="utf-8", errors="replace")
            for ref in MD_IMG.findall(text) + IMG_TAG.findall(text):
                if ref.lower().startswith(("http://", "https://")):
                    continue
                target = (md.parent / ref).resolve()
                if target.exists() and target.is_file():
                    referenced.add((sess.name, target.name))
                else:
                    broken[sess.name].append((md.name, ref))
    orphans = defaultdict(list)
    disk_hashes = {}                # (session, name) -> sha256
    for f in sorted(pdir.glob("*/assets/*")):
        if not f.is_file():
            continue
        key = (f.parent.parent.name, f.name)
        if key not in referenced:
            orphans[key[0]].append(key[1])
        disk_hashes[key] = sha256_of(f)

    # dedup analysis for orphans: identical bytes to a referenced file in same session?
    ref_hashes = {}
    for (s, n), h in disk_hashes.items():
        if (s, n) in referenced:
            ref_hashes.setdefault((s, h), n)
    orphan_dup_of = {}
    for s, names in orphans.items():
        for n in names:
            h = disk_hashes[(s, n)]
            twin = ref_hashes.get((s, h))
            orphan_dup_of[f"{s}/{n}"] = twin  # None = unique content

    report[paper] = {
        "broken_total": sum(len(v) for v in broken.values()),
        "broken": {k: v for k, v in sorted(broken.items())},
        "orphan_total": sum(len(v) for v in orphans.values()),
        "orphans": dict(sorted(orphans.items())),
        "orphan_dup_of": orphan_dup_of,
        "referenced_total": len(referenced),
        "files_on_disk": len(disk_hashes),
    }

out = Path("/home/z/my-project/scripts/cleanup_analysis.json")
out.write_text(json.dumps(report, indent=1))
for paper, r in report.items():
    print(f"\n=== {paper} ===")
    print(f"  md refs resolved OK : {r['referenced_total']}")
    print(f"  BROKEN refs (file deleted): {r['broken_total']} across {len(r['broken'])} sessions")
    for s, lst in list(r['broken'].items())[:6]:
        print(f"    {s}: {len(lst)} broken (e.g. {lst[0][1]})")
    print(f"  files on disk       : {r['files_on_disk']}")
    print(f"  UNREFERENCED files  : {r['orphan_total']} across {len(r['orphans'])} sessions")
    dups = sum(1 for v in r['orphan_dup_of'].values() if v)
    uniq = r['orphan_total'] - dups
    print(f"    -> byte-identical twin of a referenced file: {dups}")
    print(f"    -> unique content (true additions)        : {uniq}")
    for s, lst in list(r['orphans'].items())[:6]:
        print(f"    {s}: {len(lst)} (e.g. {lst[0]})")
print(f"\nfull report: {out}")

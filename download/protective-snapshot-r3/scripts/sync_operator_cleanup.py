#!/usr/bin/env python3
"""
Operator-cleanup sync pass:
  1. Remove <img> / markdown refs whose target file is gone (operator deletions).
     - remove only the dead <img ...> tag, keep siblings
     - collapse now-empty <div ...></div> wrappers
     - drop lines that become empty
  2. Rewrite MANIFEST.json per paper:
     - drop image entries whose saved_as is gone; update image_count
     - recompute QP/MS md sha256 (md bytes changed)
     - record operator_cleanup provenance block (per-session removed list)
  3. Print before/after stats. Dry-run first with --apply to write.
"""
import datetime
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path("/home/z/my-project/repos/Past-Papers")
MD_IMG = re.compile(r'!\[[^\]]*\]\(([^)\s]+)\)')
IMG_TAG = re.compile(r"<img\b[^>]*\bsrc=['\"]([^'\"]+)['\"][^>]*>", re.IGNORECASE)
EMPTY_DIV = re.compile(r"<div\b[^>]*>\s*</div>", re.IGNORECASE)

APPLY = "--apply" in sys.argv

def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def clean_line(line: str, md_dir: Path, removed_here: list) -> str:
    # markdown-style refs
    def md_sub(m):
        ref = m.group(1)
        if ref.lower().startswith(("http://", "https://")):
            return m.group(0)
        if not (md_dir / ref).resolve().exists():
            removed_here.append(ref)
            return ""
        return m.group(0)
    line = MD_IMG.sub(md_sub, line)

    # html img tags — iteratively (regex can't span siblings safely in one pass)
    changed = True
    while changed:
        changed = False
        for m in list(IMG_TAG.finditer(line)):
            ref = m.group(1)
            if ref.lower().startswith(("http://", "https://")):
                continue
            if not (md_dir / ref).resolve().exists():
                line = line[:m.start()] + line[m.end():]
                removed_here.append(ref)
                changed = True
                break  # restart scan on mutated string
    # collapse empty div wrappers repeatedly
    while EMPTY_DIV.search(line):
        line = EMPTY_DIV.sub("", line)
    return line

grand = {}
for paper in ("paper 1", "paper 2"):
    pdir = REPO / paper
    manifest_path = pdir / "MANIFEST.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    removed_all = defaultdict(list)   # session -> [refs]
    edited_files = 0

    for sess in sorted(d for d in pdir.iterdir() if d.is_dir()):
        for md in sorted(sess.glob("*.md")):
            orig = md.read_text(encoding="utf-8")
            removed_here: list = []
            new_lines = []
            for line in orig.splitlines(keepends=True):
                nl = clean_line(line, md.parent, removed_here)
                body = nl.rstrip("\r\n")
                if body.strip() == "" and (removed_here or EMPTY_DIV.search(line)):
                    # line became empty because we removed content from it -> drop line + its newline
                    continue
                new_lines.append(nl)
            new_text = "".join(new_lines)
            if removed_here:
                if APPLY:
                    md.write_text(new_text, encoding="utf-8")
                edited_files += 1
                for r in removed_here:
                    removed_all[sess.name].append(Path(r).name)

    # ── manifest rewrite ──────────────────────────────────────────────────────
    sess_report = {}
    for sess_name, sdata in manifest["sessions"].items():
        imgs = sdata.get("images", {})
        gone = [url for url, e in list(imgs.items())
                if not (pdir / sess_name / "assets" / e.get("saved_as", "")).exists()]
        for url in gone:
            del imgs[url]
        sdata["image_count"] = len(imgs)
        # refresh md checksums (bytes changed in this pass)
        for doc in sdata.get("documents", {}).values():
            f = pdir / sess_name / doc["path"]
            if f.exists():
                doc["sha256"] = sha256_of(f)
        if gone:
            sess_report[sess_name] = sorted(gone)

    removed_total = sum(len(v) for v in removed_all.values())
    manifest_removed_total = sum(len(v) for v in sess_report.values())
    if APPLY:
        manifest["operator_cleanup"] = {
            "date_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "description": (
                "Operator manually reviewed every asset image and deleted unwanted ones "
                "(page furniture, logos, barcodes, stamps, non-content crops). MD image "
                "references to removed files were removed programmatically in the same pass; "
                "QP/MS checksums above were recomputed after the edit. Original GLM-OCR crop "
                "names are preserved below; the underlying signed URLs were expiring and the "
                "bytes are intentionally gone."
            ),
            "removed_image_count": manifest_removed_total,
            "removed_images": dict(sorted(sess_report.items())),
        }
        manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")

    grand[paper] = dict(broken_refs_removed=removed_total, md_files_edited=edited_files,
                        manifest_entries_removed=manifest_removed_total,
                        sessions_with_removals=len(sess_report),
                        disk_assets=sum(1 for _ in pdir.glob('*/assets/*')))
    print(f"{'[APPLIED]' if APPLY else '[DRY-RUN]'} {paper}: "
          f"md refs removed={removed_total} in {edited_files} files | "
          f"manifest entries removed={manifest_removed_total} across {len(sess_report)} sessions | "
          f"assets on disk now={grand[paper]['disk_assets']}")

if APPLY:
    print("\ngrand:", json.dumps(grand, indent=1))
else:
    print("\n(dry run — re-run with --apply to write changes)")

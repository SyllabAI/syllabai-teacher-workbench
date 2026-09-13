#!/usr/bin/env python3
"""cleanup_round2.py — sync md references + manifest for the operator's second
deletion pass (commit aa9cfe6, 9 asset files). Mirrors the 77082eb pattern:
remove matching <img> refs, collapse empty wrappers, drop manifest entries,
update image_count, recompute QP/MS sha256, append operator_cleanup_2 block.
Idempotent: safe to re-run; sha256 recomputed unconditionally per session."""
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/home/z/my-project/repos/Past-Papers")

DELETED = [
    ("paper 1", "2014-Jun-R", "crop_2_1789047663863.png"),
    ("paper 1", "2019-Jun-R", "crop_1_1789054868286.png"),
    ("paper 1", "2020-Jan-R", "crop_2_1789044667685.png"),
    ("paper 2", "2014-Jun-R", "crop_1_1789069376369.png"),
    ("paper 2", "2015-Jan", "crop_1_1789063974947.png"),
    ("paper 2", "2015-Jun", "crop_1_1789069430991.png"),
    ("paper 2", "2019-Jun-R", "crop_1_1789069581404.png"),
    ("paper 2", "2019-Jun-R", "crop_1_1789069581489.png"),
    ("paper 2", "2019-Jun-R", "crop_1_1789069581575.png"),
]

EMPTY_DIV = re.compile(r"<div[^>]*>\s*</div>", re.IGNORECASE)


def sha256_of(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def img_remover(name):
    pat = re.compile("<img[^>]+src=['\"]assets/" + re.escape(name) +
                     "['\"][^>]*/?>", re.IGNORECASE)
    return pat


def main():
    removed_images = {}
    touched_files = []
    for paper, sess, name in DELETED:
        sdir = ROOT / paper / sess
        manifest_path = sdir.parent / "MANIFEST.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        s = manifest["sessions"][sess]
        urls = [u for u, meta in s["images"].items()
                if meta.get("saved_as") == name]
        if not urls:
            print(f"  WARN: {paper}/{sess}/{name} not in manifest")
        else:
            removed_images.setdefault(sess, []).extend(urls)
        remover = img_remover(name)
        for md_name in ("QP.md", "MS.md"):
            md = sdir / md_name
            text = md.read_text(encoding="utf-8")
            new = remover.sub("", text)
            new = EMPTY_DIV.sub("", new)
            if new != text:
                md.write_text(new, encoding="utf-8")
                if f"{sess}/{md_name}" not in touched_files:
                    touched_files.append(f"{sess}/{md_name}")
            s["documents"][md_name.split(".")[0]]["sha256"] = sha256_of(md)
        for u in urls:
            s["images"].pop(u, None)
        s["image_count"] = len(s["images"])
        manifest_path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"  {paper}/{sess}/{name}: {len(urls)} manifest entry(ies) dropped")

    for paper in ("paper 1", "paper 2"):
        sessions_here = sorted({sess for p, sess, _ in DELETED if p == paper})
        if not sessions_here:
            continue
        manifest_path = ROOT / paper / "MANIFEST.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["operator_cleanup_2"] = {
            "date_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "description": (
                "Second operator review pass (commit aa9cfe6): 9 residual "
                "page-furniture crops deleted (answer-line strips, BLANK PAGE "
                "frames, do-not-write borders) that the first pass missed. MD "
                "image references were removed programmatically in this commit; "
                "QP/MS checksums recomputed; manifest entries dropped and "
                "image_count updated. Original GLM-OCR URLs of the removed "
                "files are preserved below per session."),
            "removed_image_count": sum(1 for p, _, _ in DELETED if p == paper),
            "removed_images": {sess: removed_images.get(sess, [])
                               for sess in sessions_here},
        }
        manifest_path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nmd files touched: {len(touched_files)}")
    for t in sorted(touched_files):
        print(f"  {t}")


if __name__ == "__main__":
    main()

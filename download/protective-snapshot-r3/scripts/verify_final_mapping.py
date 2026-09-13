#!/usr/bin/env python3
"""verify_final_mapping.py — SyllabAI Past-Papers GLM-OCR image mapping audit.
6 checks (A-F) over 'paper 1' and 'paper 2'. Exit 0 = all green."""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path("/home/z/my-project/repos/Past-Papers")
PAPERS = ["paper 1", "paper 2"]
SPOT_CHECK_N = 60

IMG_TAG = re.compile(r"<img[^>]+src=['\"]([^'\"]+)['\"]", re.IGNORECASE)
MD_IMG = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")

issues = []


def fail(check, paper, sess, detail):
    issues.append((check, paper, sess, detail))


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def audit_paper(paper: str):
    pdir = ROOT / paper
    manifest = json.loads((pdir / "MANIFEST.json").read_text(encoding="utf-8"))
    sessions = manifest["sessions"]
    print(f"\n{'=' * 70}\n{paper}  ({len(sessions)} sessions)\n{'=' * 70}")
    exempt_saved_as = set()
    for sess, s in sessions.items():
        for dup in s.get("superseded_duplicates", []):
            for url, meta in dup.get("images", {}).items():
                exempt_saved_as.add(meta.get("saved_as"))
    totals = {"refs": 0, "disk_files": 0, "manifest_imgs": 0}
    spot_done = 0
    for sess in sorted(sessions):
        s = sessions[sess]
        sdir = pdir / sess
        assets = sdir / "assets"
        md_refs = {}
        for md_name in ("QP.md", "MS.md"):
            md = sdir / md_name
            if not md.exists():
                fail("A", paper, sess, f"missing {md_name}")
                continue
            text = md.read_text(encoding="utf-8")
            for ref in IMG_TAG.findall(text) + MD_IMG.findall(text):
                totals["refs"] += 1
                if re.match(r"^(https?:)?//|^/", ref) or ".." in ref:
                    fail("B", paper, sess, f"{md_name}: non-local ref {ref!r}")
                    continue
                target = sdir / ref
                if not target.exists():
                    fail("A", paper, sess, f"{md_name}: broken ref {ref!r}")
                else:
                    md_refs.setdefault(ref, []).append(md_name)
        disk_files = {f.name for f in assets.glob("*") if f.is_file()} if assets.exists() else set()
        totals["disk_files"] += len(disk_files)
        manifest_imgs = s.get("images", {})
        totals["manifest_imgs"] += len(manifest_imgs)
        by_saved = {}
        for url, meta in manifest_imgs.items():
            by_saved.setdefault(meta.get("saved_as"), []).append((url, meta))
        for ref, mds in md_refs.items():
            name = Path(ref).name
            entries = by_saved.get(name)
            if not entries:
                fail("C", paper, sess, f"{name} referenced by {mds} but absent from manifest")
                continue
            actual = sha256_of(sdir / ref)
            if not any(meta.get("sha256") == actual for _, meta in entries):
                fail("C", paper, sess, f"{name} sha256 mismatch vs manifest")
        for url, meta in manifest_imgs.items():
            name = meta.get("saved_as")
            if name in exempt_saved_as:
                continue
            if not (sdir / "assets" / name).exists():
                fail("D", paper, sess, f"manifest image {name} missing on disk")
        ref_names = {Path(r).name for r in md_refs}
        man_names = {m.get("saved_as") for m in manifest_imgs.values()} - exempt_saved_as
        for n in sorted(disk_files - ref_names - exempt_saved_as):
            fail("E", paper, sess, f"on disk but never referenced & not exempt: {n}")
        for n in sorted(man_names - ref_names):
            fail("E", paper, sess, f"in manifest but never referenced by md: {n}")
        for n in sorted(ref_names - man_names - disk_files):
            fail("E", paper, sess, f"referenced by md but not in manifest: {n}")
        for doc in ("QP", "MS"):
            meta = s.get("documents", {}).get(doc)
            if not meta:
                fail("F", paper, sess, f"manifest missing documents.{doc}")
                continue
            f = sdir / meta["path"]
            if not f.exists():
                fail("F", paper, sess, f"{doc} file missing: {meta['path']}")
            elif sha256_of(f) != meta["sha256"]:
                fail("F", paper, sess, f"{doc} sha256 mismatch (md edited after manifest?)")
        for name in sorted(disk_files):
            if spot_done >= SPOT_CHECK_N:
                break
            if name in exempt_saved_as:
                continue
            entries = by_saved.get(name)
            if not entries:
                continue
            spot_done += 1
            actual = sha256_of(assets / name)
            if not any(meta.get("sha256") == actual for _, meta in entries):
                fail("F", paper, sess, f"spot-check sha256 mismatch: {name}")
    totals["spot_checked"] = spot_done
    return totals


def main():
    grand = {}
    for paper in PAPERS:
        grand[paper] = audit_paper(paper)
    print(f"\n{'=' * 70}\nSUMMARY\n{'=' * 70}")
    for paper, t in grand.items():
        print(f"{paper}: refs={t['refs']} disk={t['disk_files']} "
              f"manifest={t['manifest_imgs']} spot_checked={t['spot_checked']}")
    if issues:
        print(f"\nFAILURES: {len(issues)}")
        by_check = {}
        for check, paper, sess, detail in issues:
            by_check.setdefault(check, []).append((paper, sess, detail))
        for check in sorted(by_check):
            lst = by_check[check]
            print(f"\n  Check {check}: {len(lst)} issue(s)")
            for paper, sess, detail in lst[:15]:
                print(f"    [{paper}/{sess}] {detail}")
            if len(lst) > 15:
                print(f"    ... and {len(lst) - 15} more")
        sys.exit(1)
    print("\nALL CHECKS GREEN (A-F)")
    sys.exit(0)


if __name__ == "__main__":
    main()

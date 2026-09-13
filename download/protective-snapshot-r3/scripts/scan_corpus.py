#!/usr/bin/env python3
"""scan_corpus.py — Stage 1 the WHOLE 4CH1 corpus (both papers) and report
structural anomalies (duplicate part labels per question) + figure stats.
Bundles land in /home/z/my-project/corpus-bundles/<slug>/ for reuse."""
import json
import subprocess
import sys
from pathlib import Path

TC = Path("/home/z/toolchain")
JAVA = TC / "jdk-25.0.4.1+1/bin/java"
PARSER = Path("/home/z/my-project/repos/syllabai-parser")
PAPERS = Path("/home/z/my-project/repos/Past-Papers")
PARSER_CP = (TC / "parser-cp.txt").read_text().strip()
OUT = Path("/home/z/my-project/corpus-bundles")


def slug_for(paper, sess):
    code = "1c" if paper == "paper 1" else "2c"
    return f"igcse-chemistry-4ch0-{code}-{sess.lower().replace('-', '')}"


def figs(draft):
    tot = res = 0
    def walk(fs):
        nonlocal tot, res
        for f in fs or []:
            tot += 1
            if f.get("availability") == "available":
                res += 1
    for q in draft.get("questions", []):
        walk(q.get("figures"))
        for p in q.get("parts", []):
            walk(p.get("figures"))
    return tot, res


anomalies = []
fig_total = fig_res = 0
sessions = [("paper 1", s) for s in sorted(d.name for d in (PAPERS / "paper 1").iterdir() if d.is_dir())] \
    + [("paper 2", s) for s in sorted(d.name for d in (PAPERS / "paper 2").iterdir() if d.is_dir())]
print(f"scanning {len(sessions)} sessions", flush=True)
for paper, sess in sessions:
    sdir = PAPERS / paper / sess
    slug = slug_for(paper, sess)
    out = OUT / slug
    if not (out / "reconciliation.json").exists():
        r = subprocess.run(
            [str(JAVA), "-cp", f"{PARSER}/target/classes:{PARSER_CP}",
             "com.syllabai.parser.GlmOcrPairCli",
             str(sdir / "QP.md"), str(sdir / "MS.md"), str(out),
             f"--uri-prefix=corpus/{slug}", f"--assets-dir={sdir / 'assets'}"],
            capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            anomalies.append({"session": slug, "type": "stage1-failed",
                              "detail": r.stderr[-300:]})
            print(f"  {slug}: STAGE1 FAILED", flush=True)
            continue
    qp = json.loads((out / "qp-draft.json").read_text())
    rec = json.loads((out / "reconciliation.json").read_text())
    t, rr = figs(qp)
    fig_total += t
    fig_res += rr
    problems = []
    for q in qp.get("questions", []):
        labels = [p.get("label") for p in q.get("parts", [])]
        dups = sorted({l for l in labels if l and labels.count(l) > 1})
        if dups:
            problems.append({"question": q.get("questionNumber"),
                             "labels": labels, "dups": dups})
    if problems:
        anomalies.append({"session": slug, "type": "duplicate-part-labels",
                          "problems": problems})
        print(f"  {slug}: DUP LABELS {[(p['question'], p['dups']) for p in problems]}", flush=True)
    if rec.get("mismatchCount") or rec.get("paperTotalConflict"):
        print(f"  {slug}: recon mismatch={rec.get('mismatchCount')} "
              f"conflict={rec.get('paperTotalConflict')}", flush=True)

print(f"\nfigures: {fig_res}/{fig_total} resolved")
print(f"anomalous sessions: {len(anomalies)}")
OUT.mkdir(exist_ok=True)
(Path("/home/z/my-project/corpus-anomalies.json")).write_text(json.dumps(
    {"figures": {"resolved": fig_res, "total": fig_total}, "anomalies": anomalies}, indent=1))
print("written: /home/z/my-project/corpus-anomalies.json")

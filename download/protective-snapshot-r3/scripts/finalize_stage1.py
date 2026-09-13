#!/usr/bin/env python3
"""
T-C03 Stage-1 finalization:
  1. Organize the 82 pair bundles into batch roots of <=10 pairs each
     (paper1-b1..bN, paper2-b1..bN) ready for core's --syllabai.glmocr.batch-dir
  2. Write a markdown summary report (extraction table, repair log, runbook)
  3. Zip the batch roots into download/
"""
import json
import shutil
import zipfile
from pathlib import Path

T03 = Path("/home/z/my-project/t-c03")
DL = Path("/home/z/my-project/download")
DL.mkdir(exist_ok=True)
MAX_PAIRS = 10

rows = [l.split("\t") for l in (T03 / "pair_runs.tsv").read_text().splitlines()[1:] if l.strip()]

# 1. batch roots ------------------------------------------------------------
if (T03 / "batch-roots").exists():
    shutil.rmtree(T03 / "batch-roots")
roots = []
for slug in ("paper-1", "paper-2"):
    sessions = sorted((T03 / slug).iterdir()) if (T03 / slug).exists() else []
    for bi in range(0, len(sessions), MAX_PAIRS):
        chunk = sessions[bi:bi + MAX_PAIRS]
        root = T03 / "batch-roots" / f"{slug}-b{bi // MAX_PAIRS + 1}"
        root.mkdir(parents=True)
        for sdir in chunk:
            shutil.copytree(sdir, root / sdir.name)
        roots.append(root)
        print(f"batch root: {root.name} ({len(chunk)} pairs)")

# 2. summary report ----------------------------------------------------------
p1 = [r for r in rows if r[0] == "paper 1"]
p2 = [r for r in rows if r[0] == "paper 2"]

def total(rs, idx):
    return sum(int(r[idx]) for r in rs if r[idx].isdigit())

lines = []
A = lines.append
A("# T-C03 Stage 1 — Pair Processing Report (4CH0/4CH1 Chemistry corpus)")
A("")
A("Generated 2026-09-11 · corpus: `SyllabAI/Past-Papers` `paper 1` + `paper 2` "
  "(41 sessions each, post operator image-cleanup + structural repair)")
A("")
A("## What was run")
A("")
A("```")
A("syllabai-glmocr-pair <session>/QP.md <session>/MS.md <bundle-dir> \\")
A("    --uri-prefix=\"<paper>/<session>\"      # production parser CLI (syllabai-parser)")
A("```")
A("")
A("82/82 pairs processed, 0 failures. Deterministic ids (SHA-256 of md bytes + engine), "
  "so re-runs reproduce the same bundles byte-for-byte (only `extractedAt` differs).")
A("")
A("## Corpus repairs applied BEFORE processing (provenance in MANIFEST.json + git)")
A("")
A("| Pass | What | Scope | Commit |")
A("|---|---|---|---|")
A("| Operator image cleanup sync | removed 2,269 md `<img>` refs to operator-deleted files; "
  "MANIFEST entries dropped, QP/MS sha256 recomputed, `operator_cleanup` block added | 148 files | `77082eb` |")
A("| Structural repair | inserted 13 missing `</table>` / `$$` closers (truncated periodic-table "
  "tables, unbalanced math fences) that made the canonical parser swallow question content; "
  "`structural_repair` block added | 11 files | `a668550` |")
A("")
A("Extraction recovered in 9 sessions (e.g. paper 1 2013-Jan q 0→10, 2016-Jun-R q 2→12, "
  "paper 2 2011-Jun q 0→8). Post-repair idempotency check: 0 residual pathologies.")
A("")
A("## Results overview")
A("")
A(f"| | paper 1 | paper 2 |")
A(f"|---|---|---|")
A(f"| pairs processed | {len(p1)} | {len(p2)} |")
A(f"| questions extracted (QP drafts) | {total(p1,2)} | {total(p2,2)} |")
A(f"| mark-scheme entries extracted | {total(p1,3)} | {total(p2,3)} |")
A(f"| reconciliation mismatches | {total(p1,4)} | {total(p2,4)} |")
A(f"| paper-total conflicts | {total(p1,5)} | {total(p2,5)} |")
A(f"| review-required pairs | {total(p1,6) and sum(1 for r in p1 if r[6]=='true')} | {sum(1 for r in p2 if r[6]=='true')} |")
A("")
A("All 82 reconciliations report **0 mark mismatches and 0 paper-total conflicts**. "
  "Caveat: where one side extracted little/nothing (see below) the comparison is vacuous — "
  "those pairs still land as SUGGESTED + reviewRequired and must be human-reviewed.")
A("")
A("## Per-session extraction")
A("")
A("| Paper | Session | QP questions | MS entries | Mismatches | Review |")
A("|---|---|---|---|---|---|")
for r in rows:
    A(f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]} | {r[6]} |")
A("")
A("## Known extraction-fidelity outliers (v0 regex extractor — expected, review-flagged)")
A("")
A("- **2011-era `N.` numbering**: paper 1 2011-Jun Q1 uses `1 ` style but Q2 starts "
  "`2. (a)` — the extractor supports `1:` / `1 ` only, so q2's stem is absorbed into q1. "
  "Parser improvement candidate (Java + Python + conformance).")
A("- **Low MS-entry counts** (e.g. paper 1 2015-Jan ms=1, 2019-Jun ms=2; paper 2 2014-Jun-R ms=0, "
  "2016-Jun-R ms=0): mark-scheme table layouts the v0 row parser does not fully decompose. "
  "Entries that DO extract are correct-verbatim; missing ones surface in review.")
A("- **High MS-entry counts** (Specimen-2017 ms=63/40, 2022-Jan-R ms=40): table-row granularity "
  "splits one logical entry into several — same content, finer rows. Review merges.")
A("- **Figures**: local `assets/` refs are carried verbatim; the committed CLI labels them "
  "`unavailable-signed-url` (legacy label). `GlmOcrImageAssets` (`img:<sha256>`, MIME sniff, "
  "dimensions) exists in Java but is not wired into the CLI yet — wiring is a small, safe "
  "follow-up so figures become `available` with ownership.")
A("")
A("## Stage 2 — core batch ingestion (runbook)")
A("")
A("Bundles are organized into batch roots of <=10 pairs (the core firehose guard):")
A("")
for r in sorted(roots):
    A(f"- `{r}`")
A("")
A("Per batch root (core repo, requires the pgvector Postgres the app normally uses):")
A("")
A("```")
A("java -jar syllabai-core.jar --syllabai.glmocr.batch-dir=<batch-root> \\")
A("     [--syllabai.glmocr.batch-max-pairs=10]")
A("```")
A("")
A("Each run writes `batch-audit-report.json` into the batch root: per-pair first+idempotency "
  "pass, row-count deltas, and 5 DB-verified invariants (`all-content-suggested`, "
  "`no-implicit-embedding`, `not-learner-servable`, `conflict-preservation`, "
  "`deterministic-rerun`). Non-zero exit on any invariant failure. Whole batch is atomic.")
A("")
A("Per the backlog's T-C04 gate: review the pilot audit report (or this corpus's first small "
  "batch) before scaling beyond the initial batches; everything lands SUGGESTED — nothing "
  "serves learners and nothing embeds until teacher validation.")

(DL / "t-c03-stage1-report.md").write_text("\n".join(lines), encoding="utf-8")
print(f"report: {DL / 't-c03-stage1-report.md'}")

# 3. zip ---------------------------------------------------------------------
zpath = DL / "t-c03-bundles.zip"
if zpath.exists():
    zpath.unlink()
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
    for r in roots:
        for f in r.rglob("*"):
            if f.is_file():
                z.write(f, f.relative_to(T03))
print(f"zip: {zpath} ({zpath.stat().st_size // 1024} KB)")

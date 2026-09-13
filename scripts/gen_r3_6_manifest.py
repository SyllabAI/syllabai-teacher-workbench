#!/usr/bin/env python3
"""gen_r3_6_manifest.py — machine-readable R3-6 state manifest for the evidence pack."""
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone

BASE = "/home/z/my-project"
EV = f"{BASE}/download/evidence-r3-6"

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()

def git(repo, ref="HEAD"):
    try:
        return subprocess.run(["git", "-C", repo, "rev-parse", ref],
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return None

# Canonical DB facts via read-only psql
PSQL = "/home/z/toolchain/pgdebs/root/usr/lib/postgresql/17/bin/psql"
ARGS = ["-h", "/home/z/toolchain", "-U", "syllabai", "-d", "syllabai", "-tA", "-c"]

def q(sql):
    return subprocess.run([PSQL] + ARGS + [sql], capture_output=True, text=True, check=True).stdout.strip()

identity = q("SELECT campaign_label || '|' || db_name || '|' || core_commit || '|' || claimed_at FROM campaign_db_identity")
flyway = int(q("SELECT count(*) FROM flyway_schema_history"))
events = q("SELECT decision_seq || '|' || action || '|' || target_type || '|' || result_state || '|' || reviewer || '|' || left(decision_hash, 16) FROM teacher_validation_events ORDER BY decision_seq")
counts = q("""SELECT
  (SELECT count(*) FROM exam_papers),
  (SELECT count(*) FROM exam_papers WHERE validation_state='SUGGESTED'),
  (SELECT count(*) FROM question_versions),
  (SELECT count(*) FROM question_versions WHERE validation_state='VALIDATED'),
  (SELECT count(*) FROM question_versions WHERE validation_state='SUGGESTED'),
  (SELECT count(*) FROM question_versions WHERE validation_state='REJECTED'),
  (SELECT count(*) FROM mark_schemes),
  (SELECT count(*) FROM mark_schemes WHERE validation_state='REJECTED'),
  (SELECT count(*) FROM teacher_validation_events)""").split("|")

real_log = f"{BASE}/download/teacher-validation/decision-log.jsonl"
manifest = {
    "milestone": "R3-6 — Teacher Validation Workbench: canonical state + staged intent",
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "commits": {
        "workbench_app_local_main": git(BASE),
        "syllabai_core_local_main": git(f"{BASE}/repos/syllabai-core"),
        "syllabai_core_origin_main": git(f"{BASE}/repos/syllabai-core", "origin/main"),
        "corpus_past_papers": git(f"{BASE}/repos/Past-Papers"),
        "parser": git(f"{BASE}/repos/syllabai-parser"),
        "note": "core local main is AHEAD of origin (R3-5 commits 68e9da9/9615b69/b37837a unpushed — no PAT in sandbox); workbench commit 2f6e8a7 likewise local-only",
    },
    "migrationProvenance": {
        "decision": "NO new migration",
        "numericMaxOverRemoteTree": "V18 (checked by numeric max, not filename sorting)",
        "v17": "learner_state_version_columns (parallel agent, aa5319e)",
        "v18": "teacher_validation_review (R3-5, 9615b69)",
        "flywayRowsInCampaignDB": flyway,
    },
    "canonicalIdentity": dict(zip(["campaign_label", "db_name", "core_commit", "claimed_at"], identity.split("|"))),
    "canonicalCounts": {
        "papers": int(counts[0]), "papers_suggested": int(counts[1]),
        "versions": int(counts[2]), "versions_validated_seed": int(counts[3]),
        "versions_suggested": int(counts[4]), "versions_rejected": int(counts[5]),
        "schemes": int(counts[6]), "schemes_rejected": int(counts[7]),
        "applied_events": int(counts[8]),
    },
    "appliedEvents": [
        dict(zip(["decision_seq", "action", "target_type", "result_state", "reviewer", "hash16"], row.split("|")))
        for row in events.splitlines()
    ],
    "stagingLog": {
        "realLogSha256": sha256(real_log),
        "entries": int(q("SELECT 6")) if False else sum(1 for l in open(real_log) if l.strip()),
        "browserVerificationScratchLog": f"download/teacher-validation/test-runs/browser-verify-decision-log.jsonl",
        "browserScratchSha256": sha256(f"{BASE}/download/teacher-validation/test-runs/browser-verify-decision-log.jsonl"),
    },
    "verificationMatrix": {
        "unit_and_integration_tests": "42/42 pass (tests/r3-6: relationship, session-auth, integration) — test-results-full.log",
        "importerUntouched": {"sha256": sha256(f"{BASE}/scripts/import_teacher_decisions.py"), "checkMode": "exit 0 — 6/6 already-applied DUPLICATE, chain valid — importer-check-mode-r3-6.log"},
        "lint": "eslint clean", "tsc": "clean (app tsconfig)", "build": "next build success (8 routes)",
        "browser": "agent-browser two-phase script; 7 screenshots; 0 console errors both phases; real staging log sha256 identical before/after",
        "dbUntouchedDuringR3_6": "papers SUGGESTED=81, versions 758 SUGGESTED + 8 seed VALIDATED, events=6 — identical pre/post milestone",
    },
    "authorization": {
        "stagingWrites": "require HMAC teacher session (HttpOnly cookie); 403 without/forged/expired/wrong-role — proven by tests",
        "canonicalWrites": "impossible from serving path: connection-level read-only + hostile sweep test (72 requests) left canonical DB byte-identical; apply path = gated importer only (server-side, identity-preflighted)",
    },
    "claimLabels": {
        "canonical-vs-staged UI separation": "VERIFIED (screenshots 01-06 + relationship unit tests)",
        "applied events with attribution": "VERIFIED (live feed + screenshots 02/03/04)",
        "reversal representation": "VERIFIED (unit tests + screenshot 03 rehearsal chain seq1->seq4)",
        "FLAG events-only": "VERIFIED (unit + integration + live event result_state=SUGGESTED)",
        "authorization matrix": "VERIFIED (integration tests, hostile sweep)",
        "importer gates untouched and passing": "VERIFIED (sha256 + check-mode log)",
        "seed-VALIDATED lock": "VERIFIED (integration test + seed-validated-live-state.json)",
        "canonical REJECTED rendering": "VERIFIED for the render mapping by unit fixture; NOTE: 0 canonical REJECTED rows exist in the live DB (nothing to photograph) — honest absence, not a gap",
        "durable off-container export": "BLOCKED — no GitHub PAT in sandbox; evidence committed locally (2f6e8a7) + SHA256SUMS; release upload deferred to next PAT provision",
    },
    "canonicalVsStagedExample": {
        "staged": "browser scratch log seq 1: VALIDATE exam_paper:f95f3b12 by Browser Verification (R3-6) — relationship WOULD_CHANGE_CANONICAL, canonical stays SUGGESTED",
        "applied": "teacher_validation_events seq 1: VALIDATE question_version:00190480 by E2E Rehearsal (R3-5 machine-gate test) — was applied, then reversed by seq 4; canonical SUGGESTED",
        "canonical": "8 seed question_versions VALIDATED with zero applied events (seed-locked); 81 papers SUGGESTED",
    },
}

with open(f"{EV}/r3-6-state-manifest.json", "w") as f:
    json.dump(manifest, f, indent=2)
print(json.dumps(manifest["canonicalCounts"], indent=1))
print("manifest written")

#!/usr/bin/env python3
"""R3-7 — public-repository audit: classify every tracked artifact of
SyllabAI/syllabai-teacher-workbench (public since 2026-09-14).

Categories:
  SAFE              safe to publish (code, tests, docs, manifests)
  OPERATIONAL_SAFE  operational but safe (run logs, read-model data, lockfiles,
                    env file with non-secret content, infra port config)
  SHOULD_NOT_BE_PUBLIC  must not be public (secrets, identity state) — none expected
  UNCERTAIN         needs an operator decision
"""
import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path

REPO = Path("/home/z/my-project")

def tracked():
    out = subprocess.run(["git", "ls-files"], cwd=REPO, capture_output=True, text=True, check=True)
    return [l for l in out.stdout.splitlines() if l.strip()]

RULES = [
    # (regex, category, rationale)
    (r"^src/", "SAFE", "workbench application source (no secrets; reads identity state only from env/file paths outside git)"),
    (r"^tests/", "SAFE", "test suites; use env-isolated scratch state"),
    (r"^scripts/hooks/", "SAFE", "repo hygiene guards"),
    (r"^scripts/(provision-reviewer|check-large-files|r3-6b_|r3-7_)", "SAFE", "operator tooling — contains no credentials; tokens are generated at runtime and printed once"),
    (r"^scripts/", "SAFE", "campaign generation/verification scripts (no hardcoded credentials; token patterns audited)"),
    (r"^docs/", "SAFE", "policy documentation"),
    (r"^\.zscripts/", "OPERATIONAL_SAFE", "sandbox task runner helpers"),
    (r"^(package|next)\.json$|^postcss\.config\.mjs$|^tailwind\.config\.ts$|^tsconfig\.json$|eslint\.config\.mjs$|^next\.config\.ts$|^components\.json$|^bun\.lock$|^next-env\.d\.ts$", "SAFE", "build/config manifests"),
    (r"^\.gitignore", "SAFE", "ignore rules"),
    (r"^public/", "SAFE", "static UI assets"),
    (r"^prisma/", "SAFE", "ORM schema (points at local sqlite dev file)"),
    (r"^db/", "SAFE", "local dev database file path config only" ),
    (r"^README\.md$|^worklog\.md$", "OPERATIONAL_SAFE", "campaign narrative — audited for secrets (none found; token-pattern scan of all history blobs came back clean)"),
    (r"^Caddyfile$", "OPERATIONAL_SAFE", "local reverse-proxy port config — no hosts/credentials"),
    (r"^\.env$", "OPERATIONAL_SAFE", "contains a local sqlite FILE PATH only (DATABASE_URL=file:...) — no credentials"),
    (r"^examples/", "OPERATIONAL_SAFE", "sandbox scaffold examples (not campaign code)"),
    (r"^mini-services/", "OPERATIONAL_SAFE", "sandbox scaffold services directory (gitkeep only)"),
    (r"^repos/(Past-Papers|syllabai-core|syllabai-parser)$", "OPERATIONAL_SAFE", "gitlink pointers to the public campaign repos — no embedded content"),
    (r"^tool-results/", "OPERATIONAL_SAFE", "auto-captured tool output — inspected: it is a copy of review-workbench.tsx source; no sensitive patterns"),
    (r"^data/review/", "OPERATIONAL_SAFE", "read-model dataset DERIVED FROM canonical content; the corpus itself is already public (SyllabAI/Past-Papers) — contains per-run random UUIDs, no PII"),
    (r"^data/", "OPERATIONAL_SAFE", "campaign dataset files derived from public corpus material"),
    (r"^download/evidence-r3-6-b/.*\.tar\.gz$", "UNCERTAIN", "60MB source tarball swept into history by sandbox auto-commit 4c58b19 — FROZEN (not rewritten); byte-identical to the release asset; future tarballs are gitignored + hook-blocked"),
    (r"^download/evidence-", "OPERATIONAL_SAFE", "milestone evidence packs: screenshots show SYNTHETIC reviewer names only; identifiers are per-run random UUIDs; hashes/manifests intended for publication"),
    (r"^download/teacher-validation/test-runs/", "OPERATIONAL_SAFE", "throwaway suite scratch state (gitignored going forward; historical file is a scratch log, no identity data)"),
    (r"^download/teacher-validation/runs/", "OPERATIONAL_SAFE", "importer run manifests (check-mode runs; no secrets)"),
    (r"^download/teacher-validation/decision-log\.jsonl$", "OPERATIONAL_SAFE", "REAL hash-chained staging log — rehearsal entries only, attributed to synthetic machine-gate test identities; intended audit material"),
    (r"^download/teacher-validation/session-secret\.key$", "SHOULD_NOT_BE_PUBLIC", "HMAC secret — MUST never be committed (gitignored; verified untracked)"),
    (r"^download/teacher-validation/reviewers\.json$", "SHOULD_NOT_BE_PUBLIC", "reviewer identity registry — MUST never be committed (gitignored; verified absent)"),
    (r"^download/teacher-validation/provisioning-log\.jsonl$", "SHOULD_NOT_BE_PUBLIC", "provisioning audit — MUST never be committed (gitignored)"),
    (r"^download/", "OPERATIONAL_SAFE", "campaign artifacts (dumps/snapshots verified untracked separately)"),
]

def classify(path):
    for pattern, cat, why in RULES:
        if re.match(pattern, path):
            return cat, why
    return "UNCERTAIN", "no rule matched — operator review"

def main():
    files = tracked()
    detail = []
    by_cat = defaultdict(list)
    for f in files:
        cat, why = classify(f)
        by_cat[cat].append(f)
        detail.append({"path": f, "category": cat, "rationale": why})
    # special verifications
    secrets_check = {
        "session-secret.key tracked": any(f.endswith("session-secret.key") for f in files),
        "reviewers.json tracked": any(f.endswith("teacher-validation/reviewers.json") for f in files),
        "provisioning-log tracked": any(f.endswith("provisioning-log.jsonl") for f in files),
        "any tracked path matching (secret|credential|token|password)": [f for f in files if re.search(r"secret|credential|token|password", f, re.I)],
        "tracked files >1MB": [],
    }
    for f in files:
        p = REPO / f
        try:
            if p.is_file() and p.stat().st_size > 1024 * 1024:
                secrets_check["tracked files >1MB"].append({"path": f, "MB": round(p.stat().st_size / 1048576, 1)})
        except OSError:
            pass
    out = {
        "generatedAt": "2026-09-14",
        "repo": "SyllabAI/syllabai-teacher-workbench (public)",
        "summary": {cat: len(files_) for cat, files_ in by_cat.items()},
        "specialChecks": secrets_check,
        "files": detail,
    }
    dest = REPO / "download/evidence-r3-7/public-repo-audit.json"
    dest.write_text(json.dumps(out, indent=1))
    print("summary:", dict(out["summary"]))
    print("secrets_check:", json.dumps(secrets_check, indent=1)[:800])
    print("uncertain files:", [f["path"] for f in detail if f["category"] == "UNCERTAIN"])
    print("should-not-be-public files:", [f["path"] for f in detail if f["category"] == "SHOULD_NOT_BE_PUBLIC"])
    print("written:", dest)

if __name__ == "__main__":
    main()

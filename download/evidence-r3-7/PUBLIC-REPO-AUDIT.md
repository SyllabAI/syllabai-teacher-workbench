# R3-7 — Public Repository Audit

Repo: `SyllabAI/syllabai-teacher-workbench` (public since 2026-09-14, flipped
on operator instruction only after a full-history secret re-scan).
Machine-readable classification: `public-repo-audit.json` (this directory).

## Method

Every tracked file (2325 at audit time) was classified by an explicit rule
table (`scripts/r3-7_public_repo_audit.py`) into: SAFE / OPERATIONAL_SAFE /
SHOULD_NOT_BE_PUBLIC / UNCERTAIN. Special checks ran on top: tracked-path
secret-name scan, tracked-file size scan, and (earlier, before the public
flip) a full-history scan of EVERY blob in ALL commits for GitHub-token
patterns and private-key material.

## Result

| Category | Count | Meaning |
|---|---|---|
| SAFE | 108 | application source, tests, tooling, docs, build manifests |
| OPERATIONAL_SAFE | 2216 | campaign evidence, read-model data, run logs, worklog, lockfiles, config |
| SHOULD_NOT_BE_PUBLIC (tracked) | 0 | — |
| UNCERTAIN | 1 | the historical 60MB source tarball (below) |

Explicit verifications (all negative = good):
- `session-secret.key` NOT tracked (gitignored line-level exclusion).
- `reviewers.json` NOT tracked and did not exist at audit time.
- `provisioning-log.jsonl` NOT tracked.
- No tracked path matches secret/credential/token/password naming.
- Zero token/private-key patterns in any historical blob (8 commits).

## Key judgments

- **Screenshots** (`download/evidence-r3-6/screenshots/`): show the workbench
  UI with SYNTHETIC attribution only ("E2E Rehearsal (R3-5 machine-gate
  test)", "Browser Verification (R3-6)"). No real reviewer names exist in the
  system yet (no real teachers onboarded — per R3-6/R3-7 directive).
- **Database identifiers**: all per-run random UUIDs (cross-run byte-diff
  decomposition in R3-4 proved UUIDs are regenerated per ingest). Nothing
  links to a person.
- **Corpus-derived material** (`data/review/`, dumps `r32/r34.noident`,
  `after-r35.dump.gz`): derived from the ingested question papers / mark
  schemes, which are PUBLIC in `SyllabAI/Past-Papers`. No PII, no credentials.
- **`db/custom.db`** (19.6MB, tracked): inspected — empty scaffold (User 0,
  Post 0). Harmless; flagged as hygiene candidate (should be untracked going
  forward; not worth a history rewrite).
- **`.env`**: contains a local sqlite FILE PATH only. No credentials.
- **`worklog.md`**: campaign narrative; blob-scanned clean.
- **`tool-results/`**: inspected — a copy of workbench source; no sensitive
  patterns.

## The one UNCERTAIN item — 60MB source tarball

`download/evidence-r3-6-b/workbench-source-2f6e8a7.tar.gz` entered history
via sandbox auto-commit `4c58b19` (`git add .` behavior), NOT by a deliberate
commit. Facts: byte-identical (sha256 `24ada70a…`) to the release asset on
`t-c04-r3-6-teacher-validation-workbench`; its contents are the 2f6e8a7 tree,
which is fully public in this same repo anyway — so NO additional exposure.

Decision (least-destructive, per directive): DO NOT rewrite frozen history.
Remediation applied instead:
1. `.gitignore` now excludes `*.tar.gz` / `*.dump*` and the evidence dir's
   tarballs;
2. `scripts/hooks/pre-commit` blocks release-bundle artifacts and
   reviewer-identity state from future commits;
3. `scripts/check-large-files.sh` fails >50MB, warns >5MB;
4. `docs/RELEASING.md` makes GitHub Releases the only channel for bundles.
If the operator later wants the blob gone, the least-destructive path is a
documented `git filter-repo` + coordinated force-push in a quiet period —
explicitly NOT done now because SHAs are evidence anchors.

## Going forward

- Reviewer identity state (`reviewers.json`, `provisioning-log.jsonl`) and
  the session secret are unversionable by rule and by hook.
- Any new large artifact must go to GitHub Releases; the pre-commit hook
  enforces it locally.

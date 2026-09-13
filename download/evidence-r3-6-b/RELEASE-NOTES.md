# T-C04 R3-6 — Teacher Validation Workbench: canonical state + staged intent

Milestone: the workbench now makes three states visually and semantically
impossible to confuse — (a) CANONICAL truth (authoritative DB), (b) STAGED
intent (never truth), (c) APPLIED events (attribution trail). 12/12 acceptance
gates VERIFIED. Follows R3-5 GREEN; no R3-5 gate weakened or redesigned.

## Commit SHAs (all VERIFIED present on GitHub at release time)

| Artifact | SHA | Where |
|---|---|---|
| syllabai-core local main @ R3-6 | `b37837a` | in `main` history |
| syllabai-core `main` at release | `9747d0a` | includes post-R3-6 importer hardening F-1/F-2/F-3 (`9747d0a`), verify_final_state re-anchor (`21cce2e`), coordination alignment (`704c3f1`) |
| workbench app @ R3-6 feature | `2f6e8a7` | durable at SyllabAI/syllabai-teacher-workbench (private, created 2026-09-14) |
| workbench evidence pack commit | `a5ee887` | same repo |
| workbench HEAD at release | `d11d778` | same repo (scratch/test-runner files only) |
| corpus Past-Papers | `c42b6a14` | unchanged from baseline |
| syllabai-parser | `d3415caa` | unchanged |

## Migration provenance

NO new migration for R3-6. V18 (`teacher_validation_review`) already stores
everything R3-6 displays. Migration head checked by NUMERIC MAX over the
remote tree (V17 lesson applied): max = V18. V1..V18 untouched, no V19
allocated. Flyway rows in campaign DB: 18.

## Canonical DB state (VERIFIED 2026-09-14, pre == post R3-6)

Identity `syllabai | T-C04-CAMPAIGN | 9615b69`; papers 81 SUGGESTED;
question_versions 766 = 758 SUGGESTED + 8 seed VALIDATED; 0 REJECTED;
schemes 641; `teacher_validation_events` = 6 (R3-5 rehearsal, attributed).
Quarantine `1c-2016jan` intact; no KG writes (T-C11 independence preserved).

## Verification matrix (claim labels)

- 12/12 acceptance gates: VERIFIED — see `VERIFICATION-VERDICT.txt` and
  `r3-6-state-manifest.json` (machine-readable) in this release.
- Test suite 42/42, RE-RUN 2026-09-14 at workbench `d11d778`:
  `test-results-rerun-r3-6b.log`. Real staging log sha256 identical pre/post
  suite (`d2bac629…`).
- Importer HARDENED upstream (`9747d0a`, F-1 pre-interpolation validation,
  F-2 plan-vs-apply TOCTOU guard, F-3 structured `reverses`): check-mode
  re-run against the REAL log under the hardened importer — chain valid
  (6 entries, head `891dbf10…`), 6/6 already-applied DUPLICATE, exit 0,
  real log untouched: `importer-check-mode-hardened-r3-6b.log`.
- Browser evidence: 10 screenshots + two-phase console logs, 0 console
  errors; real log untouched.
- Off-container durability: was BLOCKED (no PAT) at R3-6 time — NOW VERIFIED
  by this release upload + workbench repo push.

## Canonical vs staged vs applied — worked example (live)

- canonical: 8 seed question_versions VALIDATED, seed-locked, zero events;
  81 papers SUGGESTED.
- applied: `teacher_validation_events` seq 1 `VALIDATE
  question_version:00190480` by "E2E Rehearsal (R3-5 machine-gate test)".
- staged (isolated browser scratch log): seq 1 `VALIDATE
  exam_paper:f95f3b12` by "Browser Verification (R3-6)" — relationship
  WOULD_CHANGE_CANONICAL, chip "STAGED — NOT YET APPLIED".

## Assets

- Frozen R3-6 evidence pack (verify with `sha256sum -c SHA256SUMS`).
- `workbench-source-2f6e8a7.tar.gz` — full workbench source + tests +
  evidence packs at the R3-6 feature commit (self-contained).
- `SHA256SUMS.r3-6b` — covers the tarball, these notes, and the two R3-6-b
  re-verification logs.
- `importer-check-mode-hardened-r3-6b.log`, `test-results-rerun-r3-6b.log`.

NOTE — two pack files are NOT uploadable as release assets:
`phaseA-errors.txt` and `phaseB-errors.txt` are 0-byte files BY DESIGN
(zero browser console errors in both verification phases — the emptiness IS
the evidence). GitHub rejects 0-byte assets. Their SHA-256 (the canonical
empty-string digest `e3b0c442…b855`) is recorded in the pack's `SHA256SUMS`
and both files ship inside `workbench-source-2f6e8a7.tar.gz` under
`download/evidence-r3-6/` and in the syllabai-teacher-workbench repo.

## Honest-audit notes / corrections

- `r3-6-state-manifest.json` (frozen, unmodified) records core R3-5 commits
  as unpushed and importer sha `f6657901…` — true at R3-6 time. Since then:
  commits pushed (now in `main` history) and importer hardened by `9747d0a`
  (new sha `b71ef91b…`). Corrections recorded HERE; the frozen pack was not
  rewritten.
- Real teachers are still NOT pointed at the workbench (per R3-6 directive).
  Next safe action: operator reviews `VERIFICATION-VERDICT.txt` and decides
  on real-teacher onboarding (optionally server-side reviewer provisioning
  instead of local session files).

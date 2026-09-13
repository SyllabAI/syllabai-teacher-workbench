# T-C04 R3-7 — Reviewer Provisioning & Production Readiness

Milestone: the minimum production-safe boundary required before real
teachers/reviewers use the validation workbench. Follows R3-6 (operator-
accepted GREEN); no R3-5/R3-6 gate weakened; **real teachers still NOT
onboarded**.

## Commit SHAs (all VERIFIED on GitHub at release time)

| Artifact | SHA | Where |
|---|---|---|
| workbench R3-7 implementation | `3cb3aa8` | SyllabAI/syllabai-teacher-workbench (public) |
| workbench R3-7 evidence pack | `9d49b37` | same repo |
| syllabai-core main | `4343b5a` | importer F-1..F-4 — ZERO R3-7 commits to core |
| corpus Past-Papers | `c42b6a14` | unchanged |
| syllabai-parser | `d3415caa` | unchanged |

## Migration provenance

NO new migration. Numeric max over the remote migration tree is still V18;
campaign DB flyway rows = 18. R3-7 adds zero schema.

## What shipped

- **Reviewer provisioning** (CLI-only, no HTTP provisioning): registry
  outside git (0600) + append-only provisioning audit; tokens shown once,
  stored only as sha256; unique active names — no shared accounts; role
  `teacher` (staging privilege ONLY — apply remains importer-exclusive);
  revocation + re-provisioning kill sessions immediately (epoch binding);
  break-glass session-secret rotation command.
- **Sessions v2**: issuance REQUIRES a provisioned token; display name comes
  from the registry (client names ignored); payload binds reviewerId+epoch;
  legacy v1 cookies fail closed. Cookie: HttpOnly, SameSite=Strict, Secure
  in production, 12h.
- **Production fail-closed gate** (instrumentation): missing/undersized
  secret, missing reviewer registry, `TV_PUBLIC_HTTPS!=1`, implicit DB
  defaults → explicit startup failure. Boot check: insecure env fails to
  prepare (HTTP 500, all six problems listed); fully configured env serves
  200 (`prod-boot-check.log`).
- **Live canonical staging gate** (mirror of the importer — importer stays
  the sole authority): VALIDATE/REJECT/FLAG require LIVE SUGGESTED
  (fail-closed on feed outage); REVERSE requires prior applied + last-event
  consistency. CSRF: JSON content-type + same-origin Origin checks.
- **Explicit conflict semantics** (pure module; five R3-6 kinds preserved):
  open state-changing intent vs non-SUGGESTED canonical = BLOCKED + CONFLICT
  explanation; STALE + supersededBy[] with newer applied-event attribution.
  Never collapsed into one status field.
- **reviewerId in the staging log OUTSIDE the frozen hash base** (F-3
  pattern): bun helper reproduces real-log hashes; importer check-mode
  accepts reviewerId-bearing scratch logs (cross-side proof).
- **Repo hygiene**: identity state + `*.tar.gz`/`*.dump*` gitignored;
  pre-commit hook + `check-large-files.sh`; `docs/RELEASING.md`; the
  historical 60MB tarball documented as frozen (no history rewrite).

## Verification (claim labels)

- 11/11 mandated negative tests VERIFIED (see VERIFICATION-VERDICT.txt §5).
- Full suite: **97 pass / 0 fail / 343 expect()** across 6 files
  (R3-6 suites adapted to the v2 issuance contract — assertion semantics
  preserved; R3-7 suites new). `test-results-full.log`.
- eslint clean; tsc clean (app scope); `next build` success.
- Concurrency proof: A VALIDATE 200 → B REJECT 422 (explicit, not merged) →
  B FLAG 200 (events-only coexistence) → canonical unchanged, events=6,
  distinct reviewerIds.
- Stale intent: refused at 3 layers (relationship BLOCKED/STALE; live gate
  422; importer ABORT on a COPY log — `importer-abort-stale-intent-refusal.json`:
  "gate: … state VALIDATED, not SUGGESTED (seed lock / lifecycle violation) —
  aborting / ABORT — nothing written (fail-closed)").
- Importer untouched: sha256 `6f56c993…` @ core `4343b5a`; check-mode green
  vs real log (6/6 already-applied DUPLICATE), real log sha256 `d2bac629…`
  byte-identical pre/post the entire milestone.
- Canonical DB unchanged: identity `syllabai | T-C04-CAMPAIGN | 9615b69`;
  766 versions = 758 SUGGESTED + 8 seed VALIDATED + 0 REJECTED; 6 applied
  events; 18 flyway rows.
- Public-repo audit: 2325 files classified — SAFE 108, OPERATIONAL_SAFE
  2216, UNCERTAIN 1 (frozen tarball), SHOULD_NOT_BE_PUBLIC 0
  (`public-repo-audit.json` + `PUBLIC-REPO-AUDIT.md`).

## UNVERIFIED (honest gaps — need a real deployment host)

- TLS termination on an actual HTTPS host; HSTS/header behavior in front of
  Next.
- Boot check against the standalone server entry (`output: standalone`).
- Production backups/monitoring for registry + staging log.

## Next safe action

Operator reviews this pack. Deployment order when ready: real host with
`TV_PUBLIC_HTTPS=1` + mounted secret → provision first real reviewer →
onboarding decision. NOT before.

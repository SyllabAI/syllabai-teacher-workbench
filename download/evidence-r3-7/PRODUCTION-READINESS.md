# R3-7 — Production-Readiness Checklist

Status at milestone close. Claim labels: VERIFIED = proven by artifact in
this evidence pack; DOCUMENTED = policy/design statement; UNVERIFIED = not
yet exercised in a real deployment (expected — no production host exists yet).

## A. Reviewer identity & authorization

- [x] VERIFIED — provisioning via CLI only; token shown once, stored hashed
      (`importer-and-integrity-r3-7.log` CLI smoke; `tests/r3-7/session-r37`).
- [x] VERIFIED — no shared accounts (duplicate active name refused).
- [x] VERIFIED — staging authorization cannot be self-minted: tokenless or
      garbage-token `POST /api/session` → 403; client-supplied names ignored.
- [x] VERIFIED — role enforced: `teacher`-only issuance; signed `viewer`
      payloads → 403.
- [x] VERIFIED — revocation immediate (registry revalidation on every
      staging write; epoch bump kills re-provisioned credentials).
- [x] VERIFIED — unauthorized canonical mutation impossible: serving pool is
      connection-level `default_transaction_read_only=on`; hostile sweep
      (all routes × state-changing verbs, with and without cookies) leaves
      canonical state byte-identical (R3-6 suite re-run green + R3-7 sweep).

## B. Session security

- [x] VERIFIED — secret external to repo (0600 file, gitignored; absent from
      all tracked trees and all history blobs).
- [x] VERIFIED — expiration enforced (12h; expired → 403).
- [x] VERIFIED — logout exists (DELETE /api/session clears cookie); real
      security = revocation (immediate), rotation (global).
- [x] VERIFIED — production never falls back to development secrets:
      `loadSecret()` throws in production; instrumentation gate lists the
      problem and the server fails to prepare (`prod-boot-check.log` A).
- [x] VERIFIED — cookie: HttpOnly + SameSite=Strict always, Secure in
      production; `TV_PUBLIC_HTTPS=1` required or startup fails (boot check).
- [x] VERIFIED — rotation invalidates all sessions
      (`tests/r3-7/session-r37` "rotation invalidates…").

## C. Deployment boundary

- [x] DOCUMENTED — HTTPS terminates at the reverse proxy (Caddy in this
      environment); workbench declares `TV_PUBLIC_HTTPS=1` so Secure cookies
      are only ever promised over TLS.
- [x] VERIFIED — secure cookie config + SameSite=Strict (unit-tested).
- [x] VERIFIED — CSRF: state-changing routes require `application/json` and
      reject cross-origin `Origin` headers (415/403 paths tested); session
      cookie SameSite=Strict is the primary browser-side defense.
- [x] DOCUMENTED — reverse proxy forwards X-Forwarded-Proto/Host; the app
      itself never trusts client IP for authorization decisions.
- [x] DOCUMENTED — allowed origins: same-origin only for state-changing
      routes; GETs are read-only review data.
- [x] VERIFIED — environment configuration: production REQUIRES explicit
      `TV_PGHOST/TV_PGUSER/TV_PGDATABASE` (no silent defaults — boot check
      lists all three when missing).
- [x] VERIFIED — DB connection: read-only enforcement is at the CONNECTION
      level (`options: "-c default_transaction_read_only=on"`), proven by
      `SHOW transaction_read_only` + in-suite UPDATE refusal.
- [x] VERIFIED — staging-log persistence: append-only JSONL with fsync per
      entry; env-isolatable for tests; real log sha256 unchanged
      (`d2bac629…`) across the whole milestone.

## D. Concurrency & auditability

- [x] VERIFIED — two provisioned reviewers staging conflicting decisions on
      one target: second reviewer's conflicting state-change explicitly
      refused 422 (never merged); FLAG coexists by design (events-only);
      canonical state and applied-event count unchanged throughout.
- [x] VERIFIED — stale intent detectable at three layers: (1) relationship
      layer marks BLOCKED + STALE with superseding attribution (pure, unit
      tested); (2) live staging gate refuses non-SUGGESTED targets; (3) the
      importer refuses forced stale entries on a COPY log (SUGGESTED-only).
- [x] VERIFIED — applied events retain attribution (event feed = 6 rehearsal
      events, each with reviewer + seq + hash + timestamp).
- [x] DOCUMENTED — minimum audit record (single sources of truth, no new
      model): staged = staging-log entry {seq, ts, action, target identity,
      reviewer name + reviewerId, note, hash chain}; applied =
      `teacher_validation_events` (V18) {decision_seq/hash linkage, action,
      reviewer, result_state, applied_at}; provisioning =
      `provisioning-log.jsonl` {ts, PROVISION/REVOKE, id, name, by, note}.
      Reversal = REVERSE entry/event referencing "reverses seq N" (+ F-3
      structured field on new logs).

## E. Repository

- [x] VERIFIED — public-repo audit complete (see PUBLIC-REPO-AUDIT.md):
      0 tracked SHOULD_NOT_BE_PUBLIC files; identity state and secrets
      unversionable by ignore-rule AND pre-commit hook.
- [x] VERIFIED — large-artifact guard (`check-large-files.sh` + hook);
      future bundles go to GitHub Releases (`docs/RELEASING.md`).
- [x] DOCUMENTED — the historical 60MB tarball stays frozen (no history
      rewrite); recorded as the single UNCERTAIN classification.

## F. Explicitly NOT done (scope discipline)

- No new validation-state model; no second source of truth; no UI state
  becomes canonical truth; no learner-state duplication.
- Importer untouched: sha256 `6f56c993…` (core `4343b5a`); check-mode green
  on the real log (6/6 already-applied DUPLICATE, chain valid, log
  byte-identical pre/post).
- NO migration: V18 suffices; remote migration numeric-max is still V18.
- Real teachers NOT onboarded — this milestone is the boundary BEFORE that
  decision.

## G. Known gaps (honest, labeled UNVERIFIED)

- No real HTTPS host has served the workbench yet: TLS termination, HSTS and
  header behavior in front of Next are UNVERIFIED until a production host
  exists (boot check simulates the production env locally).
- `next start` warns that `output: standalone` prefers
  `node .next/standalone/server.js`; the standalone entry also executes the
  instrumentation gate (built into `.next/server/instrumentation.js`), but a
  dedicated boot check against the standalone server is UNVERIFIED.
- Backups/monitoring of `reviewers.json` + staging log on a production host:
  policy stated, infrastructure UNVERIFIED (no host).

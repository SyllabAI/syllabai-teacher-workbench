# R3-7 IMPLEMENTATION PLAN — Reviewer Provisioning & Production Readiness

Written BEFORE coding (campaign discipline). Base: workbench `5d4b502`,
core `4343b5a` (importer F-1..F-4; migration numeric-max over remote tree:
**V18 — no new migration; none needed**). R3-5/R3-6 semantics, gates and the
importer are NOT redesigned; the importer is touched by NOBODY in R3-7
(sha256 recorded, re-verified).

## Gap analysis (from code inspection, honest)

1. `POST /api/session` issues a teacher session to ANY caller with any
   displayName — staging authorization is obtainable without a provisioned
   identity. (R3-6 scoped authz to "a verified session"; R3-7 closes WHO can
   get one.)
2. `loadSecret()` AUTO-GENERATES the HMAC secret when missing — dev
   convenience that must fail closed in production.
3. Session cookie has no `Secure` flag (dev-local OK; production must be
   explicit + validated at startup).
4. No revocation: sessions are valid until 12h expiry; nothing can kill one.
5. Staging decidability gate reads the STATIC read-model registry, not the
   LIVE canonical DB — after an importer apply, a second reviewer can stage
   against a target that is no longer SUGGESTED (stale intent enters the log;
   the importer would refuse it later, but the workbench does not say so).
6. Open REJECT vs canonical VALIDATED (and VALIDATE vs REJECTED) renders
   WOULD_CHANGE_CANONICAL although the importer will REFUSE it (SUGGESTED-only)
   — conflict must be BLOCKED, explicitly.
7. Staged entries carry display-name attribution only; no stable reviewer id.
8. CSRF: SameSite=Strict cookie mitigates, but no Origin/Content-Type check on
   state-changing routes.
9. Public repo has no deliberate artifact classification; one 60MB tarball in
   history (auto-commit 4c58b19) — frozen, documented, not rewritten.

## Design decisions

- **Identity**: reviewer registry (durable file, 0600, OUTSIDE git, env-
  overridable path for tests): `{id, name, role:"teacher", tokenHash
  (sha256), status active|revoked, epoch, createdAt, revokedAt?,
  provisionedBy}`. Tokens are 32-byte random (`tvr_…`), shown ONCE at
  provisioning, stored ONLY as hash. One token per reviewer — no shared
  account. Append-only provisioning audit log (JSONL) records
  PROVISION/REVOKE/ROTATE with operator attribution.
- **Sessions v2**: payload `{v:2, reviewerId, name, role, exp, epoch}`.
  Issuance REQUIRES a valid provisioned token; `name` comes from the
  registry (client-supplied displayName is IGNORED — no impersonation).
  Staging revalidates the reviewer against the registry on EVERY write
  (active + epoch match) → revocation is immediate; a stolen cookie dies at
  revoke/re-provision; expiry still bounds all sessions. Old v1 cookies fail
  verification (no reviewerId) — fail-closed migration, GETs unaffected.
- **reviewerId in the staging log**: added OUTSIDE the frozen hash base
  (exact F-3 `reverses` pattern) so existing chain + importer verification
  stay valid. Python importer ignores unknown JSON fields (verified by
  running its check-mode against a scratch log containing reviewerId).
- **Live canonical staging gate** (mirror of importer gates — importer stays
  the only authority): route supplies `liveGate` to `appendDecision`;
  VALIDATE/REJECT/FLAG require LIVE canonical SUGGESTED (fail-closed when
  canonical feed unavailable: staging refused, GETs degrade as in R3-6);
  REVERSE requires the referenced prior entry to have a matching applied
  event that is still the last event on that target (R3-5 reverse-
  consistency). Divergence between registry state and live state is
  surfaced by the live gate itself (live wins).
- **Relationship semantics** (pure module, R3-6 five kinds unchanged):
  open state-changing intent vs canonical ≠ SUGGESTED and ≠ resulting →
  BLOCKED (importer will refuse) + `stale: true` + `supersededBy[]` when
  applied events on that target postdate the staged intent. AGREES
  (VALIDATE-vs-VALIDATED etc.), ALREADY_APPLIED, APPLIED_THEN_REVERSED,
  FLAG-events-only: all preserved exactly.
- **CSRF/origin**: state-changing routes require `Content-Type:
  application/json` and reject mismatched `Origin` (when the browser sends
  one). SameSite=Strict retained.
- **Production fail-closed config**: `assertProductionConfig()` — in
  production REQUIRES: session secret file present ≥32B (no auto-gen),
  reviewers registry present, `TV_PUBLIC_HTTPS=1` (Secure cookie honesty),
  explicit `TV_PGHOST/TV_PGUSER/TV_PGDATABASE` (no silent DB defaults).
  Wired via `src/instrumentation.ts register()` → startup failure. Cookie
  `secure: NODE_ENV==="production"`.
- **No migration** (V18 suffices); **importer untouched**; **no apply
  endpoint** (unchanged — apply stays importer-only).

## Files

NEW: `src/lib/reviewers.ts`, `src/lib/prod-config.ts`, `src/instrumentation.ts`,
`scripts/provision-reviewer.ts`, `scripts/check-large-files.sh`,
`tests/r3-7/{relationship-r37,session-r37,integration-r37}.test.ts`,
`docs/RELEASING.md`,
`download/evidence-r3-7/{IMPLEMENTATION-PLAN.md,PRODUCTION-READINESS.md,
REVIEWER-PROVISIONING.md,PUBLIC-REPO-AUDIT.md,public-repo-audit.json,
VERIFICATION-VERDICT.txt,r3-7-state-manifest.json,SHA256SUMS,…}`.
EDIT: `src/lib/session.ts` (v2, prod secret policy, cookieConfig),
`src/lib/decision-log.ts` (reviewerId outside hash, liveGate),
`src/lib/canonical-relationship.ts` (BLOCKED + stale — pure),
`src/app/api/session/route.ts` (token-required, flags),
`src/app/api/decisions/route.ts` (registry revalidation, liveGate, origin/CT),
`src/app/api/canonical/*` (no semantic change; reused),
`review-workbench.tsx` (session dialog w/ token, who-am-i + logout, stale/
blocked chips), `.gitignore` (registry/log/tarball exclusions).

## Reused vs new

REUSED: importer (untouched), canonical.ts feed, read-model registry,
hash-chain log, R3-6 relationship kinds, isolation pattern (TV_LOG_FILE).
NEW CONTRACTS: reviewer registry + provisioning log + CLI; session payload
v2; `liveGate` input to appendDecision; instrumentation fail-closed checks.
NO new API endpoints (POST /api/session contract tightened — documented).

## Tests → required negative gates

r3-7 suites map 1:1 to the 11 mandated negative tests (unauth 403, forged,
expired, wrong-role, prod-secret fail-closed, insecure-cookie startup
failure, canonical-mutation impossibility (hostile sweep), concurrent
conflict explicit, stale intent refused (live gate + importer check-mode on
COPY), revocation kills session, real-log sha guard) + reviewerId chain
compatibility (bun verifyChain AND python importer check-mode) + prod boot
check script (next start, insecure env → explicit failure; secure env →
healthy then killed).

## Acceptance for GREEN

All mandated tests VERIFIED; lint/tsc/build clean; importer sha unchanged
(6f56c993…) + check-mode green on real log; canonical DB byte-state
unchanged (counts + identity + events=6); real staging log sha unchanged;
public-repo audit complete with classifications; evidence pack + release
t-c04-r3-7-production-readiness with re-downloaded hash-verified assets.
R3-7 GREEN may NOT be claimed from R3-6 suites alone.

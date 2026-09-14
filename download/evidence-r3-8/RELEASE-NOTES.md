# T-C04 R3-8 — Real Host Deployment & First Reviewer Readiness

Pure deployment milestone on the actual host chain: prove the R3-7
security/authorization model on a real deployment, then provision exactly one
real reviewer under controlled conditions. No validation semantics added, no
importer redesign, no teacher-facing expansion; **general teacher onboarding
still NOT authorized**.

## Commit provenance (read this first)

| Artifact | SHA | Where |
|---|---|---|
| workbench R3-8 (original deployed commit) | `34ed7e396a20dfcd0c08cf8d082c8d5ac6561c36` | local-only; .git lost to a sandbox reset BEFORE push |
| workbench R3-8 (reconstructed commit carrying this pack) | see repo HEAD | SyllabAI/syllabai-teacher-workbench (public) |
| syllabai-core main | `4343b5a` | importer F-1..F-4 — ZERO R3-8 commits to core |
| corpus Past-Papers | `c42b6a14` | unchanged |
| syllabai-parser | `d3415caa` | unchanged |

The sandbox environment reset destroyed `.git` after deployment evidence was
captured but before the push. The working tree was recovered from the platform
snapshot and re-committed: the tree content is verified (evidence files
byte-match `SHA256SUMS`; delta vs remote main `c42ab03f` limited to the R3-8
files listed in worklog addendum 1), but the new commit SHA necessarily
differs from the deployed original. The original SHA is preserved in
`deployed-commit.txt` and `r3-8-state-manifest.json` — both captured on the
host BEFORE the reset, hashes verifiable in this pack.

## Migration provenance

NO new migration. Numeric max over the remote migration tree is still V18;
campaign DB flyway rows = 18. R3-8 adds zero schema.

## Deployment chain (Phase A/B)

`public HTTPS edge (Aliyun ALB, *.space-z.ai wildcard, TrustAsia DV cert,
notAfter 2026-11-02) -> platform Caddy :81 -> access-log forwarder :3000 ->
Next.js standalone :3001 (loopback only)`.

- Production state ALL outside the repo, 0600: `/home/z/workbench-prod`
  (staging log, reviewer registry, provisioning audit, session secret,
  workbench.env). Explicit `TV_*` env; `TV_PUBLIC_HTTPS=1`; secure cookies
  observed on issued cookies over the real chain; deploy preflight aborts on
  any config gap; negative boot x4 (HTTPS=0 / missing secret / missing
  registry / missing TV_PGHOST) each refuse to start, exit 1.
- Host/platform inventory: `PHASE-A-DEPLOYMENT-RECON.md`.

## Real-host findings (all fixed, regression-tested in tests/r3-8)

1. Next.js 16.1.3 standalone swallows a `register()` throw as
   unhandledRejection — process stayed listening, every route 500'd. Fix:
   production gate now `process.exit(1)` (uncatchable). `negative-boot-results.txt`.
2. Unknown action `"PROMOTE"` passed the write path (DecisionAction was
   compile-time only) and poisoned the production staging log. Fix: runtime
   action-enum validation (422). Poisoned entry preserved in evidence
   (`finding-promote-poisoned-log.txt`, `finding-promote-postfix.log`); log
   repaired to bootstrapped-empty; replay after fix -> 422, log untouched.
3. `verifyChain` hashed reviewerId INTO the base while `writeEntry` and the
   importer's frozen base exclude it — every HTTP-staged entry reported
   `chainValid:false`. Fix: verifyChain mirrors the frozen base; regression
   test proves python-identical recomputation.

## Real network boundary (Phase C) — VERIFIED through the ingress chain

no-session/forged/expired/revoked/wrong-role -> 403; cross-origin -> 403;
non-JSON -> 415; malformed target -> 422; stale target -> 422 with lifecycle
message; Secure+HttpOnly+SameSite=strict cookie issued; provisioned reviewer
authenticates 200; canonical DB physically read-only from the workbench
(server-enforced `default_transaction_read_only=on`; UPDATE+INSERT denied);
staging log + registry persist across restart; restart does NOT regenerate the
secret (byte-identical); unexpired session survives restart by documented
design; bogus token -> 403. `phase-c-*.log`, `phase-c-restart-battery.log`.

## Backup & recovery (Phase D)

Classification: staging log + registry + provisioning audit + session secret =
BACKED UP/RECOVERABLE (operator tarballs + SHA256SUMS); workbench.env =
reproducible; access/monitor logs = disposable; canonical DB = campaign-owned,
read-only from the workbench, untouched by any rehearsal. D1 (mechanics) and
D2 (full semantics: chain verifies WITH entries, attribution preserved,
revoked reviewer rejected against restored registry) both VERIFIED.
`phase-d-*.log`. Honest note on D1's first loss-phase attempt inside
`VERIFICATION-VERDICT.txt`.

## Monitoring (Phase E)

`monitor.sh` 60s loop: process up/restart detection, staging-chain validity,
canonical read probe, registry load, auth-failure counter (observed counting
the live negative tests), 4xx/5xx spikes; access-log forwarder feeds
per-request JSONL. No large observability subsystem.

## Exactly one real reviewer (Phase F)

credential-1 `tvr-92d298ba` provisioned (token shown once, stored only as
sha256, delivered via 0600 operator file) -> real-chain auth 200 -> REVOKE
(epoch 2): live session 403 AND token 403 -> credential-2 `tvr-af21ceeb` (same
human) -> session-secret rotation -> credential-2 authenticates post-rotation.
END STATE: exactly ONE active reviewer. Tokens NEVER in repo/evidence/chat —
IDs + sha256 only. `phase-f-*.log`, `phase-f-audit-chain.jsonl.txt`.

## Controlled end-to-end rehearsal (Phase G)

Marked target `ff67ead3-97b4-43db-aff0-37515d9269f7` (q08-3815dec0 v1), note
"R3-8 REHEARSAL — NOT AN EDUCATIONAL DECISION": stage VALIDATE (canonical
unchanged) -> importer check -> apply run `0f6549e8` (event 7, attribution:
run id, decision_seq 1, decision_hash == staged hash, reviewer, marked note)
-> stage REVERSE -> apply run `ffabb2c7` (event 8) -> canonical restored 758
SUGGESTED / 8 VALIDATED, flyway 18, identity `T-C04-CAMPAIGN @ 9615b69`, no
unintended target (3-angle proof). UI screenshots with attribution badges;
zero console/page errors through the real ingress. `phase-g-rehearsal.log`,
`screenshots/`, `r3-8-state-manifest.json`.

## Regression / guards

r3-6: 44 pass + r3-7: 53 pass + r3-8: 7 pass, 0 fail
(`test-results-full-r3-8.log`); real campaign log sha256 `d2bac629…`
identical pre/post; production state combined sha identical pre/post; operator
slip (scratch provision to dev defaults) documented + cleaned
(`operator-slip-scratch-provision.txt`).

## Claim labels (honest)

- VERIFIED: every phase claim above with captured artifacts in this pack;
  all Phase B–G evidence is REAL-HOST evidence (only the bun test suites and
  pre-deploy negative-boot matrix are LOCAL-SIMULATION artifacts).
- INFERRED: platform edge route registration being control-plane driven.
- UNVERIFIED: arbitrary-external-network fetch of the public hostname (all
  in-session probes traverse public DNS + edge TLS from inside the container;
  the definitive preview hostname is operator-side state). GREEN is therefore
  CONDITIONAL on that one operator click-through check — every other final-gate
  item is independently evidenced (see VERIFICATION-VERDICT.txt final section).
- REPORTED: platform-managed components not directly inspectable (Caddyfile
  contents, ALB config) — behavior verified empirically.

## Next safe action

Operator: (1) fresh PAT -> push this pack + cut `t-c04-r3-8` release with all
evidence assets + source tarball; (2) operator click-through of the platform
preview URL to close the single UNVERIFIED item; (3) ONLY THEN, as a separate
decision: first-teacher onboarding.

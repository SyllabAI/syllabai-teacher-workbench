# R3-8 Phase A — Deployment Reconnaissance (before any change)

Task ID: R3-8 · Agent: main · Date: 2026-09-14 (UTC+8)

## Base commits (AGENT.md §8)

| Repo | Base | Sync state |
|---|---|---|
| syllabai-teacher-workbench (local) | `f06cc39` | ahead of remote `main` (`c42b03`) by ONE workspace auto-commit `f06cc39` — inspected: benign R3-7 run artifacts (importer check-mode ABORT proofs, asset-verify script, scratch-log updates). No divergence. Push PENDING operator PAT (none in session; not persisted by design). |
| syllabai-teacher-workbench (remote main) | `c42b03` | fetched anonymously (public repo) |
| syllabai-core | `4343b5a` | synced with origin (importer F-1..F-4 hardened) |
| Past-Papers | `c42b6a14` | unchanged |
| syllabai-parser | `d3415caa` | unchanged |

## Host / deployment environment (VERIFIED by direct inspection, 2026-09-14)

| Dimension | Finding |
|---|---|
| Hosting platform | z.ai agent sandbox container (KATA), Aliyun cloud, region `cn-hongkong` (`FC_REGION`) |
| Container identity | `c-6aa6a9f9-14d96228-adb5c4149b99` (`FC_CONTAINER_ID`/`FC_INSTANCE_ID`); function `ws-53abbeae-8642-42f8-af6a-e1b918e5b53e` |
| Reverse proxy / ingress | Platform-managed **Caddy** (runs as root, config `/app/Caddyfile` root-only), listening `*:81` (= `FC_CUSTOM_LISTEN_PORT`). Behaviorally VERIFIED: `:81 → 127.0.0.1:3000` (502 with no upstream; 200 with probe server on 3000). |
| TLS termination | **Platform edge** — Aliyun ALB (`alb-1i2q34bllrtyl61zig.cn-hongkong.alb.aliyuncsslbintl.com`, IPs 47.83.197.91 / 47.239.88.7 / 47.239.134.228). Wildcard DNS `*.space-z.ai`. TLS certificate verification PASSED from inside (`ssl_verify_result=0`) on `https://preview-*.space-z.ai`. Caddy hop is plain HTTP inside the container network (edge terminates TLS). |
| Public hostname | `https://preview-53abbeae-8642-42f8-af6a-e1b918e5b53e.space-z.ai/` (function-id pattern). Edge route registration is control-plane driven: all candidate hosts returned edge 404 pre-deployment. Re-verify in Phase C after deployment registration. |
| Environment-variable mechanism | Process environment; platform injects `FC_*` vars. App deployment uses a dedicated protected env file (0600, OUTSIDE the repo) sourced by the deploy script. |
| Secret storage mechanism | Filesystem, OUTSIDE the git repo: `/home/z/workbench-prod/secrets/` (dir 0700, files 0600). Session secret generated out-of-band with openssl; never committed, never logged, never in evidence. |
| Persistent storage — staging log | `/home/z/workbench-prod/state/decision-log.jsonl` (production log, bootstrapped empty; TV_LOG_FILE override). The R3-6/R3-7 campaign log at `download/teacher-validation/decision-log.jsonl` (sha256 `d2bac629…`) is frozen DEV/TEST evidence — production must NOT write to it. |
| Persistent storage — reviewer registry | `/home/z/workbench-prod/state/reviewers.json` (TV_REVIEWERS_FILE) + `/home/z/workbench-prod/state/provisioning-log.jsonl` (TV_PROVISIONING_LOG_FILE), outside repo (auto-commit protection). |
| Canonical DB connection | PostgreSQL 17 @ `127.0.0.1:5432/syllabai`, user `syllabai`, explicit `TV_PGHOST/TV_PGUSER/TV_PGDATABASE` (production gate forbids silent defaults). Workbench connections are read-only at the connection level: `options: -c default_transaction_read_only=on` (src/lib/canonical.ts). |
| Backup mechanism | None platform-managed for container FS. R3-8 Phase D establishes operator-controlled backup + restore rehearsal for workbench-owned state. |
| Logging / monitoring | App stdout only (no platform log aggregation visible). R3-8 Phase E adds: access-log forwarder (3000→app), status monitor, auth-failure counter. |
| Restart / deploy behavior | Container long-running (tini PID 1). Platform Caddy is platform-supervised. App process supervised by operator scripts (start/stop/restart + pidfile + health gating); documented as manual-supervision (honest limitation). |
| Network boundaries | App binds `127.0.0.1` ONLY (never `0.0.0.0`); all external access traverses edge TLS → Caddy:81 → app. Postgres binds `127.0.0.1` only. Platform-internal ports (12600/19001/19005/19006) unrelated to the workbench. |

## R3-7 mechanisms carried into production unchanged (code-inspected, VERIFIED)

- `src/instrumentation.ts` → `assertProductionConfig()` throws at start unless: secret file exists (≥32B), reviewer registry exists, `TV_PUBLIC_HTTPS=1`, `TV_PGHOST/TV_PGUSER/TV_PGDATABASE` all set. Fail-closed.
- Sessions: payload v2 `{v,reviewerId,name,role,exp,epoch}`, HMAC-SHA256, 12h expiry, cookie `tvs` HttpOnly + SameSite=Strict + Secure (production), issued ONLY against provisioned reviewer tokens (registry, SHA-256 token hashes, shown once).
- Staging: CSRF guard (application/json + Origin==Host) → session verify → registry revalidation (revocation/epoch kills live sessions) → live-canonical gate (fail-closed on DB outage) → append to hash-chained staging log with `reviewerId` outside frozen hash base.
- Canonical DB: read-only enforced at connection level; importer (syllabai-core @ `4343b5a`) remains the ONLY canonical apply authority.
- Provisioning CLI: `scripts/provision-reviewer.ts` (provision / revoke / list / rotate-session-secret), audit JSONL append-only.

## No-code-change conclusion

Phase A finds NO deployment-required change to validation semantics, importer, or
session model. R3-8 deployment adds ONLY operational infrastructure (deploy scripts,
access-log forwarder, monitor, state/secret directories) — no R3-5/R3-6/R3-7 gate is
weakened. Production staging log is a NEW file (bootstrapped empty); campaign dev log
remains frozen evidence.

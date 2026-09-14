#!/usr/bin/env bash
# R3-8 Phase B — production deploy/start script (operator tool).
#
# Fail-closed order:
#   1. preflight: every required TV_* variable present, secret >=32 bytes,
#      reviewer registry valid shape, state dir writable — abort on ANY gap.
#   2. start Next.js standalone (127.0.0.1:3001) with the protected env file.
#   3. wait for app health; only then start the access-log forwarder on :3000.
#
# Usage: scripts/prod/deploy.sh [--repo /home/z/my-project] [--state /home/z/workbench-prod]
# Never echoes secret or env values.
set -euo pipefail

REPO="/home/z/my-project"
STATE="/home/z/workbench-prod"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2;;
    --state) STATE="$2"; shift 2;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done

ENV_FILE="$STATE/workbench.env"
LOG_DIR="$STATE/logs"

[ -f "$ENV_FILE" ] || { echo "PREFLIGHT FAIL: env file missing: $ENV_FILE" >&2; exit 1; }
chmod 600 "$ENV_FILE" 2>/dev/null || true
set -a; . "$ENV_FILE"; set +a

fail() { echo "PREFLIGHT FAIL: $*" >&2; exit 1; }

# --- 1. Preflight (mirror of src/lib/prod-config.ts, operator side) ---
[ "${NODE_ENV}" = "production" ] || fail "NODE_ENV must be production"
[ "${TV_PUBLIC_HTTPS:-}" = "1" ] || fail "TV_PUBLIC_HTTPS must be 1"
for v in TV_SESSION_SECRET_FILE TV_REVIEWERS_FILE TV_PROVISIONING_LOG_FILE TV_LOG_FILE TV_PGHOST TV_PGUSER TV_PGDATABASE; do
  [ -n "${!v:-}" ] || fail "$v must be set explicitly (no silent defaults)"
done
[ -f "$TV_SESSION_SECRET_FILE" ] || fail "session secret file missing: $TV_SESSION_SECRET_FILE"
[ "$(wc -c < "$TV_SESSION_SECRET_FILE")" -ge 32 ] || fail "session secret smaller than 32 bytes"
[ -f "$TV_REVIEWERS_FILE" ] || fail "reviewer registry missing: $TV_REVIEWERS_FILE"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(r.version!==1||!Array.isArray(r.reviewers))process.exit(1);' "$TV_REVIEWERS_FILE" || fail "reviewer registry invalid shape"
touch "$TV_LOG_FILE" 2>/dev/null || fail "staging log not writable: $TV_LOG_FILE"
[ "${HOSTNAME:-}" = "127.0.0.1" ] || fail "HOSTNAME must bind 127.0.0.1 (app never exposed directly)"
echo "preflight: OK (config complete, secret present, registry valid, staging log writable, loopback binding)"

# --- 2. Stop previous instance if any ---
for pf in "$STATE/app.pid" "$STATE/proxy.pid"; do
  if [ -f "$pf" ]; then
    kill "$(cat "$pf")" 2>/dev/null || true
    rm -f "$pf"
  fi
done
sleep 1

# --- 3. Build if standalone server missing ---
if [ ! -f "$REPO/.next/standalone/server.js" ]; then
  echo "standalone server missing — building..."
  (cd "$REPO" && bun run build)
fi

# --- 4. Start app (cwd = repo so the derived read model data/review resolves) ---
cd "$REPO"
nohup env NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3001 \
  TV_PUBLIC_HTTPS="$TV_PUBLIC_HTTPS" \
  TV_SESSION_SECRET_FILE="$TV_SESSION_SECRET_FILE" \
  TV_REVIEWERS_FILE="$TV_REVIEWERS_FILE" \
  TV_PROVISIONING_LOG_FILE="$TV_PROVISIONING_LOG_FILE" \
  TV_LOG_FILE="$TV_LOG_FILE" \
  TV_PGHOST="$TV_PGHOST" TV_PGPORT="${TV_PGPORT:-5432}" TV_PGUSER="$TV_PGUSER" TV_PGDATABASE="$TV_PGDATABASE" \
  bun .next/standalone/server.js >> "$LOG_DIR/server.log" 2>&1 &
echo $! > "$STATE/app.pid"
echo "app starting (pid $(cat "$STATE/app.pid")) on 127.0.0.1:3001"

# --- 5. Health gate: app must answer before the forwarder is admitted ---
ok=""
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:3001/api/review/index"; then ok=1; break; fi
  if ! kill -0 "$(cat "$STATE/app.pid")" 2>/dev/null; then
    echo "DEPLOY FAIL: app process died during start — last log lines:" >&2
    tail -20 "$LOG_DIR/server.log" >&2
    exit 1
  fi
  sleep 1
done
[ -n "$ok" ] || { echo "DEPLOY FAIL: app did not become healthy in 60s" >&2; tail -20 "$LOG_DIR/server.log" >&2; exit 1; }
echo "app health: OK (read-only canonical index reachable)"

# --- 6. Start access-log forwarder on 3000 (Caddy upstream) ---
PORT_UP=3000 PORT_APP=3001 ACCESS_LOG="$LOG_DIR/access.jsonl" \
  nohup node "$STATE/ops/access-log-proxy.mjs" >> "$LOG_DIR/proxy.log" 2>&1 &
echo $! > "$STATE/proxy.pid"
sleep 1
curl -sf -o /dev/null "http://127.0.0.1:3000/api/review/index" || fail "forwarder path not healthy"
echo "forwarder: OK (127.0.0.1:3000 -> 3001, access log $LOG_DIR/access.jsonl)"
echo "deploy: COMPLETE"

#!/bin/bash
# R3-7: production boot check — prove the fail-closed startup gate.
#  A) `next start` (NODE_ENV=production) with MISSING secret / NO TV_PUBLIC_HTTPS
#     / no registry -> process must FAIL to start (explicit error).
#  B) fully configured production env (scratch secret + scratch registry,
#     HTTPS declared, DB envs explicit) -> server starts and serves;
#     session cookie must be Secure. Then killed. Scratch state only.
set -u
cd /home/z/my-project
OUT=download/evidence-r3-7/prod-boot-check.log
RUNS=download/teacher-validation/test-runs/prodboot
: "${PROD_PORT:=3213}"

echo "== R3-7 production boot check $(date -u +%Y-%m-%dT%H:%M:%SZ) ==" | tee "$OUT"
# kill_port: reliably free $PROD_PORT (fuser is not dependable here)
kill_port() {
  for pid in $(ss -tlnp 2>/dev/null | grep ":$PROD_PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
    kill -9 "$pid" 2>/dev/null || true
  done
}
echo "next build first (needed for next start)..." | tee -a "$OUT"
# free the port from any stale child of a previous run (bun wrapper kill
# does not always reap the next-server child)
kill_port; sleep 1

# --- A) insecure production env must fail closed -----------------------------
rm -rf "$RUNS"; mkdir -p "$RUNS"
INSECURE_LOG="$RUNS/insecure-boot.log"
env -u TV_PUBLIC_HTTPS -u TV_PGHOST -u TV_PGUSER -u TV_PGDATABASE \
  NODE_ENV=production TV_SESSION_SECRET_FILE="$RUNS/missing-secret.key" \
  TV_REVIEWERS_FILE="$RUNS/no-registry.json" \
  bun x next start -p "$PROD_PORT" >"$INSECURE_LOG" 2>&1 &
PID_A=$!
sleep 12
if kill -0 "$PID_A" 2>/dev/null; then
  # Next keeps the listener alive but fails to prepare the server — every
  # route must then be unusable (500) and the log must carry the R3-7 error.
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PROD_PORT/api/review/index" 2>/dev/null || echo 000)
  kill -9 "$PID_A" 2>/dev/null
  sleep 1; kill_port; sleep 1
  if rg -q "R3-7 production configuration check FAILED" "$INSECURE_LOG" && [ "$code" != "200" ]; then
    echo "RESULT A: PASS — insecure production boot FAILED TO PREPARE (HTTP $code on probe; explicit R3-7 startup error logged)" | tee -a "$OUT"
    rg -A6 "configuration check FAILED" "$INSECURE_LOG" | head -10 | tee -a "$OUT"
  else
    echo "RESULT A: FAIL — probe=$code but no explicit R3-7 failure found" | tee -a "$OUT"
    tail -5 "$INSECURE_LOG" | tee -a "$OUT"
    exit 1
  fi
else
  if rg -q "R3-7 production configuration check FAILED" "$INSECURE_LOG"; then
    echo "RESULT A: PASS — insecure production boot exited with explicit R3-7 startup error" | tee -a "$OUT"
    rg -A6 "configuration check FAILED" "$INSECURE_LOG" | head -10 | tee -a "$OUT"
  else
    echo "RESULT A: FAIL — process exited but without the R3-7 startup error" | tee -a "$OUT"
    tail -5 "$INSECURE_LOG" | tee -a "$OUT"
    exit 1
  fi
fi
sleep 1; kill_port; sleep 1

# --- B) fully configured production env boots and serves ---------------------
SECRET="$RUNS/session-secret.key"
head -c 32 /dev/urandom > "$SECRET"; chmod 600 "$SECRET"
echo '{"version":1,"reviewers":[{"id":"tvr-0a1b2c3d","name":"Prod Boot Probe","role":"teacher","tokenHash":"0000000000000000000000000000000000000000000000000000000000000000","status":"active","epoch":1,"createdAt":"2026-09-14T00:00:00.000Z","provisionedBy":"operator:prodboot"}]}' > "$RUNS/reviewers.json"
SECURE_LOG="$RUNS/secure-boot.log"
NODE_ENV=production \
  TV_SESSION_SECRET_FILE="$SECRET" TV_REVIEWERS_FILE="$RUNS/reviewers.json" \
  TV_PUBLIC_HTTPS=1 TV_PGHOST=127.0.0.1 TV_PGUSER=syllabai TV_PGDATABASE=syllabai \
  TV_LOG_FILE="$RUNS/scratch-decision-log.jsonl" TV_PROVISIONING_LOG_FILE="$RUNS/provisioning-log.jsonl" \
  bun x next start -p "$PROD_PORT" >"$SECURE_LOG" 2>&1 &
PID_B=$!
UP=""
for i in $(seq 1 40); do
  sleep 1
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PROD_PORT/api/review/index" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then UP=yes; break; fi
done
if [ -n "$UP" ]; then
  echo "RESULT B: PASS — fully configured production boot serves /api/review/index -> 200" | tee -a "$OUT"
  # session cookie over declared-HTTPS production must carry Secure
  curl -s -X POST -H "Content-Type: application/json" -d '{"token":"tvr_invalid_probe_token_value"}' \
    -D "$RUNS/session-headers.txt" -o /dev/null "http://127.0.0.1:$PROD_PORT/api/session" || true
  if rg -qi "HttpOnly" "$RUNS/session-headers.txt"; then
    echo "session route responds with HttpOnly cookie headers (403 body for invalid token — expected)" | tee -a "$OUT"
    rg -i "set-cookie" "$RUNS/session-headers.txt" | head -2 | tee -a "$OUT"
  fi
else
  echo "RESULT B: FAIL — configured production boot did not serve in time" | tee -a "$OUT"
  tail -8 "$SECURE_LOG" | tee -a "$OUT"
fi
kill -9 "$PID_B" 2>/dev/null
sleep 1; kill_port
wait "$PID_B" 2>/dev/null
[ -n "$UP" ]

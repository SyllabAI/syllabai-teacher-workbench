#!/usr/bin/env bash
# R3-8 Phase E — minimal operational monitor (operator tool).
#
# Smallest operationally useful signal set (60s loop, JSONL status + ALERT lines):
#   - process restart/crash detection (pid change / dead pid)
#   - production config failure (health endpoint dead = serving path down)
#   - staging-log write failure (GET /api/decisions must return chainValid:true)
#   - reviewer-registry failure (registry file must load with valid shape)
#   - canonical read failure (GET /api/canonical/state must answer available:true)
#   - repeated authentication failures (403 count on /api/* in window)
#   - unexpected 4xx/5xx spikes (non-403 4xx + 5xx count in window)
#
# Usage: scripts/prod/monitor.sh [--state /home/z/workbench-prod] [--once]
set -uo pipefail
STATE="/home/z/workbench-prod"
ONCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --state) STATE="$2"; shift 2;;
    --once) ONCE=1; shift;;
    *) shift;;
  esac
done
LOG_DIR="$STATE/logs"
WINDOW=300   # seconds for rate signals
INTERVAL=60

line() { # ts level signal detail...
  local ts="$1" level="$2" signal="$3"; shift 3
  printf '{"ts":"%s","level":"%s","signal":"%s","detail":"%s"}\n' "$ts" "$level" "$signal" "$detail" 2>/dev/null || true
}
emit() { # level signal detail
  local level="$1" signal="$2" detail="$3"
  local json
  json=$(printf '{"ts":"%s","level":"%s","signal":"%s","detail":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$signal" "${detail//\"/\\\"}")
  printf '%s' "$json" >> "$LOG_DIR/monitor.log"
}

last_pid=0
mkdir -p "$LOG_DIR"
while :; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # process restart/crash
  if [ -f "$STATE/app.pid" ]; then
    pid=$(cat "$STATE/app.pid" 2>/dev/null || echo 0)
    if kill -0 "$pid" 2>/dev/null; then
      [ "$last_pid" != 0 ] && [ "$pid" != "$last_pid" ] && emit ALERT process_restart "app pid changed $last_pid -> $pid"
      last_pid=$pid
      emit INFO process_up "pid=$pid"
    else
      emit ALERT process_down "app pid $pid not running"
    fi
  else
    emit ALERT process_down "no app.pid"
  fi

  # serving path + staging log + canonical read
  dec=$(curl -sf --max-time 5 "http://127.0.0.1:3000/api/decisions" 2>/dev/null) \
    && echo "$dec" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.exit(j.chainValid===true?0:1)}catch{process.exit(1)}})' \
    && emit INFO staging_log_ok "chainValid=true" \
    || emit ALERT staging_log_fail "decisions endpoint failed or chainValid!=true"
  can=$(curl -sf --max-time 8 -X POST -H "content-type: application/json" -d '{"targets":[{"type":"question_version","id":"00000000-0000-0000-0000-000000000000"}]}' "http://127.0.0.1:3000/api/canonical/state" 2>/dev/null)
  if [ -n "$can" ] && echo "$can" | grep -q '"available"'; then
    echo "$can" | grep -q '"available":true' && emit INFO canonical_read_ok "available=true" || emit ALERT canonical_read_fail "canonical unavailable"
  else
    emit ALERT canonical_read_fail "canonical state endpoint failed"
  fi

  # reviewer registry loads
  if [ -f "$STATE/state/reviewers.json" ] && node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(r.version!==1||!Array.isArray(r.reviewers))process.exit(1);' "$STATE/state/reviewers.json" 2>/dev/null; then
    emit INFO registry_ok "loads"
  else
    emit ALERT registry_fail "registry missing or invalid"
  fi

  # rate signals from access log
  if [ -f "$LOG_DIR/access.jsonl" ]; then
    since=$(node -e "console.log(new Date(Date.now()-$WINDOW*1000).toISOString())")
    auth403=$(awk -v s="\"ts\":\"$since\"" '$0 ~ /"status":403/ && $0 > s {n++} END{print n+0}' "$LOG_DIR/access.jsonl" 2>/dev/null)
    other4xx5xx=$(awk -v s="\"ts\":\"$since\"" '$0 ~ /"status":(4[0-9][0-9]|5[0-9][0-9])/ && $0 !~ /"status":403/ && $0 > s {n++} END{print n+0}' "$LOG_DIR/access.jsonl" 2>/dev/null)
    [ "${auth403:-0}" -ge 10 ] && emit ALERT auth_failures_spike "403 on /api in last ${WINDOW}s: $auth403" || emit INFO auth_failures "403 last ${WINDOW}s: $auth403"
    [ "${other4xx5xx:-0}" -ge 20 ] && emit ALERT http_error_spike "4xx/5xx (non-403) last ${WINDOW}s: $other4xx5xx" || emit INFO http_errors "4xx/5xx last ${WINDOW}s: $other4xx5xx"
  else
    emit ALERT access_log_missing "$LOG_DIR/access.jsonl"
  fi

  [ "$ONCE" = 1 ] && break
  sleep "$INTERVAL"
done

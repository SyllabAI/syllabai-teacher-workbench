#!/usr/bin/env bash
# R3-8 Phase B negative boot tests — production MUST fail closed on unsafe config.
# Each scenario boots the standalone server with ONE required config item removed.
# Expected: process exits nonzero with the R3-7 production-config error.
set -uo pipefail
EV=/home/z/my-project/download/evidence-r3-8
OUT=$EV/negative-boot-results.txt
: > "$OUT"
ENV=/home/z/workbench-prod/workbench.env
SERVER=/home/z/my-project/.next/standalone/server.js

run_case() { # name env-override...
  local name="$1"; shift
  local log="/tmp/boot-neg-$name.log"
  ( set -a; . "$ENV"; set +a; cd /home/z/my-project; env "$@" bun "$SERVER" > "$log" 2>&1 )
  local rc=$?
  echo "== case: $name (exit=$rc)" >> "$OUT"
  grep -m1 -oE "R3-7 production configuration check FAILED|refusing to start|production never falls back|production requires an out-of-band secret" "$log" | head -2 >> "$OUT" || echo "  (no fail-closed message found)" >> "$OUT"
  tail -3 "$log" | head -c 400 >> "$OUT"; echo >> "$OUT"
  if [ "$rc" != 0 ]; then echo "   RESULT: FAIL-CLOSED OK" >> "$OUT"; else echo "   RESULT: !!! PROCESS KEPT RUNNING (bad) !!!" >> "$OUT"; fi
  echo >> "$OUT"
}

run_case no-https-flag "TV_PUBLIC_HTTPS=0"
run_case missing-secret "TV_SESSION_SECRET_FILE=/home/z/workbench-prod/secrets/DOES-NOT-EXIST.key"
run_case missing-registry "TV_REVIEWERS_FILE=/home/z/workbench-prod/state/DOES-NOT-EXIST.json"
run_case missing-pghost "TV_PGHOST="

echo "==== SUMMARY ====" >> "$OUT"
grep -c "FAIL-CLOSED OK" "$OUT" | xargs echo "fail-closed cases passed:" >> "$OUT"
cat "$OUT"

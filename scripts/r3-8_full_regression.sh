#!/bin/bash
# R3-8: full regression — all suites (r3-6 + r3-7) + r3-8 regression tests,
# with real staging log + production state guards.
set -u
cd /home/z/my-project
LOG=download/teacher-validation/decision-log.jsonl
PROD=/home/z/workbench-prod/state
OUT=download/evidence-r3-8/test-results-full-r3-8.log
LOG_BEFORE=$(sha256sum "$LOG" | awk '{print $1}')
PROD_BEFORE=$(sha256sum $PROD/decision-log.jsonl $PROD/reviewers.json $PROD/provisioning-log.jsonl $PROD/../secrets/session-secret.key | sha256sum | awk '{print $1}')
{
echo "== R3-8 full regression at $(git rev-parse --short HEAD) ($(date -u +%Y-%m-%dT%H:%M:%SZ)) =="
echo "real campaign log sha256 BEFORE: $LOG_BEFORE"
echo "prod state combined sha256 BEFORE: $PROD_BEFORE"
echo ""
echo "--- bun test tests/r3-6/ ---"
bun test tests/r3-6/ 2>&1 | tail -6
echo "r3-6 exit: ${PIPESTATUS[0]}"
echo ""
echo "--- bun test tests/r3-7/ ---"
bun test tests/r3-7/ 2>&1 | tail -6
echo "r3-7 exit: ${PIPESTATUS[0]}"
echo ""
echo "--- bun tests/r3-8/regression.test.ts ---"
bun tests/r3-8/regression.test.ts 2>&1 | tail -3
echo "r3-8 regression exit: $?"
echo ""
} > "$OUT" 2>&1
LOG_AFTER=$(sha256sum "$LOG" | awk '{print $1}')
PROD_AFTER=$(sha256sum $PROD/decision-log.jsonl $PROD/reviewers.json $PROD/provisioning-log.jsonl $PROD/../secrets/session-secret.key | sha256sum | awk '{print $1}')
{
echo "real campaign log sha256 AFTER:  $LOG_AFTER"
echo "prod state combined sha256 AFTER:  $PROD_AFTER"
[ "$LOG_BEFORE" = "$LOG_AFTER" ] && echo "REAL CAMPAIGN LOG UNTOUCHED: yes" || echo "REAL CAMPAIGN LOG UNTOUCHED: NO — INVESTIGATE"
[ "$PROD_BEFORE" = "$PROD_AFTER" ] && echo "PROD STATE UNTOUCHED BY TESTS: yes" || echo "PROD STATE UNTOUCHED BY TESTS: NO — INVESTIGATE"
} >> "$OUT" 2>&1
cat "$OUT"

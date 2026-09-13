#!/bin/bash
# R3-6-b: re-run full R3-6 test suite at release base; guard the real staging log.
set -u
cd /home/z/my-project
LOG=download/teacher-validation/decision-log.jsonl
OUT=download/evidence-r3-6/test-results-rerun-r3-6b.log
BEFORE=$(sha256sum "$LOG" | awk '{print $1}')
echo "== R3-6 test suite re-run at release base ($(git rev-parse --short HEAD)) ==" | tee "$OUT"
echo "real log sha256 BEFORE: $BEFORE" | tee -a "$OUT"
echo "bun: $(bun --version), db up: $(pgrep -f 'postgres -D /home/z/toolchain/pgdata' | head -1)" | tee -a "$OUT"
echo "" | tee -a "$OUT"

bun test tests/r3-6/ 2>&1 | tee -a "$OUT"
RC=${PIPESTATUS[0]}

AFTER=$(sha256sum "$LOG" | awk '{print $1}')
echo "" | tee -a "$OUT"
echo "real log sha256 AFTER:  $AFTER" | tee -a "$OUT"
[ "$BEFORE" = "$AFTER" ] && echo "REAL LOG UNTOUCHED: yes" | tee -a "$OUT" || echo "REAL LOG UNTOUCHED: NO — INVESTIGATE" | tee -a "$OUT"
echo "suite exit code: $RC" | tee -a "$OUT"
exit $RC

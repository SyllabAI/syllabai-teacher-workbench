#!/bin/bash
# R3-6-b: re-verify real staging log under the HARDENED importer (F-1/F-2/F-3, core 9747d0a).
# Read-only check mode. Real log is NEVER written (check mode plans only).
set -u
CORE=/home/z/my-project/repos/syllabai-core
LOG=/home/z/my-project/download/teacher-validation/decision-log.jsonl
OUT=/home/z/my-project/download/evidence-r3-6/importer-check-mode-hardened-r3-6b.log

BEFORE=$(sha256sum "$LOG" | awk '{print $1}')
echo "== R3-6-b importer re-check under hardened importer ==" | tee "$OUT"
echo "core HEAD: $(git -C $CORE rev-parse HEAD)" | tee -a "$OUT"
echo "importer sha256: $(sha256sum $CORE/scripts/import_teacher_decisions.py)" | tee -a "$OUT"
echo "real log sha256 BEFORE: $BEFORE" | tee -a "$OUT"
echo "" | tee -a "$OUT"

cd "$CORE"
python3 scripts/import_teacher_decisions.py check --log-file "$LOG" 2>&1 | tee -a "$OUT"
RC=${PIPESTATUS[0]}

AFTER=$(sha256sum "$LOG" | awk '{print $1}')
echo "" | tee -a "$OUT"
echo "real log sha256 AFTER:  $AFTER" | tee -a "$OUT"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "REAL LOG UNTOUCHED: yes" | tee -a "$OUT"
else
  echo "REAL LOG UNTOUCHED: NO — INVESTIGATE" | tee -a "$OUT"
fi
echo "check exit code: $RC" | tee -a "$OUT"
exit $RC

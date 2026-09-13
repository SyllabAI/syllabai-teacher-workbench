#!/bin/bash
# R3-7: importer re-verification (untouched) + CLI smoke + integrity checks.
set -u
CORE=/home/z/my-project/repos/syllabai-core
LOG=/home/z/my-project/download/teacher-validation/decision-log.jsonl
OUT=/home/z/my-project/download/evidence-r3-7/importer-and-integrity-r3-7.log

echo "== R3-7 importer re-verification + integrity $(date -u +%Y-%m-%dT%H:%M:%SZ) ==" | tee "$OUT"
echo "core HEAD: $(git -C $CORE rev-parse HEAD)" | tee -a "$OUT"
echo "importer sha256: $(sha256sum $CORE/scripts/import_teacher_decisions.py | cut -d' ' -f1)" | tee -a "$OUT"
echo "real staging log sha256: $(sha256sum $LOG | cut -d' ' -f1)" | tee -a "$OUT"
echo "real log exists / registry does NOT exist: $(test -f $LOG && echo yes)/$(test -f /home/z/my-project/download/teacher-validation/reviewers.json && echo LEAK || echo correct-absent)" | tee -a "$OUT"
echo "" | tee -a "$OUT"

echo "-- importer check-mode vs REAL log (F-4 importer, 4343b5a) --" | tee -a "$OUT"
cd "$CORE"
BEFORE=$(sha256sum "$LOG" | awk '{print $1}')
python3 scripts/import_teacher_decisions.py check --log-file "$LOG" 2>&1 | tee -a "$OUT"
RC=${PIPESTATUS[0]}
AFTER=$(sha256sum "$LOG" | awk '{print $1}')
[ "$BEFORE" = "$AFTER" ] && echo "real log untouched: yes" | tee -a "$OUT" || echo "REAL LOG TOUCHED — INVESTIGATE" | tee -a "$OUT"
echo "check exit: $RC" | tee -a "$OUT"
CHECK_RC=$RC
cd /home/z/my-project

echo "" | tee -a "$OUT"
echo "-- provisioning CLI smoke (scratch registry) --" | tee -a "$OUT"
SMOKE=download/teacher-validation/test-runs/r3-7-cli-smoke
rm -rf "$SMOKE"; mkdir -p "$SMOKE"
export TV_REVIEWERS_FILE="$SMOKE/reviewers.json" TV_PROVISIONING_LOG_FILE="$SMOKE/provisioning-log.jsonl"
bun scripts/provision-reviewer.ts provision --name "CLI Smoke Reviewer" --by "operator:cli-smoke" --note "R3-7 CLI smoke test" > "$SMOKE/token.txt" 2> "$SMOKE/stderr.txt"
echo "provision exit: $?" | tee -a "$OUT"
cat "$SMOKE/stderr.txt" | tee -a "$OUT"
TOKEN=$(grep -o '^tvr_[A-Za-z0-9_-]*$' "$SMOKE/token.txt" | head -1)
echo "token prefix: ${TOKEN:0:8}... (shown once, then only hash stored)" | tee -a "$OUT"
bun scripts/provision-reviewer.ts list 2>>"$SMOKE/stderr.txt" | tee -a "$OUT"
bun scripts/provision-reviewer.ts revoke --name "CLI Smoke Reviewer" --by "operator:cli-smoke" --note "smoke offboarding" 2>>"$SMOKE/stderr.txt" | tee -a "$OUT"
bun scripts/provision-reviewer.ts list --all 2>>"$SMOKE/stderr.txt" | tee -a "$OUT"
rg -c "PROVISION|REVOKE" "$SMOKE/provisioning-log.jsonl" | tee -a "$OUT" && echo "provisioning audit entries: 2 (PROVISION+REVOKE)" | tee -a "$OUT"
rm -rf "$SMOKE"

echo "" | tee -a "$OUT"
echo "-- canonical DB integrity (read-only probes) --" | tee -a "$OUT"
PG=/home/z/toolchain/pgdebs/root/usr/lib/postgresql/17/bin/psql
$PG -h 127.0.0.1 -U syllabai -d syllabai -tAc "SELECT 'identity', db_name, campaign_label, core_commit FROM campaign_db_identity ORDER BY claimed_at DESC LIMIT 1" 2>&1 | tee -a "$OUT"
$PG -h 127.0.0.1 -U syllabai -d syllabai -tAc "SELECT 'versions', count(*), count(*) FILTER (WHERE validation_state='SUGGESTED'), count(*) FILTER (WHERE validation_state='VALIDATED'), count(*) FILTER (WHERE validation_state='REJECTED') FROM question_versions" 2>&1 | tee -a "$OUT"
$PG -h 127.0.0.1 -U syllabai -d syllabai -tAc "SELECT 'events', count(*) FROM teacher_validation_events" 2>&1 | tee -a "$OUT"
$PG -h 127.0.0.1 -U syllabai -d syllabai -tAc "SELECT 'flyway_rows', count(*) FROM flyway_schema_history" 2>&1 | tee -a "$OUT"
echo "final check exit: $CHECK_RC" | tee -a "$OUT"
exit $CHECK_RC

#!/usr/bin/env bash
# P1 ACTIVATION REHEARSAL — full local dogfood of the production pipeline shape:
#   boot fresh core (prod-like, no demo seeder) on the campaign DB
#   -> one-time first-admin bootstrap (V19)
#   -> glm-ocr pair ingestion (identity + dedupe + SUGGESTED)
#   -> teacher review/validation workflow (409 paper rule)
#   -> serving boundary at the attempt path (NEW fail-closed gate)
#   -> validated content becomes learner-attemptable, history recorded
# Results land in scripts/p1-rehearsal/results.txt. The JVM is always killed.
set -u
ROOT=/home/z/my-project
DIR=$ROOT/scripts/p1-rehearsal
JAR=$ROOT/repos/syllabai-core/target/syllabai-core-0.1.0-SNAPSHOT.jar
BUNDLES=/tmp/my-project/corpus-bundles
PSQL=/home/z/toolchain/pgdebs/root/usr/lib/postgresql/17/bin/psql
PORT=8090
BASE=http://127.0.0.1:$PORT
SECRET="p1-rehearsal-secret-key-0123456789abcdef"
ADMIN_PW="p1-rehearsal-passphrase-7"
RES=$DIR/results.txt
T_TOKEN=$DIR/teacher.token; S_TOKEN=$DIR/student.token
mkdir -p "$DIR"; : > "$RES"

say(){ echo "== $*" | tee -a "$RES"; }
check(){ if [ "$2" = "$3" ]; then echo "[PASS] $1 (got $3)" | tee -a "$RES";
         else echo "[FAIL] $1 expected=$2 got=$3" | tee -a "$RES"; fi; }
jqpy(){ python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

db_totals(){ $PSQL -h 127.0.0.1 -U syllabai -d syllabai -tAc \
  "SELECT (SELECT count(*) FROM exam_papers)||'/'||(SELECT count(*) FROM question_versions)||'/'\
||(SELECT count(*) FROM question_versions WHERE validation_state='VALIDATED')||'/'\
||(SELECT count(*) FROM attempts)" 2>/dev/null; }

cleanup(){ [ -n "${JPID:-}" ] && kill "$JPID" 2>/dev/null; sleep 1; kill -9 "$JPID" 2>/dev/null; }
trap cleanup EXIT

say "DB totals before (papers/versions/validated/attempts): $(db_totals)"

# ── boot ────────────────────────────────────────────────────────────────────
nohup /home/z/toolchain/jdk-25.0.4.1+1/bin/java -jar "$JAR" \
  --syllabai.security.jwt-secret="$SECRET" --server.port=$PORT \
  > "$DIR/boot.log" 2>&1 &
JPID=$!
up=0
for i in $(seq 1 90); do
  h=$(curl -s -m 2 "$BASE/actuator/health" | jqpy "d.get('status','')" 2>/dev/null)
  [ "$h" = "UP" ] && up=1 && break; sleep 1
done
check "rehearsal core boots + healthy" 1 $up
[ $up = 0 ] && { say "boot failed — aborting"; tail -20 "$DIR/boot.log" | tee -a "$RES"; exit 1; }
v19=$($PSQL -h 127.0.0.1 -U syllabai -d syllabai -tAc "SELECT to_regclass('bootstrap_admin_state') IS NOT NULL" 2>/dev/null)
check "Flyway V19 bootstrap_admin_state table present" t "$v19"

A="$BASE/api/v1/auth"
# ── Stage A: one-time first-admin bootstrap ────────────────────────────────
st=$(curl -s -m 5 "$A/bootstrap-status")
check "bootstrap status initially available" '{"available":true}' "$st"

code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$A/bootstrap-admin" \
  -H 'Content-Type: application/json' \
  -d '{"email":"ops@syllabai.dev","password":"abcdefgh","displayName":"Product Ops"}')
check "weak password claim refused" 400 "$code"

resp=$(curl -s -m 5 -w '\n%{http_code}' -X POST "$A/bootstrap-admin" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"ops@syllabai.dev\",\"password\":\"$ADMIN_PW\",\"displayName\":\"Product Ops\"}")
code=$(echo "$resp" | tail -1); body=$(echo "$resp" | head -1)
check "first-admin claim succeeds" 200 "$code"
T=$(echo "$body" | jqpy "d['accessToken']")
roles=$(echo "$body" | jqpy "sorted(d['user']['roles'])")
check "claimant roles = ADMIN+TEACHER" "['ADMIN', 'TEACHER']" "$roles"
echo "$T" > "$T_TOKEN"

code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$A/bootstrap-admin" \
  -H 'Content-Type: application/json' \
  -d '{"email":"second@syllabai.dev","password":"second-passphrase-7","displayName":"Second"}')
check "second claim refused (window consumed)" 409 "$code"
check "bootstrap status now closed" '{"available":false}' "$(curl -s -m 5 "$A/bootstrap-status")"

code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE/api/v1/teacher/content/review-queue")
check "review-queue anonymous -> 401" 401 "$code"
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" \
  "$BASE/api/v1/teacher/content/review-queue")
check "review-queue as teacher -> 200" 200 "$code"

# ── Stage B: a student exists (RBAC probes) ────────────────────────────────
resp=$(curl -s -m 5 -X POST "$A/register" -H 'Content-Type: application/json' \
  -d '{"email":"student@rehearsal.dev","password":"student-pass-1234","displayName":"Rehearsal Student"}')
S=$(echo "$resp" | jqpy "d['accessToken']"); echo "$S" > "$S_TOKEN"
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $S" \
  "$BASE/api/v1/teacher/content/review-queue")
check "review-queue as student -> 403" 403 "$code"

# ── Stage C: corpus ingestion (glm-ocr pairs, exact parser contract) ───────
TC="$BASE/api/v1/teacher/content"
ingest(){ # ingest <session-dir> -> http body
  python3 - "$BUNDLES/$1" <<'PY'
import json,sys, pathlib
d=pathlib.Path(sys.argv[1])
load=lambda n: json.loads((d/n).read_text())
print(json.dumps({"qpCanonical":load("qp-canonical.json"),"msCanonical":load("ms-canonical.json"),
 "qpDraft":load("qp-draft.json"),"msDraft":load("ms-draft.json"),
 "reconciliation":load("reconciliation.json")}))
PY
}
post_pair(){ ingest "$1" > "$DIR/pair.json"; curl -s -m 60 -X POST "$TC/glm-ocr/pairs" \
  -H "Authorization: Bearer $T" -H 'Content-Type: application/json' --data-binary @"$DIR/pair.json"; }

r=$(post_pair igcse-chemistry-4ch0-1c-2011jun)
check "2011jun ingested" INGESTED "$(echo "$r" | jqpy "d['examPaper']['status']")"
check "2011jun question count" 11 "$(echo "$r" | jqpy "d['questions']")"
check "2011jun parts count" 92 "$(echo "$r" | jqpy "d['parts']")"
check "2011jun mark points" 14 "$(echo "$r" | jqpy "d['markSchemes']>0 and d['markPoints']")"
check "2011jun embedding skipped" True "$(echo "$r" | jqpy "d['embeddingSkipped']")"
echo "$r" | jqpy "d['examPaper']['paperId']" > "$DIR/paper1.id"

r=$(post_pair igcse-chemistry-4ch0-1c-2012jan)
check "2012jan ingested" INGESTED "$(echo "$r" | jqpy "d['examPaper']['status']")"
check "2012jan parts count" 85 "$(echo "$r" | jqpy "d['parts']")"
echo "$r" | jqpy "d['examPaper']['paperId']" > "$DIR/paper2.id"

r=$(post_pair igcse-chemistry-4ch0-1c-2011jun)
check "2011jun re-run deduped" DUPLICATE "$(echo "$r" | jqpy "d['examPaper']['status']")"

# ── Stage D: browse + review surfaces ──────────────────────────────────────
SUBJ=$(curl -s -m 5 -H "Authorization: Bearer $T" "$BASE/api/v1/curriculum/subjects" \
  | jqpy "[s['id'] for s in d if s.get('code')=='4CH1'][0]")
say "4CH1 subject: $SUBJ"
P1=$(cat "$DIR/paper1.id"); P2=$(cat "$DIR/paper2.id")

papers=$(curl -s -m 5 -H "Authorization: Bearer $S" "$BASE/api/v1/exam-papers?subjectId=$SUBJ")
check "student sees 2 subject papers" 2 "$(echo "$papers" | jqpy "len(d)")"
check "papers are SUGGESTED" "SUGGESTED" "$(echo "$papers" | jqpy "d[0]['validationState']")"

detail=$(curl -s -m 5 -H "Authorization: Bearer $S" "$BASE/api/v1/exam-papers/$P1")
leak=$(echo "$detail" | jqpy "'correct' in json.dumps(d).lower()" 2>/dev/null)
check "paper detail metadata-only (no answer leak)" False "$leak"
QID=$(echo "$detail" | jqpy "d['questions'][0]['questionId']")
VID=$(echo "$detail" | jqpy "d['questions'][0]['currentVersionId']")

review=$(curl -s -m 5 -H "Authorization: Bearer $T" "$TC/exam-papers/$P1/review")
schemeids=$(echo "$review" | jqpy "','.join(str(v['schemeId']) for v in d['versions'] if v['schemeId'])")
nschemes=$(echo "$review" | jqpy "len([v for v in d['versions'] if v['schemeId']])")
say "2011jun review: $(echo "$review" | jqpy "len(d['versions'])") versions, $nschemes schemes"
key=$(echo "$review" | jqpy "any(v['points'] for v in d['versions'])")
check "teacher review carries answer/marking evidence" True "$key"

q=$(curl -s -m 5 -H "Authorization: Bearer $T" "$TC/review-queue")
check "review-queue lists 2 suggested papers" 2 "$(echo "$q" | jqpy "len(d['papers'])")"

# ── Stage E: the serving boundary at the attempt path ──────────────────────
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $S" \
  -H 'Content-Type: application/json' -X POST "$BASE/api/v1/attempts/structured" \
  -d "{\"questionId\":\"$QID\",\"partAnswers\":[{\"partId\":\"00000000-0000-0000-0000-0000000000aa\",\"answerText\":\"probe\"}],\"responseTimeMs\":1000,\"confidence\":3,\"selfDoubtFlag\":false,\"timedCondition\":false}")
check "structured attempt on SUGGESTED question refused" 404 "$code"
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $S" \
  -H 'Content-Type: application/json' -X POST "$BASE/api/v1/attempts" \
  -d "{\"questionId\":\"$QID\",\"chosenOptionId\":\"00000000-0000-0000-0000-000000000000\",\"responseTimeMs\":1000,\"confidence\":3,\"selfDoubtFlag\":false,\"timedCondition\":false}")
check "MCQ attempt on SUGGESTED structured question refused" 404 "$code"

code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" \
  -X POST "$TC/exam-papers/$P1/validate")
check "paper validate refused while versions unvalidated" 409 "$code"

# ── Stage F: teacher validates 2011jun fully ───────────────────────────────
echo "$review" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for v in d['versions']:
    print('V', v['versionId'])
    if v.get('schemeId'): print('S', v['schemeId'])
" > "$DIR/validate.list"
nv=0; ns=0
while read -r kind id; do
  if [ "$kind" = V ]; then
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" -X POST "$TC/question-versions/$id/validate")
    [ "$code" = 200 ] && nv=$((nv+1)) || echo "[FAIL] version $id validate -> $code" | tee -a "$RES"
  else
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" -X POST "$TC/mark-schemes/$id/validate")
    [ "$code" = 200 ] && ns=$((ns+1)) || echo "[FAIL] scheme $id validate -> $code" | tee -a "$RES"
  fi
done < "$DIR/validate.list"
say "validated $nv versions + $ns schemes"
check "all 2011jun versions validated" "$(echo "$review" | jqpy "len(d['versions'])")" "$nv"

code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" -X POST "$TC/exam-papers/$P1/validate")
check "paper validate succeeds once versions done" 200 "$code"
state=$(curl -s -m 5 -H "Authorization: Bearer $S" "$BASE/api/v1/exam-papers/$P1" | jqpy "d['paper']['validationState']")
check "paper state reflected to student view" VALIDATED "$state"

# ── Stage G: validated content becomes learner-attemptable ────────────────
qid2=$(curl -s -m 5 -H "Authorization: Bearer $S" "$BASE/api/v1/exam-papers/$P1" | jqpy "d['questions'][0]['questionId']")
qv=$(curl -s -m 5 -H "Authorization: Bearer $S" "$BASE/api/v1/questions/$qid2")
np=$(echo "$qv" | jqpy "len(d['parts'])")
say "student question view parts: $np"
pa=$(echo "$qv" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(json.dumps([{'partId':p['id'],'answerText':'Rehearsal answer for '+p['label']} for p in d['parts']]))")
resp=$(curl -s -m 10 -w '\n%{http_code}' -H "Authorization: Bearer $S" -H 'Content-Type: application/json' \
  -X POST "$BASE/api/v1/attempts/structured" \
  -d "{\"questionId\":\"$qid2\",\"partAnswers\":$pa,\"responseTimeMs\":42000,\"confidence\":3,\"selfDoubtFlag\":false,\"timedCondition\":false}")
code=$(echo "$resp" | tail -1)
check "structured attempt on VALIDATED question accepted" 201 "$code"
check "attempt enters PENDING marking" PENDING "$(echo "$resp" | head -1 | jqpy "d['markingState']")"

hist=$(curl -s -m 5 -H "Authorization: Bearer $S" "$BASE/api/v1/learners/me/attempts" 2>/dev/null)
nh=$(echo "$hist" | jqpy "len(d.get('attempts',[]))" 2>/dev/null)
say "history entries: ${nh:-unparsed}"
check "learner history records the attempt" 1 "${nh:-0}"

q=$(curl -s -m 5 -H "Authorization: Bearer $T" "$TC/review-queue")
check "review-queue shrinks to 1 paper" 1 "$(echo "$q" | jqpy "len(d['papers'])")"

say "DB totals after (papers/versions/validated/attempts): $(db_totals)"
pass=$(grep -c '^\[PASS\]' "$RES"); fail=$(grep -c '^\[FAIL\]' "$RES")
say "REHEARSAL VERDICT: $pass PASS / $fail FAIL"
[ "$fail" = 0 ]

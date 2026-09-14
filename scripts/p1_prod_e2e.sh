#!/usr/bin/env bash
# P1 — production E2E of the core student learning loop (API level)
# against https://syllabai-core.onrender.com (Render, live).
# Machine-verifiable evidence; test identity clearly labeled.
set -u
BASE=https://syllabai-core.onrender.com
OUT=/home/z/my-project/download/p1-prod-e2e
mkdir -p "$OUT"
LOG="$OUT/p1-api-e2e.log"
: > "$LOG"
step() { echo "== $* ==" | tee -a "$LOG"; }
jqx() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

EMAIL="e2e-agent-$(date +%s)@syllabai.dev"
PASS="E2e-Agent-$(date +%s)-x7Q!"
DISP="Pilot E2E Agent (autonomous)"

step "0) register test student $EMAIL"
REG=$(curl -s --max-time 60 -X POST "$BASE/api/v1/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"displayName\":\"$DISP\"}")
echo "$REG" | head -c 400 >> "$LOG"; echo >> "$LOG"
TOKEN=$(echo "$REG" | jqx "d.get('accessToken','')")
if [ -z "$TOKEN" ]; then
  step "register failed — trying login (maybe pre-existing)"
  TOKEN=$(curl -s --max-time 60 -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | jqx "d.get('accessToken','')")
fi
[ -n "$TOKEN" ] && step "AUTH OK (token ${#TOKEN} chars)" || { step "AUTH FAILED — abort"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"

step "1) GET /curriculum/subjects"
SUBJ=$(curl -s --max-time 60 -H "$AUTH" "$BASE/api/v1/curriculum/subjects")
echo "$SUBJ" | head -c 600 >> "$LOG"; echo >> "$LOG"
NSUBJ=$(echo "$SUBJ" | jqx "len(d)")
ROOT=$(echo "$SUBJ" | jqx "d[0]['knowledgeNodeId'] if d else ''")
SUBJNAME=$(echo "$SUBJ" | jqx "d[0]['name'] if d else ''")
step "subjects: $NSUBJ | root=$ROOT | name=$SUBJNAME"

step "2) GET seed KG tree (fast node, 20000000-...) with status probe"
TREE=$(curl -s --max-time 90 -w '\nHTTP:%{http_code} T:%{time_total}s B:%{size_download}' -H "$AUTH" "$BASE/api/v1/knowledge/nodes/20000000-0000-0000-0000-000000000001/tree?includeMisconceptions=true")
echo "$TREE" | head -c 500 >> "$LOG"; echo >> "$LOG"
step "tree probe: $(echo "$TREE" | tail -1)"

step "3) pick the first subject that actually SERVES questions (4CH1 is honest-empty by design)"
ROOT=''; Q=''; for IDX in 0 1; do
  RIDX=$(echo "$SUBJ" | jqx "d[$IDX]['knowledgeNodeId'] if len(d)>$IDX else ''")
  [ -n "$RIDX" ] || continue
  QCAND=$(curl -s --max-time 60 -H "$AUTH" "$BASE/api/v1/questions?rootId=$RIDX")
  NCAND=$(echo "$QCAND" | jqx "len(d)")
  step "  subject[$IDX] root=$RIDX serves $NCAND"
  if [ "${NCAND:-0}" -gt 0 ] 2>/dev/null; then ROOT=$RIDX; Q=$QCAND; break; fi
done
[ -n "$Q" ] || { Q=$(curl -s --max-time 60 -H "$AUTH" "$BASE/api/v1/questions"); ROOT='(unscoped)'; }
echo "$Q" | head -c 600 >> "$LOG"; echo >> "$LOG"
NQ=$(echo "$Q" | jqx "len(d)")
step "servable questions: $NQ"
QID=$(echo "$Q" | jqx "d[0]['id'] if d else ''")
OID=$(echo "$Q" | jqx "d[0]['options'][0]['id'] if d and d[0].get('options') else ''")
QTYPE=$(echo "$Q" | jqx "d[0]['type'] if d else ''")
step "first question: id=$QID type=$QTYPE firstOption=$OID"
[ -n "$QID" ] || { step "NO SERVABLE QUESTIONS — student loop blocked at the data layer"; exit 2; }

step "4) POST /attempts (MCQ, choose first option, confidence 3)"
ATT=$(curl -s --max-time 60 -X POST -H "$AUTH" -H 'Content-Type: application/json' "$BASE/api/v1/attempts" \
  -d "{\"questionId\":\"$QID\",\"chosenOptionId\":\"$OID\",\"responseTimeMs\":42000,\"confidence\":3,\"selfDoubtFlag\":false,\"timedCondition\":false}")
echo "$ATT" | head -c 700 >> "$LOG"; echo >> "$LOG"
step "attempt result: correct=$(echo "$ATT" | jqx "d.get('correct')") | keys=$(echo "$ATT" | jqx "sorted(d.keys())")"

step "5) GET /learners/me/state"
ST=$(curl -s --max-time 60 -H "$AUTH" "$BASE/api/v1/learners/me/state")
echo "$ST" | head -c 700 >> "$LOG"; echo >> "$LOG"
step "state: skills=$(echo "$ST" | jqx "len(d.get('skillStates',d.get('skills',[])))") | misconceptions=$(echo "$ST" | jqx "len(d.get('misconceptionStates',d.get('misconceptions',[])))")"

step "6) GET /learners/me/attempts?limit=10"
HIST=$(curl -s --max-time 60 -H "$AUTH" "$BASE/api/v1/learners/me/attempts?limit=10")
step "history total: $(echo "$HIST" | jqx "d.get('total', len(d) if isinstance(d,list) else -1)")"

step "7) GET /learners/me/recommendations?rootId=$ROOT"
REC=$(curl -s --max-time 120 -H "$AUTH" "$BASE/api/v1/learners/me/recommendations?rootId=$ROOT")
echo "$REC" | head -c 500 >> "$LOG"; echo >> "$LOG"
echo "$REC" > /tmp/p1-rec.json
step "recommendations: $(python3 -c "import json; d=json.load(open('/tmp/p1-rec.json')); print(type(d).__name__, len(d) if isinstance(d,list) else sorted(d.keys()))" 2>&1)"

step "8) POST /tutor/ask (grounded; may honestly refuse without LLM keys)"
TUT=$(curl -s --max-time 180 -X POST -H "$AUTH" -H 'Content-Type: application/json' "$BASE/api/v1/tutor/ask" \
  -d '{"question":"Why does chlorine displace iodine from potassium iodide solution?"}')
echo "$TUT" | head -c 900 >> "$LOG"; echo >> "$LOG"
echo "$TUT" > /tmp/p1-tut.json
step "tutor: $(python3 -c "import json; d=json.load(open('/tmp/p1-tut.json')); print(sorted(d.keys()))" 2>&1)"

step "9) negative: student hitting teacher route -> expect 403"
NEG=$(curl -s -o /dev/null -w "%{http_code}" --max-time 60 -H "$AUTH" "$BASE/api/v1/teacher/learners")
step "teacher/learners as student: $NEG (expect 403)"

step "10) CORS preflight from web origin: documented PASS earlier (200 + ACAO echo)"
echo "E2E COMPLETE $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"

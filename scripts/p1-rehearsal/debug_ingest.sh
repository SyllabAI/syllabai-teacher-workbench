#!/usr/bin/env bash
# Debug ingestion manually: boot fresh core, login as rehearsal admin, POST one pair.
set -u
ROOT=/home/z/my-project
DIR=$ROOT/scripts/p1-rehearsal
JAR=$ROOT/repos/syllabai-core/target/syllabai-core-0.1.0-SNAPSHOT.jar
BUNDLES=/tmp/my-project/corpus-bundles
PSQL=/home/z/toolchain/pgdebs/root/usr/lib/postgresql/17/bin/psQL
PSQL=/home/z/toolchain/pgdebs/root/usr/lib/postgresql/17/bin/psql
PORT=8090
BASE=http://127.0.0.1:$PORT
SECRET="p1-rehearsal-secret-key-0123456789abcdef"
ADMIN_PW="p1-rehearsal-passphrase-7"

cleanup(){ [ -n "${JPID:-}" ] && kill "$JPID" 2>/dev/null; sleep 1; kill -9 "$JPID" 2>/dev/null; }
trap cleanup EXIT

nohup /home/z/toolchain/jdk-25.0.4.1+1/bin/java -jar "$JAR" \
  --syllabai.security.jwt-secret="$SECRET" --server.port=$PORT \
  > "$DIR/debug-boot.log" 2>&1 &
JPID=$!
up=0
for i in $(seq 1 90); do
  h=$(curl -s -m 2 "$BASE/actuator/health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  [ "$h" = "UP" ] && up=1 && break; sleep 1
done
[ $up = 0 ] && { echo "BOOT FAILED"; tail -5 "$DIR/debug-boot.log"; exit 1; }
echo "booted"

T=$(curl -s -m 5 -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"ops@syllabai.dev\",\"password\":\"$ADMIN_PW\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")
echo "teacher token: ${T:0:20}..."

python3 - "$BUNDLES/igcse-chemistry-4ch0-1c-2011jun" <<'PY' > "$DIR/pair.json"
import json,sys, pathlib
d=pathlib.Path(sys.argv[1])
load=lambda n: json.loads((d/n).read_text())
print(json.dumps({"qpCanonical":load("qp-canonical.json"),"msCanonical":load("ms-canonical.json"),
 "qpDraft":load("qp-draft.json"),"msDraft":load("ms-draft.json"),
 "reconciliation":load("reconciliation.json")}))
PY
echo "pair.json bytes: $(wc -c < "$DIR/pair.json")"

echo "=== POST response (first 800 chars) ==="
curl -s -m 60 -w '\nHTTP:%{http_code}\n' -X POST "$BASE/api/v1/teacher/content/glm-ocr/pairs" \
  -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  --data-binary @"$DIR/pair.json" | head -c 800
echo
echo "=== server errors during POST ==="
grep -A6 "ERROR" "$DIR/debug-boot.log" | grep -v "^--$" | tail -30

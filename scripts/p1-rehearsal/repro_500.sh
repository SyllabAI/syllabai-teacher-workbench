#!/usr/bin/env bash
# Reproduce the 4 prod 500 sessions locally on a FRESH schema, capture traces.
set -u
ROOT=/home/z/my-project
DIR=$ROOT/scripts/p1-rehearsal
JAR=$ROOT/repos/syllabai-core/target/syllabai-core-0.1.0-SNAPSHOT.jar
BUNDLES=/tmp/my-project/corpus-bundles
PSQL=/home/z/toolchain/pgdebs/root/usr/lib/postgresql/17/bin/psql
PORT=8091
BASE=http://127.0.0.1:$PORT
SECRET="p1-rehearsal-secret-key-0123456789abcdef"
ADMIN_PW="p1-rehearsal-passphrase-7"

cleanup(){ [ -n "${JPID:-}" ] && kill "$JPID" 2>/dev/null; sleep 1; kill -9 "$JPID" 2>/dev/null; }
trap cleanup EXIT

echo "== fresh schema =="
$PSQL -h 127.0.0.1 -U syllabai -d syllabai -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>&1 | head -2

nohup /home/z/toolchain/jdk-25.0.4.1+1/bin/java -jar "$JAR" \
  --syllabai.security.jwt-secret="$SECRET" --server.port=$PORT \
  > "$DIR/repro-boot.log" 2>&1 &
JPID=$!
up=0
for i in $(seq 1 100); do
  h=$(curl -s -m 2 "$BASE/actuator/health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  [ "$h" = "UP" ] && up=1 && break; sleep 1
done
[ $up = 0 ] && { echo "BOOT FAILED"; tail -5 "$DIR/repro-boot.log"; exit 1; }
echo "booted"

A="$BASE/api/v1/auth"
curl -s -X POST "$A/bootstrap-admin" -H 'Content-Type: application/json' \
  -d "{\"email\":\"ops@syllabai.dev\",\"password\":\"$ADMIN_PW\",\"displayName\":\"Ops\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])" > "$DIR/teacher.token"
T=$(cat "$DIR/teacher.token")
TC="$BASE/api/v1/teacher/content"

post(){ # post <session>
  python3 - "$BUNDLES/$1" <<'PY' > "$DIR/pair.json"
import json,sys, pathlib
d=pathlib.Path(sys.argv[1])
load=lambda n: json.loads((d/n).read_text())
print(json.dumps({"qpCanonical":load("qp-canonical.json"),"msCanonical":load("ms-canonical.json"),
 "qpDraft":load("qp-draft.json"),"msDraft":load("ms-draft.json"),
 "reconciliation":load("reconciliation.json")}))
PY
  curl -s -m 120 -w '\nHTTP:%{http_code}' -X POST "$TC/glm-ocr/pairs" \
    -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    --data-binary @"$DIR/pair.json" | tail -c 200
}

for s in igcse-chemistry-4ch0-1c-2013jun igcse-chemistry-4ch0-1c-2013junr \
         igcse-chemistry-4ch0-2c-2016jun igcse-chemistry-4ch0-2c-2019jun \
         igcse-chemistry-4ch0-2c-2019junr igcse-chemistry-4ch0-2c-2024jun \
         igcse-chemistry-4ch0-2c-2024junr; do
  echo "== $s =="
  post "$s"; echo
done

echo "== ERROR traces from repro-boot.log =="
grep -A 4 "ERROR\|Exception:" "$DIR/repro-boot.log" | grep -v "^--$" | tail -50

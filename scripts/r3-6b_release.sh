#!/usr/bin/env bash
# R3-6-b: create t-c04-r3-6 release on SyllabAI/syllabai-core and upload assets.
# Token comes from GH_TOKEN env — NEVER hardcoded here or logged.
set -u
REPO=SyllabAI/syllabai-core
TAG=t-c04-r3-6-teacher-validation-workbench
PACK=/home/z/my-project/download/evidence-r3-6
R6B=/home/z/my-project/download/evidence-r3-6-b
LOG=/home/z/my-project/download/evidence-r3-6-b/release-create.log
: "${GH_TOKEN:?GH_TOKEN must be set in env}"
API=https://api.github.com

log(){ echo "$@" | tee -a "$LOG"; }

# 1. Create release (idempotent: reuse if exists)
EXISTING=$(curl -s -H "Authorization: token $GH_TOKEN" "$API/repos/$REPO/releases/tags/$TAG")
RID=$(echo "$EXISTING" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)
if [ -z "$RID" ]; then
  python3 - "$R6B/RELEASE-NOTES.md" > /tmp/rel-payload.json <<'PY'
import json,sys
body=open(sys.argv[1]).read()
print(json.dumps({
 "tag_name":"t-c04-r3-6-teacher-validation-workbench",
 "target_commitish":"main",
 "name":"T-C04 R3-6 — Teacher Validation Workbench: canonical state + staged intent",
 "body":body,
 "draft":False,"prerelease":False}))
PY
  RID=$(curl -s -X POST -H "Authorization: token $GH_TOKEN" -H "Accept: application/vnd.github+json" \
    -d @/tmp/rel-payload.json "$API/repos/$REPO/releases" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id') or ('ERR:'+str(d.get('errors'))))")
  rm -f /tmp/rel-payload.json
  log "created release id=$RID"
else
  log "release exists id=$RID (reuse)"
fi
[ "$RID" = "${RID#ERR:}" ] || { log "RELEASE CREATE FAILED: $RID"; exit 1; }

UPLOAD_URL="https://uploads.github.com/repos/$REPO/releases/$RID/assets?name="

# 2. Upload assets (idempotent: skip names already present)
declare -a FILES=()
for f in "$PACK"/*; do [ -f "$f" ] && FILES+=("$f"); done
FILES+=("$R6B/workbench-source-2f6e8a7.tar.gz" "$R6B/SHA256SUMS.r3-6b" "$R6B/RELEASE-NOTES.md")

UPLOADED=0; SKIPPED=0; FAILED=0
HAVE=$(curl -s -H "Authorization: token $GH_TOKEN" "$API/repos/$REPO/releases/$RID/assets?per_page=100" \
  | python3 -c "import json,sys; print(' '.join(a['name'] for a in json.load(sys.stdin)))")
for f in "${FILES[@]}"; do
  n=$(basename "$f")
  if [ ! -s "$f" ]; then SKIPPED=$((SKIPPED+1)); log "skip (0-byte by design, GitHub rejects empty assets): $n"; continue; fi
  if echo " $HAVE " | rg -q " $n "; then SKIPPED=$((SKIPPED+1)); log "skip (present): $n"; continue; fi
  ok=""
  for attempt in 1 2 3; do
    code=$(curl -s -o /tmp/up-out.json -w "%{http_code}" -X POST \
      -H "Authorization: token $GH_TOKEN" -H "Content-Type: application/octet-stream" \
      --data-binary "@$f" "$UPLOAD_URL$n")
    if [ "$code" = "201" ]; then ok=yes; break; fi
    log "retry $attempt for $n (HTTP $code)"; sleep 2
  done
  if [ -n "$ok" ]; then UPLOADED=$((UPLOADED+1)); log "uploaded: $n"; else FAILED=$((FAILED+1)); log "FAILED: $n"; fi
done
log "assets: uploaded=$UPLOADED skipped=$SKIPPED failed=$FAILED"
[ "$FAILED" = "0" ] || exit 2
log "RELEASE_ID=$RID"

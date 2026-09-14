#!/usr/bin/env bash
# R3-7: verify every release asset by re-downloading and hash-comparing.
set -u
: "${GH_TOKEN:?GH_TOKEN must be set in env}"
REPO=SyllabAI/syllabai-core
TAG=t-c04-r3-7-production-readiness
PACK=/home/z/my-project/download/evidence-r3-7
LOG=/home/z/my-project/download/evidence-r3-7/asset-verify.log
TMP=$(mktemp -d)
RID=$(curl -s -H "Authorization: token $GH_TOKEN" "https://api.github.com/repos/$REPO/releases/tags/$TAG" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "== R3-7 release asset verification $(date -u +%Y-%m-%dT%H:%M:%SZ) release=$RID ==" > "$LOG"

python3 - "$REPO" "$RID" > "$TMP/assets.tsv" <<'PY'
import json,sys,urllib.request,os
req=urllib.request.Request(f"https://api.github.com/repos/{sys.argv[1]}/releases/{sys.argv[2]}/assets?per_page=100")
req.add_header("Authorization", f"token {os.environ['GH_TOKEN']}")
for a in json.load(urllib.request.urlopen(req)):
    print(a["id"], a["name"], a["size"], sep="\t")
PY

PASS=0; FAIL=0
while IFS=$'\t' read -r aid name size; do
  local_f="$PACK/$name"
  if [ ! -f "$local_f" ]; then
    echo "FAIL no-local-copy: $name" | tee -a "$LOG"; FAIL=$((FAIL+1)); continue
  fi
  curl -sL -H "Authorization: token $GH_TOKEN" -H "Accept: application/octet-stream" \
    "https://api.github.com/repos/$REPO/releases/assets/$aid" -o "$TMP/dl"
  actual_size=$(stat -c%s "$TMP/dl")
  h1=$(sha256sum "$TMP/dl" | awk '{print $1}')
  h2=$(sha256sum "$local_f" | awk '{print $1}')
  if [ "$h1" = "$h2" ] && [ "$actual_size" = "$size" ]; then
    echo "PASS $name ($actual_size bytes, $h1)" | tee -a "$LOG"; PASS=$((PASS+1))
  else
    echo "FAIL mismatch: $name dl=$h1 local=$h2 sizes=$actual_size/$size" | tee -a "$LOG"; FAIL=$((FAIL+1))
  fi
done < "$TMP/assets.tsv"
rm -rf "$TMP"
echo "== totals: PASS=$PASS FAIL=$FAIL ==" | tee -a "$LOG"
[ "$FAIL" = "0" ]

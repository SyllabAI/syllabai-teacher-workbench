#!/usr/bin/env bash
# R3-6-b: verify every release asset by re-downloading and hash-comparing.
set -u
: "${GH_TOKEN:?GH_TOKEN must be set in env}"
REPO=SyllabAI/syllabai-core
RID=388016740
PACK=/home/z/my-project/download/evidence-r3-6
R6B=/home/z/my-project/download/evidence-r3-6-b
LOG=/home/z/my-project/download/evidence-r3-6-b/asset-verify.log
TMP=$(mktemp -d)
echo "== R3-6-b release asset verification $(date -u +%Y-%m-%dT%H:%M:%SZ) ==" > "$LOG"

python3 - "$REPO" "$RID" > "$TMP/assets.tsv" <<'PY'
import json,sys,urllib.request,os
req=urllib.request.Request(f"https://api.github.com/repos/{sys.argv[1]}/releases/{sys.argv[2]}/assets?per_page=100")
req.add_header("Authorization", f"token {os.environ['GH_TOKEN']}")
for a in json.load(urllib.request.urlopen(req)):
    print(a["id"], a["name"], a["size"], sep="\t")
PY

PASS=0; FAIL=0
while IFS=$'\t' read -r aid name size; do
  # local candidate path
  if [ -f "$PACK/$name" ]; then local_f="$PACK/$name"; elif [ -f "$R6B/$name" ]; then local_f="$R6B/$name"; else
    echo "FAIL no-local-copy: $name" | tee -a "$LOG"; FAIL=$((FAIL+1)); continue; fi
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

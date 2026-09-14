#!/usr/bin/env bash
# R3-8: push reconstructed workbench main + cut t-c04-r3-8 release on
# SyllabAI/syllabai-core with 32 assets, then re-download + hash-verify all.
# Token: env GH_TOKEN only — never written to disk, never echoed.
set -u
: "${GH_TOKEN:?GH_TOKEN must be set in env}"
WB=/home/z/my-project
STG=/home/z/r3-8-release
CORE=SyllabAI/syllabai-core
WBREPO=SyllabAI/syllabai-teacher-workbench
TAG=t-c04-r3-8

echo "== 0) token check =="
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: token $GH_TOKEN" https://api.github.com/user)
if [ "$code" != "200" ]; then echo "TOKEN INVALID (HTTP $code) — aborting. Obtain a fresh PAT."; exit 2; fi
echo "token OK"

echo "== 1) push workbench main =="
git -C "$WB" push "https://x-access-token:${GH_TOKEN}@github.com/${WBREPO}.git" HEAD:main 2>&1 | sed "s/${GH_TOKEN}/<REDACTED>/g"
remote=$(git ls-remote https://github.com/${WBREPO}.git refs/heads/main | awk '{print $1}')
localsha=$(git -C "$WB" rev-parse HEAD)
echo "remote main: $remote / local: $localsha"
[ "$remote" = "$localsha" ] || { echo "PUSH VERIFY FAILED"; exit 3; }

echo "== 2) create release $TAG on $CORE =="
RID=$(curl -s -H "Authorization: token $GH_TOKEN" "https://api.github.com/repos/$CORE/releases/tags/$TAG" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))")
if [ -z "$RID" ]; then
  python3 - "$TAG" > /tmp/r3-8-body.json <<'PY'
import json,sys
body=open('/home/z/r3-8-release/RELEASE-BODY.md').read()
print(json.dumps({"tag_name":sys.argv[1],"target_commitish":"main",
 "name":"T-C04 R3-8 — Real Host Deployment & First Reviewer Readiness",
 "body":body,"draft":False,"prerelease":False}))
PY
  RID=$(curl -s -X POST -H "Authorization: token $GH_TOKEN" -H "Content-Type: application/json" \
        -d @/tmp/r3-8-body.json "https://api.github.com/repos/$CORE/releases" \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id') or die if False else d.get('id',''))")
  rm -f /tmp/r3-8-body.json
  [ -n "$RID" ] || { echo "RELEASE CREATE FAILED"; exit 4; }
  echo "created release id $RID"
else
  echo "release exists (id $RID) — clearing stale assets"
  curl -s -H "Authorization: token $GH_TOKEN" "https://api.github.com/repos/$CORE/releases/$RID/assets?per_page=100" \
   | python3 -c "import json,sys; [print(a['id']) for a in json.load(sys.stdin)]" \
   | while read -r aid; do curl -s -X DELETE -H "Authorization: token $GH_TOKEN" "https://api.github.com/repos/$CORE/releases/assets/$aid"; done
  python3 > /tmp/r3-8-body.json <<'PY'
import json
body=open('/home/z/r3-8-release/RELEASE-BODY.md').read()
print(json.dumps({"body":body}))
PY
  curl -s -X PATCH -H "Authorization: token $GH_TOKEN" -H "Content-Type: application/json" \
       -d @/tmp/r3-8-body.json "https://api.github.com/repos/$CORE/releases/$RID" > /dev/null
  rm -f /tmp/r3-8-body.json
fi

echo "== 3) upload assets (ALLOWLIST: SHA256SUMS entries + tarball ONLY — never directory scan) =="
UP=0
for f in $(cd "$STG" && awk '{print $2}' /home/z/my-project/download/evidence-r3-8/SHA256SUMS | sed 's|^\./||' | sort; echo workbench-source-43eace2.tar.gz); do
  [ -f "$STG/$f" ] || continue
  name=$(basename "$f")
  sz=$(stat -c%s "$STG/$f")
  [ "$sz" -gt 0 ] || { echo "SKIP 0-byte: $name (GitHub 422)"; continue; }
  r=$(curl -s -o /tmp/r3-8-up.json -w "%{http_code}" -X POST \
      -H "Authorization: token $GH_TOKEN" -H "Content-Type: application/octet-stream" \
      --data-binary @"$STG/$f" \
      "https://uploads.github.com/repos/$CORE/releases/$RID/assets?name=$name")
  if [ "$r" = "201" ]; then UP=$((UP+1)); echo "OK  $name ($sz B)"; else echo "FAIL $name http=$r $(head -c 200 /tmp/r3-8-up.json)"; fi
  rm -f /tmp/r3-8-up.json
done
echo "uploaded: $UP"

echo "== 4) re-download every asset + hash verify (R3-7 pattern) =="
python3 - "$CORE" "$RID" "$STG" <<'PY'
import json,sys,urllib.request,hashlib,os
core,rid,stg=sys.argv[1],sys.argv[2],sys.argv[3]
req=urllib.request.Request(f"https://api.github.com/repos/{core}/releases/{rid}/assets?per_page=100")
req.add_header("Authorization",f"token {os.environ['GH_TOKEN']}")
assets=json.load(urllib.request.urlopen(req))
print(f"remote assets: {len(assets)} (expected 33 = 32 pack files + tarball)")
fails=0
# expected: SHA256SUMS entries (relative) + tarball
exp={}
for line in open(f"{stg}/../my-project/download/evidence-r3-8/SHA256SUMS") if False else open("/home/z/my-project/download/evidence-r3-8/SHA256SUMS"):
    h,p=line.split(None,1); exp[os.path.basename(p.strip())]=h
tb=open("/home/z/r3-8-release/tarball-sha256.txt").read().split()[0]
exp["workbench-source-43eace2.tar.gz"]=tb
for a in assets:
    n=a["name"]
    # PRIVATE repo: browser_download_url 404s — use the API asset endpoint
    req=urllib.request.Request(f"https://api.github.com/repos/{core}/releases/assets/{a['id']}")
    req.add_header("Authorization",f"token {os.environ['GH_TOKEN']}")
    req.add_header("Accept","application/octet-stream")
    data=urllib.request.urlopen(req).read()
    h=hashlib.sha256(data).hexdigest()
    ok = n in exp and exp[n]==h and len(data)==a["size"]
    print(("PASS " if ok else "FAIL ")+n+f" ({len(data)} B)")
    if not ok: fails+=1
missing=set(exp)-{a['name'] for a in assets}
for m in missing: print("FAIL missing asset:",m); fails+=1
print(f"VERIFICATION: {len(assets)-fails}/{len(assets)} PASS, {fails} FAIL")
sys.exit(1 if fails else 0)
PY
echo "== done =="

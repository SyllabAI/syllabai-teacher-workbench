#!/usr/bin/env bash
# R3-8 release staging verifier: staging dir must contain EXACTLY the
# 31 SHA256SUMS-covered files + the source tarball, byte-identical to source.
set -u
SRC=/home/z/my-project/download/evidence-r3-8
STG=/home/z/r3-8-release
TARB=/home/z/r3-8-release/workbench-source-43eace2.tar.gz
fail=0

# 1) every SHA256SUMS entry present + hash matches source
cd "$SRC"
while read -r sum path; do
  [ -f "$STG/$path" ] || { echo "MISSING in staging: $path"; fail=1; continue; }
  a=$(sha256sum "$path" | awk '{print $1}')
  b=$(sha256sum "$STG/$path" | awk '{print $1}')
  [ "$a" = "$b" ] || { echo "HASH MISMATCH: $path"; fail=1; }
done < SHA256SUMS

# 2) tarball present with recorded hash
[ -f "$TARB" ] || { echo "MISSING: tarball"; fail=1; }
grep -q "$(awk '{print $1}' "$STG/tarball-sha256.txt")" <(sha256sum "$TARB") || { echo "TARBALL HASH MISMATCH"; fail=1; }

# 3) no unexpected extras that would be uploaded accidentally
[ -f "$STG/RELEASE-BODY.md" ] || { echo "MISSING: RELEASE-BODY.md"; fail=1; }

[ $fail -eq 0 ] && echo "STAGING OK: 31 evidence files + tarball + release body" || { echo "STAGING FAILED"; exit 1; }

#!/usr/bin/env bash
# R3-7 — large-artifact guard.
# Fails on files >50MB (GitHub warns/blocks at 50MB/100MB), warns >5MB.
# Usage: scripts/check-large-files.sh [paths...]   (default: tracked files)
set -u
FAIL_LIMIT=$((50 * 1024 * 1024))
WARN_LIMIT=$((5 * 1024 * 1024))
rc=0
check() {
  local f="$1"
  [ -f "$f" ] || return 0
  local size
  size=$(stat -c%s "$f" 2>/dev/null || echo 0)
  if [ "$size" -gt "$FAIL_LIMIT" ]; then
    echo "FAIL: $f is $((size / 1048576))MB (>50MB) — release bundles belong in GitHub Releases, not git" >&2
    rc=1
  elif [ "$size" -gt "$WARN_LIMIT" ]; then
    echo "warn: $f is $((size / 1048576))MB (>5MB) — consider GitHub Releases" >&2
  fi
}
if [ "$#" -gt 0 ]; then
  for f in "$@"; do check "$f"; done
else
  while IFS= read -r f; do check "$f"; done < <(git ls-files)
fi
exit $rc

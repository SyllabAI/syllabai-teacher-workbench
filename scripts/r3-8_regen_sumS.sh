#!/usr/bin/env bash
# Regenerate evidence-r3-8/SHA256SUMS with FULL relative-path coverage
# (all files except SHA256SUMS itself), then self-verify.
set -eu
cd /tmp/wb-clone/download/evidence-r3-8
find . -type f ! -name SHA256SUMS | sort | while read -r f; do
  sha256sum "$f"
done > SHA256SUMS
echo "entries: $(wc -l < SHA256SUMS)"
sha256sum -c SHA256SUMS

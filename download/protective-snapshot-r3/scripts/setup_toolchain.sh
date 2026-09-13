#!/bin/bash
# setup_toolchain.sh — reconstruct the ephemeral toolchain (maven + PG17 debs)
set -x
cd /home/z/toolchain

# --- maven (resume until complete; archive.apache.org is slow) ---
for i in 1 2 3 4 5 6 7 8; do
  size=$(stat -c %s maven.tgz 2>/dev/null || echo 0)
  # full size is 9245919 bytes
  if [ "$size" -ge 9245919 ]; then break; fi
  curl -sSL -C - -o maven.tgz https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz
done
if [ -f maven.tgz ]; then
  tar xzf maven.tgz 2>/dev/null && rm -f maven.tgz && echo "MAVEN_OK $(./apache-maven-3.9.9/bin/mvn -version 2>&1 | head -1)"
fi

# --- postgresql 17 debs from debian pool ---
mkdir -p pgdebs/debs pgdebs/root
cd pgdebs/debs
BASE=http://deb.debian.org/debian/pool/main/p
for f in postgresql-17_17.11-0+deb13u1_amd64.deb \
         postgresql-client-17_17.11-0+deb13u1_amd64.deb \
         libpq5_17.11-0+deb13u1_amd64.deb; do
  [ -f "$f" ] && continue
  for try in 1 2 3 4 5; do
    src="$BASE/postgresql-17/$f"
    curl -sfL -C - -o "$f" "$src" && [ -s "$f" ] && break
    src="$BASE/postgresql-common/$f"
    curl -sfL -C - -o "$f" "$src" && break
    sleep 3
  done
  echo "DEB $f $(stat -c %s "$f" 2>/dev/null)"
done

# --- extract into pgdebs/root (no root needed) ---
cd /home/z/toolchain/pgdebs/root
for d in /home/z/toolchain/pgdebs/debs/*.deb; do
  dpkg -x "$d" . && echo "EXTRACTED $(basename $d)"
done
PG_BIN=/home/z/toolchain/pgdebs/root/usr/lib/postgresql/17/bin
ls "$PG_BIN" | head -6
echo "=== ldd missing libs ==="
ldd "$PG_BIN/psql" 2>/dev/null | rg 'not found' || echo "psql deps OK"
ldd "$PG_BIN/postgres" 2>/dev/null | rg 'not found' || echo "postgres deps OK"
ldd "$PG_BIN/initdb" 2>/dev/null | rg 'not found' || echo "initdb deps OK"
echo "SETUP_DONE"

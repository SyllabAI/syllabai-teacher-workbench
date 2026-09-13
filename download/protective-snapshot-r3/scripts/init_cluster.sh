#!/bin/bash
# init_cluster.sh — create + start the PostgreSQL 17 cluster (trust auth, as user z)
set -e
PGBIN=/home/z/toolchain/pgdebs/root/usr/lib/postgresql/17/bin
PGDATA=/home/z/toolchain/pgdata
SOCK=/home/z/toolchain/pgsock
mkdir -p "$SOCK" /home/z/toolchain/pglog

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  "$PGBIN/initdb" -D "$PGDATA" -A trust -U postgres -E UTF8 >/home/z/toolchain/pglog/initdb.log 2>&1
  echo "cluster initialized"
fi

if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  "$PGBIN/pg_ctl" -D "$PGDATA" -l /home/z/toolchain/pglog/pg.log \
    -o "-k $SOCK -p 5432 -c listen_addresses=127.0.0.1" -w start
fi

"$PGBIN/psql" -h 127.0.0.1 -p 5432 -U postgres -d postgres -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname='syllabai'" | grep -q 1 || \
  "$PGBIN/psql" -h 127.0.0.1 -p 5432 -U postgres -d postgres -c \
  "CREATE ROLE syllabai LOGIN SUPERUSER;"

"$PGBIN/psql" -h 127.0.0.1 -p 5432 -U postgres -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='syllabai'" | grep -q 1 || \
  "$PGBIN/psql" -h 127.0.0.1 -p 5432 -U postgres -d postgres -c \
  "CREATE DATABASE syllabai OWNER syllabai;"

"$PGBIN/psql" -h 127.0.0.1 -p 5432 -U syllabai -d syllabai -tAc "SELECT current_database(), current_user;"
echo "CLUSTER_READY"

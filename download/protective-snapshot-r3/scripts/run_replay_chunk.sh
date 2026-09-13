#!/bin/bash
# run_replay_chunk.sh — foreground chunked campaign replay (sandbox-safe).
# Clears stray JVMs from any previously killed stage-2 boot, then resumes the
# driver (state-file driven: completed batches are skipped automatically).
PGBIN=/home/z/toolchain/pgdebs/root/usr/lib/postgresql/17/bin
export JAVA_HOME=/home/z/toolchain/jdk-25.0.4.1+1
export PATH="$JAVA_HOME/bin:$PATH"

# 1. clear stray JVMs (killed-mid-boot leftovers hold port 8080)
pkill -f syllabai-core.jar 2>/dev/null && sleep 3

# 2. sanity: campaign DB identity must still hold before any batch
python3 /home/z/my-project/scripts/campaign_db_preflight.py || exit 1

# 3. resume the campaign (foreground; caller enforces the time window)
cd /home/z/my-project
python3 scripts/run_ingestion_campaign.py all
exit $?

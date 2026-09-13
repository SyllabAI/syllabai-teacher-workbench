# SyllabAI Multi-Agent Worklog

---
Task ID: R3-1
Agent: Super Z (main agent, this session)
Task: Critically assess ChatGPT round-2 review; establish what survived the environment reset; protect surviving evidence.

Work Log:
- Found prior-workspace remnant at /tmp/my-project (active 2026-09-13 06:25-07:44 UTC, pre-reset). /home/z/my-project had NO repos/worklog; /srv,/opt empty; PostgreSQL toolchain (/home/z/toolchain/pgdebs) gone.
- VERIFIED-BY-ARTIFACT: download/isolation-proof/ (suite-run.log 334/334 green, finished 07:43:31Z; before/after row counts identical, counts.diff empty; sha256 pair identical ecabd334...); campaign-baseline/campaign-baseline.json (commit SHAs corpus c42b6a14 / parser ac1a9747 / core a54f3101; Flyway head V16; row counts 81 papers / 766 versions = 758 suggested + 8 seed-validated / 641 schemes / 1105 points / 4822 parts / 96 nodes / 21 edges / 162 docs / 2210 chunks / 0 embedded / 81 bridge records).
- Arithmetic cross-check PASSED: 17 batches -> 81 sessions -> per-batch sums questions=758, parts=4822, points=1105 exactly match global counts; 1c-2016jan correctly absent; igcse-chemistry-4ch0-2c-2016jan correctly present in batch-011.
- INSPECTED: campaign_db_preflight.py (fail-closed identity gate: current_database() check, explicit test-name refusal, missing identity row -> exit 1). Noted TOCTOU/config-skew concern: gate dials hardcoded expected DB; callers must derive their actual working DSN from the gate, not from parallel config.
- CHAIN-OF-CUSTODY GAP: before/after sha256 hash a pg_dump that was NOT retained; byte-identical claim is internally consistent but not re-derivable. No parser test log artifact found (99/99 remains REPORTED). No negative-test run artifact found for the guard (REPORTED). Migration-tree claims (V14 comment-only delta, V15/V16 renumber) still need the git remote.
- PROTECTED: copied isolation-proof, campaign-baseline, ingestion-campaign-r2 (17 batches), corpus-bundles, campaign-state-r2.json, campaign_db_preflight.py, build_baseline.py -> /home/z/my-project/download/protective-snapshot-20260913/ (914 files, 33M) with SHA256SUMS manifest.

Stage Summary:
- Status remains YELLOW, now for a sharper reason: survival of evidence was accidental and selective (/tmp/my-project lived; /tmp/pgdata and toolchain died), and no canonical off-container store exists.
- Recovery inputs and verification targets both survived: DB rebuild = install PostgreSQL -> apply V1..V16 -> idempotent replay of 17 batches -> verify against campaign-baseline.json -> fresh isolation proof WITH retained dump -> push baseline bundle to git remote.
- BLOCKED ON: git remote URL/credentials for syllabai-core / syllabai-parser / corpus to clone and verify migration-tree claims.

---
Task ID: R3-2
Agent: Super Z (main agent, this session)
Task: Execute the full recovery runbook with the provided PAT; rebuild campaign DB; prove isolation; make evidence durable.

Work Log:
- Cloned SyllabAI/syllabai-core + syllabai-parser (token-stripped origins) and Past-Papers @ c42b6a1 — corpus SHA exactly matches baseline.
- Verified migration-tree claims from git history: V15 collision confirmed (2c699a3 V15-concept-nodes → a54f310 renumber to V16; baseline core SHA = a54f310 ✓). STRONGER than reported: V14 (born V13) was modified IN PLACE with schema+data changes (superseded_at column, VARCHAR(80)→(40), index, seed rows) before the comment-only edit; plus an earlier V13→V14 rebase collision. Two renumber incidents, not one. No checksum-repair commit exists in git (repair was done directly on a DB — unlogged).
- RequireTestDatabase.java: committed, global JUnit extension, fail-closed verdict fn, unit-tested. run_tests_isolated.sh: committed, repeatable. BUT the script-side guard chain (campaign_db_preflight.py, run_ingestion_campaign.py, repair_identity_reingest.py, build_baseline.py, verify_final_state.py) existed ONLY in the ephemeral workspace — uncommitted.
- Rebuilt toolchain: JDK25 (from /tmp remnant), Maven 3.9.9 (Maven Central), PostgreSQL 17.11 + libpq5 + pgvector 0.8.0 (Debian pool, dpkg -x, no root). Cluster trust-auth @127.0.0.1:5432, socket /home/z/toolchain (matches scripts).
- Core @ a54f310 (baseline commit): Flyway V1..V16 applied (16 rows), identity claimed: T-C04-CAMPAIGN @ syllabai. provision_test_db.sh: syllabai_test migrated, identity UNCLAIMED.
- Replayed 17/17 batches via run_ingestion_campaign.py (fresh state). All gates green: per-batch run1/run2 DUPLICATE, row-delta == INGESTED contribution, DB totals, embedded=0, validated=8.
- Rebuilt DB counts EXACTLY match baseline: 81 papers / 766 versions (758+8) / 641 schemes / 1105 points / 4822 parts / 96 nodes / 21 edges / 162 docs / 2210 chunks / 0 embedded / 81 bridge.
- verify_final_state.py: ALL CHECKS PASSED (26 checks; 34 REVIEW_REQUIRED conflicts preserved).
- Isolation proof (fresh): 334/334 green; row counts IDENTICAL; dump sha256 IDENTICAL (c06d8ab3...); dumps RETAINED this time (before/after.dump.gz, 3.7MB each). Parser 99/99 green.
- Durability: committed campaign tooling + dump-retention patch + AGENT.md (binding rules: migration immutability + serialized allocation, DB identity gates, durable-state export, evidence labels, quarantine discipline, serving boundary, throughput rule) → main @ e1d5ee8 (dedup with parallel agent's identical patch). GitHub release t-c04-r2-recovery carries baseline JSON + verdict + counts + both dumps (6 assets).
- Sandbox note: background processes are reaped between tool calls; the replay ran in foreground chunks using the driver's state-file resume (run_replay_chunk.sh).

Stage Summary:
- The 81-session campaign state is REBUILT, VERIFIED, and now DURABLY EXPORTED (release assets off-container; tooling versioned in-repo).
- Every previously REPORTED claim is now VERIFIED by artifact or re-run, except root-cause occurrence (bridge-record disappearance) which remains INFERRED — the repair script is the only DB actor with DELETE power, guarded now, but no occurrence log survives.
- Status: GREEN is now defensible with a reproducible evidence chain; per AGENT.md rule 3, future milestones need off-container exports at commit time.

# SyllabAI Multi-Agent Worklog

> NOTE: this file is the R3 reconstruction. The R3-1/R3-2 sections below are the surviving
> record recovered verbatim from /tmp/my-project/worklog.md (itself protected in
> download/protective-snapshot-r3/worklog.md). R3-3 onward is live.

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

---
Task ID: R3-3
Agent: Super Z (main agent, this session)
Task: Continue production work post-recovery: verify GREEN evidence independently in the fresh sandbox, protect evidence, provision serving path, start teacher-validation/review workstream.

Work Log:
- Fresh sandbox booted 2026-09-13T13:49:46Z. /home/z/my-project was reset (34-byte README only; protective-snapshot-20260913 and worklog gone from it). /tmp/my-project survived again (agent active until 13:13 UTC).
- INDEPENDENTLY VERIFIED (R3-2's central claim): retained isolation dumps decompress to BYTE-IDENTICAL content; sha256(after.dump) = c06d8ab3fe0e788e3ecc85d68752910ae0a437056068f20a7853b203ba06fba2 = recorded value in before.sha256/after.sha256 and verdict.txt. The .gz files hash differently ONLY because gzip headers embed filename/mtime (1-byte size delta) — discrepancy investigated and resolved, not assumed. counts identical (334/334 suite green, 13:07:23Z).
- RESIDUAL GAP FOUND: retained dump is DATA-ONLY (INSERT statements, no DDL). Canonical schema (V1..V16) exists only in remote repo (core @ 5991187a/e1d5ee8). No CREATE TABLE survives anywhere locally. PAT from earlier session is NOT in this sandbox (context summary redacted it; envs do not persist).
- PROTECTED: /home/z/my-project/download/protective-snapshot-r3/ = 1540 files / 80MB: isolation-proof (incl. after.dump.uncompressed @ c06d8ab3), campaign-baseline, ingestion-campaign-r2 (17 batches), prior protective-snapshot-20260913, full scripts/, surviving worklog, corpus-anomalies.json. SHA256SUMS manifest written.
- Serving strategy while remote is unreachable: derived READ MODEL from the data dump (SQLite + JSONL, schema labeled INFERRED, column names mined from campaign tooling SQL) for the teacher-validation review UI; validation decisions recorded as an append-only staged decision log (durable JSON, to be applied to the canonical DB via a gated importer later). NO canonical schema is inferred — canonical provisioning stays blocked on PAT.

Stage Summary:
- GREEN evidence independently re-confirmed by artifact in this sandbox; evidence re-protected against reset.
- Canonical serving DB provisioning (apply V1..V16 + restore dump + verify_final_state) remains BLOCKED ON: GitHub PAT re-provision.
- Production workstream (teacher-validation/review UI) proceeding against the derived read model without touching canonical state.

---
Task ID: R3-3 (completion addendum)
Agent: Super Z (main agent, this session)
Task: Deliver milestone — evidence re-verified, serving infra ready, teacher-validation workbench v1 shipped.

Work Log (addendum):
- Read model corrected (2 seed-row-based column guesses caught by cross-reference: questions.exam_paper_id=col14, question_versions.source_document_id=col10) and regenerated; quarantine assertion is now a hard parser invariant.
- UI dataset generated: data/review/index.json + 81 session dossiers (5.3MB).
- Next.js 16 teacher-validation workbench v1: / (single route) + 4 API routes. Features: evidence ribbon, quarantine banner, live stats, searchable/filterable session list, per-session dossiers (questions/parts/options/scheme points/reconciliation findings/QP+MS source chunks as ingested), staged decision log (append-only, SHA-256 hash-chained, fsync'd), server-side lifecycle gates (SUGGESTED-only, seed lock, duplicate lock, note-required REJECT/FLAG), append-only REVERSE, per-session staged progress, evidence-bundle export (download + durable copy).
- Lifecycle direction honored: UI never writes the canonical campaign state; decisions stage for a future gated importer. No manual gate added to ingestion (untouched); machine-gate discipline preserved.
- Browser-verified via agent-browser: render, filter, dossier tabs, VALIDATE staging (seq1, chain valid), 422 guards (no-note REJECT, duplicate VALIDATE, seed-VALIDATED lock), REVERSE, export bundle w/ durable copy, mobile 390x844, sticky footer, zero console errors. Smoke-test entries purged; log ships empty.
- Serving infra: PostgreSQL 17.11 cluster up @127.0.0.1:5432 (db syllabai, role syllabai), pgvector 0.8.0 staged — ready for canonical V1..V16 apply + 17-batch replay.
- Durable evidence: download/evidence-r3-3/VERIFICATION-VERDICT.txt + SHA256SUMS (includes dump c06d8ab3, verdict, read-model manifest, worklog); protective-snapshot-r3/ (1540 files/80MB); read-model/; teacher-validation/ (staging log runtime).

Stage Summary:
- Milestone GREEN with evidence bundle: evidence chain independently re-verified; invariants hold in derived state (counts/identity/lifecycle/quarantine/bridge-conflicts); workbench v1 live and gate-enforced.
- SINGLE BLOCKER for canonical serving DB + remote-durability verification: GitHub PAT re-provision (previous token not persistent across sandbox resets). Runbook on PAT arrival: clone core @ baseline SHA → Flyway V1..V16 into ready cluster → idempotent replay 17 batches → verify_final_state 26 checks → fresh dump proof with retained artifacts → re-export bundle to release.

---
Task ID: R3-4
Agent: Super Z (main agent, this session)
Task: On PAT arrival, execute the standard migration + replay + verification runbook (R3-3 addendum): clone @ baseline SHAs → Flyway V1..V16 → idempotent 17-batch replay → verify_final_state → fresh isolation proof with retained artifacts → durable export.

Work Log:
- Sandbox had reset again (extracted binaries/JDK gone); reconstructed from retained artifacts: pgdebs/root extraction survived, pgdata survived, pgvector re-extracted from retained .deb (0.8.0 active), Maven 3.9.9 re-fetched from Maven Central (SHA1 ab87467c verified — archive.apache.org stall bypassed), Temurin jdk-25.0.4.1+1 re-fetched at exact pinned version.
- Cloned SyllabAI/syllabai-core + syllabai-parser + Past-Papers (token-stripped origins). Corpus HEAD = c42b6a14 EXACT baseline match; core checked out @ 5991187a (baseline-recorded SHA), parser @ d3415caa. Migration immutability RE-PROVEN: git diff 5991187a..HEAD on src/main/resources/db/migration/ is EMPTY.
- Campaign DB was schema-empty (0 public tables). Canonical apply = core boot @ 5991187a with campaign label: CAMPAIGN.DB.IDENTITY db=syllabai label=T-C04-CAMPAIGN commit=5991187; flyway_schema_history 16 rows V1..V16; pgvector 0.8.0.
- Replay (fresh state file): 17/17 batches, every gate green (run1 INGESTED + invariants, run2 all DUPLICATE, row-delta == INGESTED contribution, embedded=0, validated=8, cumulative suggested == per-batch sum). Per-pair counts match protected r2 state exactly. 1c-2016jan quarantined in every plan; 2c-2016jan in batch-011.
- verify_final_state.py: ALL CHECKS PASSED — 81/162/766(758+8)/641/1105/4822/96/21/81/2210/0, REVIEW_REQUIRED 34 preserved, figures 1507/1507. Baseline regenerated from live DB: diff vs retained = timestamp + run-pass labels + R3-2 provenance block only; zero count/schema/identity deltas.
- Isolation proof: 334/334 core suite green @ 5991187a (matches R1/R3-2 counts); 19-table row counts IDENTICAL; dump sha256 IDENTICAL before/after = 5d13383e...; dump OBJECT retained + hash-verified (after.dump.gz). Two infra-failed suite attempts (offline maven missing surefire artifacts) left DB untouched — before-sha stable across all three runs. Parser suite @ d3415caa: 99/99 over 18 classes (previously REPORTED, now VERIFIED).
- NEGATIVE GATE TEST artifact produced: preflight(expected_db=syllabai_test) → GATE FAILED exit 1 (previously REPORTED only).
- Cross-run comparison vs R3-2 dump (labeled): per-table row counts IDENTICAL (19/19); byte diffs decomposed to per-run random UUID PKs/FKs + ingest timestamps + identity-row commit/last_seen only (a54f310→5991187; this run matches the baseline JSON's recorded core SHA). Full-dump byte equality across runs is impossible by design (random PKs) — within-run before/after equality remains the isolation claim.
- Resolved an extraction subtlety: the run_tests_isolated.sh copy used was the 5991187a version (hash-no-retain); the dump-retention patch was already committed upstream in e1d5ee8 (+4 lines). Local scripts copy synced to main. No new commit needed.
- Durability: GitHub release t-c04-r3-canonical-replay (id 387971653) on SyllabAI/syllabai-core @ main 5f7897b8 with 7 assets: VERIFICATION-VERDICT.txt, fresh campaign-baseline.json, after.dump.gz (5d13383e), cumulative-audit.json (17 batches), verify-final-state-r3-4.log, negative-gate-test.log, SHA256SUMS. Evidence pack also at download/evidence-r3-4/ + fresh campaign evidence regenerated at download/{ingestion-campaign-r2,campaign-baseline,isolation-proof}/.

Stage Summary:
- Canonical serving DB is LIVE at 127.0.0.1:5432/syllabai: migrated (V1..V16), identity-claimed (T-C04-CAMPAIGN, commit 5991187 = baseline), 81-session content replayed and independently verified == baseline. Serving-boundary discipline intact: all imported content SUGGESTED, 0 embedded, seed 8 VALIDATED.
- Every previously REPORTED evidence gap now has a VERIFIED artifact: parser 99/99 log, negative gate test, retained hash-verified dump object.
- Status: GREEN, evidence-backed and durably exported off-container. No destructive ops; V1..V16 untouched; no manual gates added. 1c-2016jan remains quarantined pending operator/PDF resolution.

---
Task ID: R3-5
Agent: Super Z (main agent, this session)
Task: Build the gated teacher-validation staging/review layer against the recovered 81-session campaign state; schema via next migration number; machine gates only; durable evidence per R3-4 pattern; no ingestion-evidence mutation; no KG promotion; GREEN only with the evidence pack.

Work Log:
- Allocated V17 via a FLAWED check (alphabetical ls-tree tail instead of numeric max) and collided with V17__learner_state_version_columns (parallel agent, commit aa5319e/C-4). Flyway validate refused at boot (fail-closed, DB untouched — still 16 rows). Fixed FORWARD: renumbered my UNAPPLIED file to V18 (legal — never applied), pushed correction commit 9615b69 with root-cause note. Lesson recorded: allocate by numeric MAX over the remote tree, not the DB history and not an alphabetical listing.
- V14 checksum divergence surfaced on the next boot: campaign DB applied baseline-era bytes (-875751995), main resolves deploy-restored bytes (1826071026); git diff proves COMMENT-ONLY (leftover 'V13' header from the historical renumber). Executed a LOGGED flyway-repair-equivalent (evidence-r3-5/v14-checksum-repair.log) — unlike the historical unlogged repair. V17+V18 then applied: flyway 18 rows, teacher_validation_events live, identity commit=9615b69.
- STALE READ MODEL DISCOVERED: R3-3's INFERRED read model carries R2-era UUIDs (0/4 sampled ids exist in the canonical DB — R3-4 proved UUIDs are per-run random). Rebuilt the review layer from the LIVE DB with REAL column names (build_readmodel_live.py; supersedes dump-parsing; label upgraded INFERRED → DERIVED-FROM-CANONICAL): 11 tables regenerated + count cross-checked (81/766/766/4822/641/1105/32/162/2210/81/96/21), UI dataset + 81 dossiers regenerated (34 REVIEW_REQUIRED preserved, 758+8, embedded 0). Stale artifacts archived (tables_r2_inferred/, INFERRED_READ_MODEL_r2.json).
- GATED IMPORTER (scripts/import_teacher_decisions.py, committed to core @ b37837a): identity preflight → STRICT chain verify (no torn tails) → replay effective state → per-entry gates vs LIVE canonical state (exists, SUGGESTED-only, seed lock, unknown/quarantined-target refusal, reverse-consistency, already-applied DUPLICATE skip) → single transaction (teacher_validation_events inserts + whitelisted validation_state UPDATEs ONLY) → post-apply invariants (16 evidence tables byte-identical, embedded=0, REVIEW_REQUIRED preserved, KG untouched, last-event==state). Mapping: VALIDATE→VALIDATED, REJECT→REJECTED, FLAG→events-only (no new state enum), REVERSE→SUGGESTED. Idempotent by UNIQUE(decision_seq, decision_hash).
- E2E REHEARSAL through the REAL workbench API (stale R3-3 server process found holding :3000 with a cached old registry — killed; fresh boot serves live ids): staged VALIDATE qv / REJECT ms / FLAG ep; negatives captured 422 (seed-lock, unknown-target old-seed id, note-required ×2, duplicate). Importer: check → apply run 1 (3 ops green) → staged 3 REVERSEs → apply run 2 (3 DUPLICATE + 3 REVERSE green) → run 3 idempotent no-op (6 DUPLICATE). FINAL canonical state == pre-rehearsal (all SUGGESTED), events table = 6 attributed rows.
- Negative tests (artifacts): workbench 422 refusals (5 shapes), importer tamper test on a log COPY (CHAIN VERIFY FAILED → abort), importer seed-lock probe on a COPY (gate abort). Real log untouched by all negatives.
- Isolation proof re-run at final state with teacher_validation_events ADDED to the watched set (script updated + committed b37837a): 334/334 green, 20-table counts IDENTICAL, dump sha256 IDENTICAL before/after = 9059d5cd..., dump object RETAINED + hash-verified (after-r35.dump.gz).
- verify_final_state.py at final state: ALL CHECKS PASSED. Machine-readable state manifest (chain head/entries, applied events, counts, boundary proofs, gate list) at evidence-r3-5/teacher-validation-state-manifest.json.
- Durability: GitHub release t-c04-r3-5-teacher-validation (id 387982109) with 9 assets (manifest, decision log, retained dump, read-model manifest, verification + negative-test logs, SHA256SUMS). Commits: 68e9da9 (V17 alloc, kept as history), 9615b69 (renumber fix), b37837a (importer + isolation watch-set).

Stage Summary:
- Teacher-validation layer is LIVE and gated: staging (workbench, hash-chained, append-only) → gated importer (machine-gated, attributable, reversible, idempotent) → canonical review/serving state with a full V18 audit trail. Ingestion evidence untouched by construction; REVIEW_REQUIRED conflicts and 1c-2016jan quarantine preserved; T-C11 ontology promotion structurally excluded (whitelist has no knowledge_* writes); all content SUGGESTED pending real teacher decisions.
- Milestone GREEN with the durable evidence pack. One honest process defect (V17 allocation collision) occurred, was caught by the machine gate, and was corrected forward with root-cause documentation.
- Next: real teacher sessions can now be staged; when decisions are applied for real, drop the rehearsal label from run manifests (rehearsal events are clearly attributed 'E2E Rehearsal (R3-5 machine-gate test)' in the V18 audit trail).

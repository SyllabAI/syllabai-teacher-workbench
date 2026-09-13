# R3-6 Implementation Plan — Teacher Validation Workbench: canonical state + staged intent

Written BEFORE coding (per R3-6 directive), after inspecting:
- R3-5 workbench API/contract: src/app/api/{decisions,review}, src/lib/{decision-log,review-data}.ts
- Staging-log format: download/teacher-validation/decision-log.jsonl (6 rehearsal entries, hash-chained)
- Live read-model contract: data/review/index.json (DERIVED-FROM-CANONICAL, coreCommit 9615b69, flyway head 18)
- Teacher UI architecture: single route / → src/components/review-workbench.tsx (shadcn/Tailwind), 4 API routes
- teacher_validation_events schema/API: V18__teacher_validation_review.sql (append-only, UNIQUE(decision_seq,decision_hash))
- Auth boundaries: NONE existed pre-R3-6 (reviewer name was free text; staging POST open) — extension mandated by gate 10
- AGENT.md: 7 binding rules (migration immutability + serial allocation, fail-closed identity gates, durable export, evidence labels, quarantine, serving boundary, throughput)
- main + migration head: local main ahead 3 (68e9da9, 9615b69, b37837a) over origin/main @ 5f7897b; numeric-max migration = V18 (V17 = learner_state_version_columns by parallel agent; V18 = teacher_validation_review)

## Migration decision: NO new migration

V18 already stores every field the workbench needs to display applied state
(action, target_type, target_id, target_label, reviewer, note, result_state,
applied_at, decision_seq, decision_hash, importer_run_id). R3-6 only READS it.
Provenance checked against the migration tree by numeric max (not filename
sorting): max = V18. No V19 is allocated. V1..V18 untouched.

## Files to change

NEW:
- src/lib/canonical.ts            — read-only canonical DB access (pg Pool with
  default_transaction_read_only=on; fail-closed degradation to available:false)
- src/lib/canonical-relationship.ts — PURE relationship computation + render
  mapping (shared by UI and tests; never fetches; never mutates)
- src/lib/session.ts              — HMAC-signed teacher session (HttpOnly cookie),
  durable secret file under download/teacher-validation/
- src/app/api/session/route.ts    — POST open session / DELETE close
- src/app/api/canonical/events/route.ts — applied-events feed (read-only)
- src/app/api/canonical/state/route.ts  — live validation_state + lastAppliedEvent
  per target (batch ≤300; unknown ids -> UNKNOWN, fail-safe)
- tests/r3-6/*.test.ts            — verification matrix (bun test)

EDIT:
- src/lib/decision-log.ts         — TV_LOG_FILE env override (test isolation of the
  real hash-chained log); applied-matching helper (seq+hash)
- src/app/api/decisions/route.ts  — POST requires teacher session (403 otherwise);
  GET unchanged; response shapes unchanged
- src/components/review-workbench.tsx — three-state panels (CANONICAL / STAGED /
  APPLIED), relationship badges, banner "what I am proposing ≠ what the system
  currently believes", staging-log APPLIED/UNAPPLIED chips, stale-provenance
  fixes (header badges + footer now driven by index.json + live feed)

UNCHANGED (proved by hash/behavior):
- scripts/import_teacher_decisions.py (gated importer, sha256 recorded)
- V1..V18 migrations, canonical schema, dataset regeneration tooling
- GET contracts of all existing routes

## APIs reused vs genuinely new

Reused: GET /api/review/index, GET /api/review/session/[id], GET /api/decisions,
GET /api/decisions/export, V18 schema, importer gates.
New (contract extensions, documented): session issue/close; canonical events feed;
canonical state batch query. Breaking-but-mandated: staging POST now requires a
teacher session (acceptance gate 10). GETs and payload shapes unchanged.

## Relationship semantics (per staged intent; NEVER collapsed into one status field)

Computed PURELY from: canonical state (authoritative), open staged entries,
applied events matched by (decision_seq, decision_hash), staged REVERSE links.

- BLOCKED                  — target unknown / seed-VALIDATED lock / quarantined
- APPLIED_THEN_REVERSED    — intent was applied, later applied REVERSE restored
                             the prior canonical state
- ALREADY_APPLIED          — matching applied event exists, not reversed
- WOULD_CHANGE_CANONICAL   — staged intent's resulting state ≠ canonical state
- AGREES_WITH_CANONICAL    — staged intent's resulting state == canonical state
- FLAG is events-only: it never appears as a canonical validation state and its
  relationship never claims canonical effect.

## Safety invariants enforced

1. Next.js canonical-DB access is read-only AT THE CONNECTION LEVEL
   (default_transaction_read_only=on) — even a code bug cannot mutate canonical
   state from the serving path; the browser has no canonical-mutating route.
2. Staging writes require a server-verified teacher session (HMAC, HttpOnly).
3. Applied events feed is the ONLY source for "applied" claims; a staged entry
   with a matching applied event is never shown as a new unapplied action.
4. Fail-closed: if the canonical feed is unavailable the UI degrades to an
   explicit DEGRADED banner and treats staged intents as NOT APPLIED (never the
   opposite).

## Tests required (acceptance-gate mapping)

1 canonical VALIDATED renders canonical        -> unit fixture + live seed-VALIDATED row
2 canonical REJECTED renders canonical         -> unit fixture (0 REJECTED rows exist in DB; mapping proven by test)
3 staged VALIDATE vs SUGGESTED: staged-only    -> handler test + canonical-state assertion
4 staged REJECT vs SUGGESTED: staged-only      -> handler test + canonical-state assertion
5 FLAG remains events-only                     -> unit + handler + live rehearsal event (result_state=SUGGESTED)
6 applied ≠ staged                             -> live events feed vs log seq 1-6 matching
7 reversed event represented                   -> rehearsal seq 1->4, 2->5, 3->6 chains
8 stale/unknown ids fail safe                  -> 422 staging; UNKNOWN state in canonical query
9 attribution preserved                        -> reviewer fields in feed + log + UI
10 unauthorized cannot apply                   -> 403 matrix (no cookie, forged, expired,
                                                  wrong-role) + canonical-immutable sweep
11 importer gates untouched and pass           -> sha256 + check-mode run (6x DUPLICATE)
12 existing app tests green                    -> lint + tsc + next build + bun test suite

# SyllabAI 4CH1 Past-Paper Ingestion — Cumulative Campaign Report (r2, FINAL)

Generated: 2026-09-13 06:30:45 UTC

**VERDICT: YELLOW — continue with recorded issues**

## Corpus
| | |
|---|---|
| Sessions in scope | 82 (paper 1: 41, paper 2: 41) |
| Ingested | **81** |
| Quarantined | **1** — 1c-2016jan |
| Remaining unprocessed | 0 |

## Database
| table | rows |
|---|---|
| ExamPapers | 81 (all PAST_PAPER, all SUGGESTED) |
| Questions | 766 (758 imported + 8 seed) |
| QuestionVersions | 766 (758 SUGGESTED + 8 seed VALIDATED, 0 other states) |
| QuestionParts | 4822 |
| MarkSchemes | 641 |
| MarkPoints | 1105 |
| Documents | 162 (81 pairs, engine 1.1.0) |
| Chunks | 2210 — embedded: **0** |
| KnowledgeNodes | 96 (15 seed + 81 per-paper ingestion anchors) |
| Bridge records | 81 (findings preserved verbatim) |

MS coverage: 641/758 versions (84.6%) — uncovered questions stay review-visible (no fabricated schemes)

## Assets
- Figure references in imported drafts: **1507/1507 resolved (100%)**, unresolved 0
- Removed as page furniture (r1 round-2 pass, re-verified this session): **9**
  (7 blank-page/border frames + 2 answer-line strips; 0 genuine, 0 uncertain — all nine
  re-inspected visually against preserved renders)
- Removed in the operator's round-1 pass (historical): 1362
- Stale md references: 0 — 6-check mapping audit ALL GREEN (paper 1: 637, paper 2: 314)

## Integrity
- Duplicate identity: 0 (the new identity gate caught the 2016-Jan content duplicate r1 missed)
- Duplicate part labels: 0; orphaned assessment records: 0; orphaned documents: 0
- Idempotency: per-batch run1/run2 all-DUPLICATE + row-delta gate; explicit final full-batch
  rerun: rows before == after (81 papers / 766 versions / 2210 chunks / 81 bridges)
- Learner-serving boundary: ServableQuestionSpec serves only VALIDATED; all imports are
  SUGGESTED STRUCTURED → 0 servable; 0 embeddings → vector path empty
- Validation boundary: ingestion ≠ validation; no import was auto-validated
- Parser↔core contract: FigureRef 11/11 fields + PaperMeta/QuestionDraft/PartDraft name-for-name match

## Quarantine (1)
**igcse-chemistry-4ch0-1c-2016jan** — QP duplicates the January-2015 paper (printed
'Monday 12 January 2015', identical totals skeleton + questions) while its MS is the genuine
January-2016 MS of a different paper. Not auto-fixable. Next action: operator supplies the
original Jan-2016 QP PDF, or accepts the session as absent. (r1 silently ingested this
duplicate; the identity gate caught it in r2.)

The four r1 quarantines (duplicate part labels) were diagnosed as mechanical OCR artifacts,
corrected with MS evidence in commit 88507eb, and are now ingested.

## Code changes (all tested; parser 88/88, core 309/309)
**Past-Papers**: 88507eb (4-session part-numbering corrections, MS-witnessed) · c42b6a1 (manifest sha256 refresh w/ provenance)
**syllabai-parser**: 0d8b72c (table-cell identity) · 180b2b2 (TableElement rows + R codes) · 577eca6 (<br> → newline, engine 1.1.0) · d095510 (prefer International GCSE code)
**syllabai-core**: 4baf3ba (identity gate + QP-side mapping + anchor/title fixes + regression tests) · da42b9e (per-paper anchor identity)

## Governance (separate from correctness)
- All 8 commits direct-pushed to main (repo convention); no PR review bypass was deliberate
- One push rejected after an amend (non-fast-forward) → resolved by a new commit, no force-push
- r1-era bridge records vanished mid-session, root cause undetermined (log_statement=off;
  no DB-writing actor identified; zero final-state impact — all 81 recreated) → recommend
  statement logging + pg_dump before future repairs
- Operator-supplied identity for 4 cover-lost sessions (2021-Jun/Nov pairs), documented in run logs

## Decision
**YELLOW — continue with recorded issues.** Maximum safe throughput achieved: every session
that can be safely ingested IS ingested. Nothing learner-servable, nothing fabricated, nothing
lost. Remaining work is teacher validation (separate stage), the single operator-dependent
quarantine, and governance hygiene.

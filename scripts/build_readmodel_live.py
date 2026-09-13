#!/usr/bin/env python3
"""
build_readmodel_live.py — Rebuild the teacher-validation read model DIRECTLY
from the LIVE canonical campaign DB (T-C04 R3-5).

Supersedes parse_dump_readmodel.py (R3-3): that model was parsed from a dump
with INFERRED positional column names. The canonical schema is now known
(V1..V18 applied, flyway head 18), so this builder selects REAL columns and
derives the few aliases the review layer expects. Evidence label upgrades from
INFERRED to DERIVED-FROM-CANONICAL.

Outputs (review-layer contract, unchanged consumers):
  download/read-model/tables/<table>.jsonl      (registry + dataset builder)
  download/read-model/CANONICAL_READ_MODEL.json (manifest + provenance)
Row-count cross-check vs live DB: exits 1 on any mismatch.
"""
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/home/z/my-project/scripts")
from campaign_db_preflight import preflight

PSQL = "/home/z/toolchain/pgdebs/root/usr/lib/postgresql/17/bin/psql"
ARGS = ["-h", "/home/z/toolchain", "-U", "syllabai", "-d", "syllabai", "-tA", "-c"]
OUT = Path("/home/z/my-project/download/read-model")
TABLES = Path(OUT / "tables")

# live column -> review-layer field  (per-table SELECT + alias map)
SELECTS = {
    "exam_papers": {
        "cols": "id, subject_id, title, board, qualification, unit, session_label, "
                "paper_code, question_paper_document_id, mark_scheme_document_id, "
                "validation_state, provenance, created_at",
        "map": lambda r: r,  # bridge field added post-load from bridge records
    },
    "questions": {
        "cols": "id, external_ref, question_type, stem AS prompt_text, marks, "
                "command_word, primary_topic_node_id, provenance, exam_paper_id",
        "map": lambda r: r,
    },
    "question_versions": {
        "cols": "id, question_id, version, stem, marks, command_word, "
                "validation_state, source_document_id, "
                "extraction_method AS origin, created_at",
        "map": lambda r: r,
    },
    "question_parts": {
        "cols": "id, question_version_id, label, prompt AS text, command_word, "
                "marks, ordering",
        "map": lambda r: r,
    },
    "mark_schemes": {
        "cols": "id, question_version_id, version_label, validation_state, "
                "source_document_id, extraction_method",
        "map": None,  # question_number derived from mark_points refs
    },
    "mark_points": {
        "cols": "id, mark_scheme_id, question_part_id, ref, ordering, text, marks",
        "map": lambda r: {**r, "part_label": r["ref"]},
    },
    "question_options": {
        "cols": "id, question_id, label, option_text AS text, is_correct, ordering",
        "map": lambda r: r,
    },
    "documents": {
        "cols": "id, document_id, kind AS doc_role, source_uri, file_name, "
                "source_engine AS engine, source_engine_version AS engine_version, "
                "checksum, chunk_count, extracted_at",
        "map": lambda r: r,
    },
    "document_chunks": {
        "cols": "id, document_row_id AS document_id, chunk_index, content, "
                "token_estimate",
        "map": lambda r: r,
    },
    "glm_ocr_bridge_records": {
        "cols": "id, paper_id AS exam_paper_id, bridge, extraction_methods AS engine, "
                "reconciliation_status AS status, review_findings AS findings_json, "
                "qp_document_row_id, ms_document_row_id, created_at",
        "map": lambda r: r,
    },
    "knowledge_nodes": {
        "cols": "id, code, node_type, title AS label, validation_status, provenance",
        "map": lambda r: r,
    },
    "knowledge_edges": {
        "cols": "id, from_node_id, to_node_id, relation, provenance",
        "map": None,  # column names verified live below; fallback select *
    },
}


def q(sql):
    r = subprocess.run([PSQL] + ARGS + [sql], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"psql failed: {r.stderr.strip()[:300]}")
    return r.stdout.strip()


def rows_as_json(sql):
    """json_agg returns ONE JSON document (with pretty newlines between
    elements — legal JSON whitespace): parse the whole output at once."""
    text = q(sql)
    if not text.strip():
        return []
    return json.loads(text)


def edge_cols():
    cols = q("SELECT string_agg(column_name, ',' ORDER BY ordinal_position) "
             "FROM information_schema.columns "
             "WHERE table_schema='public' AND table_name='knowledge_edges'")
    return cols


def main():
    gate = preflight(expected_db="syllabai", expected_label="T-C04-CAMPAIGN")
    TABLES.mkdir(parents=True, exist_ok=True)

    # archive the stale INFERRED tables once
    stamp = "_r2_inferred"
    if not (OUT / f"tables{stamp}").exists() and (OUT / "tables").exists():
        (OUT / "tables").rename(OUT / f"tables{stamp}")
        TABLES.mkdir(parents=True, exist_ok=True)
    if (OUT / "INFERRED_READ_MODEL.json").exists() and \
       not (OUT / "INFERRED_READ_MODEL_r2.json").exists():
        (OUT / "INFERRED_READ_MODEL.json").rename(OUT / "INFERRED_READ_MODEL_r2.json")

    counts_live = {}
    for t, spec in SELECTS.items():
        cols = spec["cols"]
        if t == "knowledge_edges":  # real column names, defensive
            actual = edge_cols()
            cols = actual
        data = rows_as_json(f"SELECT coalesce(json_agg(x), '[]')::text "
                            f"FROM (SELECT {cols} FROM {t} ORDER BY id) x")
        mp = spec["map"]
        if mp:
            data = [mp(r) for r in data]
        if t == "mark_schemes":
            refs = rows_as_json("SELECT coalesce(json_agg(x), '[]')::text FROM "
                                "(SELECT mark_scheme_id, ref FROM mark_points "
                                "ORDER BY mark_scheme_id, ordering) x")
            qnum = {}
            for r in refs:
                digits = ""
                for ch in r.get("ref") or "":
                    if ch.isdigit():
                        digits += ch
                    else:
                        break
                if digits and r["mark_scheme_id"] not in qnum:
                    qnum[r["mark_scheme_id"]] = digits
            for s in data:
                s["question_number"] = qnum.get(s["id"], "")
                s["bridge"] = s.get("extraction_method", "")
        with open(TABLES / f"{t}.jsonl", "w", encoding="utf-8") as f:
            for r in data:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        counts_live[t] = len(data)

    # add paper.bridge alias from bridge records
    bridges = [json.loads(l) for l in open(TABLES / "glm_ocr_bridge_records.jsonl", encoding="utf-8")]
    bmap = {b["exam_paper_id"]: b["bridge"] for b in bridges}
    papers = [json.loads(l) for l in open(TABLES / "exam_papers.jsonl", encoding="utf-8")]
    papers = [{**p, "bridge": bmap.get(p["id"], "")} for p in papers]
    with open(TABLES / "exam_papers.jsonl", "w", encoding="utf-8") as f:
        for p in papers:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")

    # cross-check counts against the LIVE DB
    mismatches = {}
    for t, n in counts_live.items():
        live = int(q(f"SELECT count(*) FROM {t}"))
        if live != n:
            mismatches[t] = (n, live)
    if mismatches:
        raise RuntimeError(f"count cross-check FAILED: {mismatches}")

    ident = q("SELECT campaign_label, db_name, core_commit FROM campaign_db_identity")
    label, dbn, commit = (ident.split("|") + ["", ""])[:3]
    flyway = int(q("SELECT max(installed_rank) FROM flyway_schema_history"))
    head_version = q("SELECT version FROM flyway_schema_history "
                     "ORDER BY installed_rank DESC LIMIT 1")
    manifest = {
        "label": "DERIVED-FROM-CANONICAL read model — rebuilt live from the "
                 "verified campaign DB (R3-5); real column names (V1..V18 schema)",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "identity": {"campaign": label, "db": dbn, "core_commit": commit},
        "flyway_head": head_version,
        "flyway_rows": flyway,
        "tables": counts_live,
        "supersedes": "INFERRED_READ_MODEL (R3-2-era dump parse, stale UUIDs)",
        "note": "Registry/dataset consumers unchanged; ids now match the live "
                "canonical DB. The stale R2-era tables kept at tables_r2_inferred/.",
    }
    (OUT / "CANONICAL_READ_MODEL.json").write_text(json.dumps(manifest, indent=1))
    print(json.dumps({k: manifest[k] for k in
                      ("identity", "flyway_head", "tables")}, indent=1))
    print("READMODEL_LIVE_OK" if not mismatches else "MISMATCH")


if __name__ == "__main__":
    main()

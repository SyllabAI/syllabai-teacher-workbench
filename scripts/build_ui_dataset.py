#!/usr/bin/env python3
"""
build_ui_dataset.py — Build compact per-session JSON dossiers + an index for the
teacher-validation review UI, from the verified read-model JSONL tables.

Input : download/read-model/tables/*.jsonl   (derived from dump c06d8ab3...)
Output: data/review/index.json
        data/review/sessions/<exam_paper_id>.json

The dossiers contain ONLY read-model data (no bundle re-parse). Size kept small by
excluding documents.canonical_json. Source OCR text comes from document_chunks
as ingested (what the DB actually holds), not from corpus files.
"""
import json, os

TBL = "/home/z/my-project/download/read-model/tables"
OUT = "/home/z/my-project/data/review"

def load(t):
    return [json.loads(l) for l in open(f"{TBL}/{t}.jsonl", encoding="utf-8")]

def main():
    os.makedirs(f"{OUT}/sessions", exist_ok=True)
    papers = load("exam_papers")
    questions = load("questions")
    versions = load("question_versions")
    parts = load("question_parts")
    schemes = load("mark_schemes")
    points = load("mark_points")
    options = load("question_options")
    docs = load("documents")
    chunks = load("document_chunks")
    bridges = load("glm_ocr_bridge_records")
    nodes = {n["id"]: n for n in load("knowledge_nodes")}

    # indexes
    qs_by_paper = {}
    for q in questions:
        qs_by_paper.setdefault(q.get("exam_paper_id") or "", []).append(q)
    ver_by_q = {}
    for v in versions:
        ver_by_q.setdefault(v["question_id"], []).append(v)
    parts_by_ver = {}
    for p in parts:
        parts_by_ver.setdefault(p["question_version_id"], []).append(p)
    sch_by_ver = {}
    for s in schemes:
        sch_by_ver.setdefault(s["question_version_id"], []).append(s)
    pts_by_sch = {}
    for m in points:
        pts_by_sch.setdefault(m["mark_scheme_id"], []).append(m)
    opt_by_q = {}
    for o in options:
        opt_by_q.setdefault(o["question_id"], []).append(o)
    doc_by_pk = {d["id"]: d for d in docs}
    doc_by_biz = {d["document_id"]: d for d in docs}
    chunks_by_doc_pk = {}
    for c in chunks:
        chunks_by_doc_pk.setdefault(c["document_id"], []).append(c)
    for k in chunks_by_doc_pk:
        chunks_by_doc_pk[k].sort(key=lambda c: int(c["chunk_index"] or 0))
    bridge_by_paper = {b["exam_paper_id"]: b for b in bridges}

    def doc_summary(d):
        return {
            "documentId": d["document_id"], "role": d["doc_role"],
            "sourceUri": d["source_uri"], "engine": d["engine"],
            "engineVersion": d["engine_version"], "checksum": d["checksum"],
            "chunkCount": d.get("chunk_count"),
        }

    def chunk_payload(d):
        return {
            **doc_summary(d),
            "chunks": [{"index": c["chunk_index"], "content": c["content"]}
                       for c in chunks_by_doc_pk.get(d["id"], [])],
        }

    index_rows, dossiers = [], {}
    for ep in papers:
        pid = ep["id"]
        bridge = bridge_by_paper.get(pid)
        findings = []
        if bridge and bridge.get("findings_json"):
            try:
                findings = json.loads(bridge["findings_json"])
            except Exception:
                findings = []
        qlist = sorted(qs_by_paper.get(pid, []), key=lambda q: q["external_ref"] or "")
        q_items, tot_parts, tot_points, n_schemes = [], 0, 0, 0
        for q in qlist:
            qv_list = ver_by_q.get(q["id"], [])
            parts_acc, sch_acc, opts = [], [], opt_by_q.get(q["id"], [])
            for v in qv_list:
                vp = sorted(parts_by_ver.get(v["id"], []), key=lambda p: p["label"] or "")
                parts_acc = [{
                    "id": p["id"], "label": p["label"], "text": p["text"],
                    "partId": p["id"],
                } for p in vp]
                for s in sorted(sch_by_ver.get(v["id"], []), key=lambda s: s["question_number"] or ""):
                    sp = pts_by_sch.get(s["id"], [])
                    sch_acc.append({
                        "id": s["id"], "questionNumber": s["question_number"],
                        "validationState": s["validation_state"], "bridge": s["bridge"],
                        "points": [{"id": m["id"], "partLabel": m["part_label"],
                                    "text": m["text"], "marks": m["marks"],
                                    "partId": m.get("question_part_id")} for m in sp],
                    })
                    tot_points += len(sp)
                n_schemes += len(sch_acc)
            tot_parts += len(parts_acc)
            q_items.append({
                "id": q["id"], "externalRef": q["external_ref"],
                "type": q["question_type"], "prompt": q["prompt_text"],
                "marks": q.get("marks"), "commandWord": q.get("command_word"),
                "topicNode": (nodes.get(q.get("primary_topic_node_id"), {}) or {}).get("label"),
                "versionId": qv_list[0]["id"] if qv_list else None,
                "validationState": qv_list[0]["validation_state"] if qv_list else None,
                "origin": qv_list[0].get("origin") if qv_list else None,
                "options": [{"label": o["label"], "text": o["text"],
                             "isCorrect": o["is_correct"]} for o in opts],
                "parts": parts_acc, "schemes": sch_acc,
            })
        qp_doc = doc_by_biz.get(ep["question_paper_document_id"])
        ms_doc = doc_by_biz.get(ep["mark_scheme_document_id"])
        dossier = {
            "paper": {
                "id": pid, "title": ep["title"], "board": ep["board"],
                "qualification": ep["qualification"], "sessionLabel": ep["session_label"],
                "paperCode": ep["paper_code"], "validationState": ep["validation_state"],
                "provenance": ep["provenance"], "bridge": ep["bridge"],
            },
            "bridge": None if not bridge else {
                "id": bridge["id"], "status": bridge["status"], "engine": bridge["engine"],
                "bridge": bridge["bridge"], "findings": findings,
            },
            "questionPaper": chunk_payload(qp_doc) if qp_doc else None,
            "markSchemePaper": chunk_payload(ms_doc) if ms_doc else None,
            "questions": q_items,
        }
        dossiers[pid] = dossier
        index_rows.append({
            "id": pid, "title": ep["title"], "paperCode": ep["paper_code"],
            "sessionLabel": ep["session_label"], "bridgeStatus": bridge["status"] if bridge else "UNKNOWN",
            "questions": len(q_items), "parts": tot_parts,
            "schemes": n_schemes, "points": tot_points,
            "findings": len(findings),
        })

    index_rows.sort(key=lambda r: (r["paperCode"], r["sessionLabel"]))
    review_required = sum(1 for r in index_rows if r["bridgeStatus"] == "REVIEW_REQUIRED")
    index = {
        "label": "INFERRED read model — derived from retained dump c06d8ab3…; NOT the canonical DB",
        "identity": {"campaign": "T-C04-CAMPAIGN", "db": "syllabai", "coreCommit": "a54f310"},
        "dumpSha256": "c06d8ab3fe0e788e3ecc85d68752910ae0a437056068f20a7853b203ba06fba2",
        "stats": {
            "papers": len(papers), "questions": len(questions),
            "versions": len(versions), "parts": len(parts),
            "schemes": len(schemes), "points": len(points),
            "embedded": 0,
            "suggestedVersions": sum(1 for v in versions if v["validation_state"] == "SUGGESTED"),
            "validatedVersions": sum(1 for v in versions if v["validation_state"] == "VALIDATED"),
            "reviewRequiredSessions": review_required,
            "okSessions": sum(1 for r in index_rows if r["bridgeStatus"] == "OK"),
        },
        "quarantine": {
            "session": "1c-2016jan (paper 1, January 2016)",
            "rule": "quarantined — QP prints January 2015 (duplicate of ingested Jan-2015); paired MS identifies a different January-2016 paper; genuine 4CH0/1C Jan-2016 QP absent from corpus. Requires original-source/operator resolution — never auto-fixed.",
        },
        "papers": index_rows,
    }
    with open(f"{OUT}/index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)
    for pid, d in dossiers.items():
        with open(f"{OUT}/sessions/{pid}.json", "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
    print(f"index: {len(index_rows)} papers, {review_required} REVIEW_REQUIRED")
    print(f"dossiers: {len(dossiers)} files in {OUT}/sessions/")
    print("UI DATASET BUILD: PASS")

if __name__ == "__main__":
    main()

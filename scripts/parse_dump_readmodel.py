#!/usr/bin/env python3
"""
parse_dump_readmodel.py — Derive a typed READ MODEL from the retained data-only
pg_dump of the T-C04 campaign DB (after.dump, sha256 c06d8ab3...).

LABEL DISCIPLINE (per AGENT.md evidence rules):
  - This read model is a DERIVED artifact (label: INFERRED) for the
    teacher-validation review UI. It is NOT the canonical database.
  - Canonical schema (V1..V16) + canonical data provisioning remain blocked on
    repo access (PAT). This model never pretends to be canonical.
  - Column names come from three sources, tracked per column:
      tooling   = name recovered from campaign tooling SQL (high confidence)
      crossref  = name verified by UUID cross-references between tables
      inferred  = position-only, named col_<n>  (low confidence)
Outputs:
  download/read-model/tables/<table>.jsonl
  download/read-model/INFERRED_READ_MODEL.json     (manifest + counts + provenance)
  db/custom.db                                     (SQLite, all-text columns)
Cross-check: table row counts MUST equal the verified after.counts; exits 1 otherwise.
"""
import json, os, re, sqlite3, sys, hashlib

DUMP = "/tmp/dumpcheck/after.dump"
OUT_DIR = "/home/z/my-project/download/read-model"
SQLITE = "/home/z/my-project/download/read-model/readmodel.sqlite3"  # NOT db/custom.db (scaffold-owned)

# verified reference counts (from isolation-proof/after.counts)
EXPECTED = {
    "exam_papers": 81, "questions": 766, "question_versions": 766,
    "question_parts": 4822, "mark_schemes": 641, "mark_points": 1105,
    "documents": 162, "document_chunks": 2210, "glm_ocr_bridge_records": 81,
    "knowledge_nodes": 96, "knowledge_edges": 21, "question_topics": 4,
    "question_options": 32, "subjects": 2, "curriculum_versions": 2,
    "campaign_db_identity": 1,
}

# positional name maps — source: 'tooling' (recovered from campaign tooling SQL),
# 'crossref' (verified by UUID cross-references), omitted positions => col_<n>.
NAMES = {
    "exam_papers": {1:("id","crossref"),2:("subject_id","crossref"),3:("title","tooling"),
        4:("board","tooling"),5:("qualification","tooling"),6:("exam_date","inferred-named"),
        7:("session_label","tooling"),8:("paper_code","tooling"),
        9:("question_paper_document_id","tooling"),10:("mark_scheme_document_id","tooling"),
        11:("validation_state","tooling"),12:("provenance","tooling"),
        13:("bridge","tooling"),14:("operator","inferred-named"),15:("created_at","inferred-named")},
    "questions": {1:("id","tooling"),2:("external_ref","tooling"),
        3:("question_type","inferred-named"),4:("prompt_text","inferred-named"),
        5:("marks","inferred-named"),  # cross-ref: equals QP mark total from reconciliation findings
        8:("command_word","inferred-named"),9:("primary_topic_node_id","tooling"),
        10:("provenance","inferred-named"),13:("created_at","inferred-named"),
        14:("exam_paper_id","crossref")},  # verified: UUID equals exam_papers.id on imported rows
    # NOTE: superseded_at (V14) did NOT map to questions col14 as first guessed —
    # seed rows had NULL there which masked the real exam_paper_id FK.
    "question_versions": {1:("id","tooling"),2:("question_id","tooling"),
        3:("version","inferred-named"),4:("prompt_text","inferred-named"),
        5:("marks","inferred-named"),8:("command_word","inferred-named"),
        9:("validation_state","tooling"),
        10:("source_document_id","crossref"),  # equals QP document_id on imported rows
        12:("origin","inferred-named"),13:("created_at","inferred-named")},
    "question_parts": {1:("id","tooling"),2:("question_version_id","tooling"),
        3:("label","tooling"),4:("text","inferred-named"),8:("created_at","inferred-named")},
    "mark_schemes": {1:("id","tooling"),2:("question_version_id","tooling"),
        3:("question_number","inferred-named"),4:("document_id","crossref"),
        5:("validation_state","tooling"),6:("bridge","tooling"),7:("created_at","inferred-named")},
    "mark_points": {1:("id","tooling"),2:("mark_scheme_id","tooling"),
        3:("question_part_id","crossref"),  # equals question_parts.id
        4:("part_label","inferred-named"),6:("text","inferred-named"),
        7:("marks","inferred-named"),10:("created_at","inferred-named")},
    "documents": {1:("id","crossref"),2:("document_id","tooling"),
        3:("doc_version","inferred-named"),4:("revision","inferred-named"),
        5:("doc_role","inferred-named"),6:("source_uri","tooling"),7:("file_name","inferred-named"),
        8:("mime_type","inferred-named"),9:("checksum","inferred-named"),
        10:("checksum_algorithm","inferred-named"),14:("chunk_count","crossref"),
        15:("engine","inferred-named"),
        16:("engine_version","tooling"),17:("created_at","inferred-named"),18:("canonical_json","inferred-named")},
    "document_chunks": {1:("id","crossref"),2:("document_id","crossref"),
        3:("chunk_index","inferred-named"),4:("content","inferred-named")},
    "glm_ocr_bridge_records": {1:("id","crossref"),2:("exam_paper_id","crossref"),
        3:("engine","inferred-named"),4:("qp_document_id","tooling"),
        5:("ms_document_id","tooling"),6:("qp_draft","tooling"),7:("ms_draft","inferred-named"),
        10:("bridge","tooling"),11:("status","inferred-named"),12:("findings_json","inferred-named")},
    "campaign_db_identity": {1:("id","inferred-named"),2:("campaign_label","tooling"),
        3:("db_name","tooling"),4:("allowed_cidr","inferred-named"),
        5:("core_commit","inferred-named"),6:("claim_note","inferred-named"),
        7:("created_at","inferred-named"),8:("updated_at","inferred-named")},
    "knowledge_nodes": {1:("id","tooling"),2:("code","inferred-named"),
        3:("node_type","inferred-named"),4:("label","inferred-named"),
        5:("description","inferred-named"),6:("validation_state","inferred-named"),
        7:("provenance","inferred-named"),8:("engine","inferred-named"),
        9:("ordinal","inferred-named"),10:("created_at","inferred-named")},
    "knowledge_edges": {1:("id","tooling"),2:("source_node_id","crossref"),
        3:("target_node_id","crossref"),4:("edge_type","inferred-named"),
        7:("validation_state","inferred-named"),11:("created_at","inferred-named")},
    "question_options": {1:("id","crossref"),2:("question_id","tooling"),
        3:("label","inferred-named"),4:("text","inferred-named"),
        5:("is_correct","inferred-named"),7:("position","inferred-named"),
        8:("created_at","inferred-named")},
    "question_topics": {1:("id","crossref"),2:("question_id","tooling"),
        3:("node_id","crossref"),5:("created_at","inferred-named")},
    "subjects": {1:("id","crossref"),2:("curriculum_version_id","crossref"),
        3:("code","inferred-named"),4:("name","inferred-named"),
        5:("default_node_id","crossref"),6:("created_at","inferred-named")},
    "curriculum_versions": {1:("id","crossref"),2:("board","tooling"),
        3:("qualification","tooling"),4:("code","inferred-named"),
        5:("description","inferred-named"),6:("status","inferred-named"),
        7:("created_at","inferred-named")},
}

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?\+00$")


def tokenize_values(s, start):
    """Parse a parenthesized SQL value list starting at s[start]=='('.
    Returns (values, end_index_after_closing_paren)."""
    assert s[start] == "("
    i = start + 1
    vals, n = [], len(s)
    while i < n:
        while i < n and s[i] in " \t\r\n":
            i += 1
        if i < n and s[i] == ")":
            return vals, i + 1
        if s[i] == "'":
            # string literal: handle '' escapes; newlines are literal
            i += 1
            buf = []
            while i < n:
                c = s[i]
                if c == "'":
                    if i + 1 < n and s[i + 1] == "'":
                        buf.append("'"); i += 2; continue
                    i += 1; break
                buf.append(c); i += 1
            vals.append(("str", "".join(buf)))
        else:
            j = i
            while j < n and s[j] not in ",)":
                j += 1
            tok = s[i:j].strip()
            if tok == "NULL":
                vals.append(("null", None))
            elif tok in ("true", "false"):
                vals.append(("bool", tok == "true"))
            elif re.fullmatch(r"-?\d+", tok):
                vals.append(("int", int(tok)))
            elif re.fullmatch(r"-?\d+\.\d+([eE][+-]?\d+)?", tok):
                vals.append(("float", float(tok)))
            else:
                vals.append(("raw", tok))
            i = j
        # skip to comma
        while i < n and s[i] in " \t\r\n":
            i += 1
        if i < n and s[i] == ",":
            i += 1
        elif i < n and s[i] == ")":
            return vals, i + 1
    raise ValueError("unterminated value list")


def split_sections(dump_text):
    """Yield (table_name, section_text) using pg_dump's Data-for-Name headers."""
    pat = re.compile(r"^-- Data for Name: ([a-z_]+); Type: TABLE DATA", re.M)
    matches = list(pat.finditer(dump_text))
    for k, m in enumerate(matches):
        start = m.end()
        end = matches[k + 1].start() if k + 1 < len(matches) else len(dump_text)
        yield m.group(1), dump_text[start:end]


INSERT_RE = re.compile(r"INSERT INTO public\.([a-z_]+) VALUES ", re.M)


def main():
    os.makedirs(f"{OUT_DIR}/tables", exist_ok=True)
    os.makedirs(os.path.dirname(SQLITE), exist_ok=True)
    text = open(DUMP, encoding="utf-8").read()
    dump_sha = hashlib.sha256(text.encode()).hexdigest()

    tables, problems = {}, []
    for tname, sect in split_sections(text):
        rows = []
        for m in INSERT_RE.finditer(sect):
            vals, _ = tokenize_values(sect, m.end())
            rows.append([v for _, v in vals])
        if rows:
            arities = {len(r) for r in rows}
            if len(arities) != 1:
                problems.append(f"{tname}: inconsistent arity {sorted(arities)}")
            tables[tname] = rows
    if problems:
        print("ARITY PROBLEMS:", problems)
        sys.exit(1)

    # cross-check counts
    print("== count cross-check vs verified after.counts ==")
    ok = True
    for t, exp in EXPECTED.items():
        got = len(tables.get(t, []))
        flag = "OK " if got == exp else "FAIL"
        if got != exp:
            ok = False
        print(f"  [{flag}] {t}: dump={got} expected={exp}")
    extra = set(tables) - set(EXPECTED)
    if extra:
        print(f"  [info] tables outside campaign-count list: {sorted(extra)}")
    if not ok:
        print("COUNT MISMATCH — aborting (invariant failure)")
        sys.exit(1)

    # identity checks on the read model
    idrow = tables["campaign_db_identity"][0]
    assert idrow[1] == "T-C04-CAMPAIGN" and idrow[2] == "syllabai", idrow
    suggested = sum(1 for r in tables["question_versions"] if r[8] == "SUGGESTED")
    validated = sum(1 for r in tables["question_versions"] if r[8] == "VALIDATED")
    embedded = 0
    for r in tables["document_chunks"]:
        if len(r) > 18 and r[18] is not None:
            embedded += 1
    # quarantine check inside the read model (must hold before any UI use):
    # the ambiguous 1c-2016jan session must have ZERO rows anywhere (by slug)
    quarantined = 0
    for r in tables["documents"]:
        if "1c-2016jan" in str(r[5]):  # source_uri
            quarantined += 1
    quarantined += sum(1 for r in tables["exam_papers"]
                       if "1c-2016jan" in json.dumps(r, default=str))
    assert quarantined == 0, f"QUARANTINE VIOLATION: {quarantined} rows reference 1c-2016jan"
    print(f"  quarantine: 1c-2016jan referenced by 0 rows (OK)")
    print(f"  identity: {idrow[1]} @ {idrow[2]} (core commit {idrow[4]})")
    print(f"  versions: {suggested} SUGGESTED + {validated} VALIDATED (expect 758+8)")
    print(f"  embedded chunks: {embedded} (expect 0)")

    # manifest
    manifest = {
        "label": "INFERRED — derived read model, NOT canonical",
        "source_dump_sha256": dump_sha,
        "expected_canonical_dump_sha256": "c06d8ab3fe0e788e3ecc85d68752910ae0a437056068f20a7853b203ba06fba2",
        "dump_sha_matches_canonical": dump_sha == "c06d8ab3fe0e788e3ecc85d68752910ae0a437056068f20a7853b203ba06fba2",
        "generated_at_utc": "2026-09-13T14:45:00Z",
        "tables": {},
    }
    for t, rows in sorted(tables.items()):
        arity = len(rows[0])
        cols = []
        for pos in range(1, arity + 1):
            name, src = NAMES.get(t, {}).get(pos, (f"col_{pos}", "inferred"))
            kinds = set()
            for r in rows[:4000]:
                v = r[pos - 1]
                if v is None: continue
                s = str(v)
                if UUID_RE.match(s): kinds.add("uuid")
                elif TS_RE.match(s): kinds.add("timestamptz")
                elif isinstance(v, bool): kinds.add("bool")
                elif isinstance(v, int): kinds.add("int")
                elif isinstance(v, str) and s.startswith(("{", "[")): kinds.add("json")
            cols.append({"pos": pos, "name": name, "source": src,
                         "inferred_types": sorted(kinds)})
        manifest["tables"][t] = {"rows": len(rows), "columns": cols}
        with open(f"{OUT_DIR}/tables/{t}.jsonl", "w", encoding="utf-8") as f:
            hdr = [c["name"] for c in cols]
            for r in rows:
                f.write(json.dumps(dict(zip(hdr, r)), ensure_ascii=False, default=str) + "\n")

    with open(f"{OUT_DIR}/INFERRED_READ_MODEL.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)

    # SQLite (all-text; UI read model)
    if os.path.exists(SQLITE):
        os.remove(SQLITE)
    con = sqlite3.connect(SQLITE)
    for t, rows in sorted(tables.items()):
        cols = [c["name"] for c in manifest["tables"][t]["columns"]]
        collist = ", ".join(f'"{c}" TEXT' for c in cols)
        con.execute(f'CREATE TABLE "{t}" ({collist})')
        ph = ", ".join("?" * len(cols))
        con.executemany(f'INSERT INTO "{t}" VALUES ({ph})',
                        [[("" if v is None else v) if not isinstance(v, (int, float, bool)) else
                          ("true" if v is True else "false" if v is False else str(v))
                          for v in r] for r in rows])
        idx_targets = [c["name"] for c in manifest["tables"][t]["columns"]
                       if c["name"].endswith("_id") or c["name"] in ("validation_state", "paper_code", "session_label")]
        for c in idx_targets:
            try:
                con.execute(f'CREATE INDEX "ix_{t}_{c}" ON "{t}"("{c}")')
            except sqlite3.OperationalError:
                pass
    con.commit()
    con.close()
    print(f"\nSQLite read model: {SQLITE}")
    print(f"JSONL tables dir:  {OUT_DIR}/tables/")
    print("READ MODEL BUILD: PASS")


if __name__ == "__main__":
    main()

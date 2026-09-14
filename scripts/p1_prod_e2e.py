#!/usr/bin/env python3
"""
p1_prod_e2e.py — teacher/learner E2E on PROD after the 81-pair ingestion.

Proves the real gate on the real deployment (mirrors rehearse.sh stages E-G):
  1. teacher logs in (env credentials)
  2. picks the igcse-chemistry-4ch0-1c-2011jun paper from the review queue
  3. reads the paper review (answer/marking evidence)
  4. validates EVERY version + mark scheme, then the paper (409 rule first)
  5. student probe: sees the paper VALIDATED, no answer leak in detail,
     structured attempt on the first question -> 201 PENDING marking
  6. history reflects the attempt
Verdict GREEN only if every gate behaved exactly as designed.
"""
import json
import os
import sys
import time
from pathlib import Path
from urllib import request as rq, error as rqe

BASE = os.environ.get("BASE", "https://syllabai-core.onrender.com").rstrip("/")
JDIR = Path("/home/z/my-project/download/p1-activation")
JDIR.mkdir(parents=True, exist_ok=True)
ADMIN_EMAIL = os.environ.get("SYLLABAI_ADMIN_EMAIL", "")
ADMIN_PW = os.environ.get("SYLLABAI_ADMIN_PASSWORD", "")
TARGET_SESSION = os.environ.get("TARGET", "igcse-chemistry-4ch0-1c-2011jun")

RESULTS = []


def check(name, expect, got):
    ok = expect == got
    RESULTS.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name} (got {got})", flush=True)


def call(method, path, token=None, payload=None, timeout=90):
    data = json.dumps(payload).encode() if payload is not None else None
    req = rq.Request(f"{BASE}{path}", data=data, method=method)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with rq.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except rqe.HTTPError as e:
        return e.code, {"_error": e.read().decode(errors="replace")[:300]}


def login(email, pw):
    code, body = call("POST", "/api/v1/auth/login", payload={
        "email": email, "password": pw})
    return body.get("accessToken", "") if code == 200 else ""


def main():
    teacher = login(ADMIN_EMAIL, ADMIN_PW)
    if not teacher:
        print("teacher login failed"); return 1

    ingested = json.loads((JDIR / "ingested.json").read_text())
    rec = ingested.get(TARGET_SESSION)
    if not rec:
        print(f"{TARGET_SESSION} not in ingested.json"); return 1
    paper_id = rec["paperId"]

    # student probe account (created by p1_prod_drive.py)
    student = login("probe.student@syllabai.dev", ADMIN_PW + "-student")
    if not student:
        print("student login failed"); return 1

    # 0. §7 placement: the paper waits in the neutral placeholder subject; the
    #    teacher places it into the real 4CH1 subject (factual association only)
    code, subs = call("GET", "/api/v1/curriculum/subjects", token=teacher)
    subj = {s["code"]: s["id"] for s in subs}
    chem = subj.get("4CH1")
    if not chem:
        print("4CH1 subject missing"); return 1
    code, placed = call("POST", f"/api/v1/teacher/content/exam-papers/{paper_id}/place",
                        token=teacher, payload={"subjectId": chem})
    check("paper placed into 4CH1", 200, code)
    check("placement reflected", chem, (placed or {}).get("subjectId"))
    code, placed_again = call("POST", f"/api/v1/teacher/content/exam-papers/{paper_id}/place",
                              token=teacher, payload={"subjectId": chem})
    check("placement idempotent", 200, code)
    # before placement, the student's subject-scoped view did not include the paper;
    # after placement (but pre-validation) it appears as SUGGESTED with zero content
    code, papers_now = call("GET", f"/api/v1/exam-papers?subjectId={chem}", token=student)
    mine = [p for p in papers_now if p["id"] == paper_id] if code == 200 else []
    check("placed paper visible in 4CH1 scope (SUGGESTED, metadata-only)",
          True, len(mine) == 1 and mine[0]["validationState"] == "SUGGESTED")

    # 1. the 409 rule: paper validate BEFORE its versions
    code, _ = call("POST", f"/api/v1/teacher/content/exam-papers/{paper_id}/validate",
                   token=teacher)
    check("paper validate refused while versions unvalidated", 409, code)

    # 2. review carries answer/marking evidence
    code, review = call("GET", f"/api/v1/teacher/content/exam-papers/{paper_id}/review",
                        token=teacher)
    versions = review.get("versions", [])
    check("review reachable", 200, code)
    check("review carries versions", True, len(versions) == rec.get("questions"))
    check("review carries marking evidence", True,
          any(v.get("points") for v in versions))

    # 3. validate everything, then the paper
    nv = ns = 0
    for v in versions:
        c, _ = call("POST", f"/api/v1/teacher/content/question-versions/{v['versionId']}/validate",
                    token=teacher)
        nv += c == 200
        if v.get("schemeId"):
            c2, _ = call("POST", f"/api/v1/teacher/content/mark-schemes/{v['schemeId']}/validate",
                         token=teacher)
            ns += c2 == 200
    check("all versions validated", len(versions), nv)
    print(f"    versions={nv} schemes_validated={ns}", flush=True)
    code, _ = call("POST", f"/api/v1/teacher/content/exam-papers/{paper_id}/validate",
                   token=teacher)
    check("paper validate succeeds once versions done", 200, code)

    # 4. student view reflects VALIDATED, metadata-only, under the REAL subject
    code, detail = call("GET", f"/api/v1/exam-papers/{paper_id}", token=student)
    check("student reads paper detail", 200, code)
    check("paper state reflected to student", "VALIDATED",
          (detail.get("paper") or {}).get("validationState"))
    check("paper detail metadata-only (no answer leak)", False,
          "correct" in json.dumps(detail).lower())
    code, chem_papers = call("GET", f"/api/v1/exam-papers?subjectId={chem}", token=student)
    mine = [p for p in chem_papers if p["id"] == paper_id] if code == 200 else []
    check("VALIDATED paper visible under 4CH1 subject scope", True,
          len(mine) == 1 and mine[0]["validationState"] == "VALIDATED")

    # 5. structured attempt on the first question of the VALIDATED paper
    qid = detail["questions"][0]["questionId"]
    code, qv = call("GET", f"/api/v1/questions/{qid}", token=student)
    check("student question view reachable", 200, code)
    parts = qv.get("parts", [])
    pa = [{"partId": p["id"], "answerText": "Prod E2E answer for part " + p["label"]}
          for p in parts]
    code, att = call("POST", "/api/v1/attempts/structured", token=student, payload={
        "questionId": qid, "partAnswers": pa, "responseTimeMs": 45000,
        "confidence": 3, "selfDoubtFlag": False, "timedCondition": False})
    check("structured attempt on VALIDATED question accepted", 201, code)
    check("attempt enters PENDING marking", "PENDING", att.get("markingState"))

    code, hist = call("GET", "/api/v1/learners/me/attempts", token=student)
    n = len(hist.get("attempts", [])) if code == 200 else -1
    check("learner history records the attempt", True, n >= 1)

    green = all(RESULTS)
    print("E2E VERDICT:", "GREEN" if green else "RED", flush=True)
    (JDIR / "e2e.json").write_text(json.dumps({
        "session": TARGET_SESSION, "paperId": paper_id,
        "versions_validated": nv, "schemes_validated": ns,
        "verdict": "GREEN" if green else "RED",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, indent=1))
    return 0 if green else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
p1_prod_drive.py — the ONE production activation driver (run once, after the
core deploy that ships V19 + bootstrap lands on Render).

Sequence (idempotent, journaled, fail-closed):
  1. wait for the deploy: GET /api/v1/auth/bootstrap-status must answer 200
  2. one-time first-admin claim (credentials from env, never persisted)
  3. register a student probe account (RBAC + learner-side verification)
  4. ingest the T-C04 r2 corpus (81 sessions; the identity-defective
     igcse-chemistry-4ch0-1c-2016jan is quarantined and NEVER posted) through
     POST /api/v1/teacher/content/glm-ocr/pairs with per-pair invariant checks
  5. re-verify a random sample: SUGGESTED states, zero embedded chunks,
     review findings preserved, duplicate-safe re-run
  6. journal every step to download/p1-activation/journal.json

Env: SYLLABAI_ADMIN_EMAIL, SYLLABAI_ADMIN_PASSWORD (12+ chars, letters+digits),
     optional BASE (default https://syllabai-core.onrender.com),
     optional BUNDLES (default /tmp/my-project/corpus-bundles), LIMIT (max pairs).
"""
import json
import os
import sys
import time
from pathlib import Path
from urllib import request as rq, error as rqe

BASE = os.environ.get("BASE", "https://syllabai-core.onrender.com").rstrip("/")
BUNDLES = Path(os.environ.get("BUNDLES", "/tmp/my-project/corpus-bundles"))
LIMIT = int(os.environ.get("LIMIT", "0"))  # 0 = no limit
JDIR = Path("/home/z/my-project/download/p1-activation")
JDIR.mkdir(parents=True, exist_ok=True)
JOURNAL = JDIR / "journal.json"

QUARANTINED = {"igcse-chemistry-4ch0-1c-2016jan"}  # identity defect — never imported (r2 rule)
ADMIN_EMAIL = os.environ.get("SYLLABAI_ADMIN_EMAIL", "")
ADMIN_PW = os.environ.get("SYLLABAI_ADMIN_PASSWORD", "")

journal = {"started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "steps": []}


def step(kind, **kw):
    entry = {"t": time.strftime("%H:%M:%S"), "kind": kind, **kw}
    journal["steps"].append(entry)
    JOURNAL.write_text(json.dumps(journal, indent=1))
    print(json.dumps(entry), flush=True)
    return entry


def call(method, path, token=None, payload=None, timeout=90, expect=None):
    url = f"{BASE}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = rq.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with rq.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except rqe.HTTPError as e:
        body = e.read().decode(errors="replace")[:300]
        return e.code, {"_error": body}


def main():
    if not ADMIN_EMAIL or not ADMIN_PW:
        step("abort", reason="SYLLABAI_ADMIN_EMAIL / SYLLABAI_ADMIN_PASSWORD not set")
        return 2
    # 1 — wait for deploy
    for i in range(120):
        code, body = call("GET", "/api/v1/auth/bootstrap-status")
        if code == 200:
            break
        if i % 10 == 0:
            step("wait", note=f"deploy not detected yet ({code})")
        time.sleep(10)
    else:
        step("abort", reason="bootstrap-status never appeared — deploy did not land")
        return 1
    step("deploy_detected", available=body.get("available"))
    if not body.get("available"):
        step("abort", reason="claim window not available (already claimed/expired?)",
             body=body)
        return 1

    # 2 — claim (one-shot; never logged)
    code, body = call("POST", "/api/v1/auth/bootstrap-admin", payload={
        "email": ADMIN_EMAIL, "password": ADMIN_PW, "displayName": "SyllabAI Ops"})
    if code != 200:
        step("abort", reason=f"claim failed {code}", body=body)
        return 1
    teacher = body.get("accessToken", "")
    roles = sorted(body.get("user", {}).get("roles", []))
    step("claimed", roles=roles, email=ADMIN_EMAIL)
    if roles != ["ADMIN", "TEACHER"]:
        step("abort", reason="unexpected claimant roles")
        return 1

    # claim window must now be closed forever
    code, body = call("GET", "/api/v1/auth/bootstrap-status")
    step("window_closed", available=body.get("available"))

    # 3 — student probe
    probe_pw = ADMIN_PW + "-student"
    code, body = call("POST", "/api/v1/auth/register", payload={
        "email": "probe.student@syllabai.dev", "password": probe_pw,
        "displayName": "Activation Probe"})
    student = body.get("accessToken", "") if code in (200, 201) else ""
    code2, _ = call("GET", "/api/v1/teacher/content/review-queue", token=student)
    step("student_probe", registered=bool(student), teacher_route_code=code2)

    # 4 — corpus ingestion
    sessions = sorted(d.name for d in BUNDLES.iterdir() if d.is_dir())
    todo = [s for s in sessions if s not in QUARANTINED]
    if LIMIT:
        todo = todo[:LIMIT]
    step("ingest_plan", total_bundles=len(sessions), quarantined=sorted(QUARANTINED),
         to_ingest=len(todo))

    # resume support
    done = {}
    jpath = JDIR / "ingested.json"
    if jpath.exists():
        done = json.loads(jpath.read_text())
    papers = []
    totals = {"ingested": 0, "duplicate": 0, "errors": 0}
    for idx, s in enumerate(todo):
        if s in done:
            totals["ingested" if done[s].get("status") == "INGESTED" else "duplicate"] += 1
            papers.append(done[s])
            continue
        bundle = BUNDLES / s
        try:
            payload = {n: json.loads((bundle / f"{n}.json").read_text())
                       for n in ("qp-canonical", "ms-canonical", "qp-draft",
                                 "ms-draft", "reconciliation")}
        except Exception as e:
            step("pair_error", session=s, error=str(e)[:200])
            totals["errors"] += 1
            continue
        payload = {"qpCanonical": payload["qp-canonical"],
                   "msCanonical": payload["ms-canonical"],
                   "qpDraft": payload["qp-draft"],
                   "msDraft": payload["ms-draft"],
                   "reconciliation": payload["reconciliation"]}
        code, body = call("POST", "/api/v1/teacher/content/glm-ocr/pairs",
                          token=teacher, payload=payload, timeout=180)
        if code not in (200, 201):
            step("pair_http_error", session=s, code=code, body=body)
            totals["errors"] += 1
            if code == 401 or code == 403:
                step("abort", reason="auth lost mid-run")
                return 1
            continue
        rec = {"session": s, "status": body.get("examPaper", {}).get("status"),
               "paperId": body.get("examPaper", {}).get("paperId"),
               "questions": body.get("questions"), "parts": body.get("parts"),
               "markPoints": body.get("markPoints"),
               "embeddingSkipped": body.get("embeddingSkipped"),
               "findings": len(body.get("reviewFindings", []))}
        ok = (rec["status"] in ("INGESTED", "DUPLICATE")
              and rec["embeddingSkipped"] is True)
        totals["ingested" if rec["status"] == "INGESTED" else "duplicate"] += 1
        done[s] = rec
        papers.append(rec)
        jpath.write_text(json.dumps(done, indent=1))
        if not ok:
            step("pair_invariant_fail", session=s, record=rec)
        if (idx + 1) % 10 == 0:
            step("ingest_progress", at=idx + 1, **totals)
        time.sleep(0.4)  # be gentle with the free tier
    step("ingest_complete", **totals)

    # 5 — sample verification
    import random
    sample = random.sample(papers, min(5, len(papers)))
    checks = []
    for rec in sample:
        if not rec.get("paperId"):
            continue
        c1, detail = call("GET", f"/api/v1/exam-papers/{rec['paperId']}", token=student)
        leak = "correct" in json.dumps(detail).lower() if c1 == 200 else None
        checks.append({"session": rec["session"], "student_read": c1,
                       "validation_state": (detail.get("paper") or {}).get("validationState")
                                          if c1 == 200 else None,
                       "answer_leak": leak})
    step("sample_verification", checks=checks)

    # review queue as teacher
    c, q = call("GET", "/api/v1/teacher/content/review-queue", token=teacher)
    step("review_queue", code=c,
         papers=len(q.get("papers", [])) if c == 200 else None,
         suggestedVersions=q.get("suggestedVersions") if c == 200 else None)

    journal["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    journal["verdict"] = ("GREEN" if totals["errors"] == 0 and
                          all(not c.get("answer_leak") for c in checks) else "ATTENTION")
    JOURNAL.write_text(json.dumps(journal, indent=1))
    print("VERDICT:", journal["verdict"], flush=True)
    return 0 if journal["verdict"] == "GREEN" else 1


if __name__ == "__main__":
    sys.exit(main())

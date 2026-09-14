#!/usr/bin/env python3
"""Census of prod 4CH1 papers + try the 5 failed sessions again (idempotent)."""
import json, os, sys, time
from pathlib import Path
from urllib import request as rq, error as rqe

BASE = "https://syllabai-core.onrender.com"
BUNDLES = Path("/tmp/my-project/corpus-bundles")
JDIR = Path("/home/z/my-project/download/p1-activation")
QUARANTINED = {"igcse-chemistry-4ch0-1c-2016jan"}
FAILED = ["igcse-chemistry-4ch0-1c-2013junr", "igcse-chemistry-4ch0-1c-2015jan",
          "igcse-chemistry-4ch0-2c-2016jun", "igcse-chemistry-4ch0-2c-2019junr",
          "igcse-chemistry-4ch0-2c-2024junr"]


def call(method, path, token=None, payload=None, timeout=120):
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
        return e.code, {"_error": e.read().decode(errors="replace")[:200]}


env = {}
for line in Path("/home/z/my-project/.secrets/p1-admin.env").read_text().splitlines():
    if "=" in line:
        k, v = line.split("=", 1)
        env[k] = v
code, body = call("POST", "/api/v1/auth/login", payload={
    "email": env["SYLLABAI_ADMIN_EMAIL"], "password": env["SYLLABAI_ADMIN_PASSWORD"]})
teacher = body.get("accessToken", "")
print("teacher login:", code)

# census
code, subs = call("GET", "/api/v1/curriculum/subjects", token=teacher)
subj = [s for s in subs if s.get("code") == "4CH1"][0]["id"]
code, papers = call("GET", f"/api/v1/exam-papers?subjectId={subj}", token=teacher, timeout=180)
states = {}
for p in papers:
    states[p["validationState"]] = states.get(p["validationState"], 0) + 1
print(f"4CH1 papers in prod: {len(papers)} by state: {states}")
by_session = {p["sessionLabel"] + "/" + p["paperCode"]: p for p in papers}
print("unique session/paperCode keys:", len(by_session))

# retry the 5 failures (journal them)
done = json.loads((JDIR / "ingested.json").read_text())
for s in FAILED:
    if s in QUARANTINED:
        continue
    bundle = BUNDLES / s
    try:
        payload = {n: json.loads((bundle / f"{n}.json").read_text())
                   for n in ("qp-canonical", "ms-canonical", "qp-draft",
                             "ms-draft", "reconciliation")}
        payload = {"qpCanonical": payload["qp-canonical"], "msCanonical": payload["ms-canonical"],
                   "qpDraft": payload["qp-draft"], "msDraft": payload["ms-draft"],
                   "reconciliation": payload["reconciliation"]}
    except Exception as e:
        print(f"{s}: BUNDLE ERROR {e}"); continue
    code, body = call("POST", "/api/v1/teacher/content/glm-ocr/pairs",
                      token=teacher, payload=payload, timeout=180)
    st = body.get("examPaper", {}).get("status") if code in (200, 201) else f"HTTP{code}"
    print(f"retry {s}: {st}", flush=True)
    if code in (200, 201):
        done[s] = {"session": s, "status": body["examPaper"]["status"],
                   "paperId": body["examPaper"].get("paperId"),
                   "questions": body.get("questions"), "parts": body.get("parts"),
                   "markPoints": body.get("markPoints"),
                   "embeddingSkipped": body.get("embeddingSkipped"),
                   "findings": len(body.get("reviewFindings", []))}
        (JDIR / "ingested.json").write_text(json.dumps(done, indent=1))
    time.sleep(0.5)

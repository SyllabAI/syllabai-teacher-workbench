#!/usr/bin/env python3
"""Finish the corpus: re-ingest the 4 fixed pairs, then bulk-place every paper
still sitting in the GEN placeholder subject into 4CH1 (placement = factual
association fix; validation states untouched — the teacher gate stays)."""
import json, time
from pathlib import Path
from urllib import request as rq, error as rqe

BASE = "https://syllabai-core.onrender.com"
BUNDLES = Path("/tmp/my-project/corpus-bundles")
JDIR = Path("/home/z/my-project/download/p1-activation")
RETRY = ["igcse-chemistry-4ch0-1c-2013junr", "igcse-chemistry-4ch0-2c-2016jun",
         "igcse-chemistry-4ch0-2c-2019junr", "igcse-chemistry-4ch0-2c-2024junr"]


def call(method, path, token=None, payload=None, timeout=180):
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


env = dict(line.split("=", 1) for line in
           Path("/home/z/my-project/.secrets/p1-admin.env").read_text().splitlines())
code, body = call("POST", "/api/v1/auth/login", payload={
    "email": env["SYLLABAI_ADMIN_EMAIL"], "password": env["SYLLABAI_ADMIN_PASSWORD"]})
teacher = body["accessToken"]
print("teacher login:", code)

# 1. re-ingest the 4 previously-500 pairs
done = json.loads((JDIR / "ingested.json").read_text())
for s in RETRY:
    bundle = BUNDLES / s
    payload = {n: json.loads((bundle / f"{n}.json").read_text())
               for n in ("qp-canonical", "ms-canonical", "qp-draft", "ms-draft", "reconciliation")}
    payload = {"qpCanonical": payload["qp-canonical"], "msCanonical": payload["ms-canonical"],
               "qpDraft": payload["qp-draft"], "msDraft": payload["ms-draft"],
               "reconciliation": payload["reconciliation"]}
    code, body = call("POST", "/api/v1/teacher/content/glm-ocr/pairs", token=teacher,
                      payload=payload)
    st = body.get("examPaper", {}).get("status") if code in (200, 201) else f"HTTP{code}"
    print(f"re-ingest {s}: {st}", flush=True)
    if code in (200, 201):
        done[s] = {"session": s, "status": body["examPaper"]["status"],
                   "paperId": body["examPaper"].get("paperId"),
                   "questions": body.get("questions"), "parts": body.get("parts"),
                   "markPoints": body.get("markPoints"),
                   "embeddingSkipped": body.get("embeddingSkipped"),
                   "findings": len(body.get("reviewFindings", []))}
        (JDIR / "ingested.json").write_text(json.dumps(done, indent=1))
    time.sleep(0.4)

# 2. bulk-place: every SUGGESTED paper still in the GEN placeholder -> 4CH1
code, subs = call("GET", "/api/v1/curriculum/subjects", token=teacher)
subj = {s["code"]: s["id"] for s in subs}
gen, chem = subj.get("GEN"), subj.get("4CH1")
code, queue = call("GET", "/api/v1/teacher/content/review-queue", token=teacher)
in_gen = [p for p in queue.get("papers", []) if p.get("subjectId") == gen]
print(f"papers still in GEN placeholder: {len(in_gen)}")
placed = failed = 0
for p in in_gen:
    code, _ = call("POST", f"/api/v1/teacher/content/exam-papers/{p['id']}/place",
                   token=teacher, payload={"subjectId": chem})
    if code == 200:
        placed += 1
    else:
        failed += 1
        print(f"  place FAILED {p['id']} ({p.get('title')}): {code}", flush=True)
    if (placed + failed) % 20 == 0:
        print(f"  ...{placed + failed}/{len(in_gen)}", flush=True)
    time.sleep(0.25)
print(f"bulk-place done: {placed} placed, {failed} failed")

# 3. final census
code, papers = call("GET", f"/api/v1/exam-papers?subjectId={chem}", token=teacher)
states = {}
for p in papers:
    states[p["validationState"]] = states.get(p["validationState"], 0) + 1
print(f"4CH1 subject scope now: {len(papers)} papers {states}")

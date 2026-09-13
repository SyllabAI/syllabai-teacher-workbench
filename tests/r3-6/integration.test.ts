import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { Client } from "pg";
import { createHash, createHmac } from "crypto";
import fs from "fs";
import path from "path";

/**
 * R3-6 integration matrix — exercises the REAL HTTP surface of the workbench
 * (next dev on :3199 with TV_LOG_FILE isolated to a scratch log) against the
 * LIVE canonical DB. The real hash-chained staging log must remain untouched
 * (proven by sha256 before/after the whole suite).
 */

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH_LOG = path.join(process.cwd(), "download", "teacher-validation", "test-runs", "scratch-decision-log.jsonl");
const REAL_LOG = path.join(process.cwd(), "download", "teacher-validation", "decision-log.jsonl");
const SECRET_FILE = path.join(process.cwd(), "download", "teacher-validation", "session-secret.key");

let child: ChildProcess | null = null;
let teacherCookie = "";
const db = new Client({
  host: "127.0.0.1", port: 5432, user: "syllabai", database: "syllabai",
  options: "-c default_transaction_read_only=on", // never write from tests either
});

const sha256 = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
let realLogShaBefore = "";

async function waitForServer(timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/review/index`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("dev server did not start in time");
}

beforeAll(async () => {
  realLogShaBefore = sha256(REAL_LOG);
  fs.mkdirSync(path.dirname(SCRATCH_LOG), { recursive: true });
  if (fs.existsSync(SCRATCH_LOG)) fs.rmSync(SCRATCH_LOG);
  await db.connect();
  child = spawn("bun", ["x", "next", "dev", "-p", String(PORT)], {
    cwd: process.cwd(),
    env: { ...process.env, TV_LOG_FILE: SCRATCH_LOG },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();
}, 120_000);

afterAll(async () => {
  if (child) {
    child.kill("SIGTERM");
    await new Promise((res) => setTimeout(res, 1500));
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  try { await db.end(); } catch { /* already closed */ }
  // Real log must be byte-identical to before the suite (test isolation proof).
  const after = sha256(REAL_LOG);
  if (after !== realLogShaBefore) {
    throw new Error("REAL STAGING LOG WAS MODIFIED BY TESTS — isolation failure");
  }
}, 30_000);

interface Ev { decisionSeq: number; decisionHash: string; action: string; targetType: string; targetId: string; reviewer: string; note: string; resultState: string; appliedAt: string; }

let events: Ev[] = [];
let flaggedPaperId = "";
let validateTargetQv = "";  // rehearsal-VALIDATEd question_version (then reversed)
let rejectTargetMs = "";    // rehearsal-REJECTed mark_scheme (then reversed)

function scratchLines(): string[] {
  if (!fs.existsSync(SCRATCH_LOG)) return [];
  return fs.readFileSync(SCRATCH_LOG, "utf-8").split("\n").filter(Boolean);
}

async function stage(body: object, cookie = teacherCookie) {
  return fetch(`${BASE}/api/decisions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe("R3-6 integration matrix", () => {
  test("canonical applied-events feed is live with full attribution (gates 6, 9)", async () => {
    const r = await fetch(`${BASE}/api/canonical/events`);
    const d = await r.json();
    expect(d.available).toBe(true);
    events = d.events;
    expect(events).toHaveLength(6); // R3-5 rehearsal: 3 decisions + 3 reverses
    for (const e of events) {
      expect(e.reviewer).toBe("E2E Rehearsal (R3-5 machine-gate test)");
      expect(typeof e.appliedAt).toBe("string");
      expect(e.decisionHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Feed matches the REAL staging log by (seq, hash) — applied evidence and
    // staged entries are linkable without collapsing them.
    const realLog = fs.readFileSync(REAL_LOG, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const e of events) {
      const stagedMatch = realLog.find((l) => l.seq === e.decisionSeq);
      expect(stagedMatch).toBeDefined();
      expect(stagedMatch.hash).toBe(e.decisionHash);
    }
  }, 30_000);

  test("live canonical state query: FLAG event left state SUGGESTED; UNKNOWN ids fail safe (gates 5, 8)", async () => {
    const flagEv = events.find((e) => e.action === "FLAG")!;
    flaggedPaperId = flagEv.targetId;
    const valEv = events.find((e) => e.action === "VALIDATE")!;
    const rejEv = events.find((e) => e.action === "REJECT")!;
    validateTargetQv = valEv.targetId;
    rejectTargetMs = rejEv.targetId;

    const r = await fetch(`${BASE}/api/canonical/state`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: [
        { type: "exam_paper", id: flaggedPaperId },
        { type: "question_version", id: validateTargetQv },
        { type: "mark_scheme", id: rejectTargetMs },
        { type: "question_version", id: "00000000-0000-0000-0000-000000000000" }, // stale/unknown
        { type: "question_version", id: "not-a-uuid" }, // malformed
      ] }),
    });
    const d = await r.json();
    expect(d.available).toBe(true);
    const s = d.states;
    // FLAG was applied as an event but the canonical state stayed SUGGESTED:
    expect(s[`exam_paper:${flaggedPaperId}`].state).toBe("SUGGESTED");
    expect(s[`exam_paper:${flaggedPaperId}`].appliedCount).toBe(2); // FLAG + REVERSE
    expect(s[`exam_paper:${flaggedPaperId}`].lastEvent.action).toBe("REVERSE");
    // rehearsal VALIDATE then REVERSE -> back to SUGGESTED
    expect(s[`question_version:${validateTargetQv}`].state).toBe("SUGGESTED");
    expect(s[`question_version:${validateTargetQv}`].appliedCount).toBe(2);
    // rehearsal REJECT then REVERSE -> back to SUGGESTED
    expect(s[`mark_scheme:${rejectTargetMs}`].state).toBe("SUGGESTED");
    // stale/unknown/malformed ids -> UNKNOWN, never an error, never inferred
    expect(s["question_version:00000000-0000-0000-0000-000000000000"].state).toBe("UNKNOWN");
    expect(s["question_version:not-a-uuid"].state).toBe("UNKNOWN");
  }, 30_000);

  test("authorization matrix: no session / forged cookie / wrong role -> 403 (gate 10)", async () => {
    const realId = validateTargetQv;
    // no cookie
    let r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: realId }, "");
    expect(r.status).toBe(403);
    // forged cookie
    r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: realId }, `${"tvs"}=forged.token.value`);
    expect(r.status).toBe(403);
    // validly-signed token with WRONG ROLE
    const secret = fs.readFileSync(SECRET_FILE);
    const payloadB64 = Buffer.from(JSON.stringify({ name: "Viewer V", role: "viewer", exp: Date.now() + 999e6 })).toString("base64url");
    const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
    r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: realId }, `tvs=${payloadB64}.${sig}`);
    expect(r.status).toBe(403);
    // nothing was staged by any of the refused attempts
    expect(scratchLines()).toHaveLength(0);
  }, 30_000);

  test("session issue + attribution (gate 9)", async () => {
    let r = await fetch(`${BASE}/api/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    });
    expect(r.status).toBe(422);
    r = await fetch(`${BASE}/api/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "R3-6 Verification Teacher" }),
    });
    expect(r.status).toBe(200);
    const setCookie = r.headers.get("set-cookie") || "";
    expect(setCookie).toContain("tvs=");
    expect(setCookie).toContain("HttpOnly");
    teacherCookie = setCookie.split(";")[0];
    const d = await r.json();
    expect(d.role).toBe("teacher");
    expect(d.name).toBe("R3-6 Verification Teacher");
  }, 30_000);

  test("staged VALIDATE against SUGGESTED stays staged — canonical state unchanged (gate 3)", async () => {
    const before = await (await fetch(`${BASE}/api/canonical/state`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: [{ type: "question_version", id: validateTargetQv }] }),
    })).json();
    expect(before.states[`question_version:${validateTargetQv}`].state).toBe("SUGGESTED");

    const r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: validateTargetQv });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.entry.action).toBe("VALIDATE");
    expect(d.entry.reviewer).toBe("R3-6 Verification Teacher"); // session-authoritative attribution
    expect(d.effective[validateTargetQv]).toBe("VALIDATED");

    // Staged intent exists in the log...
    expect(scratchLines()).toHaveLength(1);
    // ...but canonical state is UNCHANGED and no applied event was created.
    const after = await (await fetch(`${BASE}/api/canonical/state`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: [{ type: "question_version", id: validateTargetQv }] }),
    })).json();
    expect(after.states[`question_version:${validateTargetQv}`].state).toBe("SUGGESTED");
    expect(after.states[`question_version:${validateTargetQv}`].appliedCount).toBe(2); // rehearsal VALIDATE+REVERSE, nothing new
    const feed = await (await fetch(`${BASE}/api/canonical/events`)).json();
    expect(feed.events).toHaveLength(6); // no new applied events
  }, 30_000);

  test("duplicate staged VALIDATE refused; REJECT-after-VALIDATE refused (negative)", async () => {
    let r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: validateTargetQv });
    expect(r.status).toBe(422);
    r = await stage({ action: "REJECT", targetType: "question_version", targetId: validateTargetQv, note: "switching opinion" });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toContain("already staged");
    expect(scratchLines()).toHaveLength(1);
  }, 30_000);

  test("staged REJECT against SUGGESTED stays staged — canonical state unchanged (gate 4)", async () => {
    const r = await stage({ action: "REJECT", targetType: "mark_scheme", targetId: rejectTargetMs, note: "R3-6 verification: criterion duplicates point 1" });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.entry.action).toBe("REJECT");
    expect(d.effective[rejectTargetMs]).toBe("REJECTED");
    const after = await (await fetch(`${BASE}/api/canonical/state`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: [{ type: "mark_scheme", id: rejectTargetMs }] }),
    })).json();
    expect(after.states[`mark_scheme:${rejectTargetMs}`].state).toBe("SUGGESTED");
    expect(scratchLines()).toHaveLength(2);
  }, 30_000);

  test("REJECT without reason refused (negative)", async () => {
    // fresh scheme target from the flagged paper dossier
    const dossier = await (await fetch(`${BASE}/api/review/session/${flaggedPaperId}`)).json();
    const scheme = dossier.questions.flatMap((q: any) => q.schemes).find((s: any) => s.validationState === "SUGGESTED" && s.id !== rejectTargetMs);
    const r = await stage({ action: "REJECT", targetType: "mark_scheme", targetId: scheme.id, note: "" });
    expect(r.status).toBe(422);
    expect(scratchLines()).toHaveLength(2);
  }, 30_000);

  test("FLAG remains events-only: staged flag does not touch canonical state (gate 5)", async () => {
    const r = await stage({ action: "FLAG", targetType: "exam_paper", targetId: flaggedPaperId, note: "R3-6 verification: flag staged via API" });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.effective[flaggedPaperId]).toBe("FLAGGED");
    const after = await (await fetch(`${BASE}/api/canonical/state`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: [{ type: "exam_paper", id: flaggedPaperId }] }),
    })).json();
    expect(after.states[`exam_paper:${flaggedPaperId}`].state).toBe("SUGGESTED");
    const feed = await (await fetch(`${BASE}/api/canonical/events`)).json();
    expect(feed.events).toHaveLength(6);
    expect(scratchLines()).toHaveLength(3);
  }, 30_000);

  test("seed-VALIDATED lock still enforced through the API (negative)", async () => {
    const q = await db.query("SELECT id FROM question_versions WHERE validation_state='VALIDATED' LIMIT 1");
    const seedId = q.rows[0].id;
    const r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: seedId });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toContain("SUGGESTED");
    expect(scratchLines()).toHaveLength(3);
  }, 30_000);

  test("staged REVERSE clears the staged intent; canonical still untouched (gates 3, 7)", async () => {
    const r = await stage({ action: "REVERSE", reverseSeq: 1 });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.entry.action).toBe("REVERSE");
    expect(d.entry.note).toContain("reverses seq 1");
    expect(d.effective[validateTargetQv]).toBeUndefined();
    const after = await (await fetch(`${BASE}/api/canonical/state`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: [{ type: "question_version", id: validateTargetQv }] }),
    })).json();
    expect(after.states[`question_version:${validateTargetQv}`].state).toBe("SUGGESTED");
    expect(scratchLines()).toHaveLength(4);
  }, 30_000);

  test("unknown target ids fail safely at staging (gate 8)", async () => {
    const r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: "00000000-0000-0000-0000-000000000000" });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toContain("unknown target");
    const r2 = await stage({ action: "VALIDATE", targetType: "bogus_type", targetId: validateTargetQv });
    expect(r2.status).toBe(422);
    expect(scratchLines()).toHaveLength(4);
  }, 30_000);

  test("serving path is connection-level read-only: UPDATE through the workbench DB config must fail (gate 10)", async () => {
    const guard = await db.query("SHOW transaction_read_only");
    expect(guard.rows[0].transaction_read_only).toBe("on");
    let threw = "";
    try {
      await db.query(
        "UPDATE exam_papers SET validation_state='VALIDATED' WHERE id=$1::uuid",
        [flaggedPaperId]
      );
    } catch (err) {
      threw = (err as Error).message;
    }
    expect(threw).toContain("read-only");
    // and nothing changed
    const check = await db.query("SELECT validation_state FROM exam_papers WHERE id=$1::uuid", [flaggedPaperId]);
    expect(check.rows[0].validation_state).toBe("SUGGESTED");
  }, 30_000);

  test("hostile sweep: no route can mutate canonical validation state from HTTP (gate 10)", async () => {
    const logBefore = scratchLines().length;
    const suggested = await db.query("SELECT id FROM question_versions WHERE validation_state='SUGGESTED' LIMIT 1");
    const targetId = suggested.rows[0].id;
    const bodies = [
      { action: "VALIDATE", targetType: "question_version", targetId },
      { targets: [{ type: "question_version", id: targetId }], force: true },
      { displayName: "Sweeper" },
    ];
    const routes = ["/api/decisions", "/api/canonical/state", "/api/canonical/events", "/api/session", "/api/review/index", "/api/decisions/export"];
    for (const route of routes) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const body of bodies) {
          const r = await fetch(`${BASE}${route}`, {
            method,
            headers: { "Content-Type": "application/json" }, // deliberately NO cookie
            body: JSON.stringify(body),
          });
          // No route may answer a mutating request with success for an
          // unauthenticated caller; 405/404 are also acceptable (no handler).
          if (r.status < 400) {
            // Only legitimate 200s allowed here: GET-style export/index/events
            // (read-only) and session open (no canonical privilege).
            const ct = r.headers.get("content-type") || "";
            expect(["/api/decisions"].includes(route) && r.status === 200).toBe(false);
            expect(ct).toBeDefined();
          }
        }
      }
    }
    // canonical DB untouched by the whole sweep
    const counts = await db.query(`SELECT
      (SELECT count(*) FROM exam_papers WHERE validation_state='SUGGESTED') AS papers_suggested,
      (SELECT count(*) FROM question_versions WHERE validation_state='VALIDATED') AS versions_validated,
      (SELECT count(*) FROM question_versions WHERE validation_state='SUGGESTED') AS versions_suggested,
      (SELECT count(*) FROM mark_schemes WHERE validation_state='REJECTED') AS schemes_rejected,
      (SELECT count(*) FROM teacher_validation_events) AS events`);
    const row = counts.rows[0];
    expect(Number(row.papers_suggested)).toBe(81);
    expect(Number(row.versions_validated)).toBe(8);
    expect(Number(row.versions_suggested)).toBe(758);
    expect(Number(row.schemes_rejected)).toBe(0);
    expect(Number(row.events)).toBe(6);
    // and the scratch log gained nothing from the unauthenticated sweep
    expect(scratchLines().length).toBe(logBefore);
  }, 60_000);

  test("test isolation: real hash-chained staging log untouched by the whole suite", async () => {
    const after = sha256(REAL_LOG);
    expect(after).toBe(realLogShaBefore);
    // scratch log holds exactly the 4 intentional staging writes
    const lines = scratchLines().map((l) => JSON.parse(l));
    expect(lines.map((l: any) => l.action)).toEqual(["VALIDATE", "REJECT", "FLAG", "REVERSE"]);
    expect(lines.every((l: any) => l.reviewer === "R3-6 Verification Teacher")).toBe(true);
  }, 30_000);
});

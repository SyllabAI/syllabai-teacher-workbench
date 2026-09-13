import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { Client } from "pg";
import { createHash, createHmac } from "crypto";
import fs from "fs";
import path from "path";
import { provisionReviewer, revokeReviewer } from "@/lib/reviewers";

/**
 * R3-7 integration matrix — the mandated negative gates, two-reviewer
 * concurrency, revocation, and importer cross-verification, exercised on the
 * REAL HTTP surface (next dev on :3211) against the LIVE canonical DB.
 *
 * Isolation: TV_LOG_FILE / TV_REVIEWERS_FILE / TV_PROVISIONING_LOG_FILE all
 * point at suite-local scratch files; the REAL hash-chained staging log, the
 * REAL reviewer registry and the REAL provisioning log are never touched
 * (real-log sha256 is asserted byte-identical after the suite). The canonical
 * DB is only ever queried (read-only connections everywhere).
 */

const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const RUNS = path.join(process.cwd(), "download", "teacher-validation", "test-runs", `r3-7-${process.pid}`);
const SCRATCH_LOG = path.join(RUNS, "scratch-decision-log.jsonl");
const SCRATCH_REGISTRY = path.join(RUNS, "scratch-reviewers.json");
const SCRATCH_PROV_LOG = path.join(RUNS, "scratch-provisioning-log.jsonl");
const REAL_LOG = path.join(process.cwd(), "download", "teacher-validation", "decision-log.jsonl");
const REAL_REGISTRY = path.join(process.cwd(), "download", "teacher-validation", "reviewers.json");
const SECRET_FILE = path.join(process.cwd(), "download", "teacher-validation", "session-secret.key");
const IMPORTER = path.join(process.cwd(), "repos", "syllabai-core", "scripts", "import_teacher_decisions.py");

let child: ChildProcess | null = null;
let realLogShaBefore = "";
let realRegistryExisted = false;

const sha256 = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const db = new Client({
  host: "127.0.0.1", port: 5432, user: "syllabai", database: "syllabai",
  options: "-c default_transaction_read_only=on", // never write from tests either
});

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

let adaCookie = "", benCookie = "", caraToken = "";

beforeAll(async () => {
  realLogShaBefore = sha256(REAL_LOG);
  realRegistryExisted = fs.existsSync(REAL_REGISTRY);
  fs.mkdirSync(RUNS, { recursive: true });
  for (const f of [SCRATCH_LOG, SCRATCH_REGISTRY, SCRATCH_PROV_LOG]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  // Two DISTINCT provisioned reviewers for the concurrency scenario — no
  // shared accounts. Scratch registry only.
  process.env.TV_REVIEWERS_FILE = SCRATCH_REGISTRY;
  process.env.TV_PROVISIONING_LOG_FILE = SCRATCH_PROV_LOG;
  const ada = provisionReviewer({ name: "Ada Concurrency", by: "operator:r3-7-suite" });
  const ben = provisionReviewer({ name: "Ben Concurrency", by: "operator:r3-7-suite" });
  const cara = provisionReviewer({ name: "Cara Revocation", by: "operator:r3-7-suite" });
  if (!ada.ok || !ben.ok || !cara.ok) throw new Error("scratch provisioning failed");
  caraToken = cara.token;
  await db.connect();
  child = spawn("bun", ["x", "next", "dev", "-p", String(PORT)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TV_LOG_FILE: SCRATCH_LOG,
      TV_REVIEWERS_FILE: SCRATCH_REGISTRY,
      TV_PROVISIONING_LOG_FILE: SCRATCH_PROV_LOG,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();
  // Sessions are opened against the RUNNING server (registry revalidates
  // per request from the same scratch registry the server sees).
  adaCookie = (await openSession(ada.token))!;
  benCookie = (await openSession(ben.token))!;
  if (!adaCookie || !benCookie) throw new Error("scratch reviewer sessions failed to open");
}, 120_000);

afterAll(async () => {
  if (child) {
    child.kill("SIGTERM");
    await new Promise((res) => setTimeout(res, 1500));
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  try { await db.end(); } catch { /* already closed */ }
  // Real staging log must be byte-identical to before the suite.
  if (sha256(REAL_LOG) !== realLogShaBefore) {
    throw new Error("REAL STAGING LOG WAS MODIFIED BY TESTS — isolation failure");
  }
  // Real registry must not have been created/touched by the suite.
  if (!realRegistryExisted && fs.existsSync(REAL_REGISTRY)) {
    throw new Error("REAL REVIEWER REGISTRY WAS CREATED BY TESTS — isolation failure");
  }
  fs.rmSync(RUNS, { recursive: true, force: true });
}, 30_000);

async function openSession(token: string): Promise<string | null> {
  const r = await fetch(`${BASE}/api/session`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!r.ok) return null;
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

function stage(body: object, cookie: string, extraHeaders: Record<string, string> = {}) {
  return fetch(`${BASE}/api/decisions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function scratchLines(): string[] {
  if (!fs.existsSync(SCRATCH_LOG)) return [];
  return fs.readFileSync(SCRATCH_LOG, "utf-8").split("\n").filter(Boolean);
}

/** Replicates the frozen workbench hash base (verified against the real log below). */
function frozenBaseHash(e: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(e)).digest("hex");
}

describe("R3-7 negative gates — session issuance", () => {
  test("staging authorization cannot be self-minted: no token / garbage token -> 403", async () => {
    let r = await fetch(`${BASE}/api/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Self Minted" }),
    });
    expect(r.status).toBe(403);
    r = await fetch(`${BASE}/api/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "tvr_garbage_garbage_garbage" }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toContain("token");
  }, 30_000);

  test("sessions carry the provisioned identity; client displayName is ignored", async () => {
    const r = await fetch(`${BASE}/api/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: caraToken, displayName: "Impostor" }),
    });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.name).toBe("Cara Revocation"); // registry-authoritative
    expect(d.reviewerId).toMatch(/^tvr-[0-9a-f]{8}$/);
  }, 30_000);
});

describe("R3-7 negative gates — staging", () => {
  test("unauthenticated staging -> 403", async () => {
    const target = (await db.query(
      "SELECT id FROM question_versions WHERE validation_state='SUGGESTED' AND id NOT IN (SELECT target_id FROM teacher_validation_events) LIMIT 1"
    )).rows[0].id;
    const r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: target }, "");
    expect(r.status).toBe(403);
    expect(scratchLines()).toHaveLength(0);
  }, 30_000);

  test("forged session -> 403", async () => {
    const target = (await db.query(
      "SELECT id FROM question_versions WHERE validation_state='SUGGESTED' AND id NOT IN (SELECT target_id FROM teacher_validation_events) LIMIT 1"
    )).rows[0].id;
    const r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: target }, "tvs=forged.cookie.value");
    expect(r.status).toBe(403);
  }, 30_000);

  test("expired session -> 403", async () => {
    const target = (await db.query(
      "SELECT id FROM question_versions WHERE validation_state='SUGGESTED' AND id NOT IN (SELECT target_id FROM teacher_validation_events) LIMIT 1"
    )).rows[0].id;
    const secret = fs.readFileSync(SECRET_FILE);
    const payloadB64 = Buffer.from(JSON.stringify({
      v: 2, reviewerId: "tvr-0a1b2c3d", name: "Ada Concurrency", role: "teacher",
      exp: Date.now() - 1000, epoch: 1,
    })).toString("base64url");
    const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
    const r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: target }, `tvs=${payloadB64}.${sig}`);
    expect(r.status).toBe(403);
  }, 30_000);

  test("wrong role -> 403 (even correctly signed)", async () => {
    const target = (await db.query(
      "SELECT id FROM question_versions WHERE validation_state='SUGGESTED' AND id NOT IN (SELECT target_id FROM teacher_validation_events) LIMIT 1"
    )).rows[0].id;
    const secret = fs.readFileSync(SECRET_FILE);
    const payloadB64 = Buffer.from(JSON.stringify({
      v: 2, reviewerId: "tvr-0a1b2c3d", name: "Ada Concurrency", role: "viewer",
      exp: Date.now() + 999e6, epoch: 1,
    })).toString("base64url");
    const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
    const r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: target }, `tvs=${payloadB64}.${sig}`);
    expect(r.status).toBe(403);
  }, 30_000);

  test("cross-origin staging -> 403; non-JSON body -> 415 (CSRF hardening)", async () => {
    const target = (await db.query(
      "SELECT id FROM question_versions WHERE validation_state='SUGGESTED' AND id NOT IN (SELECT target_id FROM teacher_validation_events) LIMIT 1"
    )).rows[0].id;
    const r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: target }, adaCookie, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    const r2 = await fetch(`${BASE}/api/decisions`, {
      method: "POST", headers: { "Content-Type": "text/plain", cookie: adaCookie },
      body: "action=VALIDATE",
    });
    expect(r2.status).toBe(415);
    expect(scratchLines()).toHaveLength(0);
  }, 30_000);
});

describe("R3-7 concurrency — two reviewers, one target, no silent merge", () => {
  let conflictTarget = "";

  test("reviewer A stages VALIDATE — canonical state unchanged, event count unchanged", async () => {
    conflictTarget = (await db.query(
      "SELECT id FROM question_versions WHERE validation_state='SUGGESTED' AND id NOT IN (SELECT target_id FROM teacher_validation_events) LIMIT 1"
    )).rows[0].id;
    const before = await (await fetch(`${BASE}/api/canonical/state`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: [{ type: "question_version", id: conflictTarget }] }),
    })).json();
    expect(before.states[`question_version:${conflictTarget}`].state).toBe("SUGGESTED");

    const r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: conflictTarget }, adaCookie);
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.entry.reviewer).toBe("Ada Concurrency");
    expect(String(d.entry.reviewerId)).toMatch(/^tvr-[0-9a-f]{8}$/);
    expect(d.entry.hash).toMatch(/^[0-9a-f]{64}$/);
    // canonical untouched
    const after = await (await fetch(`${BASE}/api/canonical/state`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: [{ type: "question_version", id: conflictTarget }] }),
    })).json();
    expect(after.states[`question_version:${conflictTarget}`].state).toBe("SUGGESTED");
    expect(after.states[`question_version:${conflictTarget}`].appliedCount).toBe(0);
    expect(scratchLines()).toHaveLength(1);
  }, 30_000);

  test("reviewer B's conflicting REJECT on the same target is EXPLICITLY refused, not merged", async () => {
    const r = await stage({ action: "REJECT", targetType: "question_version", targetId: conflictTarget, note: "Ben disagrees with Ada" }, benCookie);
    expect(r.status).toBe(422);
    const err = (await r.json()).error;
    expect(err).toContain("already staged");
    expect(err).toContain("reverse");
    expect(scratchLines()).toHaveLength(1);
  }, 30_000);

  test("reviewer B's duplicate VALIDATE is refused too; FLAG coexists by design (events-only)", async () => {
    const r = await stage({ action: "VALIDATE", targetType: "question_version", targetId: conflictTarget }, benCookie);
    expect(r.status).toBe(422);
    const flag = await stage({ action: "FLAG", targetType: "question_version", targetId: conflictTarget, note: "Ben flags a wording concern" }, benCookie);
    expect(flag.status).toBe(200);
    const d = await flag.json();
    expect(d.entry.reviewer).toBe("Ben Concurrency");
    expect(d.entry.reviewerId).not.toBe(JSON.parse(scratchLines()[0]).reviewerId); // distinct identities in the ledger
    // FLAG staged an event-only annotation: canonical state STILL unchanged
    const state = await (await fetch(`${BASE}/api/canonical/state`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: [{ type: "question_version", id: conflictTarget }] }),
    })).json();
    expect(state.states[`question_version:${conflictTarget}`].state).toBe("SUGGESTED");
    expect(scratchLines()).toHaveLength(2);
  }, 30_000);

  test("applied events retain attribution; nothing new was applied during the conflict", async () => {
    const feed = await (await fetch(`${BASE}/api/canonical/events`)).json();
    expect(feed.available).toBe(true);
    expect(feed.events).toHaveLength(6); // R3-5 rehearsal events only — no more
    for (const e of feed.events) {
      expect(e.reviewer).toBe("E2E Rehearsal (R3-5 machine-gate test)");
    }
  }, 30_000);
});

describe("R3-7 revocation", () => {
  test("a revoked reviewer's session dies on the next staging request", async () => {
    // Cara stages successfully first...
    const target = (await db.query(
      "SELECT id FROM exam_papers WHERE validation_state='SUGGESTED' AND id NOT IN (SELECT target_id FROM teacher_validation_events) LIMIT 1"
    )).rows[0].id;
    const caraCookie = await openSession(caraToken);
    expect(caraCookie).not.toBeNull();
    const ok = await stage({ action: "FLAG", targetType: "exam_paper", targetId: target, note: "Cara flags before revocation" }, caraCookie!);
    expect(ok.status).toBe(200);
    // ...then is revoked server-side (registry outside git)
    const rev = revokeReviewer({ idOrName: "Cara Revocation", by: "operator:r3-7-suite", note: "offboarding rehearsal" });
    expect(rev.ok).toBe(true);
    // the SAME cookie now fails staging — revocation is immediate
    const denied = await stage({ action: "FLAG", targetType: "exam_paper", targetId: target, note: "Cara tries after revocation" }, caraCookie!);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toContain("revoked");
    // and the dead token cannot open a fresh session either
    const reauth = await openSession(caraToken);
    expect(reauth).toBeNull();
    expect(scratchLines()).toHaveLength(3); // A's VALIDATE, B's FLAG, Cara's first FLAG — the denied one never landed
  }, 30_000);
});

describe("R3-7 — stale intent cannot silently become canonical (importer cross-check)", () => {
  test("workbench hash helper reproduces the REAL log's hashes (frozen base proof)", () => {
    const firstLine = fs.readFileSync(REAL_LOG, "utf-8").split("\n").filter(Boolean)[0];
    const real = JSON.parse(firstLine);
    const { hash, reviewerId, ...rest } = real;
    expect(frozenBaseHash(rest)).toBe(hash);
    expect(reviewerId).toBeUndefined(); // R3-5-era entries carry no reviewerId — old lines stay verifiable
  }, 30_000);

  test("importer check-mode accepts the scratch log WITH reviewerId entries (cross-side compatibility)", async () => {
    // The scratch log holds two reviewerId-bearing entries (VALIDATE + FLAG)
    // for a LIVE-SUGGESTED target. The importer is the apply authority; its
    // STRICT reader must accept the extra field and plan without error.
    const p = spawnSync("python3", [IMPORTER, "check", "--log-file", SCRATCH_LOG], { encoding: "utf-8", timeout: 60_000 });
    expect(p.status).toBe(0);
    expect(p.stdout + p.stderr).toContain("chain valid");
    expect(JSON.parse(scratchLines()[0]).reviewerId).toMatch(/^tvr-[0-9a-f]{8}$/);
  }, 90_000);

  test("forced stale intent on a log COPY is refused by the importer (SUGGESTED-only gate)", async () => {
    // Craft a well-formed entry (correct frozen-base hash) whose target is
    // canonical VALIDATED (seed-locked). The live staging gate would never
    // allow this to be staged — here it is forced onto a COPY log to prove
    // the importer, as the only apply authority, refuses it. The REAL log is
    // untouched (sha asserted in afterAll).
    const seed = (await db.query(
      "SELECT id FROM question_versions WHERE validation_state='VALIDATED' LIMIT 1"
    )).rows[0].id;
    const GENESIS = "0".repeat(64);
    const base = {
      action: "VALIDATE",
      targetType: "question_version",
      targetId: seed,
      targetLabel: "forced stale intent (craft, COPY only)",
      reviewer: "Stale Crafter (R3-7 negative test)",
      note: "forced entry on a COPY log — must be refused",
      seq: 1,
      ts: "2026-09-14T00:00:00.000Z",
      prevHash: GENESIS,
    };
    const copy = path.join(RUNS, "stale-intent-copy.jsonl");
    fs.writeFileSync(copy, JSON.stringify({ ...base, hash: frozenBaseHash(base) }) + "\n");
    const p = spawnSync("python3", [IMPORTER, "check", "--log-file", copy], { encoding: "utf-8", timeout: 60_000 });
    expect(p.status).not.toBe(0);
    const out = p.stdout + p.stderr;
    expect(out).toMatch(/SUGGESTED|lifecycle/i);
    fs.rmSync(copy, { force: true });
  }, 90_000);
});

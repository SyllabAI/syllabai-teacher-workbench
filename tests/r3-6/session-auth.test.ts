import { describe, test, expect } from "bun:test";
import { createHmac } from "crypto";
import fs from "fs";
import path from "path";
import { issueSessionForReviewer, verifySession, sessionFromRequest, SESSION_COOKIE } from "@/lib/session";

const SECRET_FILE = path.join(process.cwd(), "download", "teacher-validation", "session-secret.key");

/**
 * R3-7 NOTE: this suite is the ORIGINAL R3-6 session gate matrix, adapted to
 * the v2 session contract (sessions bind a provisioned reviewer id + epoch).
 * Every R3-6 assertion semantic is preserved; issuance now goes through
 * issueSessionForReviewer (the registry-backed path), and NEW fail-closed
 * assertions cover legacy-cookie rejection and identity binding.
 */

/** Sign an arbitrary payload with the REAL secret (tests the role gate honestly). */
function forgeSignedToken(payload: object): string {
  const secret = fs.readFileSync(SECRET_FILE);
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

const REVIEWER = { id: "tvr-0a1b2c3d", name: "Teacher A", role: "teacher" as const, epoch: 1 };

describe("teacher session gate (acceptance gate 10)", () => {
  test("valid teacher session round-trips (binds provisioned identity)", () => {
    const r = issueSessionForReviewer(REVIEWER);
    const s = verifySession(r.token);
    expect(s).not.toBeNull();
    expect(s!.name).toBe("Teacher A");
    expect(s!.role).toBe("teacher");
    expect(s!.v).toBe(2);
    expect(s!.reviewerId).toBe("tvr-0a1b2c3d");
    expect(s!.epoch).toBe(1);
    expect(s!.exp).toBeGreaterThan(Date.now());
  });

  test("missing/garbage/short tokens are rejected", () => {
    expect(verifySession(null)).toBeNull();
    expect(verifySession(undefined)).toBeNull();
    expect(verifySession("")).toBeNull();
    expect(verifySession("garbage")).toBeNull();
    expect(verifySession("a.b")).toBeNull();
  });

  test("forged signature is rejected (constant-time path)", () => {
    const r = issueSessionForReviewer(REVIEWER);
    const [payloadB64] = r.token.split(".");
    const forged = `${payloadB64}.${Buffer.from("deadbeefdeadbeef").toString("base64url")}`;
    expect(verifySession(forged)).toBeNull();
  });

  test("tampered payload (same signature) is rejected", () => {
    const r = issueSessionForReviewer(REVIEWER);
    const [, sig] = r.token.split(".");
    const evil = Buffer.from(JSON.stringify({ v: 2, reviewerId: "tvr-0a1b2c3d", name: "Someone Else", role: "teacher", exp: Date.now() + 999e6, epoch: 1 })).toString("base64url");
    expect(verifySession(`${evil}.${sig}`)).toBeNull();
  });

  test("expired session is rejected", () => {
    const r = issueSessionForReviewer(REVIEWER, Date.now() - 13 * 60 * 60 * 1000); // issued 13h ago, TTL 12h
    expect(verifySession(r.token)).toBeNull();
  });

  test("wrong role (viewer) is rejected even when correctly signed", () => {
    const token = forgeSignedToken({ v: 2, reviewerId: "tvr-0a1b2c3d", name: "Viewer V", role: "viewer", exp: Date.now() + 999e6, epoch: 1 });
    expect(verifySession(token)).toBeNull();
  });

  test("token signed with the WRONG secret is rejected", () => {
    const payloadB64 = Buffer.from(JSON.stringify({ v: 2, reviewerId: "tvr-0a1b2c3d", name: "Teacher A", role: "teacher", exp: Date.now() + 999e6, epoch: 1 })).toString("base64url");
    const sig = createHmac("sha256", "not-the-real-secret").update(payloadB64).digest("base64url");
    expect(verifySession(`${payloadB64}.${sig}`)).toBeNull();
  });

  test("legacy v1 cookie (no reviewerId) is fail-closed rejected", () => {
    // A pre-R3-7 token: correctly signed, but without the v2 identity fields.
    const legacy = forgeSignedToken({ name: "Teacher A", role: "teacher", exp: Date.now() + 999e6 });
    expect(verifySession(legacy)).toBeNull();
  });

  test("malformed reviewer id / epoch in a signed payload is rejected", () => {
    expect(verifySession(forgeSignedToken({ v: 2, reviewerId: "not-an-id", name: "Teacher A", role: "teacher", exp: Date.now() + 999e6, epoch: 1 }))).toBeNull();
    expect(verifySession(forgeSignedToken({ v: 2, reviewerId: "tvr-0a1b2c3d", name: "Teacher A", role: "teacher", exp: Date.now() + 999e6, epoch: 0 }))).toBeNull();
  });

  test("reviewer name comes from the registry — invalid registry names throw, never issued", () => {
    expect(() => issueSessionForReviewer({ ...REVIEWER, name: "a" })).toThrow();
    expect(() => issueSessionForReviewer({ ...REVIEWER, name: "x".repeat(81) })).toThrow();
    expect(() => issueSessionForReviewer({ ...REVIEWER, name: "  Padded Name  " })).not.toThrow();
    expect(() => issueSessionForReviewer({ ...REVIEWER, id: "" })).toThrow();
  });

  test("sessionFromRequest parses the HttpOnly cookie from a Request", () => {
    const r = issueSessionForReviewer({ ...REVIEWER, name: "Cookie Teacher" });
    const req = new Request("http://localhost/api/decisions", {
      headers: { cookie: `other=1; ${SESSION_COOKIE}=${encodeURIComponent(r.token)}` },
    });
    const s = sessionFromRequest(req);
    expect(s?.name).toBe("Cookie Teacher");
    expect(s?.reviewerId).toBe("tvr-0a1b2c3d");
    const reqNoCookie = new Request("http://localhost/api/decisions");
    expect(sessionFromRequest(reqNoCookie)).toBeNull();
  });
});

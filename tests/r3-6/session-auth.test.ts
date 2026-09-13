import { describe, test, expect } from "bun:test";
import { createHmac } from "crypto";
import fs from "fs";
import path from "path";
import { issueSession, verifySession, sessionFromRequest, SESSION_COOKIE } from "@/lib/session";

const SECRET_FILE = path.join(process.cwd(), "download", "teacher-validation", "session-secret.key");

/** Sign an arbitrary payload with the REAL secret (tests the role gate honestly). */
function forgeSignedToken(payload: object): string {
  const secret = fs.readFileSync(SECRET_FILE);
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

describe("teacher session gate (acceptance gate 10)", () => {
  test("valid teacher session round-trips", () => {
    const r = issueSession("Teacher A");
    expect("token" in r).toBe(true);
    if (!("token" in r)) return;
    const s = verifySession(r.token);
    expect(s).not.toBeNull();
    expect(s!.name).toBe("Teacher A");
    expect(s!.role).toBe("teacher");
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
    const r = issueSession("Teacher A");
    if (!("token" in r)) throw new Error("issue failed");
    const [payloadB64] = r.token.split(".");
    const forged = `${payloadB64}.${Buffer.from("deadbeefdeadbeef").toString("base64url")}`;
    expect(verifySession(forged)).toBeNull();
  });

  test("tampered payload (same signature) is rejected", () => {
    const r = issueSession("Teacher A");
    if (!("token" in r)) throw new Error("issue failed");
    const [, sig] = r.token.split(".");
    const evil = Buffer.from(JSON.stringify({ name: "Someone Else", role: "teacher", exp: Date.now() + 999e6 })).toString("base64url");
    expect(verifySession(`${evil}.${sig}`)).toBeNull();
  });

  test("expired session is rejected", () => {
    const r = issueSession("Teacher A", Date.now() - 13 * 60 * 60 * 1000); // issued 13h ago, TTL 12h
    if (!("token" in r)) throw new Error("issue failed");
    expect(verifySession(r.token)).toBeNull();
  });

  test("wrong role (viewer) is rejected even when correctly signed", () => {
    const token = forgeSignedToken({ name: "Viewer V", role: "viewer", exp: Date.now() + 999e6 });
    expect(verifySession(token)).toBeNull();
  });

  test("token signed with the WRONG secret is rejected", () => {
    const payloadB64 = Buffer.from(JSON.stringify({ name: "Teacher A", role: "teacher", exp: Date.now() + 999e6 })).toString("base64url");
    const sig = createHmac("sha256", "not-the-real-secret").update(payloadB64).digest("base64url");
    expect(verifySession(`${payloadB64}.${sig}`)).toBeNull();
  });

  test("display-name validation: too short / too long refused", () => {
    expect(issueSession("a")).toHaveProperty("error");
    expect(issueSession("")).toHaveProperty("error");
    expect(issueSession("x".repeat(81))).toHaveProperty("error");
    expect(issueSession("  Padded Name  ")).toHaveProperty("token");
  });

  test("sessionFromRequest parses the HttpOnly cookie from a Request", () => {
    const r = issueSession("Cookie Teacher");
    if (!("token" in r)) throw new Error("issue failed");
    const req = new Request("http://localhost/api/decisions", {
      headers: { cookie: `other=1; ${SESSION_COOKIE}=${encodeURIComponent(r.token)}` },
    });
    const s = sessionFromRequest(req);
    expect(s?.name).toBe("Cookie Teacher");
    const reqNoCookie = new Request("http://localhost/api/decisions");
    expect(sessionFromRequest(reqNoCookie)).toBeNull();
  });
});

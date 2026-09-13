import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";

/**
 * R3-6 — Workbench-local teacher session gate (minimal authorization boundary).
 *
 * Why: acceptance gate 10 — "Unauthorized users cannot apply validation merely
 * through UI/API manipulation". Staging writes now require a server-verified
 * session. This is NOT SSO and not Cycle-2 auth infrastructure: it is a
 * single-workbench HMAC session whose only privilege is to STAGE intent (never
 * to apply anything — canonical apply remains importer-only).
 *
 * Design:
 *  - Secret: 32 random bytes in download/teacher-validation/session-secret.key
 *    (0600, fsync'd, durable evidence territory). Regenerating the file
 *    invalidates all sessions (fail-closed).
 *  - Token: base64url(payload).base64url(HMAC-SHA256) where payload is
 *    {name, role, exp} — HttpOnly cookie, SameSite=Strict, 12h expiry.
 *  - Verification is constant-time; expired/malformed/forged -> null.
 *  - GET routes stay open (read-only review data). Only staging writes are
 *    gated.
 */

const SESSION_DIR = path.join(process.cwd(), "download", "teacher-validation");
const SECRET_FILE = path.join(SESSION_DIR, "session-secret.key");
const TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionPayload {
  name: string;
  role: "teacher";
  exp: number; // epoch ms
}

function loadSecret(): Buffer {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  if (fs.existsSync(SECRET_FILE)) {
    const raw = fs.readFileSync(SECRET_FILE);
    if (raw.length >= 32) return raw;
  }
  const secret = randomBytes(32);
  const fd = fs.openSync(SECRET_FILE, "w", 0o600);
  try {
    fs.writeSync(fd, secret);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return secret;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payloadB64: string, secret: Buffer): string {
  return b64url(createHmac("sha256", secret).update(payloadB64).digest());
}

export function issueSession(displayName: string, now = Date.now()): { token: string; payload: SessionPayload } | { error: string } {
  const name = (displayName || "").trim();
  if (name.length < 2 || name.length > 80) {
    return { error: "display name required (2-80 chars)" };
  }
  const payload: SessionPayload = { name, role: "teacher", exp: now + TTL_MS };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf-8"));
  const token = `${payloadB64}.${sign(payloadB64, loadSecret())}`;
  return { token, payload };
}

export function verifySession(token: string | undefined | null, now = Date.now()): SessionPayload | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const expected = sign(payloadB64, loadSecret());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as SessionPayload;
    if (payload.role !== "teacher") return null;
    if (typeof payload.exp !== "number" || payload.exp <= now) return null;
    if (typeof payload.name !== "string" || payload.name.length < 2 || payload.name.length > 80) return null;
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "tvs";

export function sessionFromRequest(req: Request): SessionPayload | null {
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]*)`));
  return verifySession(m ? decodeURIComponent(m[1]) : null);
}

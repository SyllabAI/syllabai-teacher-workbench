import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";
import { isProduction } from "./prod-config";

/**
 * R3-6/R3-7 — Workbench teacher session gate.
 *
 * R3-6: staging writes require a server-verified HMAC session (HttpOnly
 * cookie). The session's ONLY privilege is to STAGE intent — canonical apply
 * remains importer-only.
 *
 * R3-7 hardening (this revision):
 *  - Sessions are issued ONLY against a PROVISIONED reviewer token
 *    (src/lib/reviewers.ts). Nobody can self-mint staging authorization.
 *  - The payload binds reviewerId + epoch; staging revalidates the registry
 *    on every write, so revocation/re-provisioning kills outstanding
 *    sessions immediately.
 *  - The display name comes from the registry, not the client.
 *  - The secret is NEVER auto-generated in production (fail closed via
 *    prod-config + the check below); regenerating the file invalidates all
 *    sessions.
 *  - Cookie: HttpOnly, SameSite=Strict, Secure in production (requires
 *    TV_PUBLIC_HTTPS=1, enforced at startup), 12h expiry.
 *
 * Payload v2: {v:2, reviewerId, name, role:"teacher", exp, epoch}.
 * Legacy v1 cookies (no reviewerId) fail verification — fail-closed.
 */

const SESSION_DIR = path.join(process.cwd(), "download", "teacher-validation");
const SECRET_FILE = path.join(SESSION_DIR, "session-secret.key");
const TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionPayload {
  v: 2;
  reviewerId: string;
  name: string;
  role: "teacher";
  exp: number; // epoch ms
  epoch: number; // reviewer registry epoch at issuance
}

function secretFile(): string {
  return process.env.TV_SESSION_SECRET_FILE || SECRET_FILE;
}

function loadSecret(): Buffer {
  const file = secretFile();
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file);
    if (raw.length >= 32) return raw;
    if (isProduction()) {
      throw new Error(`session secret file ${file} is smaller than 32 bytes — refusing to start (production never falls back to weak secrets)`);
    }
  } else if (isProduction()) {
    // Defense in depth: prod-config already fails startup; never auto-generate here.
    throw new Error(`session secret file missing at ${file} — production requires an out-of-band secret (fail closed)`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const secret = randomBytes(32);
  const fd = fs.openSync(file, "w", 0o600);
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

export interface IssuedSession {
  token: string;
  payload: SessionPayload;
}

/** Issue a session for a PROVISIONED, ACTIVE reviewer (registry-checked by the caller/route). */
export function issueSessionForReviewer(
  reviewer: { id: string; name: string; role: "teacher"; epoch: number },
  now = Date.now()
): IssuedSession {
  const name = (reviewer.name || "").trim();
  if (name.length < 2 || name.length > 80) {
    throw new Error("reviewer name from registry must be 2-80 chars");
  }
  if (!reviewer.id || typeof reviewer.epoch !== "number") {
    throw new Error("reviewer id/epoch required — sessions bind a provisioned identity");
  }
  const payload: SessionPayload = {
    v: 2, reviewerId: reviewer.id, name, role: "teacher", exp: now + TTL_MS, epoch: reviewer.epoch,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf-8"));
  return { token: `${payloadB64}.${sign(payloadB64, loadSecret())}`, payload };
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
    if (payload.v !== 2) return null; // legacy v1 cookies are fail-closed rejected
    if (payload.role !== "teacher") return null;
    if (typeof payload.exp !== "number" || payload.exp <= now) return null;
    if (typeof payload.reviewerId !== "string" || !/^tvr-[0-9a-f]{8}$/.test(payload.reviewerId)) return null;
    if (typeof payload.epoch !== "number" || payload.epoch < 1) return null;
    if (typeof payload.name !== "string" || payload.name.length < 2 || payload.name.length > 80) return null;
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "tvs";

/** Cookie attributes — Secure is MANDATORY in production (startup-asserted via TV_PUBLIC_HTTPS). */
export function cookieConfig(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: isProduction(),
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function sessionFromRequest(req: Request): SessionPayload | null {
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]*)`));
  return verifySession(m ? decodeURIComponent(m[1]) : null);
}

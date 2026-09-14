import { createHash, randomBytes, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";

/**
 * R3-7 — Reviewer identity registry and provisioning.
 *
 * WHY: R3-6 scoped staging authorization to "a verified session" but anyone
 * could OBTAIN a session by calling POST /api/session with any display name.
 * R3-7 closes the loop: staging authorization now requires a PROVISIONED
 * reviewer identity. The registry is durable state OUTSIDE git (0600), with
 * an env-overridable path so tests never touch the real registry.
 *
 * Rules (R3-7 scope):
 *  - One token per reviewer; tokens are shown ONCE at provisioning and
 *    stored ONLY as a SHA-256 hash. No shared reviewer accounts.
 *  - role is explicit; only "teacher" (staging privilege) is issuable today.
 *  - Revocation flips status to "revoked" and bumps `epoch`; existing
 *    sessions carrying the old epoch die immediately on their next staging
 *    request (staging revalidates the registry every time).
 *  - Every provisioning action is appended to an append-only JSONL audit log
 *    (who provisioned/revoked whom, when, why).
 *  - NO canonical DB access here; NO second validation-state model. This is
 *    identity administration, nothing else.
 */

export const REVIEWER_ROLES = ["teacher"] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

export interface ReviewerRecord {
  id: string; // "tvr-" + 8 hex — stable reviewer identity (audit)
  name: string; // authoritative display name (2-80 chars)
  role: ReviewerRole;
  tokenHash: string; // sha256 hex of the provisioned token — token never stored
  status: "active" | "revoked";
  epoch: number; // bumped on revoke; sessions carry the epoch they were issued at
  createdAt: string;
  revokedAt?: string;
  provisionedBy: string; // operator identity from the CLI invocation
  note?: string;
}

export interface ReviewerRegistry {
  version: 1;
  reviewers: ReviewerRecord[];
}

const DEFAULT_DIR =
  process.env.TV_STATE_DIR ||
  path.join(process.cwd(), "data", "teacher-validation");

/** Env-overridable so tests isolate BOTH the registry and the audit log. */
export function registryFile(): string {
  return process.env.TV_REVIEWERS_FILE || path.join(DEFAULT_DIR, "reviewers.json");
}
export function provisioningLogFile(): string {
  return process.env.TV_PROVISIONING_LOG_FILE || path.join(DEFAULT_DIR, "provisioning-log.jsonl");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

export type LoadResult =
  | { ok: true; registry: ReviewerRegistry }
  | { ok: false; error: string };

/** Fail-closed loader: malformed JSON or schema violation is an ERROR, never an empty registry. */
export function loadRegistry(): LoadResult {
  const file = registryFile();
  if (!fs.existsSync(file)) {
    return { ok: false, error: `reviewer registry not found at ${file} — provision a reviewer first (scripts/provision-reviewer.ts)` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return { ok: false, error: `reviewer registry is malformed JSON: ${(e as Error).message}` };
  }
  const reg = raw as ReviewerRegistry;
  if (!reg || reg.version !== 1 || !Array.isArray(reg.reviewers)) {
    return { ok: false, error: "reviewer registry has an invalid shape (expected {version:1, reviewers:[]})" };
  }
  for (const r of reg.reviewers) {
    if (!r || typeof r.id !== "string" || typeof r.name !== "string" ||
        typeof r.tokenHash !== "string" || r.tokenHash.length !== 64 ||
        (r.status !== "active" && r.status !== "revoked") ||
        typeof r.epoch !== "number" || !REVIEWER_ROLES.includes(r.role)) {
      return { ok: false, error: `reviewer registry entry for ${r?.id ?? "?"} has an invalid shape` };
    }
  }
  return { ok: true, registry: reg };
}

/** Atomic save (tmp + rename), 0600. */
export function saveRegistry(registry: ReviewerRegistry): void {
  const file = registryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(registry, null, 1) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export interface ProvisioningAuditEntry {
  ts: string;
  action: "PROVISION" | "REVOKE" | "ROTATE_SESSION_SECRET";
  id?: string;
  name?: string;
  role?: ReviewerRole;
  by: string;
  note?: string;
}

/** Append-only provisioning audit (JSONL, fsync'd). */
export function appendProvisioningAudit(entry: ProvisioningAuditEntry): void {
  const file = provisioningLogFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, JSON.stringify(entry) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function newReviewerId(registry: ReviewerRegistry): string {
  for (;;) {
    const id = `tvr-${randomBytes(4).toString("hex")}`;
    if (!registry.reviewers.some((r) => r.id === id)) return id;
  }
}

export type ProvisionResult =
  | { ok: true; reviewer: ReviewerRecord; token: string } // token shown ONCE
  | { ok: false; error: string };

export function provisionReviewer(input: {
  name: string;
  role?: string;
  by: string;
  note?: string;
  now?: number;
}): ProvisionResult {
  const name = (input.name || "").trim();
  const by = (input.by || "").trim();
  if (name.length < 2 || name.length > 80) {
    return { ok: false, error: "reviewer name required (2-80 chars)" };
  }
  if (by.length < 2) {
    return { ok: false, error: "provisioned-by operator identity required (--by)" };
  }
  const role = (input.role || "teacher") as ReviewerRole;
  if (!REVIEWER_ROLES.includes(role)) {
    return { ok: false, error: `role must be one of: ${REVIEWER_ROLES.join(", ")}` };
  }
  const loaded = loadRegistry();
  if (!loaded.ok) {
    if (!fs.existsSync(registryFile())) {
      // First provisioning bootstraps the registry.
      return writeNewReviewer({ id: `tvr-${randomBytes(4).toString("hex")}`, name, role, by, note: input.note, now: input.now });
    }
    return { ok: false, error: loaded.error };
  }
  const registry = loaded.registry;
  if (registry.reviewers.some((r) => r.status === "active" && r.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `an active reviewer named "${name}" already exists — no shared or duplicate accounts` };
  }
  return writeNewReviewer({ id: newReviewerId(registry), name, role, by, note: input.note, now: input.now, registry });
}

function writeNewReviewer(seed: {
  id: string; name: string; role: ReviewerRole; by: string; note?: string; now?: number; registry?: ReviewerRegistry;
}): ProvisionResult {
  const now = seed.now ?? Date.now();
  const token = `tvr_${randomBytes(32).toString("base64url")}`;
  const reviewer: ReviewerRecord = {
    id: seed.id,
    name: seed.name,
    role: seed.role,
    tokenHash: hashToken(token),
    status: "active",
    epoch: 1,
    createdAt: new Date(now).toISOString(),
    provisionedBy: seed.by,
    ...(seed.note ? { note: seed.note } : {}),
  };
  const registry: ReviewerRegistry = seed.registry ?? { version: 1, reviewers: [] };
  registry.reviewers.push(reviewer);
  saveRegistry(registry);
  appendProvisioningAudit({ ts: reviewer.createdAt, action: "PROVISION", id: reviewer.id, name: reviewer.name, role: reviewer.role, by: seed.by, note: seed.note });
  return { ok: true, reviewer, token };
}

export type RevokeResult =
  | { ok: true; reviewer: ReviewerRecord }
  | { ok: false; error: string };

export function revokeReviewer(input: { idOrName: string; by: string; note?: string; now?: number }): RevokeResult {
  const by = (input.by || "").trim();
  if (by.length < 2) return { ok: false, error: "revoked-by operator identity required (--by)" };
  const loaded = loadRegistry();
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const key = (input.idOrName || "").trim().toLowerCase();
  const reviewer = loaded.registry.reviewers.find(
    (r) => r.id.toLowerCase() === key || (r.status === "active" && r.name.toLowerCase() === key)
  );
  if (!reviewer) return { ok: false, error: `no reviewer matching "${input.idOrName}"` };
  if (reviewer.status === "revoked") return { ok: false, error: `reviewer ${reviewer.id} (${reviewer.name}) is already revoked` };
  reviewer.status = "revoked";
  reviewer.revokedAt = new Date(input.now ?? Date.now()).toISOString();
  reviewer.epoch += 1; // kills every outstanding session for this reviewer
  saveRegistry(loaded.registry);
  appendProvisioningAudit({ ts: reviewer.revokedAt, action: "REVOKE", id: reviewer.id, name: reviewer.name, by, note: input.note });
  return { ok: true, reviewer };
}

export type TokenVerifyResult =
  | { ok: true; reviewer: ReviewerRecord }
  | { ok: false; error: string; status: number }; // status: HTTP status the route should return

/** Verify a provisioning token (constant-time) and return the ACTIVE reviewer it belongs to. */
export function verifyReviewerToken(token: string | undefined | null): TokenVerifyResult {
  if (!token || typeof token !== "string" || token.length < 16 || token.length > 256) {
    return { ok: false, error: "provisioned reviewer token required", status: 403 };
  }
  const loaded = loadRegistry();
  if (!loaded.ok) return { ok: false, error: loaded.error, status: 403 };
  const digest = Buffer.from(hashToken(token), "hex");
  for (const r of loaded.registry.reviewers) {
    const expected = Buffer.from(r.tokenHash, "hex");
    if (digest.length === expected.length && timingSafeEqual(digest, expected)) {
      if (r.status !== "active") {
        return { ok: false, error: `reviewer ${r.id} (${r.name}) is revoked — access denied`, status: 403 };
      }
      return { ok: true, reviewer: r };
    }
  }
  return { ok: false, error: "unknown reviewer token", status: 403 };
}

export function getReviewerById(id: string): ReviewerRecord | null {
  const loaded = loadRegistry();
  if (!loaded.ok) return null;
  return loaded.registry.reviewers.find((r) => r.id === id) ?? null;
}

export type SessionRevalidation =
  | { ok: true; reviewer: ReviewerRecord }
  | { ok: false; error: string };

/**
 * Revalidate a session-bound reviewer against the CURRENT registry.
 * Called on EVERY staging write: revocation and re-provisioning take effect
 * immediately — a stolen cookie cannot outlive the reviewer's good standing.
 */
export function revalidateSessionReviewer(payload: { reviewerId: string; epoch: number }): SessionRevalidation {
  const reviewer = getReviewerById(payload.reviewerId);
  if (!reviewer) return { ok: false, error: "reviewer no longer exists in the registry — access denied" };
  if (reviewer.status !== "active") {
    return { ok: false, error: `reviewer ${reviewer.name} has been revoked — staging denied` };
  }
  if (reviewer.epoch !== payload.epoch) {
    return { ok: false, error: "reviewer credentials were re-provisioned — open a new session with the current token" };
  }
  return { ok: true, reviewer };
}

export function listReviewers(includeRevoked = false): ReviewerRecord[] {
  const loaded = loadRegistry();
  if (!loaded.ok) return [];
  return loaded.registry.reviewers.filter((r) => includeRevoked || r.status === "active");
}

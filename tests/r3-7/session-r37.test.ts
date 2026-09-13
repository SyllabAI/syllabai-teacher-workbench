import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import {
  provisionReviewer,
  revokeReviewer,
  verifyReviewerToken,
  revalidateSessionReviewer,
  getReviewerById,
  listReviewers,
  hashToken,
  registryFile,
  provisioningLogFile,
} from "@/lib/reviewers";
import { issueSessionForReviewer, verifySession, cookieConfig } from "@/lib/session";
import { assertProductionConfig, isProduction } from "@/lib/prod-config";
import { rotateSessionSecret } from "@/lib/session-admin";

/**
 * R3-7 unit matrix — reviewer provisioning, session v2 binding, revocation,
 * secret rotation, production fail-closed configuration. ALL state lives in
 * suite-local scratch files (env overrides); the real registry, real
 * provisioning log and real session secret are NEVER touched.
 */

const SCRATCH = path.join(process.cwd(), "download", "teacher-validation", "test-runs", `r3-7-unit-${process.pid}`);
const REG = path.join(SCRATCH, "reviewers.json");
const PROV = path.join(SCRATCH, "provisioning-log.jsonl");
const SECRET = path.join(SCRATCH, "session-secret.key");

let adaToken = "";
let adaId = "";

beforeAll(() => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  process.env.TV_REVIEWERS_FILE = REG;
  process.env.TV_PROVISIONING_LOG_FILE = PROV;
  process.env.TV_SESSION_SECRET_FILE = SECRET;
});

afterAll(() => {
  delete process.env.TV_REVIEWERS_FILE;
  delete process.env.TV_PROVISIONING_LOG_FILE;
  delete process.env.TV_SESSION_SECRET_FILE;
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

describe("reviewer provisioning (no shared accounts, token shown once)", () => {
  test("provision issues a one-time token and stores ONLY its hash", () => {
    const r = provisionReviewer({ name: "Ada Teacher", by: "operator:root", note: "first reviewer" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    adaToken = r.token;
    adaId = r.reviewer.id;
    expect(adaToken).toMatch(/^tvr_/);
    expect(r.reviewer.status).toBe("active");
    expect(r.reviewer.epoch).toBe(1);
    expect(r.reviewer.role).toBe("teacher");
    // registry holds the hash, never the token
    const raw = fs.readFileSync(REG, "utf-8");
    expect(raw).not.toContain(adaToken);
    expect(raw).toContain(hashToken(adaToken));
    // audit log records the provisioning
    const audit = fs.readFileSync(PROV, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("PROVISION");
    expect(audit[0].by).toBe("operator:root");
    // 0600 on the registry
    expect((fs.statSync(REG).mode & 0o777) === 0o600 || process.platform === "win32").toBe(true);
  });

  test("duplicate active reviewer name is refused — no shared accounts", () => {
    const r = provisionReviewer({ name: "ada teacher", by: "operator:root" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("already exists");
  });

  test("provisioning requires an operator identity and a sane name", () => {
    expect(provisionReviewer({ name: "No Operator", by: "" }).ok).toBe(false);
    expect(provisionReviewer({ name: "x", by: "operator:root" }).ok).toBe(false);
    expect(provisionReviewer({ name: "y".repeat(81), by: "operator:root" }).ok).toBe(false);
    expect(provisionReviewer({ name: "Bad Role", by: "operator:root", role: "admin" }).ok).toBe(false);
  });

  test("token verification: valid / unknown / revoked", () => {
    expect(verifyReviewerToken(adaToken).ok).toBe(true);
    expect(verifyReviewerToken("tvr_not_a_real_token_at_all_aaaaaaaaaaaa").ok).toBe(false);
    expect(verifyReviewerToken("").ok).toBe(false);
    expect(verifyReviewerToken(undefined).ok).toBe(false);
  });
});

describe("session v2 binding + revocation", () => {
  test("session binds reviewerId + epoch; name comes from the registry", () => {
    const reviewer = getReviewerById(adaId)!;
    expect(reviewer).not.toBeNull();
    const s = issueSessionForReviewer(reviewer!);
    const payload = verifySession(s.token);
    expect(payload).not.toBeNull();
    expect(payload!.reviewerId).toBe(adaId);
    expect(payload!.name).toBe("Ada Teacher");
    expect(payload!.epoch).toBe(1);
  });

  test("staging revalidation passes while active", () => {
    const r = revalidateSessionReviewer({ reviewerId: adaId, epoch: 1 });
    expect(r.ok).toBe(true);
  });

  test("revocation kills outstanding sessions on the next staging request", () => {
    const rev = revokeReviewer({ idOrName: adaId, by: "operator:root", note: "offboarding" });
    expect(rev.ok).toBe(true);
    if (!rev.ok) return;
    expect(rev.reviewer.epoch).toBe(2); // bumped
    // previously valid session now fails revalidation even though the cookie still verifies
    expect(verifySession(issueSessionForReviewer({ id: adaId, name: "Ada Teacher", role: "teacher", epoch: 1 }).token)).not.toBeNull(); // HMAC fine, expiry fine
    const r = revalidateSessionReviewer({ reviewerId: adaId, epoch: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("revoked");
    // old token cannot even open a new session
    expect(verifyReviewerToken(adaToken).ok).toBe(false);
  });

  test("epoch mismatch is refused: a session from before a credential epoch bump cannot revalidate", () => {
    // Mechanism test (self-contained): a session carrying epoch N must be
    // refused when the registry record's epoch has moved on (re-provision /
    // re-activation flows bump the epoch without changing the reviewer id).
    const re = provisionReviewer({ name: "Epoch Probe", by: "operator:root", note: "epoch mechanism probe" });
    expect(re.ok).toBe(true);
    if (!re.ok) return;
    expect(revalidateSessionReviewer({ reviewerId: re.reviewer.id, epoch: re.reviewer.epoch }).ok).toBe(true);
    const mismatch = revalidateSessionReviewer({ reviewerId: re.reviewer.id, epoch: re.reviewer.epoch + 999 });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.error).toContain("re-provisioned");
    // and an old-epoch session cannot be issued into validity either — the
    // issued payload always carries the reviewer's CURRENT epoch
    const s = issueSessionForReviewer(re.reviewer);
    expect(verifySession(s.token)!.epoch).toBe(re.reviewer.epoch);
  });

  test("unknown reviewer id cannot revalidate", () => {
    expect(revalidateSessionReviewer({ reviewerId: "tvr-00000000", epoch: 1 }).ok).toBe(false);
  });

  test("revoked reviewers can be listed with --all semantics", () => {
    const all = listReviewers(true);
    expect(all.filter((r) => r.status === "revoked").length).toBeGreaterThanOrEqual(1);
  });
});

describe("cookie configuration", () => {
  test("Secure is mandatory in production and off in dev", () => {
    expect(cookieConfig(3600)).toEqual({ httpOnly: true, sameSite: "strict", secure: false, path: "/", maxAge: 3600 });
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(cookieConfig(3600).secure).toBe(true);
      expect(isProduction()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

describe("production configuration gate (fail closed)", () => {
  const OK_ENV = () => ({
    NODE_ENV: "production",
    TV_SESSION_SECRET_FILE: SECRET,
    TV_REVIEWERS_FILE: REG,
    TV_PUBLIC_HTTPS: "1",
    TV_PGHOST: "127.0.0.1",
    TV_PGUSER: "syllabai",
    TV_PGDATABASE: "syllabai",
  });

  test("a complete production configuration passes", () => {
    // ensure the secret exists for the ok-case
    if (!fs.existsSync(SECRET)) fs.writeFileSync(SECRET, Buffer.alloc(32, 7));
    const r = assertProductionConfig(OK_ENV() as unknown as NodeJS.ProcessEnv);
    expect(r.ok).toBe(true);
    expect(r.problems).toHaveLength(0);
  });

  test("missing production secret fails closed", () => {
    const env = { ...OK_ENV(), TV_SESSION_SECRET_FILE: path.join(SCRATCH, "does-not-exist.key") };
    const r = assertProductionConfig(env as unknown as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("session secret");
  });

  test("undersized production secret fails closed", () => {
    const small = path.join(SCRATCH, "small.key");
    fs.writeFileSync(small, Buffer.alloc(8, 1));
    const r = assertProductionConfig({ ...OK_ENV(), TV_SESSION_SECRET_FILE: small } as unknown as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("32 bytes");
  });

  test("missing reviewer registry fails closed", () => {
    const r = assertProductionConfig({ ...OK_ENV(), TV_REVIEWERS_FILE: path.join(SCRATCH, "nope.json") } as unknown as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("reviewer registry");
  });

  test("insecure cookie configuration (TV_PUBLIC_HTTPS unset) fails closed", () => {
    const { TV_PUBLIC_HTTPS, ...rest } = OK_ENV();
    const r = assertProductionConfig(rest as unknown as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("TV_PUBLIC_HTTPS");
  });

  test("silent DB defaults are refused in production", () => {
    const { TV_PGHOST, ...rest } = OK_ENV();
    const r = assertProductionConfig(rest as unknown as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("TV_PGHOST");
  });

  test("development configuration is not subjected to production checks", () => {
    const r = assertProductionConfig({ NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv);
    expect(r.ok).toBe(true);
  });
});

describe("secret rotation", () => {
  test("rotation invalidates every outstanding session (fail closed)", () => {
    const reviewer = listReviewers(true).find((r) => r.status === "active")!;
    const before = issueSessionForReviewer(reviewer);
    expect(verifySession(before.token)).not.toBeNull();
    const rotated = rotateSessionSecret();
    expect(rotated.file).toBe(SECRET);
    expect(rotated.bytes).toBe(32);
    // old signature no longer verifies against the new secret
    expect(verifySession(before.token)).toBeNull();
    // a session minted AFTER rotation verifies
    const after = issueSessionForReviewer(reviewer);
    expect(verifySession(after.token)).not.toBeNull();
  });
});

describe("production loadSecret refuses to auto-generate", () => {
  test("missing secret file in production throws instead of auto-generating", () => {
    const prev = process.env.NODE_ENV;
    const missing = path.join(SCRATCH, "never-created.key");
    try {
      process.env.NODE_ENV = "production";
      process.env.TV_SESSION_SECRET_FILE = missing;
      let threw = "";
      try {
        issueSessionForReviewer({ id: "tvr-00000001", name: "Prod Teacher", role: "teacher", epoch: 1 });
      } catch (e) {
        threw = (e as Error).message;
      }
      expect(threw).toContain("fail closed");
      expect(fs.existsSync(missing)).toBe(false); // nothing was auto-generated
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
      process.env.TV_SESSION_SECRET_FILE = SECRET;
    }
  });
});

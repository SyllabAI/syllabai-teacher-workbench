import fs from "fs";
import path from "path";

/**
 * R3-7 — Production configuration gate (fail closed, explicit startup failure).
 *
 * In production the workbench MUST NOT:
 *  - auto-generate or fall back to development secrets,
 *  - serve Secure cookies over an origin not declared HTTPS,
 *  - silently default its canonical DB connection,
 *  - run without a reviewer registry (staging would be impossible anyway —
 *    fail loudly instead of mysteriously).
 *
 * Wired from src/instrumentation.ts register(): any problem THROWS at server
 * start, so an insecure deployment fails visibly instead of degrading.
 * Development (next dev) is unaffected: checks run only when
 * NODE_ENV === "production".
 */

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production";
}

export interface ProductionCheckResult {
  ok: boolean;
  problems: string[];
}

function secretFile(env: NodeJS.ProcessEnv): string {
  return env.TV_SESSION_SECRET_FILE || path.join(process.cwd(), "data", "teacher-validation", "session-secret.key");
}
function reviewersFile(env: NodeJS.ProcessEnv): string {
  return env.TV_REVIEWERS_FILE || path.join(process.cwd(), "data", "teacher-validation", "reviewers.json");
}

/**
 * TV_DEPLOYMENT_MODE (2026-09-15 workbench Vercel repair):
 *  - "full" (default off-platform) — the original single-host posture:
 *    out-of-band session secret + provisioned reviewer registry + explicit
 *    canonical DB. Staging writes enabled. Unchanged behavior.
 *  - "readonly" — a READ-ONLY audit mirror (e.g. the Vercel deployment): the
 *    dataset reads (data/review, read-model tables, decision log) are served,
 *    but NO session can be issued and NO staging write is accepted (routes
 *    refuse with 503 before touching auth). No secret is required because no
 *    secret-bearing capability exists — fail-closed is preserved: the gate
 *    still refuses to boot on any undeclared mode, and "readonly" still
 *    requires the HTTPS declaration. This is strictly LESS capability than
 *    full mode, never more.
 *
 * On Vercel (platform-injected VERCEL=1) the default is "readonly": staging
 * writes can never be durable on serverless hosts, so the platform can only
 * honestly serve a mirror. An operator MAY still opt into "full" there by
 * setting TV_DEPLOYMENT_MODE=full and providing the full secret set — the
 * gate then enforces exactly the same requirements as any other host.
 */
export function deploymentMode(env: NodeJS.ProcessEnv = process.env):
    "full" | "readonly" {
  const raw = (env.TV_DEPLOYMENT_MODE || "").trim().toLowerCase();
  if (raw === "readonly") return "readonly";
  if (raw === "full") return "full";
  if (raw !== "") {
    throw new Error(`TV_DEPLOYMENT_MODE must be "full" or "readonly" (got "${raw}")`);
  }
  // Undeclared: serverless hosts default to readonly (writes cannot persist).
  return env.VERCEL === "1" ? "readonly" : "full";
}

export function isReadOnlyDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return isProduction(env) && deploymentMode(env) === "readonly";
}

export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): ProductionCheckResult {
  if (!isProduction(env)) return { ok: true, problems: [] };
  const problems: string[] = [];

  // Deployment mode (declared, never implicit).
  const readonly = deploymentMode(env) === "readonly";

  if (readonly) {
    // Readonly mirror: no staging capability exists, so no secret/registry/DB
    // is required. The ONLY hard requirement is HTTPS honesty. On Vercel the
    // platform serves HTTPS-only by construction, so VERCEL=1 satisfies the
    // declaration; elsewhere the operator must declare it explicitly.
    if (env.TV_PUBLIC_HTTPS !== "1" && env.VERCEL !== "1") {
      problems.push("TV_PUBLIC_HTTPS must be \"1\" in production — the readonly mirror must still declare HTTPS");
    }
    return { ok: problems.length === 0, problems };
  }

  // 1. Session secret: must EXIST (never auto-generated in production).
  const sec = secretFile(env);
  if (!fs.existsSync(sec)) {
    problems.push(`session secret file missing at ${sec} — generate it out-of-band (openssl rand -base64 32) and mount it at 0600; production never auto-generates secrets`);
  } else if (fs.statSync(sec).size < 32) {
    problems.push(`session secret file at ${sec} is smaller than 32 bytes — invalid`);
  }

  // 2. Reviewer registry must exist (staging without provisioning is impossible by design).
  const reg = reviewersFile(env);
  if (!fs.existsSync(reg)) {
    problems.push(`reviewer registry not found at ${reg} — provision at least one reviewer before production start`);
  }

  // 3. Secure-cookie honesty: production must declare the public origin is HTTPS.
  if (env.TV_PUBLIC_HTTPS !== "1") {
    problems.push("TV_PUBLIC_HTTPS must be \"1\" in production — the session cookie is Secure and must only be served over HTTPS");
  }

  // 4. Canonical DB connection: no silent defaults in production.
  for (const k of ["TV_PGHOST", "TV_PGUSER", "TV_PGDATABASE"]) {
    if (!env[k] || !String(env[k]).trim()) {
      problems.push(`${k} must be set explicitly in production — no silent DB defaults`);
    }
  }

  return { ok: problems.length === 0, problems };
}

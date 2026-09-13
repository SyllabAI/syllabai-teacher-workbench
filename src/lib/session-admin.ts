import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

/**
 * R3-7 — Session-secret rotation (operator action, not an HTTP endpoint).
 *
 * Rotating the HMAC secret instantly invalidates EVERY outstanding workbench
 * session (verification signs against the new secret; old signatures fail).
 * This is the break-glass answer to "a session may have leaked" and the
 * routine answer to key-age policy.
 *
 * Kept separate from src/lib/session.ts so the serving module stays minimal;
 * the CLI (scripts/provision-reviewer.ts rotate-session-secret) is the only
 * intended caller besides tests.
 */

export const SESSION_SECRET_FILE_HELP =
  "Rotation does not touch the reviewer registry — reviewers re-authenticate with their existing provisioned tokens.";

export function sessionSecretFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.TV_SESSION_SECRET_FILE || path.join(process.cwd(), "download", "teacher-validation", "session-secret.key");
}

export function rotateSessionSecret(env: NodeJS.ProcessEnv = process.env): { file: string; bytes: number } {
  const file = sessionSecretFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const secret = randomBytes(32);
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, secret);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort on filesystems without chmod */
  }
  return { file, bytes: secret.length };
}

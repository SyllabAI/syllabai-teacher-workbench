#!/usr/bin/env bun
/**
 * R3-8 — operator-side negative-test token minter.
 *
 * Mints HMAC session tokens signed with the PRODUCTION session secret for
 * the ONLY permitted purpose: proving on the real host that the workbench
 * rejects expired / wrong-role / malformed sessions (Phase C + negative
 * tests). Requires filesystem access to the secret file — i.e. operator
 * privilege on the host. A token this script can mint is BY DEFINITION one
 * a non-operator attacker cannot produce (they lack the secret).
 *
 * Usage:
 *   bun scripts/prod/mint-test-token.ts expired          # role teacher, exp in the past
 *   bun scripts/prod/mint-test-token.ts wrong-role       # role "admin" (not issuable)
 *   bun scripts/prod/mint-test-token.ts unknown-reviewer # reviewerId absent from registry
 * Env: TV_SESSION_SECRET_FILE (required), TV_MINT_EPOCH (optional epoch, default 1)
 * Output: single line "token" — never logged to evidence.
 */
import { createHmac } from "crypto";
import fs from "fs";

const file = process.env.TV_SESSION_SECRET_FILE;
if (!file || !fs.existsSync(file)) {
  console.error("mint-test-token: TV_SESSION_SECRET_FILE missing");
  process.exit(1);
}
const secret = fs.readFileSync(file);
const mode = process.argv[2] || "expired";
const now = Date.now();
const base: Record<string, unknown> = {
  v: 2,
  reviewerId: "tvr-00000000",
  name: "Negative Test Operator",
  role: "teacher",
  epoch: Number(process.env.TV_MINT_EPOCH || 1),
};
let payload: Record<string, unknown>;
if (mode === "expired") payload = { ...base, exp: now - 60_000 };
else if (mode === "wrong-role") payload = { ...base, role: "admin", exp: now + 3_600_000 };
else if (mode === "unknown-reviewer") payload = { ...base, exp: now + 3_600_000 };
else if (mode === "valid-shaped") payload = { ...base, exp: now + 60_000 };
else { console.error("unknown mode"); process.exit(1); }
const b64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
const sig = createHmac("sha256", secret).update(b64).digest("base64url");
console.log(`${b64}.${sig}`);

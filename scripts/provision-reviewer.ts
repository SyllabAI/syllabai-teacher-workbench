#!/usr/bin/env bun
/**
 * R3-7 — Reviewer provisioning CLI (operator tool).
 *
 * The workbench NEVER provisions reviewers over HTTP. An operator with
 * server access runs this script; tokens are printed ONCE to stdout and
 * stored only as a SHA-256 hash in the registry.
 *
 * Usage:
 *   bun scripts/provision-reviewer.ts provision --name "Ada Teacher" --by "operator:amine" [--role teacher] [--note "..."]
 *   bun scripts/provision-reviewer.ts revoke   --id tvr-0a1b2c3d | --name "Ada Teacher" --by "operator:amine" [--note "..."]
 *   bun scripts/provision-reviewer.ts list [--all]
 *   bun scripts/provision-reviewer.ts rotate-session-secret --by "operator:amine"
 *
 * Env overrides (tests / alternate deployments):
 *   TV_REVIEWERS_FILE, TV_PROVISIONING_LOG_FILE, TV_SESSION_SECRET_FILE
 */
import {
  provisionReviewer,
  revokeReviewer,
  listReviewers,
  hashToken,
  appendProvisioningAudit,
  registryFile,
  provisioningLogFile,
} from "../src/lib/reviewers";
import { SESSION_SECRET_FILE_HELP, rotateSessionSecret } from "../src/lib/session-admin";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
const cmd = process.argv[2];

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (cmd === "provision") {
  const name = arg("--name");
  const by = arg("--by");
  const note = arg("--note");
  const role = arg("--role") || "teacher";
  if (!name || !by) fail("provision requires --name and --by");
  const result = provisionReviewer({ name: name!, by: by!, note, role });
  if (!result.ok) fail(result.error);
  console.error(`reviewer provisioned: id=${result.reviewer.id} name="${result.reviewer.name}" role=${result.reviewer.role} epoch=${result.reviewer.epoch}`);
  console.error(`registry: ${registryFile()}`);
  console.error("THE TOKEN BELOW IS SHOWN EXACTLY ONCE — store it in the reviewer's password manager now:");
  console.log(result.token);
  console.error(`token sha256 (recorded in registry): ${hashToken(result.token)}`);
  process.exit(0);
}

if (cmd === "revoke") {
  const by = arg("--by");
  const idOrName = arg("--id") ?? arg("--name");
  if (!by || !idOrName) fail("revoke requires --by and one of --id/--name");
  const result = revokeReviewer({ idOrName: idOrName!, by: by!, note: arg("--note") });
  if (!result.ok) fail(result.error);
  console.log(`revoked: id=${result.reviewer.id} name="${result.reviewer.name}" epoch now ${result.reviewer.epoch} — all outstanding sessions for this reviewer are dead on their next staging request.`);
  process.exit(0);
}

if (cmd === "list") {
  const all = hasFlag("--all");
  const reviewers = listReviewers(all);
  if (!reviewers.length) {
    console.log(all ? "registry is empty" : "no active reviewers (use --all to include revoked)");
    process.exit(0);
  }
  for (const r of reviewers) {
    const rev = r.status === "revoked" ? ` REVOKED at ${r.revokedAt}` : "";
    console.log(`${r.id}  ${r.name}  role=${r.role} epoch=${r.epoch} status=${r.status} provisioned_by=${r.provisionedBy} at ${r.createdAt}${rev}`);
  }
  process.exit(0);
}

if (cmd === "rotate-session-secret") {
  const by = arg("--by");
  if (!by) fail("rotate-session-secret requires --by");
  const r = rotateSessionSecret();
  console.error(`session secret rotated: new file ${r.file} (${r.bytes} bytes, 0600, fsync'd).`);
  console.error(`All previously issued workbench sessions are now INVALID (fail-closed). ${SESSION_SECRET_FILE_HELP}`);
  appendProvisioningAudit({ ts: new Date().toISOString(), action: "ROTATE_SESSION_SECRET", by, note: r.file });
  console.log("session secret rotated");
  process.exit(0);
}

console.error(`usage:
  bun scripts/provision-reviewer.ts provision --name "Ada Teacher" --by "operator:you" [--role teacher] [--note "..."]
  bun scripts/provision-reviewer.ts revoke --id tvr-xxxxxxxx | --name "Ada Teacher" --by "operator:you" [--note "..."]
  bun scripts/provision-reviewer.ts list [--all]
  bun scripts/provision-reviewer.ts rotate-session-secret --by "operator:you"

registry:      ${registryFile()}
audit log:     ${provisioningLogFile()}`);
process.exit(1);

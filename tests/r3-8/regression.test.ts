#!/usr/bin/env bun
/**
 * R3-8 — regression tests for the two real-host findings:
 *
 * F-A  unknown action strings must be rejected by appendDecision (write-path
 *      runtime validation of the DecisionAction enum).
 * F-B  verifyChain must exclude `reviewerId` from the recomputation base —
 *      identical to writeEntry and to the importer's frozen base
 *      (import_teacher_decisions.py entry_hash). Before the fix, every
 *      reviewerId-bearing entry failed the workbench's own verifier.
 *
 * Everything runs on TV_* scratch state; the real campaign log and the
 * production state are never touched.
 */
import { appendDecision, verifyChain, readEntries } from "../../src/lib/decision-log";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "r3-8-regression-"));
process.env.TV_LOG_FILE = join(dir, "decision-log.jsonl");
process.env.TV_REVIEWERS_FILE = join(dir, "reviewers.json");
process.env.TV_PROVISIONING_LOG_FILE = join(dir, "provisioning-log.jsonl");

// Minimal valid registry with one active reviewer (shape per src/lib/reviewers.ts)
writeFileSync(
  process.env.TV_REVIEWERS_FILE,
  JSON.stringify({
    version: 1,
    reviewers: [
      {
        id: "tvr-1a2b3c4d",
        name: "Regression Tester",
        role: "teacher",
        tokenHash: "0".repeat(64),
        status: "active",
        epoch: 1,
        createdAt: new Date().toISOString(),
        provisionedBy: "test:r3-8",
      },
    ],
  })
);

// Pick a real SUGGESTED target from the read model (same source the route uses)
import { getLifecycleRegistry } from "../../src/lib/review-data";
const reg = getLifecycleRegistry();
const target = [...reg.entries()].find(([, t]) => t.state === "SUGGESTED" && t.type === "question_version");
if (!target) {
  console.error("no SUGGESTED target in read model — cannot run regression");
  process.exit(1);
}
const [targetId, t] = target;

const liveGate = { liveState: "SUGGESTED" as const };

let failures = 0;
function expect(cond: boolean, label: string) {
  console.log(`${cond ? "PASS" : "FAIL"} — ${label}`);
  if (!cond) failures++;
}

// F-A: unknown action rejected
const bad = appendDecision({
  action: "PROMOTE" as never,
  targetType: "question_version",
  targetId,
  reviewer: "Regression Tester",
  reviewerId: "tvr-1a2b3c4d",
  note: "",
  liveGate,
});
expect(!bad.ok, "F-A: unknown action PROMOTE rejected by appendDecision");
if (!bad.ok) {
  expect(String(bad.error).includes("unknown action"), "F-A: rejection names the action enum");
}
expect(readEntries().length === 0, "F-A: log still empty after rejected action");

// F-B: valid append with reviewerId must self-verify (the pre-fix bug)
const good = appendDecision({
  action: "FLAG",
  targetType: "question_version",
  targetId,
  reviewer: "Regression Tester",
  reviewerId: "tvr-1a2b3c4d",
  note: "R3-8 regression probe entry (scratch)",
  liveGate,
});
expect(good.ok, "F-B: valid FLAG append accepted");
if (good.ok) {
  const es = readEntries();
  expect(es.length === 1 && es[0].reviewerId === "tvr-1a2b3c4d", "F-B: entry carries reviewerId");
  expect(verifyChain(es), "F-B: verifyChain accepts the reviewerId-bearing entry (was FALSE pre-fix)");
  // Cross-side: recompute the importer's frozen base in TS the same way the python does
  const { createHash } = await import("crypto");
  const e = es[0];
  const base = {
    action: e.action, targetType: e.targetType, targetId: e.targetId, targetLabel: e.targetLabel,
    reviewer: e.reviewer, note: e.note, seq: e.seq, ts: e.ts, prevHash: e.prevHash,
  };
  const pyStyle = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  expect(pyStyle === e.hash, "F-B: hash equals importer frozen-base recomputation (python-identical)");
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "R3-8 regression: ALL PASS" : `R3-8 regression: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

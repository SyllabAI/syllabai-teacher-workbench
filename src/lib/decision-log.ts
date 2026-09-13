import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { getLifecycleRegistry } from "./review-data";

/**
 * Staged teacher-validation decision log.
 *
 * EVIDENCE RULES (AGENT.md):
 *  - APPEND-ONLY, hash-chained (tamper-evident). No update/delete APIs exist.
 *  - This log STAGES teacher intent only. It never mutates the canonical
 *    campaign state. Applying staged decisions to the canonical DB is a
 *    separate, gated importer that runs only when the canonical DB is
 *    provisioned (currently blocked on repo access).
 *  - The lifecycle is enforced server-side: only SUGGESTED targets may be
 *    decided; seed-VALIDATED content is locked; REJECT/FLAG require a note.
 *  - Durable by construction: the log lives under download/teacher-validation/
 *    (evidence-bundle territory, outside scaffold-owned paths).
 */

const LOG_DIR = path.join(process.cwd(), "download", "teacher-validation");

/**
 * Log path is lazy so tests can isolate the real hash-chained log via
 * TV_LOG_FILE (the real log is durable evidence — tests must never touch it).
 */
function logFile(): string {
  return process.env.TV_LOG_FILE || path.join(LOG_DIR, "decision-log.jsonl");
}

export type TargetType = "question_version" | "mark_scheme" | "exam_paper";
export type DecisionAction = "VALIDATE" | "REJECT" | "FLAG" | "REVERSE";

export interface DecisionEntry {
  seq: number;
  ts: string;
  action: DecisionAction;
  targetType: TargetType;
  targetId: string;
  targetLabel: string;
  reviewer: string;
  note: string;
  prevHash: string;
  hash: string;
  /**
   * R3-7: stable provisioned reviewer identity. Deliberately OUTSIDE the
   * entry hash (exact F-3 `reverses` pattern): the hash base is frozen to
   * match the gated importer's verifier, so adding a field to the JSON
   * without adding it to the hash keeps every existing entry verifiable by
   * BOTH sides. Old entries simply lack the field.
   */
  reviewerId?: string;
}

const GENESIS = "0".repeat(64);

/**
 * Hash base EXCLUDES reviewerId (R3-7) — frozen to match the gated
 * importer's verifier. Do not add fields here without a cross-side
 * compatibility proof (importer check-mode on a scratch log).
 */
function entryHash(e: Omit<DecisionEntry, "hash" | "reviewerId">): string {
  return createHash("sha256").update(JSON.stringify(e)).digest("hex");
}

export function readEntries(): DecisionEntry[] {
  const LOG_FILE = logFile();
  if (!fs.existsSync(LOG_FILE)) return [];
  const out: DecisionEntry[] = [];
  for (const line of fs.readFileSync(LOG_FILE, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as DecisionEntry); } catch { /* skip torn tail */ }
  }
  return out;
}

export function verifyChain(entries: DecisionEntry[]): boolean {
  let prev = GENESIS;
  for (const e of entries) {
    const { hash, ...rest } = e;
    if (e.prevHash !== prev) return false;
    if (entryHash(rest) !== hash) return false;
    prev = hash;
  }
  return true;
}

export interface StageState {
  entries: DecisionEntry[];
  chainValid: boolean;
  head: string;
  staged: { validated: number; rejected: number; flagged: number; reversed: number };
  effective: Record<string, "VALIDATED" | "REJECTED" | "FLAGGED">;
}

export function getStageState(): StageState {
  const entries = readEntries();
  const chainValid = verifyChain(entries);
  const staged = { validated: 0, rejected: 0, flagged: 0, reversed: 0 };
  const reversedSeqs = new Set(
    entries.filter((e) => e.action === "REVERSE").map((e) => parseInt(extractSeq(e.note), 10)).filter((n) => !isNaN(n))
  );
  const effective: Record<string, "VALIDATED" | "REJECTED" | "FLAGGED"> = {};
  for (const e of entries) {
    if (e.action === "VALIDATE") { staged.validated++; effective[e.targetId] = "VALIDATED"; }
    else if (e.action === "REJECT") { staged.rejected++; effective[e.targetId] = "REJECTED"; }
    else if (e.action === "FLAG") { staged.flagged++; if (!effective[e.targetId]) effective[e.targetId] = "FLAGGED"; }
    else if (e.action === "REVERSE") { staged.reversed++; delete effective[e.targetId]; }
  }
  return {
    entries,
    chainValid,
    head: entries.length ? entries[entries.length - 1].hash : GENESIS,
    staged,
    effective,
  };
}

function extractSeq(note: string): string {
  const m = note.match(/seq (\d+)/);
  return m ? m[1] : "-1";
}

export interface AppendInput {
  action: DecisionAction;
  targetType: TargetType;
  targetId: string;
  reviewer: string;
  note?: string;
  reverseSeq?: number;
  /** R3-7: provisioned reviewer identity (stored outside the hash). */
  reviewerId?: string;
  /**
   * R3-7 live canonical gate — a MIRROR of the importer's gates (the
   * importer remains the only authority). The caller (staging route) fetches
   * this from the LIVE canonical DB; the log itself stays I/O-free.
   *   liveState: live validation_state of the target, or null if the live
   *              DB could not confirm it (fail-closed).
   *   priorApplied / priorIsLastEvent: for REVERSE — the referenced prior
   *              staged entry has a matching applied event and it is still
   *              the last event on that target (R3-5 reverse-consistency).
   */
  liveGate?: {
    liveState: string | null;
    priorApplied?: boolean;
    priorIsLastEvent?: boolean;
  };
}

export function appendDecision(input: AppendInput): { ok: true; entry: DecisionEntry } | { ok: false; error: string } {
  const reviewer = (input.reviewer || "").trim();
  if (reviewer.length < 2 || reviewer.length > 80) {
    return { ok: false, error: "reviewer name required (2-80 chars)" };
  }
  const note = (input.note || "").trim();
  const state = getStageState();
  const reg = getLifecycleRegistry();

  if (input.action === "REVERSE") {
    const prior = state.entries.find((e) => e.seq === input.reverseSeq);
    if (!prior) return { ok: false, error: `no staged entry with seq ${input.reverseSeq}` };
    const alreadyReversed = state.entries.some(
      (e) => e.action === "REVERSE" && parseInt(extractSeq(e.note), 10) === prior.seq
    );
    if (alreadyReversed) return { ok: false, error: `entry seq ${prior.seq} already reversed` };
    // R3-7 live reverse-consistency (mirror of the importer's gate): the
    // referenced decision must already be applied AND still be the last
    // event on that target — otherwise the staged REVERSE is dead intent
    // that the importer would refuse.
    if (!input.liveGate || input.liveGate.liveState === null) {
      return { ok: false, error: "live canonical state not confirmed — reversal staging is blocked (fail-closed)" };
    }
    if (input.liveGate.priorApplied !== true) {
      return { ok: false, error: `seq ${prior.seq} has no matching applied event in the canonical DB — a reversal may only be staged for an APPLIED decision` };
    }
    if (input.liveGate.priorIsLastEvent !== true) {
      return { ok: false, error: `seq ${prior.seq} is no longer the last applied event on this target — reversal refused (stale intent must not accumulate)` };
    }
    return writeEntry({
      action: "REVERSE", targetType: prior.targetType, targetId: prior.targetId,
      targetLabel: prior.targetLabel, reviewer, note: `reverses seq ${prior.seq} (${prior.action})${note ? ` — ${note}` : ""}`,
      reviewerId: input.reviewerId,
    });
  }

  const target = reg.get(input.targetId);
  if (!target || target.type !== input.targetType) {
    return { ok: false, error: `unknown target ${input.targetType}:${input.targetId}` };
  }
  // R3-7 LIVE canonical gate (mirror of the importer's SUGGESTED-only rule).
  // The static read-model registry remains the identity source; the LIVE DB
  // decides decidability — a stale read model can no longer let intent
  // enter the log against a target whose canonical state has moved on.
  if (!input.liveGate || input.liveGate.liveState === null) {
    return { ok: false, error: "live canonical state not confirmed — staging is blocked (fail-closed); the canonical DB feed must confirm the target" };
  }
  if (input.liveGate.liveState !== "SUGGESTED") {
    return { ok: false, error: `live canonical state is ${input.liveGate.liveState}, not SUGGESTED — the gated importer applies state-changing decisions only against SUGGESTED targets (lifecycle violation refused)` };
  }
  if (target.state !== "SUGGESTED") {
    return { ok: false, error: `lifecycle violation: target is ${target.state}, not SUGGESTED — only SUGGESTED content may be decided` };
  }
  const current = state.effective[input.targetId];
  if ((input.action === "VALIDATE" || input.action === "REJECT") && current && current !== "FLAGGED") {
    return { ok: false, error: `target already staged as ${current}; reverse that entry first` };
  }
  if (input.action === "REJECT" && note.length < 4) {
    return { ok: false, error: "REJECT requires a reason note (min 4 chars)" };
  }
  if (input.action === "FLAG" && note.length < 4) {
    return { ok: false, error: "FLAG requires a note (min 4 chars)" };
  }
  return writeEntry({
    action: input.action, targetType: target.type, targetId: target.id,
    targetLabel: target.label, reviewer, note,
    reviewerId: input.reviewerId,
  });
}

function writeEntry(
  e: Omit<DecisionEntry, "seq" | "ts" | "prevHash" | "hash"> & { reviewerId?: string }
): { ok: true; entry: DecisionEntry } | { ok: false; error: string } {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    const entries = readEntries();
    const prevHash = entries.length ? entries[entries.length - 1].hash : GENESIS;
    // reviewerId rides OUTSIDE the hash base (frozen cross-side base).
    const { reviewerId, ...rest } = e;
    const base = { ...rest, seq: entries.length + 1, ts: new Date().toISOString(), prevHash };
    const entry: DecisionEntry = {
      ...base,
      ...(reviewerId ? { reviewerId } : {}),
      hash: entryHash(base),
    };
    // append-only durable write
    const fd = fs.openSync(logFile(), "a");
    try {
      fs.writeSync(fd, JSON.stringify(entry) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, entry };
  } catch (err) {
    return { ok: false, error: `append failed: ${(err as Error).message}` };
  }
}

export interface ExportBundle {
  bundleVersion: string;
  exportedAt: string;
  campaign: string;
  provenance: {
    label: string;
    dumpSha256: string;
    identity: { campaign: string; db: string; coreCommit: string };
    note: string;
  };
  chainValid: boolean;
  head: string;
  counts: { entries: number; validated: number; rejected: number; flagged: number; reversed: number };
  entries: DecisionEntry[];
}

export function buildExportBundle(provenance: {
  label: string; dumpSha256: string; identity: { campaign: string; db: string; coreCommit: string };
}): ExportBundle {
  const state = getStageState();
  return {
    bundleVersion: "1",
    exportedAt: new Date().toISOString(),
    campaign: "T-C04-teacher-validation-staging",
    provenance: {
      ...provenance,
      note: "Staged teacher decisions only — applying to the canonical campaign DB requires the gated importer and the provisioned canonical state (V1..V16 + verified campaign data).",
    },
    chainValid: state.chainValid,
    head: state.head,
    counts: { entries: state.entries.length, ...state.staged },
    entries: state.entries,
  };
}

export function writeDurableExport(bundle: ExportBundle): string {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const name = `decision-bundle-${bundle.exportedAt.replace(/[:.]/g, "-")}.json`;
  const file = path.join(LOG_DIR, name);
  fs.writeFileSync(file, JSON.stringify(bundle, null, 1), "utf-8");
  return file;
}

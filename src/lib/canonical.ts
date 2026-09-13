import { Pool } from "pg";

/**
 * Read-only canonical-DB access for the teacher-validation workbench (R3-6).
 *
 * SERVING-BOUNDARY INVARIANT (AGENT.md §6 + R3-6 directive):
 *  - Every connection is opened with default_transaction_read_only=on, so the
 *    Next.js serving path is PHYSICALLY unable to mutate canonical state —
 *    even through a code bug. Staged intent lives in the JSONL log; applying
 *    it to canonical state is the separate gated importer (server-side only).
 *  - All queries are parameterized against a whitelisted table map. No user
 *    string ever becomes a table or column name.
 *  - Fail-closed: any canonical-feed error degrades to { available: false } —
 *    the UI must then treat staged intent as NOT APPLIED (never the opposite).
 */

const CANONICAL_TABLES: Record<string, string> = {
  exam_paper: "exam_papers",
  question_version: "question_versions",
  mark_scheme: "mark_schemes",
};

export type CanonicalTargetType = keyof typeof CANONICAL_TABLES;

export function isCanonicalTargetType(t: string): t is CanonicalTargetType {
  return Object.prototype.hasOwnProperty.call(CANONICAL_TABLES, t);
}

export interface AppliedEvent {
  id: number;
  importerRunId: string;
  decisionSeq: number;
  decisionHash: string;
  action: "VALIDATE" | "REJECT" | "FLAG" | "REVERSE";
  targetType: string;
  targetId: string;
  targetLabel: string;
  reviewer: string;
  note: string;
  resultState: "SUGGESTED" | "VALIDATED" | "REJECTED";
  appliedAt: string;
}

export interface CanonicalTargetStatus {
  state: string; // canonical validation_state, or "UNKNOWN" if the id is not present
  appliedCount: number;
  lastEvent: AppliedEvent | null;
}

let pool: Pool | null = null;
let poolBroken = false;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.TV_PGHOST || "127.0.0.1",
      port: Number(process.env.TV_PGPORT || 5432),
      user: process.env.TV_PGUSER || "syllabai",
      database: process.env.TV_PGDATABASE || "syllabai",
      max: 3,
      idleTimeoutMillis: 15_000,
      connectionTimeoutMillis: 3_000,
      statement_timeout: 5_000,
      // The load-bearing safety line: read-only at the connection level.
      options: "-c default_transaction_read_only=on",
    });
    pool.on("error", () => { poolBroken = true; });
  }
  return pool;
}

/** Health probe used by tests: confirms the read-only guard is server-enforced. */
export async function readOnlyGuardEnforced(): Promise<boolean> {
  const r = await getPool().query("SHOW transaction_read_only");
  return r.rows[0].transaction_read_only === "on";
}

export async function getAppliedEvents(limit = 500): Promise<{ available: boolean; events: AppliedEvent[]; error?: string }> {
  try {
    const r = await getPool().query(
      `SELECT id, importer_run_id, decision_seq, decision_hash, action, target_type,
              target_id, target_label, reviewer, note, result_state, applied_at
         FROM teacher_validation_events
        ORDER BY decision_seq ASC, id ASC
        LIMIT $1`,
      [Math.min(Math.max(limit, 1), 2000)]
    );
    poolBroken = false;
    return {
      available: true,
      events: r.rows.map((row) => ({
        id: row.id,
        importerRunId: row.importer_run_id,
        decisionSeq: row.decision_seq,
        decisionHash: row.decision_hash,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        targetLabel: row.target_label,
        reviewer: row.reviewer,
        note: row.note,
        resultState: row.result_state,
        appliedAt: new Date(row.applied_at).toISOString(),
      })),
    };
  } catch (err) {
    return { available: false, events: [], error: (err as Error).message };
  }
}

export interface StateRequest {
  type: CanonicalTargetType;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Live canonical validation_state per requested target, with the last applied
 * event (if any). Unknown ids return state "UNKNOWN" — fail-safe, never an
 * error, never inferred. Canonical DB remains the single source of truth.
 */
export async function getCanonicalStates(
  targets: StateRequest[]
): Promise<{ available: boolean; checkedAt: string; states: Record<string, CanonicalTargetStatus>; error?: string }> {
  const checkedAt = new Date().toISOString();
  const key = (t: string, id: string) => `${t}:${id}`;
  const out: Record<string, CanonicalTargetStatus> = {};
  for (const t of targets.slice(0, 300)) {
    out[key(t.type, t.id)] = { state: "UNKNOWN", appliedCount: 0, lastEvent: null };
  }
  const valid = targets
    .slice(0, 300)
    .filter((t) => UUID_RE.test(t.id) && isCanonicalTargetType(t.type));

  try {
    // Per-type whitelist query: parameterized ids, fixed table names.
    const byType = new Map<string, string[]>();
    for (const t of valid) {
      const list = byType.get(t.type) || [];
      if (list.length < 150) list.push(t.id);
      byType.set(t.type, list);
    }
    for (const [type, ids] of byType) {
      const table = CANONICAL_TABLES[type];
      const r = await getPool().query(
        `SELECT id, validation_state FROM ${table} WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      for (const row of r.rows) {
        const k = key(type, row.id);
        if (k in out) out[k].state = row.validation_state;
      }
    }
    const eventsRes = await getAppliedEvents(2000);
    if (eventsRes.available) {
      for (const ev of eventsRes.events) {
        const k = key(ev.targetType, ev.targetId);
        const slot = out[k];
        if (!slot) continue;
        slot.appliedCount++;
        if (!slot.lastEvent || ev.appliedAt > slot.lastEvent.appliedAt) slot.lastEvent = ev;
      }
    }
    return { available: true, checkedAt, states: out };
  } catch (err) {
    return { available: false, checkedAt, states: {}, error: (err as Error).message };
  }
}

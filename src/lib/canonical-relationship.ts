/**
 * R3-6 — Pure canonical-vs-staged relationship semantics.
 *
 * This module is the SINGLE definition of how the workbench relates staged
 * intent to canonical truth and to applied events. It is PURE (no I/O, no
 * React) so both the UI and the test suite exercise the exact same logic.
 *
 * Binding semantics (R3-6):
 *  - Canonical DB state is authoritative; staged intent is NOT truth.
 *  - A staged VALIDATE/REJECT never appears canonical merely because it is in
 *    the staging log.
 *  - FLAG is events-only: it never results in a canonical validation state.
 *  - Reversal follows R3-5 event semantics: a REVERSE entry references the
 *    staged entry it undoes ("reverses seq N"); applied REVERSE events carry
 *    their own decision_seq/decision_hash.
 *  - The five relationship kinds are deliberately NOT collapsed into one
 *    status field: canonical state, staged intent, and applied events are
 *    reported separately alongside the relationship.
 */

export type CanonicalState = "SUGGESTED" | "VALIDATED" | "REJECTED" | "UNKNOWN" | string;

export type Relationship =
  | "AGREES_WITH_CANONICAL"
  | "WOULD_CHANGE_CANONICAL"
  | "ALREADY_APPLIED"
  | "APPLIED_THEN_REVERSED"
  | "BLOCKED";

export interface StagedEntryLike {
  seq: number;
  ts: string;
  action: "VALIDATE" | "REJECT" | "FLAG" | "REVERSE";
  targetType: string;
  targetId: string;
  targetLabel: string;
  reviewer: string;
  note: string;
  hash: string;
}

export interface AppliedEventLike {
  decisionSeq: number;
  decisionHash: string;
  action: "VALIDATE" | "REJECT" | "FLAG" | "REVERSE";
  targetType: string;
  targetId: string;
  reviewer: string;
  note: string;
  resultState: "SUGGESTED" | "VALIDATED" | "REJECTED";
  appliedAt: string;
}

/** Extract "reverses seq N" from a REVERSE entry's note (R3-5 format). */
export function parseReverseSeq(note: string): number | null {
  const m = (note || "").match(/reverses seq (\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * The canonical state a staged intent WOULD produce if applied.
 * FLAG -> null (events-only: no canonical state change is proposed).
 * REVERSE -> "SUGGESTED" (restores the pre-decision serving state, R3-5).
 */
export function entryResultingState(entry: StagedEntryLike): CanonicalState | null {
  switch (entry.action) {
    case "VALIDATE": return "VALIDATED";
    case "REJECT": return "REJECTED";
    case "REVERSE": return "SUGGESTED";
    case "FLAG": return null; // events-only
  }
}

export interface EntryRelationship {
  relationship: Relationship;
  eventsOnly: boolean;
  appliedEvent: AppliedEventLike | null;
  explanation: string;
}

/**
 * Relationship of ONE staged intent to canonical truth + applied events.
 *
 * Precedence:
 *   BLOCKED (unknown/invalid target) > APPLIED_THEN_REVERSED > ALREADY_APPLIED
 *   > (open intent) WOULD_CHANGE / AGREES.
 */
export function computeRelationshipForEntry(
  entry: StagedEntryLike,
  canonicalState: CanonicalState,
  appliedEvents: AppliedEventLike[],
  allStagedEntries: StagedEntryLike[]
): EntryRelationship {
  // An applied event is matched by the staged entry's exact chain identity.
  const appliedMatch =
    appliedEvents.find((e) => e.decisionSeq === entry.seq && e.decisionHash === entry.hash) || null;

  if (canonicalState === "UNKNOWN") {
    return {
      relationship: "BLOCKED",
      eventsOnly: entry.action === "FLAG",
      appliedEvent: appliedMatch,
      explanation: "Canonical target not found in the live canonical DB — staging for this target is blocked; the canonical state cannot be confirmed.",
    };
  }

  if (entry.action === "REVERSE") {
    // The reversal itself: has it been applied? If yes, the intent it targets
    // is (from this entry's perspective) already applied as a reversal.
    if (appliedMatch) {
      return {
        relationship: "ALREADY_APPLIED",
        eventsOnly: false,
        appliedEvent: appliedMatch,
        explanation: `Reversal of seq ${parseReverseSeq(entry.note) ?? "?"} has been applied to canonical state (event seq ${appliedMatch.decisionSeq}, by ${appliedMatch.reviewer}).`,
      };
    }
    return {
      relationship: "WOULD_CHANGE_CANONICAL",
      eventsOnly: false,
      appliedEvent: null,
      explanation: `Staged reversal of seq ${parseReverseSeq(entry.note) ?? "?"} — NOT YET APPLIED; canonical state would restore to SUGGESTED when the gated importer runs.`,
    };
  }

  // Original (non-REVERSE) intent: was it applied AND later reversed?
  if (appliedMatch) {
    const reversedBy = allStagedEntries.find(
      (e) => e.action === "REVERSE" && parseReverseSeq(e.note) === entry.seq
    );
    const reversalApplied = reversedBy
      ? appliedEvents.some((e) => e.decisionSeq === reversedBy.seq && e.decisionHash === reversedBy.hash)
      : false;
    if (reversedBy && reversalApplied) {
      return {
        relationship: "APPLIED_THEN_REVERSED",
        eventsOnly: entry.action === "FLAG",
        appliedEvent: appliedMatch,
        explanation: `Applied to canonical state (event seq ${appliedMatch.decisionSeq}, result ${appliedMatch.resultState}) and later reversed (staged seq ${reversedBy.seq} applied) — canonical state is back to SUGGESTED.`,
      };
    }
    return {
      relationship: "ALREADY_APPLIED",
      eventsOnly: entry.action === "FLAG",
      appliedEvent: appliedMatch,
      explanation: `This staged intent has ALREADY BEEN APPLIED to canonical state (event seq ${appliedMatch.decisionSeq}, result ${appliedMatch.resultState}, by ${appliedMatch.reviewer}). It is not a pending action.`,
    };
  }

  // Open staged intent (not applied).
  const resulting = entryResultingState(entry);
  if (resulting === null) {
    return {
      relationship: "AGREES_WITH_CANONICAL",
      eventsOnly: true,
      appliedEvent: null,
      explanation: "FLAG is an events-only annotation — it never changes canonical validation state and never becomes canonical truth.",
    };
  }
  if (canonicalState === resulting) {
    return {
      relationship: "AGREES_WITH_CANONICAL",
      eventsOnly: false,
      appliedEvent: null,
      explanation: `Staged ${entry.action} agrees with the canonical state (already ${canonicalState}) — applying it would not change canonical truth.`,
    };
  }
  return {
    relationship: "WOULD_CHANGE_CANONICAL",
    eventsOnly: false,
    appliedEvent: null,
    explanation: `Staged ${entry.action} is NOT YET APPLIED — canonical state remains ${canonicalState} and would become ${resulting} only after the gated importer applies this entry.`,
  };
}

export interface TargetView {
  canonicalState: CanonicalState;
  seedLocked: boolean; // canonical VALIDATED with no applied events (R3-5 seed lock)
  appliedEvents: AppliedEventLike[];
  openStagedEntries: StagedEntryLike[]; // entries whose intent is not applied
  entryRelationships: Record<number, EntryRelationship>; // by staged seq
}

/**
 * Everything the UI needs for ONE review target, kept as separate dimensions
 * (canonical / staged / applied / relationship) — never one collapsed status.
 */
export function computeTargetView(
  canonicalState: CanonicalState,
  stagedEntries: StagedEntryLike[],
  appliedEvents: AppliedEventLike[]
): TargetView {
  const seedLocked = canonicalState === "VALIDATED" && appliedEvents.length === 0;
  const entryRelationships: Record<number, EntryRelationship> = {};
  for (const e of stagedEntries) {
    entryRelationships[e.seq] = computeRelationshipForEntry(e, canonicalState, appliedEvents, stagedEntries);
  }
  const openStagedEntries = stagedEntries.filter(
    (e) => entryRelationships[e.seq].relationship === "WOULD_CHANGE_CANONICAL" ||
           entryRelationships[e.seq].relationship === "AGREES_WITH_CANONICAL"
  );
  return { canonicalState, seedLocked, appliedEvents, openStagedEntries, entryRelationships };
}

/** Canonical-state badge mapping (state -> label + tone). Pure render data. */
export function canonicalStateBadge(state: CanonicalState): { label: string; tone: "slate" | "emerald" | "rose" | "amber"; authoritative: boolean } {
  switch (state) {
    case "VALIDATED": return { label: "CANONICAL VALIDATED", tone: "emerald", authoritative: true };
    case "REJECTED": return { label: "CANONICAL REJECTED", tone: "rose", authoritative: true };
    case "SUGGESTED": return { label: "CANONICAL SUGGESTED", tone: "slate", authoritative: true };
    case "UNKNOWN": return { label: "CANONICAL STATE UNKNOWN", tone: "amber", authoritative: false };
    default: return { label: `CANONICAL ${String(state).toUpperCase()}`, tone: "slate", authoritative: false };
  }
}

/** Relationship badge mapping (relationship -> label + tone). Pure render data. */
export function relationshipBadge(rel: Relationship): { label: string; tone: "emerald" | "rose" | "sky" | "amber" | "violet" } {
  switch (rel) {
    case "AGREES_WITH_CANONICAL": return { label: "agrees with canonical", tone: "sky" };
    case "WOULD_CHANGE_CANONICAL": return { label: "WOULD CHANGE canonical — staged only", tone: "amber" };
    case "ALREADY_APPLIED": return { label: "already applied", tone: "violet" };
    case "APPLIED_THEN_REVERSED": return { label: "applied, then reversed", tone: "emerald" };
    case "BLOCKED": return { label: "blocked / quarantined", tone: "rose" };
  }
}

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
  /** R3-7: provisioned reviewer identity (present on new entries; outside the entry hash). */
  reviewerId?: string;
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
  /**
   * R3-7: the staged intent is OPEN but newer applied events exist on the
   * same target — the world moved on after this intent was staged. Stale
   * intent is reported explicitly; it can never silently become canonical
   * (the live staging gate and the importer both refuse it).
   */
  stale: boolean;
  supersededBy: AppliedEventLike[];
}

/**
 * R3-7 staleness: applied events on the SAME target that are not this
 * entry's own match and were applied AFTER this entry was staged.
 */
function supersedingEvents(entry: StagedEntryLike, appliedEvents: AppliedEventLike[]): AppliedEventLike[] {
  return appliedEvents
    .filter((e) => e.targetType === entry.targetType && e.targetId === entry.targetId)
    .filter((e) => !(e.decisionSeq === entry.seq && e.decisionHash === entry.hash))
    .filter((e) => new Date(e.appliedAt).getTime() > new Date(entry.ts).getTime())
    .sort((a, b) => new Date(a.appliedAt).getTime() - new Date(b.appliedAt).getTime());
}

function finish(
  relationship: Relationship,
  eventsOnly: boolean,
  appliedEvent: AppliedEventLike | null,
  explanation: string,
  superseded: AppliedEventLike[]
): EntryRelationship {
  const stale = superseded.length > 0;
  const staleNote = stale
    ? ` STALE: ${superseded.length} newer applied event(s) exist on this target (most recent: seq ${superseded[superseded.length - 1].decisionSeq}, ${superseded[superseded.length - 1].action} by ${superseded[superseded.length - 1].reviewer}) — this intent was overtaken by canonical reality and cannot silently become canonical.`
    : "";
  return { relationship, eventsOnly, appliedEvent, explanation: explanation + staleNote, stale, supersededBy: superseded };
}

/**
 * Relationship of ONE staged intent to canonical truth + applied events.
 *
 * Precedence:
 *   BLOCKED (unknown/invalid target) > APPLIED_THEN_REVERSED > ALREADY_APPLIED
 *   > (open intent) BLOCKED (importer-ineligible) > WOULD_CHANGE / AGREES.
 * R3-7: an OPEN state-changing intent whose live canonical state is not
 * SUGGESTED (and does not already agree) is BLOCKED — the gated importer
 * applies VALIDATE/REJECT/FLAG only against SUGGESTED targets, so predicting
 * "would change" would be false. Conflicting intent is reported, never merged.
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
    return finish(
      "BLOCKED",
      entry.action === "FLAG",
      appliedMatch,
      "Canonical target not found in the live canonical DB — staging for this target is blocked; the canonical state cannot be confirmed.",
      supersedingEvents(entry, appliedEvents)
    );
  }

  if (entry.action === "REVERSE") {
    // The reversal itself: has it been applied? If yes, the intent it targets
    // is (from this entry's perspective) already applied as a reversal.
    const superseded = supersedingEvents(entry, appliedEvents);
    if (appliedMatch) {
      return finish(
        "ALREADY_APPLIED",
        false,
        appliedMatch,
        `Reversal of seq ${parseReverseSeq(entry.note) ?? "?"} has been applied to canonical state (event seq ${appliedMatch.decisionSeq}, by ${appliedMatch.reviewer}).`,
        superseded
      );
    }
    return finish(
      "WOULD_CHANGE_CANONICAL",
      false,
      null,
      `Staged reversal of seq ${parseReverseSeq(entry.note) ?? "?"} — NOT YET APPLIED; canonical state would restore to SUGGESTED when the gated importer runs.`,
      superseded
    );
  }

  // Original (non-REVERSE) intent: was it applied AND later reversed?
  const superseded = supersedingEvents(entry, appliedEvents);
  if (appliedMatch) {
    const reversedBy = allStagedEntries.find(
      (e) => e.action === "REVERSE" && parseReverseSeq(e.note) === entry.seq
    );
    const reversalApplied = reversedBy
      ? appliedEvents.some((e) => e.decisionSeq === reversedBy.seq && e.decisionHash === reversedBy.hash)
      : false;
    if (reversedBy && reversalApplied) {
      return finish(
        "APPLIED_THEN_REVERSED",
        entry.action === "FLAG",
        appliedMatch,
        `Applied to canonical state (event seq ${appliedMatch.decisionSeq}, result ${appliedMatch.resultState}) and later reversed (staged seq ${reversedBy.seq} applied) — canonical state is back to SUGGESTED.`,
        superseded
      );
    }
    return finish(
      "ALREADY_APPLIED",
      entry.action === "FLAG",
      appliedMatch,
      `This staged intent has ALREADY BEEN APPLIED to canonical state (event seq ${appliedMatch.decisionSeq}, result ${appliedMatch.resultState}, by ${appliedMatch.reviewer}). It is not a pending action.`,
      superseded
    );
  }

  // Open staged intent (not applied).
  const resulting = entryResultingState(entry);
  if (resulting === null) {
    return finish(
      "AGREES_WITH_CANONICAL",
      true,
      null,
      "FLAG is an events-only annotation — it never changes canonical validation state and never becomes canonical truth.",
      superseded
    );
  }
  if (canonicalState === resulting) {
    return finish(
      "AGREES_WITH_CANONICAL",
      false,
      null,
      `Staged ${entry.action} agrees with the canonical state (already ${canonicalState}) — applying it would not change canonical truth.`,
      superseded
    );
  }
  if (canonicalState !== "SUGGESTED") {
    // R3-7: importer-ineligible conflict, reported explicitly (never merged,
    // never rendered as a would-change that will not happen).
    return finish(
      "BLOCKED",
      false,
      null,
      `CONFLICT: canonical state is ${canonicalState}, but this staged ${entry.action} would produce ${resulting}. The gated importer applies state-changing decisions ONLY against SUGGESTED targets, so this intent is ineligible as things stand — it must be reversed/withdrawn or the canonical decision revisited through a new decision.`,
      superseded
    );
  }
  return finish(
    "WOULD_CHANGE_CANONICAL",
    false,
    null,
    `Staged ${entry.action} is NOT YET APPLIED — canonical state remains ${canonicalState} and would become ${resulting} only after the gated importer applies this entry.`,
    superseded
  );
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

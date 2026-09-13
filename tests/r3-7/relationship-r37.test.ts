import { describe, test, expect } from "bun:test";
import {
  computeRelationshipForEntry,
  computeTargetView,
  entryResultingState,
  relationshipBadge,
  canonicalStateBadge,
  type StagedEntryLike,
  type AppliedEventLike,
} from "@/lib/canonical-relationship";

/**
 * R3-7 — pure relationship semantics: conflicting intent is EXPLICIT,
 * staleness is EXPLICIT, and every R3-6 kind is preserved unchanged.
 */

function entry(partial: Partial<StagedEntryLike> & { seq: number }): StagedEntryLike {
  return {
    ts: "2026-09-14T10:00:00.000Z",
    action: "VALIDATE",
    targetType: "question_version",
    targetId: "11111111-1111-1111-1111-111111111111",
    targetLabel: "Q1 v2",
    reviewer: "Ada",
    note: "",
    hash: `hash-${partial.seq}`.padEnd(64, "0").slice(0, 64),
    ...partial,
  } as StagedEntryLike;
}

function applied(partial: Partial<AppliedEventLike> & { decisionSeq: number }): AppliedEventLike {
  return {
    decisionHash: `hash-${partial.decisionSeq}`.padEnd(64, "0").slice(0, 64),
    action: "VALIDATE",
    targetType: "question_version",
    targetId: "11111111-1111-1111-1111-111111111111",
    reviewer: "Ada",
    note: "",
    resultState: "VALIDATED",
    appliedAt: "2026-09-14T12:00:00.000Z",
    ...partial,
  } as AppliedEventLike;
}

describe("R3-6 semantics preserved (regression guard)", () => {
  test("staged VALIDATE vs SUGGESTED = WOULD_CHANGE, not applied", () => {
    const r = computeRelationshipForEntry(entry({ seq: 9 }), "SUGGESTED", [], []);
    expect(r.relationship).toBe("WOULD_CHANGE_CANONICAL");
    expect(r.stale).toBe(false);
  });

  test("staged VALIDATE vs VALIDATED = AGREES (no change proposed)", () => {
    const r = computeRelationshipForEntry(entry({ seq: 9 }), "VALIDATED", [], []);
    expect(r.relationship).toBe("AGREES_WITH_CANONICAL");
  });

  test("FLAG remains events-only", () => {
    const r = computeRelationshipForEntry(entry({ seq: 9, action: "FLAG" }), "SUGGESTED", [], []);
    expect(r.relationship).toBe("AGREES_WITH_CANONICAL");
    expect(r.eventsOnly).toBe(true);
  });

  test("applied match = ALREADY_APPLIED (by seq AND hash)", () => {
    const ev = applied({ decisionSeq: 9 });
    const r = computeRelationshipForEntry(entry({ seq: 9 }), "VALIDATED", [ev], []);
    expect(r.relationship).toBe("ALREADY_APPLIED");
    expect(r.appliedEvent).not.toBeNull();
  });

  test("same seq different hash never matches an applied event", () => {
    const ev = applied({ decisionSeq: 9, decisionHash: "different".padEnd(64, "x") });
    const r = computeRelationshipForEntry(entry({ seq: 9 }), "SUGGESTED", [ev], []);
    expect(r.relationship).toBe("WOULD_CHANGE_CANONICAL");
  });

  test("applied then reversed = APPLIED_THEN_REVERSED", () => {
    const ev = applied({ decisionSeq: 9 });
    const reversal = entry({ seq: 10, action: "REVERSE", note: "reverses seq 9 (VALIDATE)" });
    const revEv = applied({ decisionSeq: 10, action: "REVERSE", resultState: "SUGGESTED", appliedAt: "2026-09-14T13:00:00.000Z" });
    const r = computeRelationshipForEntry(entry({ seq: 9 }), "SUGGESTED", [ev, revEv], [entry({ seq: 9 }), reversal]);
    expect(r.relationship).toBe("APPLIED_THEN_REVERSED");
  });

  test("UNKNOWN canonical = BLOCKED, never inferred", () => {
    const r = computeRelationshipForEntry(entry({ seq: 9 }), "UNKNOWN", [], []);
    expect(r.relationship).toBe("BLOCKED");
  });

  test("seed lock semantics: canonical VALIDATED + zero events = seedLocked", () => {
    const view = computeTargetView("VALIDATED", [entry({ seq: 9 })], []);
    expect(view.seedLocked).toBe(true);
  });
});

describe("R3-7: conflicting intent is explicit, never merged", () => {
  test("open REJECT vs canonical VALIDATED = BLOCKED (importer would refuse)", () => {
    const r = computeRelationshipForEntry(entry({ seq: 9, action: "REJECT" }), "VALIDATED", [], []);
    expect(r.relationship).toBe("BLOCKED");
    expect(r.explanation).toContain("CONFLICT");
    expect(r.explanation).toContain("SUGGESTED");
    expect(r.stale).toBe(false);
  });

  test("open VALIDATE vs canonical REJECTED = BLOCKED", () => {
    const r = computeRelationshipForEntry(entry({ seq: 9, action: "VALIDATE" }), "REJECTED", [], []);
    expect(r.relationship).toBe("BLOCKED");
  });

  test("reviewer B's VALIDATE stays WOULD_CHANGE while reviewer A's REJECT is merely staged (no silent merge)", () => {
    // Two reviewers staged opposing intents on the same target; nothing applied yet.
    const a = entry({ seq: 1, action: "REJECT", reviewer: "Ada" });
    const b = entry({ seq: 2, action: "VALIDATE", reviewer: "Ben" });
    // B's VALIDATE after A's REJECT would be refused at staging by the
    // duplicate lock, so this scenario arises only from log replay/history —
    // the pure layer must still represent both without merging them.
    expect(a.action).not.toBe(b.action);
    const view = computeTargetView("SUGGESTED", [a, b], []);
    expect(view.entryRelationships[1].relationship).toBe("WOULD_CHANGE_CANONICAL");
    expect(view.entryRelationships[2].relationship).toBe("WOULD_CHANGE_CANONICAL");
  });

  test("after A's REJECT is applied, B's staged VALIDATE is BLOCKED + STALE with superseding attribution", () => {
    const a = entry({ seq: 1, action: "REJECT", reviewer: "Ada", ts: "2026-09-14T10:00:00.000Z" });
    const b = entry({ seq: 2, action: "VALIDATE", reviewer: "Ben", ts: "2026-09-14T10:30:00.000Z" });
    const ev = applied({
      decisionSeq: 1, action: "REJECT", resultState: "REJECTED", reviewer: "Ada",
      appliedAt: "2026-09-14T12:00:00.000Z", decisionHash: a.hash,
    });
    const r = computeRelationshipForEntry(b, "REJECTED", [ev], [a, b]);
    expect(r.relationship).toBe("BLOCKED");
    expect(r.stale).toBe(true);
    expect(r.supersededBy).toHaveLength(1);
    expect(r.supersededBy[0].decisionSeq).toBe(1);
    expect(r.explanation).toContain("STALE");
    expect(r.explanation).toContain("Ada");
  });

  test("stale flag requires the applied event to POSTDATE the staged intent", () => {
    const b = entry({ seq: 2, action: "VALIDATE", reviewer: "Ben", ts: "2026-09-14T10:30:00.000Z" });
    // An event applied BEFORE B staged (e.g. an earlier decision on the same
    // target by someone else) still blocks via canonical state, but is not
    // reported as "superseded" — B staged with full knowledge of it.
    const ev = applied({
      decisionSeq: 1, action: "REJECT", resultState: "REJECTED", reviewer: "Ada",
      appliedAt: "2026-09-14T09:00:00.000Z",
    });
    const r = computeRelationshipForEntry(b, "REJECTED", [ev], [b]);
    expect(r.relationship).toBe("BLOCKED");
    expect(r.stale).toBe(false);
    expect(r.supersededBy).toHaveLength(0);
  });

  test("own applied event never marks the entry stale", () => {
    const a = entry({ seq: 1, action: "REJECT", reviewer: "Ada", ts: "2026-09-14T10:00:00.000Z" });
    const ev = applied({ decisionSeq: 1, decisionHash: a.hash, action: "REJECT", resultState: "REJECTED", appliedAt: "2026-09-14T12:00:00.000Z" });
    const r = computeRelationshipForEntry(a, "REJECTED", [ev], [a]);
    expect(r.relationship).toBe("ALREADY_APPLIED");
    expect(r.stale).toBe(false);
  });

  test("BLOCKED open intents are excluded from openStagedEntries", () => {
    const a = entry({ seq: 1, action: "REJECT", reviewer: "Ada" });
    const view = computeTargetView("VALIDATED", [a], []);
    expect(view.entryRelationships[1].relationship).toBe("BLOCKED");
    expect(view.openStagedEntries).toHaveLength(0);
  });
});

describe("R3-7 badges and resulting-state map stay total", () => {
  test("every relationship kind has a distinct badge", () => {
    const kinds = ["AGREES_WITH_CANONICAL", "WOULD_CHANGE_CANONICAL", "ALREADY_APPLIED", "APPLIED_THEN_REVERSED", "BLOCKED"] as const;
    const labels = kinds.map((k) => relationshipBadge(k).label);
    expect(new Set(labels).size).toBe(5);
  });

  test("canonical badges stay authoritative for all real states", () => {
    expect(canonicalStateBadge("VALIDATED").authoritative).toBe(true);
    expect(canonicalStateBadge("REJECTED").authoritative).toBe(true);
    expect(canonicalStateBadge("SUGGESTED").authoritative).toBe(true);
    expect(canonicalStateBadge("UNKNOWN").authoritative).toBe(false);
  });

  test("entryResultingState: FLAG events-only, REVERSE restores SUGGESTED", () => {
    expect(entryResultingState(entry({ seq: 1, action: "FLAG" }))).toBeNull();
    expect(entryResultingState(entry({ seq: 1, action: "REVERSE" }))).toBe("SUGGESTED");
    expect(entryResultingState(entry({ seq: 1, action: "VALIDATE" }))).toBe("VALIDATED");
    expect(entryResultingState(entry({ seq: 1, action: "REJECT" }))).toBe("REJECTED");
  });
});

import { describe, test, expect } from "bun:test";
import {
  computeRelationshipForEntry, computeTargetView, canonicalStateBadge, relationshipBadge,
  entryResultingState, parseReverseSeq,
  type StagedEntryLike, type AppliedEventLike,
} from "@/lib/canonical-relationship";

const G = "0".repeat(64);
function staged(action: StagedEntryLike["action"], seq: number, over: Partial<StagedEntryLike> = {}): StagedEntryLike {
  return {
    seq, ts: "2026-09-13T18:00:00.000Z", action, targetType: "question_version",
    targetId: "11111111-1111-1111-1111-111111111111", targetLabel: "q01 · v1",
    reviewer: "Teacher A", note: "", hash: `hash-${seq}`.padEnd(64, "0"),
    ...over,
  };
}
function applied(action: AppliedEventLike["action"], seq: number, over: Partial<AppliedEventLike> = {}): AppliedEventLike {
  return {
    decisionSeq: seq, decisionHash: `hash-${seq}`.padEnd(64, "0"), action,
    targetType: "question_version", targetId: "11111111-1111-1111-1111-111111111111",
    reviewer: "Teacher A", note: "", resultState: action === "VALIDATE" ? "VALIDATED" : action === "REJECT" ? "REJECTED" : "SUGGESTED",
    appliedAt: "2026-09-13T18:05:00.000Z",
    ...over,
  };
}

describe("canonical state rendering (gates 1, 2)", () => {
  test("canonical VALIDATED renders as authoritative canonical VALIDATED", () => {
    const b = canonicalStateBadge("VALIDATED");
    expect(b.label).toBe("CANONICAL VALIDATED");
    expect(b.tone).toBe("emerald");
    expect(b.authoritative).toBe(true);
  });

  test("canonical REJECTED renders as authoritative canonical REJECTED", () => {
    const b = canonicalStateBadge("REJECTED");
    expect(b.label).toBe("CANONICAL REJECTED");
    expect(b.tone).toBe("rose");
    expect(b.authoritative).toBe(true);
  });

  test("canonical SUGGESTED renders as canonical (not as staged)", () => {
    const b = canonicalStateBadge("SUGGESTED");
    expect(b.label).toBe("CANONICAL SUGGESTED");
    expect(b.authoritative).toBe(true);
  });
});

describe("staged intent vs canonical (gates 3, 4, 5)", () => {
  test("staged VALIDATE against SUGGESTED = WOULD_CHANGE, explicitly NOT applied", () => {
    const r = computeRelationshipForEntry(staged("VALIDATE", 9), "SUGGESTED", [], []);
    expect(r.relationship).toBe("WOULD_CHANGE_CANONICAL");
    expect(r.appliedEvent).toBeNull();
    expect(r.explanation).toContain("NOT YET APPLIED");
    expect(r.explanation).toContain("SUGGESTED");
    expect(r.explanation).toContain("VALIDATED");
  });

  test("staged REJECT against SUGGESTED = WOULD_CHANGE, canonical unchanged", () => {
    const r = computeRelationshipForEntry(staged("REJECT", 9, { note: "wrong answer key" }), "SUGGESTED", [], []);
    expect(r.relationship).toBe("WOULD_CHANGE_CANONICAL");
    expect(r.explanation).toContain("REJECTED");
  });

  test("FLAG is events-only: it never produces a canonical state", () => {
    expect(entryResultingState(staged("FLAG", 9))).toBeNull();
    const r = computeRelationshipForEntry(staged("FLAG", 9, { note: "figure unclear" }), "SUGGESTED", [], []);
    expect(r.eventsOnly).toBe(true);
    expect(r.relationship).toBe("AGREES_WITH_CANONICAL");
    expect(r.explanation).toContain("events-only");
    // FLAG applied must not manufacture canonical state
    const ev = applied("FLAG", 9, { resultState: "SUGGESTED" });
    expect(ev.resultState).toBe("SUGGESTED");
  });

  test("staged VALIDATE against VALIDATED = AGREES (no canonical change proposed)", () => {
    const r = computeRelationshipForEntry(staged("VALIDATE", 9), "VALIDATED", [], []);
    expect(r.relationship).toBe("AGREES_WITH_CANONICAL");
    expect(r.explanation).toContain("already VALIDATED");
  });

  test("staged intent is never canonical merely because it exists in the log", () => {
    const view = computeTargetView("SUGGESTED", [staged("VALIDATE", 9)], []);
    // canonical dimension unchanged...
    expect(view.canonicalState).toBe("SUGGESTED");
    // ...and the entry is reported as open staged intent, not applied
    expect(view.entryRelationships[9].relationship).toBe("WOULD_CHANGE_CANONICAL");
    expect(view.appliedEvents).toHaveLength(0);
  });
});

describe("applied vs staged (gate 6)", () => {
  test("a staged entry with a matching applied event = ALREADY_APPLIED, not pending", () => {
    const e = staged("VALIDATE", 9);
    const r = computeRelationshipForEntry(e, "VALIDATED", [applied("VALIDATE", 9)], [e]);
    expect(r.relationship).toBe("ALREADY_APPLIED");
    expect(r.appliedEvent?.decisionSeq).toBe(9);
    expect(r.explanation).toContain("ALREADY BEEN APPLIED");
  });

  test("matching is by BOTH seq and chain hash — same seq with different hash never matches", () => {
    const e = staged("VALIDATE", 9);
    const forged = applied("VALIDATE", 9, { decisionHash: `hash-99`.padEnd(64, "0") });
    const r = computeRelationshipForEntry(e, "SUGGESTED", [forged], [e]);
    expect(r.relationship).toBe("WOULD_CHANGE_CANONICAL");
  });
});

describe("reversal semantics per R3-5 events (gate 7)", () => {
  test("applied intent + applied REVERSE = APPLIED_THEN_REVERSED, canonical back to SUGGESTED", () => {
    const e = staged("VALIDATE", 1);
    const rev = staged("REVERSE", 4, { note: "reverses seq 1 (VALIDATE)", targetId: e.targetId });
    const events = [
      applied("VALIDATE", 1, { resultState: "VALIDATED" }),
      applied("REVERSE", 4, { note: "reverses seq 1 (VALIDATE)", resultState: "SUGGESTED" }),
    ];
    const r = computeRelationshipForEntry(e, "SUGGESTED", events, [e, rev]);
    expect(r.relationship).toBe("APPLIED_THEN_REVERSED");
    expect(r.explanation).toContain("back to SUGGESTED");
  });

  test("applied intent without reversal stays ALREADY_APPLIED even when a staged REVERSE exists unapplied", () => {
    const e = staged("VALIDATE", 1);
    const rev = staged("REVERSE", 4, { note: "reverses seq 1 (VALIDATE)" });
    const r = computeRelationshipForEntry(e, "VALIDATED", [applied("VALIDATE", 1)], [e, rev]);
    expect(r.relationship).toBe("ALREADY_APPLIED");
    // ...and the staged-but-unapplied REVERSE is itself a pending change
    const rr = computeRelationshipForEntry(rev, "VALIDATED", [applied("VALIDATE", 1)], [e, rev]);
    expect(rr.relationship).toBe("WOULD_CHANGE_CANONICAL");
    expect(rr.explanation).toContain("NOT YET APPLIED");
  });

  test("applied REVERSE entry reports its reversal as ALREADY_APPLIED", () => {
    const rev = staged("REVERSE", 4, { note: "reverses seq 1 (VALIDATE)" });
    const r = computeRelationshipForEntry(rev, "SUGGESTED", [applied("REVERSE", 4, { note: "reverses seq 1 (VALIDATE)" })], [rev]);
    expect(r.relationship).toBe("ALREADY_APPLIED");
    expect(r.explanation).toContain("Reversal of seq 1");
  });

  test("parseReverseSeq extracts the R3-5 note format", () => {
    expect(parseReverseSeq("reverses seq 12 (REJECT) — reason")).toBe(12);
    expect(parseReverseSeq("no marker")).toBeNull();
  });
});

describe("fail-safe behavior (gate 8)", () => {
  test("UNKNOWN canonical state = BLOCKED, never inferred", () => {
    const r = computeRelationshipForEntry(staged("VALIDATE", 9), "UNKNOWN", [], []);
    expect(r.relationship).toBe("BLOCKED");
    expect(r.explanation).toContain("blocked");
  });
});

describe("target view (seed lock + dimensions kept separate)", () => {
  test("seed-VALIDATED target (canonical VALIDATED, zero events) is seed-locked", () => {
    const v = computeTargetView("VALIDATED", [], []);
    expect(v.seedLocked).toBe(true);
  });
  test("post-apply VALIDATED target with applied events is NOT seed-locked", () => {
    const e = staged("VALIDATE", 9);
    const v = computeTargetView("VALIDATED", [e], [applied("VALIDATE", 9)]);
    expect(v.seedLocked).toBe(false);
    expect(v.entryRelationships[9].relationship).toBe("ALREADY_APPLIED");
  });
  test("relationship badges carry distinct labels (no collapsed status)", () => {
    const labels = new Set(
      (["AGREES_WITH_CANONICAL", "WOULD_CHANGE_CANONICAL", "ALREADY_APPLIED", "APPLIED_THEN_REVERSED", "BLOCKED"] as const)
        .map((r) => relationshipBadge(r).label)
    );
    expect(labels.size).toBe(5);
    expect(relationshipBadge("WOULD_CHANGE_CANONICAL").label).toContain("staged only");
  });
});

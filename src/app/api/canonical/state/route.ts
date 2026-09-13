import { NextResponse } from "next/server";
import { getCanonicalStates, isCanonicalTargetType, StateRequest } from "@/lib/canonical";

/**
 * R3-6 live canonical state: validation_state per requested target, straight
 * from the canonical DB (authoritative), plus lastAppliedEvent. Unknown or
 * malformed ids -> state "UNKNOWN" (fail-safe; never an error, never inferred).
 * READ-ONLY (connection-level default_transaction_read_only).
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const rawTargets = Array.isArray(body.targets) ? body.targets : [];
  const targets: StateRequest[] = [];
  for (const t of rawTargets.slice(0, 300)) {
    const tt = (t as Record<string, unknown>)?.type;
    const id = String((t as Record<string, unknown>)?.id || "");
    if (typeof tt === "string" && isCanonicalTargetType(tt)) {
      targets.push({ type: tt, id });
    } else {
      // Unknown type: preserve the fail-safe UNKNOWN contract by key.
      targets.push({ type: "exam_paper", id: `__invalid__${id}` });
    }
  }
  const res = await getCanonicalStates(targets);
  if (!res.available) {
    return NextResponse.json(
      { available: false, checkedAt: res.checkedAt, states: {}, error: res.error },
      { status: 200 }
    );
  }
  return NextResponse.json(res);
}

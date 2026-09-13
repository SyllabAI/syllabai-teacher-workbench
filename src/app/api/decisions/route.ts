import { NextResponse } from "next/server";
import { getStageState, appendDecision, DecisionAction, TargetType } from "@/lib/decision-log";
import { getLifecycleRegistry } from "@/lib/review-data";

function paperCounts(effective: Record<string, string>) {
  const reg = getLifecycleRegistry();
  const out: Record<string, { validated: number; rejected: number; flagged: number }> = {};
  for (const [targetId, dec] of Object.entries(effective)) {
    const t = reg.get(targetId);
    if (!t?.paperId) continue;
    const bucket = (out[t.paperId] ||= { validated: 0, rejected: 0, flagged: 0 });
    if (dec === "VALIDATED") bucket.validated++;
    else if (dec === "REJECTED") bucket.rejected++;
    else if (dec === "FLAGGED") bucket.flagged++;
  }
  return out;
}

export async function GET() {
  const state = getStageState();
  return NextResponse.json({
    entries: state.entries,
    chainValid: state.chainValid,
    head: state.head,
    staged: state.staged,
    effective: state.effective,
    paperCounts: paperCounts(state.effective),
  });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const result = appendDecision({
    action: body.action as DecisionAction,
    targetType: body.targetType as TargetType,
    targetId: String(body.targetId || ""),
    reviewer: String(body.reviewer || ""),
    note: body.note === undefined || body.note === null ? "" : String(body.note),
    reverseSeq: body.reverseSeq === undefined ? undefined : Number(body.reverseSeq),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }
  const state = getStageState();
  return NextResponse.json({
    entry: result.entry,
    chainValid: state.chainValid,
    staged: state.staged,
    effective: state.effective,
    paperCounts: paperCounts(state.effective),
  });
}

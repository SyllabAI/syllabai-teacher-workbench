import { NextResponse } from "next/server";
import { getStageState, appendDecision, DecisionAction, TargetType } from "@/lib/decision-log";
import { getLifecycleRegistry } from "@/lib/review-data";
import { sessionFromRequest } from "@/lib/session";
import { revalidateSessionReviewer } from "@/lib/reviewers";
import { getCanonicalStates, getAppliedEvents, isCanonicalTargetType, type AppliedEvent } from "@/lib/canonical";
import { isReadOnlyDeployment } from "@/lib/prod-config";

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

/** CSRF hardening (R3-7): JSON bodies only; Origin (when a browser sends it) must match Host. */
function csrfGuard(req: Request): { ok: true } | { ok: false; status: number; error: string } {
  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().includes("application/json")) {
    return { ok: false, status: 415, error: "Content-Type must be application/json" };
  }
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== (req.headers.get("host") || "")) {
        return { ok: false, status: 403, error: "cross-origin staging requests are refused" };
      }
    } catch {
      return { ok: false, status: 403, error: "malformed Origin header refused" };
    }
  }
  return { ok: true };
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
  // Readonly deployment (Vercel mirror): the decision log is served read-only;
  // staging writes are refused BEFORE auth with an explicit reason.
  if (isReadOnlyDeployment()) {
    return NextResponse.json(
      { error: "readonly deployment — staging is disabled here; stage decisions on the primary workbench host" },
      { status: 503 });
  }
  // R3-6 authorization gate: staging writes require a verified teacher
  // session. R3-7: that session must bind a PROVISIONED reviewer who is
  // STILL active in the registry (revalidated on every write), and the
  // live canonical DB must confirm the target's lifecycle state.
  // This privilege stages intent ONLY — it can never mutate canonical
  // validation state (the gated importer's exclusive power, server-side,
  // behind identity preflight).
  const guard = csrfGuard(req);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const session = sessionFromRequest(req);
  if (!session) {
    return NextResponse.json(
      { error: "staging requires a teacher session — open one first (POST /api/session with a provisioned reviewer token)" },
      { status: 403 }
    );
  }
  const revalidated = revalidateSessionReviewer({ reviewerId: session.reviewerId, epoch: session.epoch });
  if (!revalidated.ok) {
    return NextResponse.json({ error: revalidated.error }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = body.action as DecisionAction;
  const targetType = body.targetType as TargetType;

  // R3-7 live canonical gate inputs (mirror of the importer's gates; the
  // importer remains the only authority). Fail-closed: if the live DB cannot
  // be consulted, staging is refused rather than guessed.
  let liveGate: { liveState: string | null; priorApplied?: boolean; priorIsLastEvent?: boolean } | undefined;
  // REVERSE carries no targetType of its own — the target comes from the
  // referenced prior staged entry.
  const effectiveType: TargetType | undefined =
    action === "REVERSE"
      ? (() => {
          const prior = getStageState().entries.find((e) => e.seq === Number(body.reverseSeq));
          return (prior?.targetType as TargetType | undefined) ?? undefined;
        })()
      : targetType;
  if (isCanonicalTargetType(effectiveType)) {
    const targetId = action === "REVERSE"
      ? (getStageState().entries.find((e) => e.seq === Number(body.reverseSeq))?.targetId ?? String(body.targetId || ""))
      : String(body.targetId || "");
    const [states, events] = await Promise.all([
      getCanonicalStates([{ type: effectiveType, id: targetId }]),
      getAppliedEvents(2000),
    ]);
    const status = states.available ? states.states[`${effectiveType}:${targetId}`] : undefined;
    const liveState = status ? (status.state === "UNKNOWN" ? null : status.state) : null;
    liveGate = { liveState };
    if (action === "REVERSE") {
      const allEvents: AppliedEvent[] = events.available ? events.events : [];
      const targetEvents = allEvents.filter((e) => e.targetType === effectiveType && e.targetId === targetId);
      const last = targetEvents.length ? targetEvents[targetEvents.length - 1] : null;
      const reverseSeq = body.reverseSeq === undefined ? NaN : Number(body.reverseSeq);
      const prior = getStageState().entries.find((e) => e.seq === reverseSeq);
      const priorApplied = !!prior && targetEvents.some(
        (e) => e.decisionSeq === prior.seq && e.decisionHash === prior.hash
      );
      const priorIsLastEvent = !!prior && !!last && priorApplied &&
        last.decisionSeq === prior.seq && last.decisionHash === prior.hash;
      liveGate.priorApplied = priorApplied;
      liveGate.priorIsLastEvent = priorIsLastEvent;
    }
  }

  const result = appendDecision({
    action,
    targetType,
    targetId: String(body.targetId || ""),
    // Attribution: the session identity is authoritative for the staging log;
    // a client-supplied reviewer name cannot impersonate another session.
    // R3-7: the stable provisioned reviewerId rides outside the entry hash.
    reviewer: session.name,
    reviewerId: session.reviewerId,
    note: body.note === undefined || body.note === null ? "" : String(body.note),
    reverseSeq: body.reverseSeq === undefined ? undefined : Number(body.reverseSeq),
    liveGate,
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

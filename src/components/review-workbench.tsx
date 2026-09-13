"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle, CheckCircle2, ClipboardList, Database, Download, FileText, Flag,
  Lock, ScrollText, Search, ShieldCheck, Undo2, XCircle, RefreshCw, LogIn, LogOut,
} from "lucide-react";
import type { ReviewIndex, SessionDossier } from "@/lib/review-data";
import {
  canonicalStateBadge, relationshipBadge, computeRelationshipForEntry, parseReverseSeq,
  type AppliedEventLike, type StagedEntryLike, type CanonicalState, type Relationship,
} from "@/lib/canonical-relationship";

type Effective = Record<string, "VALIDATED" | "REJECTED" | "FLAGGED">;
type PaperCounts = Record<string, { validated: number; rejected: number; flagged: number }>;

interface DecisionEntry {
  seq: number; ts: string; action: string; targetType: string;
  targetId: string; targetLabel: string; reviewer: string; note: string; hash: string;
}

interface DecisionsState {
  entries: DecisionEntry[];
  chainValid: boolean;
  staged: { validated: number; rejected: number; flagged: number; reversed: number };
  effective: Effective;
  paperCounts: PaperCounts;
}

/** Applied event as served by GET /api/canonical/events (read-only canonical feed). */
interface CanonicalEvent extends AppliedEventLike {
  id: number;
  importerRunId: string;
  targetLabel: string;
}

/** Live canonical status as served by POST /api/canonical/state. */
type CanonicalStatusMap = Record<string, { state: string; appliedCount: number; lastEvent: CanonicalEvent | null }>;

const TARGET_VERSION = "question_version" as const;
const TARGET_SCHEME = "mark_scheme" as const;
const TARGET_PAPER = "exam_paper" as const;

const REL_BADGE: Record<Relationship, { cls: string }> = {
  AGREES_WITH_CANONICAL: { cls: "bg-sky-100 text-sky-900 hover:bg-sky-100" },
  WOULD_CHANGE_CANONICAL: { cls: "bg-amber-200 text-amber-950 hover:bg-amber-200" },
  ALREADY_APPLIED: { cls: "bg-violet-200 text-violet-950 hover:bg-violet-200" },
  APPLIED_THEN_REVERSED: { cls: "bg-emerald-100 text-emerald-900 hover:bg-emerald-100" },
  BLOCKED: { cls: "bg-rose-100 text-rose-900 hover:bg-rose-100" },
};

const CANON_BADGE: Record<string, string> = {
  VALIDATED: "bg-emerald-700 text-white hover:bg-emerald-700",
  REJECTED: "bg-rose-700 text-white hover:bg-rose-700",
  SUGGESTED: "bg-stone-200 text-stone-800 hover:bg-stone-200",
  UNKNOWN: "bg-amber-200 text-amber-950 hover:bg-amber-200",
};

function bridgeBadge(status: string) {
  if (status === "OK") return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">bridge OK</Badge>;
  if (status === "REVIEW_REQUIRED") return <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">review required</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function fmtTime(ts: string) {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function shortHash(h: string) { return (h || "").slice(0, 10); }

/**
 * R3-6 TargetStatePanel — the load-bearing UI element that makes
 * "what I am proposing" ≠ "what the system currently believes" visible.
 * Three SEPARATE dimensions (canonical / staged / applied) + a derived
 * relationship line. Never a single collapsed status field.
 */
function TargetStatePanel({
  type, id, canonicalState, stateSource, stagedEntries, appliedEvents, chainEntries, compact,
}: {
  type: string; id: string | null | undefined;
  canonicalState: CanonicalState;           // live if available, else dataset snapshot
  stateSource: "LIVE_CANONICAL" | "SNAPSHOT";
  stagedEntries: StagedEntryLike[];         // all staged entries for this target
  appliedEvents: AppliedEventLike[];        // applied events for this target (canonical feed)
  chainEntries: StagedEntryLike[];          // full log (needed for reversal linkage)
  compact?: boolean;
}) {
  if (!id) return null;
  const canonBadge = canonicalStateBadge(canonicalState);
  const lastApplied = appliedEvents.length
    ? appliedEvents.reduce((a, b) => (a.appliedAt > b.appliedAt ? a : b))
    : null;
  // EVERY staged intent for this target gets an explicit relationship row —
  // open intents AND closed ones (already applied / applied then reversed).
  const intentRows = stagedEntries.map((e) => ({ entry: e, rel: computeRelationshipForEntry(e, canonicalState, appliedEvents, chainEntries) }));

  return (
    <div className={`rounded-md border bg-white ${compact ? "text-[10px]" : "text-[11px]"}`}>
      {/* CANONICAL row — authoritative */}
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1 border-b bg-stone-50 rounded-t-md">
        <Database className="h-3 w-3 text-stone-400 shrink-0" />
        <span className="font-semibold text-stone-500 uppercase tracking-wide">canonical</span>
        <Badge className={`${CANON_BADGE[canonicalState] || CANON_BADGE.UNKNOWN} text-[10px]`}>{canonBadge.label}</Badge>
        {stateSource === "LIVE_CANONICAL"
          ? <Badge variant="outline" className="text-[9px] text-emerald-700 border-emerald-300">live DB</Badge>
          : <Badge variant="outline" className="text-[9px] text-amber-700 border-amber-300">snapshot — feed unavailable</Badge>}
        <span className="font-mono text-[9px] text-stone-400">{type}:{id.slice(0, 8)}</span>
        {lastApplied && (
          <span className="text-stone-500">
            last applied: <b>{lastApplied.action}</b> → {lastApplied.resultState} · by {lastApplied.reviewer} · {fmtTime(lastApplied.appliedAt)}
          </span>
        )}
      </div>
      {/* STAGED rows — proposed intent, one row per staged entry with its relationship */}
      {intentRows.map(({ entry: e, rel }) => {
        const applied = rel.relationship === "ALREADY_APPLIED" || rel.relationship === "APPLIED_THEN_REVERSED";
        const rb = relationshipBadge(rel.relationship);
        return (
          <div key={`stg-${e.seq}`} className="px-2 py-1 border-b flex flex-wrap items-center gap-1.5">
            <Undo2 className={`h-3 w-3 shrink-0 ${applied ? "text-violet-500" : "text-amber-600"} rotate-90`} />
            <span className="font-semibold text-stone-500 uppercase tracking-wide">staged</span>
            <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-800">{e.action}</Badge>
            {rel.relationship === "APPLIED_THEN_REVERSED" ? (
              <Badge className="bg-emerald-100 text-emerald-900 hover:bg-emerald-100 text-[9px]">APPLIED, THEN REVERSED</Badge>
            ) : applied ? (
              <Badge className="bg-violet-200 text-violet-950 hover:bg-violet-200 text-[9px]">
                {e.action === "REVERSE" ? "REVERSAL APPLIED" : "APPLIED — IN CANONICAL STATE"}
              </Badge>
            ) : (
              <Badge className="bg-amber-100 text-amber-950 hover:bg-amber-100 text-[9px] font-mono">STAGED — NOT YET APPLIED</Badge>
            )}
            <span className="text-stone-500">by {e.reviewer} · {fmtTime(e.ts)} · log #{e.seq} h{shortHash(e.hash)}</span>
            <span className="w-full flex items-center gap-1.5">
              <Badge className={`${REL_BADGE[rel.relationship].cls} text-[9px]`}>{rb.label}</Badge>
              {!compact && <span className="text-stone-500">{rel.explanation}</span>}
            </span>
          </div>
        );
      })}
      {/* APPLIED rows — committed events with attribution */}
      {appliedEvents.map((ev) => {
        const isReverse = ev.action === "REVERSE";
        const rel: Relationship = isReverse ? "APPLIED_THEN_REVERSED" : "ALREADY_APPLIED";
        const rb = relationshipBadge(rel);
        const origSeq = isReverse ? parseReverseSeq(ev.note) : null;
        return (
          <div key={`app-${ev.decisionSeq}-${ev.decisionHash.slice(0, 10)}`} className="px-2 py-1 border-b last:border-b-0 last:rounded-b-md flex flex-wrap items-center gap-1.5">
            <ShieldCheck className="h-3 w-3 text-violet-600 shrink-0" />
            <span className="font-semibold text-stone-500 uppercase tracking-wide">applied</span>
            <Badge className="bg-violet-100 text-violet-900 hover:bg-violet-100 text-[10px]">{ev.action}</Badge>
            <span className="text-stone-600">
              → result <b>{ev.resultState}</b> · by {ev.reviewer} · {fmtTime(ev.appliedAt)} · event(log #{ev.decisionSeq}, h{shortHash(ev.decisionHash)})
            </span>
            {isReverse && origSeq !== null && (
              <Badge variant="outline" className="text-[9px] text-emerald-700 border-emerald-300">reverses staged seq {origSeq}</Badge>
            )}
            {!isReverse && ev.action !== "FLAG" && (
              <Badge className={`${REL_BADGE.APPLIED_THEN_REVERSED.cls} text-[9px]`}>{rb.label === "already applied" ? "in canonical state" : rb.label}</Badge>
            )}
            {ev.action === "FLAG" && (
              <Badge variant="outline" className="text-[9px] text-amber-700 border-amber-300">events-only — no canonical state change</Badge>
            )}
            {ev.note && !compact && <span className="w-full text-stone-500">note: {ev.note}</span>}
          </div>
        );
      })}
      {stagedEntries.length === 0 && appliedEvents.length === 0 && (
        <div className="px-2 py-1 text-stone-400">no staged intent · no applied events for this target</div>
      )}
    </div>
  );
}

export default function ReviewWorkbench() {
  const { toast } = useToast();
  const [index, setIndex] = useState<ReviewIndex | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dossier, setDossier] = useState<SessionDossier | null>(null);
  const [decisions, setDecisions] = useState<DecisionsState | null>(null);
  const [reviewer, setReviewer] = useState("");
  const [search, setSearch] = useState("");
  const [onlyReview, setOnlyReview] = useState(false);
  // R3-6 canonical feed state
  const [events, setEvents] = useState<CanonicalEvent[] | null>(null);
  const [feedAvailable, setFeedAvailable] = useState<boolean | null>(null);
  const [canonStates, setCanonStates] = useState<CanonicalStatusMap>({});
  const [canonAvailable, setCanonAvailable] = useState<boolean | null>(null);
  // R3-6 teacher session
  const [session, setSession] = useState<{ name: string; expiresAt: string } | null>(null);
  const [dialog, setDialog] = useState<
    null
    | { kind: "REJECT" | "FLAG"; targetType: string; targetId: string; label: string; note: string }
  >(null);

  useEffect(() => {
    fetch("/api/review/index").then((r) => r.json()).then(setIndex).catch(() =>
      toast({ title: "failed to load review index", variant: "destructive" })
    );
  }, []);

  const refreshDecisions = useCallback(() => {
    fetch("/api/decisions").then((r) => r.json()).then(setDecisions).catch(() => {});
  }, []);

  const refreshEvents = useCallback(() => {
    fetch("/api/canonical/events")
      .then((r) => r.json())
      .then((d) => { setEvents(d.events || []); setFeedAvailable(!!d.available); })
      .catch(() => setFeedAvailable(false));
  }, []);

  useEffect(() => {
    refreshDecisions();
    refreshEvents();
    // session probe: a cheap GET that 403s tells us there is no session; we
    // simply start logged-out (cookie presence is verified server-side).
  }, [refreshDecisions, refreshEvents]);

  useEffect(() => {
    const saved = window.localStorage.getItem("tv-reviewer");
    if (saved) {
      const id = requestAnimationFrame(() => setReviewer(saved));
      return () => cancelAnimationFrame(id);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetch(`/api/review/session/${selectedId}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setDossier(d);
        // Load LIVE canonical states for every target in this dossier.
        const targets: Array<{ type: string; id: string }> = [{ type: "exam_paper", id: selectedId }];
        for (const q of d.questions || []) {
          if (q.versionId) targets.push({ type: "question_version", id: q.versionId });
          for (const s of q.schemes || []) targets.push({ type: "mark_scheme", id: s.id });
        }
        fetch("/api/canonical/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targets }),
        })
          .then((r) => r.json())
          .then((res) => {
            if (cancelled) return;
            setCanonAvailable(!!res.available);
            if (res.available) setCanonStates(res.states || {});
          })
          .catch(() => { if (!cancelled) setCanonAvailable(false); });
      })
      .catch(() => { if (!cancelled) toast({ title: "failed to load session", variant: "destructive" }); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const openSession = async () => {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: reviewer.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast({ title: "could not open session", description: data.error, variant: "destructive" });
      return;
    }
    setSession({ name: data.name, expiresAt: data.expiresAt });
    toast({ title: "teacher session open", description: "you can now stage validation intent (staging only — never applies)" });
  };

  const closeSession = async () => {
    await fetch("/api/session", { method: "DELETE" });
    setSession(null);
    toast({ title: "session closed" });
  };

  const requireSession = (): boolean => {
    if (!session) {
      toast({ title: "open a teacher session first", description: "enter your name and press 'open session' (top right)", variant: "destructive" });
      return false;
    }
    return true;
  };

  const stageDecision = useCallback(
    async (payload: Record<string, unknown>, okTitle: string) => {
      const res = await fetch("/api/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.status === 403) {
        setSession(null);
        toast({ title: "not authorized", description: data.error, variant: "destructive" });
        return false;
      }
      if (!res.ok) {
        toast({ title: "refused by lifecycle gate", description: data.error, variant: "destructive" });
        return false;
      }
      setDecisions((prev) => prev ? {
        ...prev,
        chainValid: data.chainValid,
        staged: data.staged,
        effective: data.effective,
        paperCounts: data.paperCounts,
        entries: [...prev.entries, data.entry],
      } : prev);
      toast({ title: okTitle, description: `seq ${data.entry.seq} appended to the hash-chained staging log — NOT applied to canonical state` });
      return true;
    },
    [toast]
  );

  const act = async (action: "VALIDATE" | "REJECT" | "FLAG", targetType: string, targetId: string, label: string) => {
    if (!requireSession()) return;
    if (action === "VALIDATE") {
      await stageDecision({ action, targetType, targetId }, "VALIDATE staged");
    } else {
      setDialog({ kind: action, targetType, targetId, label, note: "" });
    }
  };

  const reverse = async (seq: number) => {
    if (!requireSession()) return;
    await stageDecision({ action: "REVERSE", reverseSeq: seq }, "reversal staged");
  };

  const exportLog = async () => {
    const res = await fetch("/api/decisions/export");
    if (!res.ok) { toast({ title: "export failed", variant: "destructive" }); return; }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (res.headers.get("Content-Disposition") || "").match(/"(.+)"/)?.[1] || "decision-bundle.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast({ title: "evidence bundle exported", description: "a durable copy was also written into download/teacher-validation/" });
  };

  // ---- R3-6 selectors ------------------------------------------------------
  const chainEntries: StagedEntryLike[] = useMemo(
    () => (decisions?.entries || []).map((e) => ({
      seq: e.seq, ts: e.ts, action: e.action as StagedEntryLike["action"], targetType: e.targetType,
      targetId: e.targetId, targetLabel: e.targetLabel, reviewer: e.reviewer, note: e.note, hash: e.hash,
    })),
    [decisions]
  );

  const appliedEventsByTarget = useCallback((type: string, id: string | null | undefined): AppliedEventLike[] => {
    if (!id || !events) return [];
    return events
      .filter((e) => e.targetType === type && e.targetId === id)
      .map((e) => ({
        decisionSeq: e.decisionSeq, decisionHash: e.decisionHash, action: e.action,
        targetType: e.targetType, targetId: e.targetId, reviewer: e.reviewer,
        note: e.note, resultState: e.resultState, appliedAt: e.appliedAt,
      }));
  }, [events]);

  const stagedByTarget = useCallback((type: string, id: string | null | undefined): StagedEntryLike[] => {
    if (!id) return [];
    return chainEntries.filter((e) => e.targetType === type && e.targetId === id);
  }, [chainEntries]);

  /** Live canonical state when available; dataset snapshot otherwise (labeled). */
  const canonStateOf = useCallback((type: string, id: string | null | undefined, snapshot: string | null | undefined): CanonicalState => {
    if (id && canonAvailable && canonStates[`${type}:${id}`]) return canonStates[`${type}:${id}`].state;
    return (snapshot as CanonicalState) ?? "UNKNOWN";
  }, [canonAvailable, canonStates]);

  const stateSourceOf = useCallback((type: string, id: string | null | undefined): "LIVE_CANONICAL" | "SNAPSHOT" => {
    return id && canonAvailable && canonStates[`${type}:${id}`] ? "LIVE_CANONICAL" : "SNAPSHOT";
  }, [canonAvailable, canonStates]);

  const papers = useMemo(() => {
    if (!index) return [];
    const q = search.trim().toLowerCase();
    return index.papers.filter((p) =>
      (!onlyReview || p.bridgeStatus === "REVIEW_REQUIRED") &&
      (!q || `${p.paperCode} ${p.sessionLabel} ${p.title}`.toLowerCase().includes(q))
    );
  }, [index, search, onlyReview]);

  const openPaper = dossier?.paper;
  const dossierLoading = !!selectedId && dossier?.paper?.id !== selectedId;
  const dossierCurrent = !!selectedId && dossier?.paper?.id === selectedId;
  const pc = selectedId ? decisions?.paperCounts[selectedId] : undefined;
  /** Decidable = canonical state is SUGGESTED (live value when available). */
  const decidable = (canonical: CanonicalState) => canonical === "SUGGESTED";
  const paperCanon = dossierCurrent
    ? canonStateOf(TARGET_PAPER, selectedId, openPaper?.validationState)
    : "UNKNOWN";

  return (
    <div className="min-h-screen flex flex-col bg-stone-50">
      {/* header */}
      <header className="border-b bg-white">
        <div className="mx-auto max-w-7xl px-4 py-3 flex flex-wrap items-center gap-2">
          <ClipboardList className="h-5 w-5 text-emerald-700" />
          <h1 className="text-base font-semibold tracking-tight">SyllabAI · Teacher Validation Workbench</h1>
          <span className="text-xs text-stone-500">T-C04 · 81 imported sessions</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="font-mono text-[10px]">T-C04-CAMPAIGN @ syllabai</Badge>
            <Badge variant="outline" className="font-mono text-[10px]">core {index?.identity.coreCommit?.slice(0, 7) || "…"}</Badge>
            <Badge className="bg-stone-800 hover:bg-stone-800 text-[10px]">read model: DERIVED-FROM-CANONICAL</Badge>
            {feedAvailable === true && (
              <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 text-[10px] gap-1">
                <Database className="h-3 w-3" /> canonical feed LIVE · {events?.length ?? 0} applied events
              </Badge>
            )}
            {feedAvailable === false && (
              <Badge className="bg-amber-200 text-amber-950 hover:bg-amber-200 text-[10px] gap-1">
                <AlertTriangle className="h-3 w-3" /> canonical feed UNAVAILABLE — treat staged as NOT applied
              </Badge>
            )}
            {session ? (
              <>
                <Badge variant="outline" className="text-[10px] gap-1 text-emerald-800 border-emerald-400">
                  <LogIn className="h-3 w-3" /> {session.name} · teacher session
                </Badge>
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={closeSession}>
                  <LogOut className="h-3 w-3" /> close session
                </Button>
              </>
            ) : (
              <>
                <Input
                  value={reviewer}
                  onChange={(e) => { setReviewer(e.target.value); window.localStorage.setItem("tv-reviewer", e.target.value); }}
                  onKeyDown={(e) => { if (e.key === "Enter") openSession(); }}
                  placeholder="reviewer name"
                  className="h-7 w-36 text-xs"
                  aria-label="reviewer name"
                />
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={openSession} disabled={reviewer.trim().length < 2}>
                  <LogIn className="h-3 w-3" /> open session
                </Button>
              </>
            )}
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-xs">
                  Staging log {decisions ? `(${decisions.entries.length})` : ""}
                </Button>
              </SheetTrigger>
              <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2">
                    Staged decision log
                    {decisions?.chainValid
                      ? <Badge className="bg-emerald-600 hover:bg-emerald-600">chain valid</Badge>
                      : <Badge className="bg-rose-600 hover:bg-rose-600">CHAIN BROKEN</Badge>}
                  </SheetTitle>
                </SheetHeader>
                <div className="px-3 pb-6 text-xs">
                  <p className="text-stone-600 mb-3">
                    Append-only, hash-chained. <b>Staging only</b> — entries below become canonical
                    state exclusively via the gated importer; the workbench can never apply them.
                  </p>
                  <div className="flex gap-2 mb-3">
                    <Button size="sm" variant="outline" onClick={exportLog} className="gap-1">
                      <Download className="h-3.5 w-3.5" /> Export evidence bundle
                    </Button>
                  </div>
                  <Separator className="my-3" />
                  {decisions?.entries.length === 0 && <p className="text-stone-500">No staged decisions yet.</p>}
                  <div className="space-y-2">
                    {[...(decisions?.entries || [])].reverse().map((e) => {
                      // Applied/unapplied representation comes ONLY from the
                      // canonical events feed (matched by seq + chain hash).
                      const ev = feedAvailable
                        ? (events || []).find((x) => x.decisionSeq === e.seq && x.decisionHash === e.hash)
                        : undefined;
                      const reversedBy = chainEntries.find((r) => r.action === "REVERSE" && parseReverseSeq(r.note) === e.seq);
                      const reversalApplied = reversedBy && feedAvailable
                        ? (events || []).some((x) => x.decisionSeq === reversedBy.seq && x.decisionHash === reversedBy.hash)
                        : false;
                      return (
                        <div key={e.seq} className="rounded-md border p-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-[10px] text-stone-400">#{e.seq}</span>
                            <Badge variant="outline" className={
                              e.action === "VALIDATE" ? "text-emerald-700 border-emerald-300" :
                              e.action === "REJECT" ? "text-rose-700 border-rose-300" :
                              e.action === "FLAG" ? "text-amber-700 border-amber-300" : ""
                            }>{e.action}</Badge>
                            {e.action === "REVERSE" && parseReverseSeq(e.note) !== null && (
                              <Badge variant="outline" className="text-[9px]">reverses seq {parseReverseSeq(e.note)}</Badge>
                            )}
                            {ev && !reversalApplied && e.action !== "REVERSE" && (
                              <Badge className="bg-violet-200 text-violet-950 hover:bg-violet-200 text-[9px]">APPLIED — in canonical state</Badge>
                            )}
                            {ev && reversalApplied && (
                              <Badge className="bg-emerald-100 text-emerald-900 hover:bg-emerald-100 text-[9px]">APPLIED, THEN REVERSED</Badge>
                            )}
                            {ev && e.action === "REVERSE" && (
                              <Badge className="bg-violet-200 text-violet-950 hover:bg-violet-200 text-[9px]">REVERSAL APPLIED</Badge>
                            )}
                            {!ev && (
                              <Badge className="bg-amber-100 text-amber-950 hover:bg-amber-100 text-[9px] font-mono">STAGED — NOT YET APPLIED</Badge>
                            )}
                            {!feedAvailable && (
                              <Badge variant="outline" className="text-[9px] text-amber-700 border-amber-300">applied-state unknown — feed unavailable</Badge>
                            )}
                            <span className="text-[10px] text-stone-400">{e.targetType}</span>
                            <span className="ml-auto text-[10px] text-stone-400">{new Date(e.ts).toLocaleString()}</span>
                          </div>
                          <div className="mt-1 text-[11px] font-medium">{e.targetLabel}</div>
                          {e.note && <div className="text-[11px] text-stone-600">{e.note}</div>}
                          <div className="mt-1 flex items-center gap-2">
                            <span className="text-[10px] text-stone-400">by {e.reviewer}</span>
                            {e.action !== "REVERSE" && (
                              <button className="ml-auto text-[10px] text-stone-500 hover:text-rose-600 underline flex items-center gap-0.5"
                                onClick={() => reverse(e.seq)}>
                                <Undo2 className="h-3 w-3" /> reverse
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      {/* R3-6 boundary banner: proposing ≠ believing */}
      <div className="mx-auto w-full max-w-7xl px-4 pt-3 space-y-2">
        <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-950 flex gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-sky-700" />
          <div>
            <b>What I am proposing ≠ what the system currently believes.</b> Every target below shows three separate
            dimensions: <b>CANONICAL</b> (persisted in the canonical DB — authoritative), <b>STAGED</b> (your proposed
            intent — <span className="font-mono">STAGED — NOT YET APPLIED</span>, never canonical truth), and
            <b> APPLIED</b> events (committed by the gated importer, with attribution). Inspect the canonical state
            before staging a decision.
          </div>
        </div>
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <b>Quarantine intact:</b> {index?.quarantine.session ?? "1c-2016jan"} is absent from this dataset and must stay
            unresolved until original-source/operator review. Never auto-fixed, never inferred. — {index?.quarantine.rule}
          </div>
        </div>
        <p className="text-[11px] text-stone-500">
          {index?.label} · serving boundary: imported content is <b>SUGGESTED</b> until a teacher decision is APPLIED by
          the gated importer; this workbench has no canonical write path (read-only DB connection).
        </p>
      </div>

      {/* stats */}
      <div className="mx-auto w-full max-w-7xl px-4 py-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {[
          ["sessions", index?.stats.papers], ["questions", index?.stats.questions],
          ["versions", index?.stats.versions], ["parts", index?.stats.parts],
          ["schemes", index?.stats.schemes], ["mark points", index?.stats.points],
          ["review-required", index?.stats.reviewRequiredSessions], ["applied events", feedAvailable ? events?.length : "—"],
        ].map(([label, val]) => (
          <Card key={label as string} className="py-2">
            <CardContent className="px-3">
              <div className="text-lg font-semibold leading-tight">{val ?? "—"}</div>
              <div className="text-[11px] text-stone-500">{label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* main */}
      <main className="mx-auto w-full max-w-7xl px-4 pb-6 flex-1 grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* session list */}
        <Card className="self-start">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <ScrollText className="h-4 w-4" /> Sessions
              <span className="ml-auto flex gap-1">
                <Button variant={onlyReview ? "default" : "outline"} size="sm" className="h-6 text-[11px]"
                  onClick={() => setOnlyReview(!onlyReview)}>
                  review-required
                </Button>
              </span>
            </CardTitle>
            <div className="relative">
              <Search className="absolute left-2 top-2 h-4 w-4 text-stone-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="search code / session…" className="h-8 pl-7 text-xs" />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[calc(100vh-380px)] min-h-72">
              <div className="px-3 pb-3 space-y-1">
                {papers.map((p) => {
                  const counts = decisions?.paperCounts[p.id];
                  return (
                    <button key={p.id}
                      onClick={() => setSelectedId(p.id)}
                      className={`w-full text-left rounded-md border px-2.5 py-2 transition-colors hover:bg-stone-100 ${
                        selectedId === p.id ? "border-emerald-500 bg-emerald-50" : "border-transparent"
                      }`}>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold">{p.paperCode}</span>
                        <span className="text-xs text-stone-600">{p.sessionLabel}</span>
                        <span className="ml-auto">{bridgeBadge(p.bridgeStatus)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-stone-500">
                        <span>{p.questions} Q · {p.parts} parts · {p.points} pts</span>
                        {counts && (counts.validated + counts.rejected + counts.flagged > 0) && (
                          <span className="ml-auto">
                            <span className="text-emerald-700">{counts.validated}✓</span>{" "}
                            <span className="text-rose-700">{counts.rejected}✗</span>{" "}
                            <span className="text-amber-700">{counts.flagged}⚑</span>
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
                {papers.length === 0 && <p className="text-xs text-stone-500 p-2">no sessions match</p>}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* dossier */}
        <div className="min-w-0">
          {!selectedId && (
            <Card className="grid place-items-center min-h-72">
              <CardContent className="text-center text-sm text-stone-500 py-10">
                <FileText className="mx-auto h-8 w-8 mb-2 text-stone-300" />
                Select a session to review its imported content.
              </CardContent>
            </Card>
          )}
          {selectedId && dossierLoading && (
            <Card className="grid place-items-center min-h-72">
              <CardContent className="flex items-center gap-2 text-sm text-stone-500 py-10">
                <RefreshCw className="h-4 w-4 animate-spin" /> loading dossier…
              </CardContent>
            </Card>
          )}
          {selectedId && dossierCurrent && (
            <div className="space-y-3">
              {/* paper header */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex flex-wrap items-center gap-2">
                    <span className="font-mono">{openPaper?.paperCode}</span>
                    <span>{openPaper?.sessionLabel}</span>
                    {bridgeBadge(dossier.bridge?.status || "UNKNOWN")}
                  </CardTitle>
                  <div className="text-xs text-stone-500">
                    {openPaper?.title} · {openPaper?.board} · {openPaper?.qualification} ·
                    {" "}provenance {openPaper?.provenance} · bridge {openPaper?.bridge}
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {/* canonical-vs-staged panel for the PAPER target */}
                  <TargetStatePanel
                    type={TARGET_PAPER} id={selectedId}
                    canonicalState={paperCanon}
                    stateSource={stateSourceOf(TARGET_PAPER, selectedId)}
                    stagedEntries={stagedByTarget(TARGET_PAPER, selectedId)}
                    appliedEvents={appliedEventsByTarget(TARGET_PAPER, selectedId)}
                    chainEntries={chainEntries}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-stone-500 mr-1">session decision (stages intent only):</span>
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                      disabled={!decidable(paperCanon)}
                      onClick={() => act("VALIDATE", TARGET_PAPER, selectedId!, `${openPaper?.paperCode} ${openPaper?.sessionLabel}`)}>
                      <CheckCircle2 className="h-3.5 w-3.5" /> validate
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-rose-700 border-rose-300 hover:bg-rose-50"
                      disabled={!decidable(paperCanon)}
                      onClick={() => act("REJECT", TARGET_PAPER, selectedId!, `${openPaper?.paperCode} ${openPaper?.sessionLabel}`)}>
                      <XCircle className="h-3.5 w-3.5" /> reject
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-amber-700 border-amber-300 hover:bg-amber-50"
                      onClick={() => act("FLAG", TARGET_PAPER, selectedId!, `${openPaper?.paperCode} ${openPaper?.sessionLabel}`)}>
                      <Flag className="h-3.5 w-3.5" /> flag
                    </Button>
                    {pc && (
                      <span className="ml-auto text-[11px] text-stone-500">
                        staged here: <b className="text-emerald-700">{pc.validated}</b> validated ·{" "}
                        <b className="text-rose-700">{pc.rejected}</b> rejected · <b className="text-amber-700">{pc.flagged}</b> flagged
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Tabs defaultValue="questions">
                <TabsList>
                  <TabsTrigger value="questions">Questions ({dossier.questions.length})</TabsTrigger>
                  <TabsTrigger value="findings">Reconciliation ({dossier.bridge?.findings?.length || 0})</TabsTrigger>
                  <TabsTrigger value="qp">QP source</TabsTrigger>
                  <TabsTrigger value="ms">MS source</TabsTrigger>
                </TabsList>

                <TabsContent value="questions" className="space-y-3 mt-3">
                  {dossier.questions.map((q) => {
                    const label = `${q.externalRef} — ${q.prompt?.slice(0, 60) || ""}`;
                    const qCanon = canonStateOf(TARGET_VERSION, q.versionId, q.validationState);
                    return (
                      <Card key={q.id}>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs bg-stone-100 rounded px-1.5 py-0.5">{q.externalRef}</span>
                            <Badge variant="outline" className="text-[10px]">{q.type}</Badge>
                            {q.marks !== null && <Badge variant="outline" className="text-[10px]">{q.marks} marks</Badge>}
                            {q.commandWord && <Badge variant="outline" className="text-[10px]">{q.commandWord}</Badge>}
                            {q.topicNode && <span className="text-[10px] text-stone-400">{q.topicNode}</span>}
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                          <p className="whitespace-pre-wrap leading-relaxed">{q.prompt}</p>

                          {q.options.length > 0 && (
                            <div className="grid gap-1 sm:grid-cols-2">
                              {q.options.map((o) => (
                                <div key={o.label}
                                  className={`rounded border px-2 py-1 text-xs flex gap-2 ${String(o.isCorrect) === "true" ? "border-emerald-300 bg-emerald-50" : ""}`}>
                                  <b>{o.label}</b><span>{o.text}</span>
                                  {String(o.isCorrect) === "true" && <CheckCircle2 className="h-3.5 w-3.5 ml-auto text-emerald-600" />}
                                </div>
                              ))}
                            </div>
                          )}

                          {q.parts.length > 0 && (
                            <div className="rounded border divide-y">
                              {q.parts.map((p) => (
                                <div key={p.id} className="px-2 py-1.5 flex gap-2 text-xs">
                                  <b className="font-mono w-8 shrink-0">({p.label})</b>
                                  <span className="whitespace-pre-wrap">{p.text}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {q.schemes.map((s) => {
                            const sCanon = canonStateOf(TARGET_SCHEME, s.id, s.validationState);
                            return (
                            <div key={s.id} className="rounded border border-stone-200 bg-stone-50">
                              <div className="px-2 py-1.5 flex flex-wrap items-center gap-2 border-b bg-white rounded-t">
                                <span className="text-xs font-semibold">Mark scheme #{s.questionNumber}</span>
                                <TargetStatePanel
                                  type={TARGET_SCHEME} id={s.id}
                                  canonicalState={sCanon}
                                  stateSource={stateSourceOf(TARGET_SCHEME, s.id)}
                                  stagedEntries={stagedByTarget(TARGET_SCHEME, s.id)}
                                  appliedEvents={appliedEventsByTarget(TARGET_SCHEME, s.id)}
                                  chainEntries={chainEntries}
                                  compact
                                />
                              </div>
                              <div className="divide-y">
                                {s.points.map((m) => (
                                  <div key={m.id} className="px-2 py-1.5 flex gap-2 text-xs">
                                    <b className="font-mono w-12 shrink-0">{m.partLabel}</b>
                                    <span className="whitespace-pre-wrap">{m.text}</span>
                                    {m.marks !== null && m.marks !== "" && (
                                      <Badge variant="outline" className="ml-auto h-4 text-[10px] shrink-0">{m.marks}</Badge>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                            );
                          })}

                          {/* canonical-vs-staged panel for the QUESTION VERSION target */}
                          <TargetStatePanel
                            type={TARGET_VERSION} id={q.versionId}
                            canonicalState={qCanon}
                            stateSource={stateSourceOf(TARGET_VERSION, q.versionId)}
                            stagedEntries={stagedByTarget(TARGET_VERSION, q.versionId)}
                            appliedEvents={appliedEventsByTarget(TARGET_VERSION, q.versionId)}
                            chainEntries={chainEntries}
                          />

                          <div className="flex items-center gap-2 pt-1">
                            <span className="text-[11px] text-stone-500">question decision (stages intent only):</span>
                            <Button size="sm" variant="outline" className="h-6 text-[11px] gap-1 text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                              disabled={!decidable(qCanon)}
                              onClick={() => act("VALIDATE", TARGET_VERSION, q.versionId!, label)}>
                              <CheckCircle2 className="h-3 w-3" /> validate
                            </Button>
                            <Button size="sm" variant="outline" className="h-6 text-[11px] gap-1 text-rose-700 border-rose-300 hover:bg-rose-50"
                              disabled={!decidable(qCanon)}
                              onClick={() => act("REJECT", TARGET_VERSION, q.versionId!, label)}>
                              <XCircle className="h-3 w-3" /> reject
                            </Button>
                            <Button size="sm" variant="outline" className="h-6 text-[11px] gap-1 text-amber-700 border-amber-300 hover:bg-amber-50"
                              onClick={() => act("FLAG", TARGET_VERSION, q.versionId!, label)}>
                              <Flag className="h-3 w-3" /> flag
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </TabsContent>

                <TabsContent value="findings" className="mt-3">
                  <Card>
                    <CardContent className="pt-4">
                      {!dossier.bridge?.findings?.length && <p className="text-sm text-stone-500">No reconciliation findings recorded.</p>}
                      <div className="space-y-1.5">
                        {dossier.bridge?.findings?.map((f, i) => (
                          <div key={i} className="rounded border px-2 py-1.5 text-xs flex gap-2 items-start">
                            <Badge variant="outline" className={
                              f.severity === "qp-only" || f.severity === "ms-only" ? "text-amber-700 border-amber-300" : ""
                            }>{String(f.severity)}</Badge>
                            <span className="font-mono">{String(f.questionNumber)}</span>
                            <span>{String(f.detail)}</span>
                            <span className="ml-auto text-stone-400 shrink-0">
                              QP {String(f.qpMarks)} / MS {String(f.msMarks ?? "—")}
                            </span>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </TabsContent>

                {(["qp", "ms"] as const).map((which) => {
                  const src = which === "qp" ? dossier.questionPaper : dossier.markSchemePaper;
                  return (
                    <TabsContent key={which} value={which} className="mt-3">
                      <Card>
                        <CardHeader className="pb-1">
                          <CardTitle className="text-xs flex flex-wrap gap-2 items-center">
                            <span>{which === "qp" ? "Question paper (as ingested)" : "Mark scheme (as ingested)"}</span>
                            <Badge variant="outline" className="text-[10px]">{src?.engine} {src?.engineVersion}</Badge>
                            <span className="text-stone-400 font-normal">{src?.sourceUri}</span>
                            <span className="ml-auto text-stone-400 font-normal">sha-256 {String(src?.checksum || "").slice(0, 16)}…</span>
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <ScrollArea className="h-[60vh]">
                            <div className="space-y-2 pr-3">
                              {src?.chunks.map((c) => (
                                <div key={c.index} className="rounded border">
                                  <div className="px-2 py-1 bg-stone-100 text-[10px] font-mono text-stone-500">chunk {c.index}</div>
                                  <pre className="px-3 py-2 text-xs whitespace-pre-wrap font-mono leading-relaxed">{c.content}</pre>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        </CardContent>
                      </Card>
                    </TabsContent>
                  );
                })}
              </Tabs>
            </div>
          )}
        </div>
      </main>

      {/* decision note dialog */}
      {dialog && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true"
          onClick={() => setDialog(null)}>
          <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold mb-1">{dialog.kind === "REJECT" ? "Reject with reason" : "Flag for review"}</h3>
            <p className="text-xs text-stone-500 mb-2">{dialog.label}</p>
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">
              Staging only — this will NOT change the canonical state. It becomes canonical only after the gated importer applies it.
            </p>
            <Textarea value={dialog.note} onChange={(e) => setDialog({ ...dialog, note: e.target.value })}
              placeholder={dialog.kind === "REJECT" ? "reason (required, min 4 chars)…" : "what needs review? (required, min 4 chars)…"}
              className="mb-3 text-xs" rows={3} />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setDialog(null)}>cancel</Button>
              <Button size="sm"
                className={dialog.kind === "REJECT" ? "bg-rose-600 hover:bg-rose-600" : "bg-amber-500 hover:bg-amber-500"}
                onClick={async () => {
                  const d = dialog;
                  setDialog(null);
                  await stageDecision({ action: d.kind, targetType: d.targetType, targetId: d.targetId, note: d.note },
                    d.kind === "REJECT" ? "REJECT staged" : "FLAG staged");
                }}>
                stage {dialog.kind.toLowerCase()}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* sticky footer */}
      <footer className="mt-auto border-t bg-white">
        <div className="mx-auto max-w-7xl px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-stone-500">
          <span>Canonical DB <b>LIVE</b> @ 127.0.0.1:5432/syllabai · flyway head V18 · identity T-C04-CAMPAIGN @ {index?.identity.coreCommit?.slice(0, 7) || "…"}</span>
          <span>·</span>
          <span>workbench DB path is <b>read-only</b> (connection-enforced); apply path = gated importer only</span>
          <span className="ml-auto">staged intent ≠ canonical truth · applied events carry full attribution</span>
        </div>
      </footer>
    </div>
  );
}

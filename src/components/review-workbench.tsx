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
  AlertTriangle, CheckCircle2, ClipboardList, Download, FileText, Flag,
  Lock, ScrollText, Search, Undo2, XCircle, RefreshCw,
} from "lucide-react";
import type { ReviewIndex, SessionDossier } from "@/lib/review-data";

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

const TARGET_VERSION = "question_version" as const;
const TARGET_SCHEME = "mark_scheme" as const;
const TARGET_PAPER = "exam_paper" as const;

function bridgeBadge(status: string) {
  if (status === "OK") return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">bridge OK</Badge>;
  if (status === "REVIEW_REQUIRED") return <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">review required</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function stagedBadge(effective: Effective, targetId: string | null | undefined, canonical?: string | null) {
  const items: React.ReactNode[] = [];
  if (canonical === "VALIDATED") {
    items.push(<Badge key="seed" variant="outline" className="gap-1 text-stone-500"><Lock className="h-3 w-3" /> seed-validated</Badge>);
  } else if (canonical) {
    items.push(<Badge key="canon" variant="outline" className="text-stone-500">{canonical}</Badge>);
  }
  const st = targetId ? effective[targetId] : undefined;
  if (st === "VALIDATED") items.push(<Badge key="st" className="bg-emerald-600 hover:bg-emerald-600">staged VALIDATE</Badge>);
  if (st === "REJECTED") items.push(<Badge key="st" className="bg-rose-600 hover:bg-rose-600">staged REJECT</Badge>);
  if (st === "FLAGGED") items.push(<Badge key="st" className="bg-amber-500 hover:bg-amber-500">staged FLAG</Badge>);
  return items;
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
  const [dialog, setDialog] = useState<
    | null
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

  useEffect(() => {
    refreshDecisions();
    const saved = window.localStorage.getItem("tv-reviewer");
    if (saved) {
      const id = requestAnimationFrame(() => setReviewer(saved));
      return () => cancelAnimationFrame(id);
    }
  }, [refreshDecisions]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetch(`/api/review/session/${selectedId}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setDossier(d); })
      .catch(() => { if (!cancelled) toast({ title: "failed to load session", variant: "destructive" }); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const requireReviewer = (): boolean => {
    if (reviewer.trim().length < 2) {
      toast({ title: "enter a reviewer name first (top right)", variant: "destructive" });
      return false;
    }
    return true;
  };

  const stageDecision = useCallback(
    async (payload: Record<string, unknown>, okTitle: string) => {
      const res = await fetch("/api/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, reviewer: reviewer.trim() }),
      });
      const data = await res.json();
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
      toast({ title: okTitle, description: `seq ${data.entry.seq} appended to the hash-chained staging log` });
      return true;
    },
    [reviewer, toast]
  );

  const act = async (action: "VALIDATE" | "REJECT" | "FLAG", targetType: string, targetId: string, label: string) => {
    if (!requireReviewer()) return;
    if (action === "VALIDATE") {
      await stageDecision({ action, targetType, targetId }, "VALIDATE staged");
    } else {
      setDialog({ kind: action, targetType, targetId, label, note: "" });
    }
  };

  const reverse = async (seq: number) => {
    if (!requireReviewer()) return;
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
  const decidable = (canonical: string | null | undefined) => canonical !== "VALIDATED";

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
            <Badge variant="outline" className="font-mono text-[10px]">core a54f310</Badge>
            <Badge variant="outline" className="font-mono text-[10px]">dump c06d8ab3…</Badge>
            <Badge className="bg-stone-800 hover:bg-stone-800 text-[10px]">INFERRED read model</Badge>
            <Input
              value={reviewer}
              onChange={(e) => { setReviewer(e.target.value); window.localStorage.setItem("tv-reviewer", e.target.value); }}
              placeholder="reviewer name"
              className="h-7 w-36 text-xs"
              aria-label="reviewer name"
            />
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
                    Append-only, hash-chained. <b>Staging only</b> — applying these decisions to the canonical
                    campaign DB happens through a gated importer once the canonical state is provisioned.
                  </p>
                  <div className="flex gap-2 mb-3">
                    <Button size="sm" variant="outline" onClick={exportLog} className="gap-1">
                      <Download className="h-3.5 w-3.5" /> Export evidence bundle
                    </Button>
                  </div>
                  <Separator className="my-3" />
                  {decisions?.entries.length === 0 && <p className="text-stone-500">No staged decisions yet.</p>}
                  <div className="space-y-2">
                    {[...(decisions?.entries || [])].reverse().map((e) => (
                      <div key={e.seq} className="rounded-md border p-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-[10px] text-stone-400">#{e.seq}</span>
                          <Badge variant="outline" className={
                            e.action === "VALIDATE" ? "text-emerald-700 border-emerald-300" :
                            e.action === "REJECT" ? "text-rose-700 border-rose-300" :
                            e.action === "FLAG" ? "text-amber-700 border-amber-300" : ""
                          }>{e.action}</Badge>
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
                    ))}
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      {/* quarantine + note */}
      <div className="mx-auto w-full max-w-7xl px-4 pt-3">
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <b>Quarantine intact:</b> {index?.quarantine.session ?? "1c-2016jan"} is absent from this dataset and must stay
            unresolved until original-source/operator review. Never auto-fixed, never inferred. — {index?.quarantine.rule}
          </div>
        </div>
        <p className="mt-2 text-[11px] text-stone-500">
          {index?.label} · All content below is <b>SUGGESTED</b> in the canonical lifecycle; decisions made here are staged for the gated apply.
        </p>
      </div>

      {/* stats */}
      <div className="mx-auto w-full max-w-7xl px-4 py-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {[
          ["sessions", index?.stats.papers], ["questions", index?.stats.questions],
          ["versions", index?.stats.versions], ["parts", index?.stats.parts],
          ["schemes", index?.stats.schemes], ["mark points", index?.stats.points],
          ["review-required", index?.stats.reviewRequiredSessions], ["embedded", index?.stats.embedded],
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
            <ScrollArea className="h-[calc(100vh-320px)] min-h-72">
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
                    {stagedBadge(decisions?.effective || {}, selectedId, openPaper?.validationState)}
                  </CardTitle>
                  <div className="text-xs text-stone-500">
                    {openPaper?.title} · {openPaper?.board} · {openPaper?.qualification} ·
                    {" "}provenance {openPaper?.provenance} · bridge {openPaper?.bridge}
                  </div>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-stone-500 mr-1">session decision:</span>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                    disabled={!decidable(openPaper?.validationState) || decisions?.effective[selectedId!] === "VALIDATED" || decisions?.effective[selectedId!] === "REJECTED"}
                    onClick={() => act("VALIDATE", TARGET_PAPER, selectedId!, `${openPaper?.paperCode} ${openPaper?.sessionLabel}`)}>
                    <CheckCircle2 className="h-3.5 w-3.5" /> validate session
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-rose-700 border-rose-300 hover:bg-rose-50"
                    disabled={!decidable(openPaper?.validationState) || decisions?.effective[selectedId!] === "VALIDATED" || decisions?.effective[selectedId!] === "REJECTED"}
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
                    return (
                      <Card key={q.id}>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs bg-stone-100 rounded px-1.5 py-0.5">{q.externalRef}</span>
                            <Badge variant="outline" className="text-[10px]">{q.type}</Badge>
                            {q.marks !== null && <Badge variant="outline" className="text-[10px]">{q.marks} marks</Badge>}
                            {q.commandWord && <Badge variant="outline" className="text-[10px]">{q.commandWord}</Badge>}
                            {q.topicNode && <span className="text-[10px] text-stone-400">{q.topicNode}</span>}
                            <span className="ml-auto flex gap-1">
                              {stagedBadge(decisions?.effective || {}, q.versionId, q.validationState)}
                            </span>
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

                          {q.schemes.map((s) => (
                            <div key={s.id} className="rounded border border-stone-200 bg-stone-50">
                              <div className="px-2 py-1.5 flex items-center gap-2 border-b bg-white rounded-t">
                                <span className="text-xs font-semibold">Mark scheme #{s.questionNumber}</span>
                                <Badge variant="outline" className="text-[10px]">{s.validationState}</Badge>
                                <span className="ml-auto flex items-center gap-1">
                                  {stagedBadge(decisions?.effective || {}, s.id, s.validationState).slice(-1)}
                                  {decidable(s.validationState) && decisions?.effective[s.id] !== "VALIDATED" && decisions?.effective[s.id] !== "REJECTED" && (
                                    <>
                                      <button className="text-[10px] text-emerald-700 hover:underline"
                                        onClick={() => act("VALIDATE", TARGET_SCHEME, s.id, `scheme #${s.questionNumber} (${label})`)}>validate</button>
                                      <button className="text-[10px] text-rose-700 hover:underline"
                                        onClick={() => act("REJECT", TARGET_SCHEME, s.id, `scheme #${s.questionNumber} (${label})`)}>reject</button>
                                      <button className="text-[10px] text-amber-700 hover:underline"
                                        onClick={() => act("FLAG", TARGET_SCHEME, s.id, `scheme #${s.questionNumber} (${label})`)}>flag</button>
                                    </>
                                  )}
                                </span>
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
                          ))}

                          <div className="flex items-center gap-2 pt-1">
                            <span className="text-[11px] text-stone-500">question decision:</span>
                            <Button size="sm" variant="outline" className="h-6 text-[11px] gap-1 text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                              disabled={!decidable(q.validationState) || decisions?.effective[q.versionId || ""] === "VALIDATED" || decisions?.effective[q.versionId || ""] === "REJECTED"}
                              onClick={() => act("VALIDATE", TARGET_VERSION, q.versionId!, label)}>
                              <CheckCircle2 className="h-3 w-3" /> validate
                            </Button>
                            <Button size="sm" variant="outline" className="h-6 text-[11px] gap-1 text-rose-700 border-rose-300 hover:bg-rose-50"
                              disabled={!decidable(q.validationState) || decisions?.effective[q.versionId || ""] === "VALIDATED" || decisions?.effective[q.versionId || ""] === "REJECTED"}
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
          <span>Derived read model from retained campaign dump <span className="font-mono">c06d8ab3…</span> (byte-identical isolation proof, 2026-09-13)</span>
          <span>·</span>
          <span>Canonical DB provisioning: <b>pending repo access</b> — V1..V16 immutable, replay path machine-gated</span>
          <span className="ml-auto">Decisions are staged only · hash-chained log · durable copy at export</span>
        </div>
      </footer>
    </div>
  );
}

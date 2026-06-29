import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Maximize2, Minimize2, PanelRight, X } from "lucide-react";
import { PromptBar } from "./components/PromptBar";
import { NewSession } from "./components/NewSession";
import { Conversation, type Turn } from "./components/Conversation";
import { DiffViewer } from "./components/DiffViewer";
import { TitleBar } from "./components/TitleBar";
import { SessionList } from "./components/SessionList";
import { ContextPanel } from "./components/ContextPanel";
import { ChangesPanel } from "./components/ChangesPanel";
import { FilesTree } from "./components/FilesTree";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Toaster } from "@/components/ui/sonner";
import { startSession, sendMessage, type AgentEvent } from "./lib/agent";
import { detectAgents, listModels, type AgentInfo, type ModelInfo } from "./lib/models";
import { reviewSession, type SessionDiff } from "./lib/review";
import { listSessions, sessionEvents, type SessionSummary, type StoredEvent } from "./lib/sessions";
import { groupByWorkspace } from "./lib/workspaces";
import { filesFromEvents, latestUsage } from "./lib/contextDerive";
import { inspectRules, readTextFile, listCapabilities, type RuleFile, type Capabilities } from "./lib/inspect";
import { turnsFromEvents } from "./lib/turns";
import { getRecentRepos, addRecentRepo } from "./lib/recents";
import {
  branchChanges as fetchBranchChanges,
  worktreeTree as fetchWorktreeTree,
  commitSession,
  type BranchChanges,
} from "./lib/conductor";
import { buildTree, type TreeNode } from "./lib/tree";

/** Derive a short display title from the first non-empty line of the prompt. */
function titleFromPrompt(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Untitled session";
}

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [rightTab, setRightTab] = useState<"context" | "changes" | "files" | null>(null);
  const [rightExpanded, setRightExpanded] = useState(false);
  const [storedEvents, setStoredEvents] = useState<StoredEvent[]>([]);
  const [rules, setRules] = useState<RuleFile[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [ruleView, setRuleView] = useState<{ label: string; content: string } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [autoEdit, setAutoEdit] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => getRecentRepos());
  // Milestone 6 will wire counts/diffstats; search is local for now.
  const [sessionSearch, setSessionSearch] = useState("");
  // Changes tab state.
  const [branchChanges, setBranchChanges] = useState<BranchChanges | null>(null);
  // Files tab state.
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  // Commit-in-flight flag.
  const [committing, setCommitting] = useState(false);
  // File-click diff Sheet — null means closed.
  const [diffSheet, setDiffSheet] = useState<{ path: string; diff: SessionDiff } | null>(null);

  // Synchronous ref keeps the active session ID readable inside async callbacks
  // without stale-closure issues — the guard for cross-session contamination.
  const activeSessionIdRef = useRef<string | null>(null);
  const setActive = (id: string | null) => {
    activeSessionIdRef.current = id;
    setActiveSessionId(id);
  };

  // Best-effort refreshers — no-op in a plain browser preview (assertDesktop throws).
  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions());
    } catch {
      /* not in the desktop app */
    }
  }, []);

  // Discover installed agents and their available models on mount.
  // Best-effort — no-op in the browser preview where IPC is unavailable.
  const loadModels = useCallback(async () => {
    try {
      const discovered = await detectAgents();
      const installed = discovered.filter((a) => a.installed);
      const results = await Promise.allSettled(installed.map((a) => listModels(a.id)));
      const all = results
        .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
        .filter((m) => !m.disabled);
      setAgents(discovered);
      setSelectedAgent((prev) => prev ?? installed[0] ?? null);
      setModels(all);
      setSelectedModel((prev) => prev ?? all[0] ?? null);
    } catch (err) {
      console.error("failed to load models", err);
    }
  }, []);

  // Guard: only apply the fetched diff if the session is still the active one.
  // A late fetch from a prior session must not clobber the now-active session's diff.
  const refreshDiff = useCallback(async (sessionId: string) => {
    try {
      const d = await reviewSession({ sessionId });
      if (activeSessionIdRef.current === sessionId) setDiff(d);
    } catch {
      if (activeSessionIdRef.current === sessionId) setDiff(null);
    }
  }, []);

  // Refresh branch-level changes for the Changes tab — same stale-session guard.
  const refreshBranchChanges = useCallback(async (sessionId: string) => {
    try {
      const result = await fetchBranchChanges(sessionId);
      if (activeSessionIdRef.current === sessionId) setBranchChanges(result);
    } catch {
      if (activeSessionIdRef.current === sessionId) setBranchChanges(null);
    }
  }, []);

  // Open a native directory picker and update repo + recents.
  // Wrapped in try-catch — `open()` throws outside the desktop app, same pattern
  // as refreshSessions / loadModels above.
  async function pickRepo() {
    try {
      const path = await open({ directory: true });
      if (typeof path !== "string" || !path) return;
      addRecentRepo(path);
      setSelectedRepo(path);
      setRecents(getRecentRepos());
    } catch {
      /* not in the desktop app, or user cancelled */
    }
  }

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // closeRight keeps the "reset both flags together" invariant structural.
  const closeRight = () => { setRightTab(null); setRightExpanded(false); };

  // Esc closes the right pane — especially useful in the chat-hiding expanded state.
  // Inline the two setters so the linter's exhaustive-deps rule is satisfied.
  useEffect(() => {
    if (rightTab === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setRightTab(null); setRightExpanded(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rightTab]);

  // Fetch rules + capabilities whenever the Context tab becomes active for a session.
  // Captures sessionId at effect-run time so the cross-session ref guard works correctly
  // even if the user switches sessions while awaiting IPC calls.
  useEffect(() => {
    if (rightTab !== "context" || !activeSessionId) return;
    const sessionId = activeSessionId;
    (async () => {
      try { const r = await inspectRules(sessionId); if (activeSessionIdRef.current === sessionId) setRules(r); }
      catch { if (activeSessionIdRef.current === sessionId) setRules([]); }
      try { const c = await listCapabilities(sessionId, selectedModel?.agent ?? "claude"); if (activeSessionIdRef.current === sessionId) setCapabilities(c); }
      catch { if (activeSessionIdRef.current === sessionId) setCapabilities(null); }
    })();
  }, [rightTab, activeSessionId, selectedModel?.agent]);

  // Fetch branch-level changes when the Changes tab becomes active.
  useEffect(() => {
    if (rightTab !== "changes" || !activeSessionId) return;
    const sessionId = activeSessionId;
    void refreshBranchChanges(sessionId);
  }, [rightTab, activeSessionId, refreshBranchChanges]);

  // Fetch the flat worktree file list and build the nested tree when Files tab opens.
  useEffect(() => {
    if (rightTab !== "files" || !activeSessionId) return;
    const sessionId = activeSessionId;
    (async () => {
      try {
        const entries = await fetchWorktreeTree(sessionId);
        if (activeSessionIdRef.current === sessionId) setTreeNodes(buildTree(entries));
      } catch {
        if (activeSessionIdRef.current === sessionId) setTreeNodes([]);
      }
    })();
  }, [rightTab, activeSessionId]);

  function appendToLastTurn(event: AgentEvent) {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, events: [...last.events, event] };
      return next;
    });
  }

  // Commit the session's worktree changes. Shows toast feedback and refreshes
  // the Changes tab data + the session's diffstat after a successful commit.
  async function handleCommit(message: string) {
    if (!activeSessionId || committing) return;
    const sessionId = activeSessionId;
    setCommitting(true);
    try {
      const result = await commitSession(sessionId, message);
      toast.success(`Committed ${result.sha.slice(0, 7)}`);
      // Refresh changes list and full diff after a successful commit.
      await Promise.allSettled([
        refreshBranchChanges(sessionId),
        refreshDiff(sessionId),
        refreshSessions(),
      ]);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setCommitting(false);
    }
  }

  // Open the diff Sheet for a clicked file path. Reuses the existing `diff` state
  // (full patch, acceptable per spec — DiffViewer has no per-file filter prop).
  // If diff hasn't loaded yet, attempt a best-effort fetch first.
  async function handleOpenFile(path: string) {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    let sessionDiff = diff;
    if (!sessionDiff) {
      try {
        sessionDiff = await reviewSession({ sessionId });
        if (activeSessionIdRef.current === sessionId) setDiff(sessionDiff);
      } catch {
        sessionDiff = null;
      }
    }
    if (sessionDiff && activeSessionIdRef.current === sessionId) {
      setDiffSheet({ path, diff: sessionDiff });
    }
  }

  async function handleSend(
    text: string,
    model: ModelInfo | null,
    opts?: { repo?: string; permissionMode?: string },
  ) {
    const isNew = activeSessionId === null;
    const sessionId = activeSessionId ?? crypto.randomUUID();
    const repo = opts?.repo ?? ".";
    // Set the ref synchronously before the first await so the cross-session guard
    // is exact for new sessions (id now known up front, not after startSession resolves).
    setActive(sessionId);
    // Optimistically upsert a "running" row at the top of the list immediately —
    // refreshSessions() in finally reconciles the real title/status from the backend.
    setSessions((prev) => {
      const existing = prev.find((s) => s.id === sessionId);
      const now = Date.now();
      const row: SessionSummary = existing
        ? { ...existing, status: "running", updatedAt: now }
        : { id: sessionId, agent: "claude", repo, branch: `agent/${sessionId}`, title: titleFromPrompt(text), status: "running", createdAt: now, updatedAt: now };
      return [row, ...prev.filter((s) => s.id !== sessionId)];
    });
    closeRight();
    setRunning(true);
    setTurns((prev) => [...prev, { prompt: text, events: [] }]);
    // Guard: if the user switches sessions while this send is streaming, drop the late
    // events from the UI — the backend persists all events regardless, so re-selecting
    // the session rehydrates anything dropped here.
    const onEvent = (event: AgentEvent) => {
      if (activeSessionIdRef.current !== sessionId) return;
      appendToLastTurn(event);
    };
    // Forward the model value for Claude; null model → omit → CLI default.
    const modelArg = model && model.agent === "claude" ? model.value : undefined;
    try {
      if (isNew) {
        await startSession({ prompt: text, repo, sessionId, model: modelArg, permissionMode: opts?.permissionMode, onEvent });
      } else {
        await sendMessage({ sessionId, prompt: text, model: modelArg, onEvent });
      }
    } catch (err) {
      onEvent({ kind: "error", data: { message: String(err) } });
    } finally {
      setRunning(false);
      await refreshSessions();
      if (activeSessionIdRef.current === sessionId) {
        await refreshDiff(sessionId);
        try { setStoredEvents(await sessionEvents(sessionId)); } catch { /* ignore */ }
      }
    }
  }

  // Start a brand-new session from the NewSession composer, threading repo,
  // permissionMode, and the currently selected model into the shared send path.
  function handleStartNewSession(text: string) {
    return handleSend(text, selectedModel, {
      repo: selectedRepo ?? ".",
      permissionMode: autoEdit ? "acceptEdits" : "default",
    });
  }

  async function handleSelectSession(id: string) {
    setActive(id);
    closeRight();
    setDiff(null);
    setRules([]);
    setCapabilities(null);
    setRuleView(null);
    setBranchChanges(null);
    setTreeNodes([]);
    setDiffSheet(null);
    try {
      const ev = await sessionEvents(id);
      setStoredEvents(ev);
      setTurns(turnsFromEvents(ev));
    } catch {
      setStoredEvents([]);
      setTurns([]);
    }
    await refreshDiff(id);
  }

  function handleNewSession() {
    setActive(null);
    setTurns([]);
    setDiff(null);
    setStoredEvents([]);
    setRules([]);
    setCapabilities(null);
    setRuleView(null);
    setBranchChanges(null);
    setTreeNodes([]);
    setDiffSheet(null);
    closeRight();
  }

  async function handleOpenRule(rule: RuleFile) {
    if (!activeSessionId) return;
    try {
      setRuleView({ label: rule.label, content: await readTextFile(activeSessionId, rule.path) });
    } catch (e) {
      setRuleView({ label: rule.label, content: `Failed to read: ${String(e)}` });
    }
  }

  const files = filesFromEvents(storedEvents);
  const usage = latestUsage(storedEvents);
  const changedCount = diff?.files.length ?? 0;

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <div className="w-72 shrink-0">
          <SessionList
            groups={groupByWorkspace(sessions)}
            activeId={activeSessionId}
            onSelect={handleSelectSession}
            onNew={handleNewSession}
            counts={null}
            diffstats={{}}
            search={sessionSearch}
            onSearchChange={setSessionSearch}
          />
        </div>
        <main className="flex flex-1 min-h-0">
          {/* Chat column — hidden only while the right pane is expanded to fullscreen. */}
          {!rightExpanded && (
            <section className="flex flex-1 flex-col min-w-0 min-h-0">
              {activeSessionId === null ? (
                /* No active session — show the new-session composer. */
                <NewSession
                  repo={selectedRepo}
                  recents={recents}
                  agents={agents}
                  agent={selectedAgent}
                  models={models}
                  model={selectedModel}
                  autoEdit={autoEdit}
                  running={running}
                  onPickRepo={pickRepo}
                  onPickRecent={(p) => {
                    addRecentRepo(p);
                    setSelectedRepo(p);
                    setRecents(getRecentRepos());
                  }}
                  onAgentChange={setSelectedAgent}
                  onModelChange={setSelectedModel}
                  onAutoEditChange={setAutoEdit}
                  onStart={handleStartNewSession}
                />
              ) : (
                /* Active session — toolbar + conversation + prompt bar. */
                <>
                  {/* Stable top toolbar — single toggle; switching Context vs Diff lives in the pane tabs. */}
                  <div className="flex items-center justify-end px-4 py-2 border-b border-border">
                    <Button
                      variant={rightTab !== null ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => (rightTab ? closeRight() : setRightTab("context"))}
                      aria-label="Toggle context panel"
                    >
                      <PanelRight data-icon />
                      Panel
                      {changedCount > 0 && (
                        <Badge variant="secondary" className="ml-1 tabular-nums">
                          {changedCount}
                        </Badge>
                      )}
                    </Button>
                  </div>
                  <div className="flex flex-1 flex-col overflow-auto min-h-0">
                    <div className="mt-auto w-full max-w-3xl mx-auto px-4">
                      <Conversation turns={turns} running={running} />
                    </div>
                  </div>
                  <PromptBar
                    onStart={handleSend}
                    running={running}
                    models={models}
                    model={selectedModel}
                    onModelChange={setSelectedModel}
                  />
                </>
              )}
            </section>
          )}

          {/* Right side-pane — tabbed Context | Changes | Files, collapsible + expandable. */}
          {rightTab && (
            <aside
              className={cn(
                "flex flex-col min-w-0 min-h-0 border-l border-border",
                rightExpanded ? "w-full border-l-0" : "w-[clamp(420px,46%,760px)]"
              )}
            >
              <Tabs
                value={rightTab}
                onValueChange={(v) => setRightTab(v as "context" | "changes" | "files")}
                className="flex flex-col min-h-0 flex-1"
              >
                <header className="flex items-center justify-between px-3 py-2 border-b border-border">
                  <TabsList>
                    <TabsTrigger value="context">Context</TabsTrigger>
                    <TabsTrigger value="changes">Changes</TabsTrigger>
                    <TabsTrigger value="files">Files</TabsTrigger>
                  </TabsList>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setRightExpanded((v) => !v)}
                      aria-label={rightExpanded ? "Collapse panel" : "Expand panel"}
                    >
                      {rightExpanded ? <Minimize2 /> : <Maximize2 />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={closeRight}
                      aria-label="Close panel"
                    >
                      <X />
                    </Button>
                  </div>
                </header>
                <TabsContent value="context" className="flex-1 min-h-0 overflow-auto">
                  <ContextPanel
                    usage={usage}
                    files={files}
                    rules={rules}
                    capabilities={capabilities}
                    model={selectedModel}
                    onOpenRule={handleOpenRule}
                    onOpenFile={(path) => void handleOpenFile(path)}
                  />
                </TabsContent>
                <TabsContent value="changes" className="flex-1 min-h-0 overflow-hidden">
                  <ChangesPanel
                    branch={branchChanges}
                    onCommit={(message) => void handleCommit(message)}
                    onOpenFile={(path) => void handleOpenFile(path)}
                    committing={committing}
                  />
                </TabsContent>
                <TabsContent value="files" className="flex-1 min-h-0 overflow-hidden">
                  <FilesTree
                    nodes={treeNodes}
                    onOpenFile={(path) => void handleOpenFile(path)}
                  />
                </TabsContent>
              </Tabs>
            </aside>
          )}
        </main>
      </div>

      {/* Rule viewer Sheet — rendered once, controlled by ruleView state. */}
      <Sheet open={ruleView !== null} onOpenChange={(o) => { if (!o) setRuleView(null); }}>
        <SheetContent className="w-[480px] sm:max-w-none flex flex-col">
          <SheetHeader>
            <SheetTitle className="font-mono text-sm">{ruleView?.label}</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 min-h-0">
            <pre className="font-mono text-xs whitespace-pre-wrap p-4">{ruleView?.content}</pre>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* File diff Sheet — opens when a file is clicked in Changes or Files tab.
          Shows the full session patch (DiffViewer has no per-file filter). */}
      <Sheet open={diffSheet !== null} onOpenChange={(o) => { if (!o) setDiffSheet(null); }}>
        <SheetContent className="w-[640px] sm:max-w-none flex flex-col">
          <SheetHeader>
            <SheetTitle className="font-mono text-sm">{diffSheet?.path}</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 min-h-0">
            {diffSheet && <DiffViewer diff={diffSheet.diff} />}
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <Toaster />
    </div>
  );
}

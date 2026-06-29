import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FileDiff, Maximize2, Minimize2, X } from "lucide-react";
import { PromptBar } from "./components/PromptBar";
import { Conversation, type Turn } from "./components/Conversation";
import { DiffViewer } from "./components/DiffViewer";
import { TitleBar } from "./components/TitleBar";
import { SessionList } from "./components/SessionList";
import { startSession, sendMessage, type AgentEvent } from "./lib/agent";
import { detectAgents, listModels, type ModelInfo } from "./lib/models";
import { reviewSession, type SessionDiff } from "./lib/review";
import { listSessions, sessionEvents, type SessionSummary } from "./lib/sessions";
import { turnsFromEvents } from "./lib/turns";

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
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);

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
      const agents = await detectAgents();
      const installed = agents.filter((a) => a.installed);
      const results = await Promise.allSettled(installed.map((a) => listModels(a.id)));
      const all = results
        .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
        .filter((m) => !m.disabled);
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

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // closeDiff keeps the "reset both flags together" invariant structural.
  const closeDiff = () => { setDiffOpen(false); setDiffExpanded(false); };

  // Esc closes the diff pane — especially useful in the chat-hiding expanded state.
  // Inline the two setters so the linter's exhaustive-deps rule is satisfied.
  useEffect(() => {
    if (!diffOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setDiffOpen(false); setDiffExpanded(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [diffOpen]);

  function appendToLastTurn(event: AgentEvent) {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, events: [...last.events, event] };
      return next;
    });
  }

  async function handleSend(text: string, model: ModelInfo | null) {
    const isNew = activeSessionId === null;
    const sessionId = activeSessionId ?? crypto.randomUUID();
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
        : { id: sessionId, agent: "claude", repo: ".", branch: `agent/${sessionId}`, title: titleFromPrompt(text), status: "running", createdAt: now, updatedAt: now };
      return [row, ...prev.filter((s) => s.id !== sessionId)];
    });
    closeDiff();
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
        await startSession({ prompt: text, repo: ".", sessionId, model: modelArg, onEvent });
      } else {
        await sendMessage({ sessionId, prompt: text, model: modelArg, onEvent });
      }
    } catch (err) {
      onEvent({ kind: "error", data: { message: String(err) } });
    } finally {
      setRunning(false);
      await refreshSessions();
      if (activeSessionIdRef.current === sessionId) await refreshDiff(sessionId);
    }
  }

  async function handleSelectSession(id: string) {
    setActive(id);
    closeDiff();
    setDiff(null);
    try {
      setTurns(turnsFromEvents(await sessionEvents(id)));
    } catch {
      setTurns([]);
    }
    await refreshDiff(id);
  }

  function handleNewSession() {
    setActive(null);
    setTurns([]);
    setDiff(null);
    closeDiff();
  }

  const changedCount = diff?.files.length ?? 0;
  const showReviewChip = !running && changedCount > 0 && !diffOpen;

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <div className="w-72 shrink-0">
          <SessionList
            sessions={sessions}
            activeId={activeSessionId}
            onSelect={handleSelectSession}
            onNew={handleNewSession}
          />
        </div>
        <main className="flex flex-1 min-h-0">
          {/* Chat column — hidden only while the diff is expanded to fullscreen. */}
          {!diffExpanded && (
            <section className="flex flex-1 flex-col min-w-0 min-h-0">
              <div className="flex flex-1 flex-col overflow-auto min-h-0">
                <div className="mt-auto w-full max-w-3xl mx-auto px-4">
                  <Conversation turns={turns} running={running} />
                </div>
              </div>
              {showReviewChip && (
                <div className="px-4 py-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => setDiffOpen(true)}
                  >
                    <FileDiff className="mr-2 size-4" />
                    {changedCount} file{changedCount === 1 ? "" : "s"} changed — Review
                  </Button>
                </div>
              )}
              <PromptBar
                onStart={handleSend}
                running={running}
                models={models}
                model={selectedModel}
                onModelChange={setSelectedModel}
              />
            </section>
          )}

          {/* Diff side-pane — beside the chat, collapsible + expandable. */}
          {diffOpen && diff && (
            <aside
              className={cn(
                "flex flex-col min-w-0 min-h-0 border-l border-border",
                diffExpanded ? "w-full border-l-0" : "w-[clamp(420px,46%,760px)]"
              )}
            >
              <header className="flex items-center justify-between px-3 py-2 border-b border-border">
                <span className="text-sm text-muted-foreground tabular-nums">
                  {changedCount} file{changedCount === 1 ? "" : "s"} changed
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDiffExpanded((v) => !v)}
                    aria-label={diffExpanded ? "Collapse diff" : "Expand diff"}
                  >
                    {diffExpanded ? <Minimize2 /> : <Maximize2 />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={closeDiff}
                    aria-label="Close diff"
                  >
                    <X />
                  </Button>
                </div>
              </header>
              <div className="flex-1 min-h-0 overflow-auto">
                <DiffViewer diff={diff} />
              </div>
            </aside>
          )}
        </main>
      </div>
    </div>
  );
}

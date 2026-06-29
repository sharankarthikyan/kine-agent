import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { PromptBar } from "./components/PromptBar";
import { Conversation, type Turn } from "./components/Conversation";
import { DiffViewer } from "./components/DiffViewer";
import { TitleBar } from "./components/TitleBar";
import { SessionList } from "./components/SessionList";
import { startSession, sendMessage, type AgentEvent } from "./lib/agent";
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

  async function handleSend(text: string) {
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
    try {
      if (isNew) {
        await startSession({ prompt: text, repo: ".", sessionId, onEvent });
      } else {
        await sendMessage({ sessionId, prompt: text, onEvent });
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
    <div style={shell}>
      <TitleBar />
      <div style={{ display: "grid", gridTemplateColumns: "var(--list-pane-w) 1fr", flex: 1, minHeight: 0 }}>
        <SessionList
          sessions={sessions}
          activeId={activeSessionId}
          onSelect={handleSelectSession}
          onNew={handleNewSession}
        />
        <main style={detail}>
          {/* Chat column — hidden only while the diff is expanded to fullscreen. */}
          {!diffExpanded && (
            <section style={chatColumn}>
              <div style={scrollArea}>
                <div style={{ marginTop: "auto", width: "100%", maxWidth: "var(--content-measure)" }}>
                  <Conversation turns={turns} running={running} />
                </div>
              </div>
              {showReviewChip && (
                <div style={chipRow}>
                  <button onClick={() => setDiffOpen(true)} style={reviewChip}>
                    {changedCount} file{changedCount === 1 ? "" : "s"} changed — Review
                  </button>
                </div>
              )}
              <PromptBar onStart={handleSend} running={running} />
            </section>
          )}

          {/* Diff side-pane — beside the chat, collapsible + expandable. */}
          {diffOpen && diff && (
            <aside style={{ ...diffPane, ...(diffExpanded ? diffPaneExpanded : null) }}>
              <header style={diffHeader}>
                <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-13)" }}>
                  {changedCount} file{changedCount === 1 ? "" : "s"} changed
                </span>
                <span style={{ display: "flex", gap: "var(--space-1)" }}>
                  <button
                    onClick={() => setDiffExpanded((v) => !v)}
                    style={iconButton}
                    aria-label={diffExpanded ? "Collapse diff" : "Expand diff"}
                  >
                    {diffExpanded ? "⤡" : "⤢"}
                  </button>
                  <button
                    onClick={closeDiff}
                    style={iconButton}
                    aria-label="Close diff"
                  >
                    ✕
                  </button>
                </span>
              </header>
              <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                <DiffViewer diff={diff} />
              </div>
            </aside>
          )}
        </main>
      </div>
    </div>
  );
}

const shell: CSSProperties = { display: "flex", flexDirection: "column", height: "100vh" };
const detail: CSSProperties = { display: "flex", minWidth: 0, minHeight: 0 };
const chatColumn: CSSProperties = { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 };
const scrollArea: CSSProperties = { flex: 1, overflow: "auto", minHeight: 0, display: "flex", flexDirection: "column" };
const chipRow: CSSProperties = { padding: "var(--space-2) var(--space-3)" };
const reviewChip: CSSProperties = {
  padding: "var(--space-1) var(--space-3)", borderRadius: "var(--radius-full)",
  border: "1px solid var(--border-hairline)", background: "var(--surface-raised)",
  color: "var(--text-primary)", cursor: "pointer", fontSize: "var(--fs-12)",
};
const diffPane: CSSProperties = {
  width: "clamp(420px, 46%, 760px)", borderLeft: "1px solid var(--border-hairline)",
  display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0,
};
const diffPaneExpanded: CSSProperties = { width: "100%", borderLeft: "none" };
const diffHeader: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "var(--space-2) var(--space-3)", borderBottom: "1px solid var(--border-hairline)",
};
const iconButton: CSSProperties = {
  width: 28, height: 24, border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-sm)",
  background: "var(--bg-card)", color: "var(--text-body)", cursor: "pointer", fontSize: "var(--fs-13)",
};

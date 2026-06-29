import { useCallback, useEffect, useState } from "react";
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

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState(false);

  // Best-effort refreshers — no-op in a plain browser preview (assertDesktop throws).
  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions());
    } catch {
      /* not in the desktop app */
    }
  }, []);

  const refreshDiff = useCallback(async (sessionId: string) => {
    try {
      setDiff(await reviewSession({ sessionId }));
    } catch {
      setDiff(null); // worktree may be gone; no changes to show
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

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
    setDiffOpen(false);
    setDiffExpanded(false);
    setRunning(true);
    setTurns((prev) => [...prev, { prompt: text, events: [] }]);
    let sessionId = activeSessionId;
    try {
      if (sessionId === null) {
        sessionId = await startSession({ prompt: text, repo: ".", onEvent: appendToLastTurn });
        setActiveSessionId(sessionId);
      } else {
        await sendMessage({ sessionId, prompt: text, onEvent: appendToLastTurn });
      }
    } catch (err) {
      appendToLastTurn({ kind: "error", data: { message: String(err) } });
    } finally {
      setRunning(false);
      await refreshSessions();
      if (sessionId) await refreshDiff(sessionId);
    }
  }

  async function handleSelectSession(id: string) {
    setActiveSessionId(id);
    setDiffOpen(false);
    setDiffExpanded(false);
    setDiff(null);
    try {
      setTurns(turnsFromEvents(await sessionEvents(id)));
    } catch {
      setTurns([]);
    }
    await refreshDiff(id);
  }

  function handleNewSession() {
    setActiveSessionId(null);
    setTurns([]);
    setDiff(null);
    setDiffOpen(false);
    setDiffExpanded(false);
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
                    onClick={() => { setDiffOpen(false); setDiffExpanded(false); }}
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

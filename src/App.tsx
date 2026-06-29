import { useState } from "react";
import type { CSSProperties } from "react";
import { PromptBar } from "./components/PromptBar";
import { Conversation, type Turn } from "./components/Conversation";
import { DiffViewer } from "./components/DiffViewer";
import { TitleBar } from "./components/TitleBar";
import { startSession, sendMessage, type AgentEvent } from "./lib/agent";
import { reviewSession, type SessionDiff } from "./lib/review";

export default function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [diff, setDiff] = useState<SessionDiff | null>(null);

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
    setDiff(null);
    setRunning(true);
    setTurns((prev) => [...prev, { prompt: text, events: [] }]);
    try {
      if (activeSessionId === null) {
        const id = await startSession({ prompt: text, repo: ".", onEvent: appendToLastTurn });
        setActiveSessionId(id);
      } else {
        await sendMessage({ sessionId: activeSessionId, prompt: text, onEvent: appendToLastTurn });
      }
    } catch (err) {
      appendToLastTurn({ kind: "error", data: { message: String(err) } });
    } finally {
      setRunning(false);
    }
  }

  function handleNewSession() {
    setTurns([]);
    setActiveSessionId(null);
    setDiff(null);
  }

  async function handleReview() {
    if (!activeSessionId) return;
    try {
      setDiff(await reviewSession({ sessionId: activeSessionId }));
    } catch (err) {
      appendToLastTurn({ kind: "error", data: { message: String(err) } });
    }
  }

  const canReview = activeSessionId !== null && !running;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TitleBar />
      <div style={{ display: "grid", gridTemplateColumns: "var(--sidebar-w) 1fr", flex: 1, minHeight: 0 }}>
        <aside style={{ borderRight: "1px solid var(--border-hairline)", background: "var(--bg-surface)", padding: "var(--space-4)" }}>
          <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)", textTransform: "uppercase", letterSpacing: "0.04em" }}>SESSIONS</p>
          <button onClick={handleNewSession} style={newSessionButton}>+ New session</button>
        </aside>
        <main style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          {/* Scrollable conversation (or diff), grows to fill; composer sits below it.
              Flex column so the conversation can bottom-anchor (margin-top:auto): a
              short chat sits just above the composer and grows upward, then scrolls. */}
          <div style={{ flex: 1, overflow: "auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
            {diff ? (
              <DiffViewer diff={diff} />
            ) : (
              <div style={{ marginTop: "auto", width: "100%", maxWidth: "var(--content-measure)" }}>
                <Conversation turns={turns} running={running} />
              </div>
            )}
          </div>
          {/* Context action row above the composer. */}
          {diff ? (
            <div style={actionRow}>
              <button onClick={() => setDiff(null)} style={secondaryButton}>← Back to conversation</button>
            </div>
          ) : (
            canReview && (
              <div style={actionRow}>
                <button onClick={handleReview} style={secondaryButton}>Review changes</button>
              </div>
            )
          )}
          {/* Composer pinned to the bottom. */}
          <PromptBar onStart={handleSend} running={running} />
        </main>
      </div>
    </div>
  );
}

const newSessionButton: CSSProperties = {
  marginTop: "var(--space-3)", width: "100%", textAlign: "left",
  padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-hairline)", background: "var(--bg-card)",
  color: "var(--text-primary)", cursor: "pointer", fontSize: "var(--fs-13)",
};

const actionRow: CSSProperties = {
  padding: "var(--space-2) var(--space-3)",
  borderTop: "1px solid var(--border-hairline)",
};

const secondaryButton: CSSProperties = {
  padding: "var(--space-2) var(--space-4)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-hairline)",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: "var(--fs-13)",
};

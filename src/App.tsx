import { useState } from "react";
import type { CSSProperties } from "react";
import { PromptBar } from "./components/PromptBar";
import { Conversation } from "./components/Conversation";
import { DiffViewer } from "./components/DiffViewer";
import { TitleBar } from "./components/TitleBar";
import { startSession, type AgentEvent } from "./lib/agent";
import { reviewSession, type SessionDiff } from "./lib/review";

export default function App() {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [diff, setDiff] = useState<SessionDiff | null>(null);

  async function handleStart(text: string) {
    setPrompt(text);
    setEvents([]);
    setDiff(null);
    setSessionId(null); // drop the previous session so a failed start can't be "reviewed"
    setRunning(true);
    try {
      const id = await startSession({
        prompt: text,
        repo: ".", // MVP: current dir as the target repo; a repo picker comes later
        onEvent: (event) => setEvents((prev) => [...prev, event]),
      });
      setSessionId(id);
    } catch (err) {
      setEvents((prev) => [...prev, { kind: "error", data: { message: String(err) } }]);
    } finally {
      setRunning(false);
    }
  }

  async function handleReview() {
    if (!sessionId) return;
    try {
      setDiff(await reviewSession({ sessionId }));
    } catch (err) {
      setEvents((prev) => [...prev, { kind: "error", data: { message: String(err) } }]);
    }
  }

  const canReview = sessionId !== null && !running;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TitleBar />
      <div style={{ display: "grid", gridTemplateColumns: "var(--sidebar-w) 1fr", flex: 1, minHeight: 0 }}>
        <aside style={{ borderRight: "1px solid var(--border-hairline)", background: "var(--bg-surface)", padding: "var(--space-4)" }}>
          <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)", textTransform: "uppercase", letterSpacing: "0.04em" }}>SESSIONS</p>
          <p style={{ color: "var(--text-disabled)", fontSize: "var(--fs-13)", marginTop: "var(--space-2)" }}>No sessions yet.</p>
        </aside>
        <main style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          {/* Scrollable conversation (or diff), grows to fill; composer sits below it. */}
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {diff ? (
              <DiffViewer diff={diff} />
            ) : (
              <div style={{ maxWidth: "var(--content-measure)" }}>
                <Conversation prompt={prompt} events={events} running={running} />
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
          <PromptBar onStart={handleStart} running={running} />
        </main>
      </div>
    </div>
  );
}

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

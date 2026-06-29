import { useState } from "react";
import type { CSSProperties } from "react";
import { PromptBar } from "./components/PromptBar";
import { EventStream } from "./components/EventStream";
import { DiffViewer } from "./components/DiffViewer";
import { RunningIndicator } from "./components/RunningIndicator";
import { startSession, type AgentEvent } from "./lib/agent";
import { reviewSession, type SessionDiff } from "./lib/review";

export default function App() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [diff, setDiff] = useState<SessionDiff | null>(null);

  async function handleStart(prompt: string) {
    setEvents([]);
    setDiff(null);
    setSessionId(null); // drop the previous session so a failed start can't be "reviewed"
    setRunning(true);
    try {
      const id = await startSession({
        prompt,
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
    <div style={{ display: "grid", gridTemplateColumns: "var(--sidebar-w) 1fr", height: "100vh" }}>
      <aside style={{ borderRight: "1px solid var(--border-hairline)", background: "var(--bg-surface)", padding: "var(--space-4)" }}>
        <h1 style={{ fontSize: "var(--fs-14)", color: "var(--text-primary)" }}>agent-editor</h1>
        <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-12)", textTransform: "uppercase", letterSpacing: "0.04em", marginTop: "var(--space-5)" }}>SESSIONS</p>
        <p style={{ color: "var(--text-disabled)", fontSize: "var(--fs-13)", marginTop: "var(--space-2)" }}>No sessions yet.</p>
      </aside>
      <main style={{ display: "flex", flexDirection: "column", height: "100vh", minHeight: 0 }}>
        <PromptBar onStart={handleStart} running={running} />
        {canReview && (
          <div style={{ padding: "var(--space-2) var(--space-3)" }}>
            <button onClick={handleReview} style={reviewButton}>Review changes</button>
          </div>
        )}
        <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          {diff ? (
            <DiffViewer diff={diff} />
          ) : (
            <div style={{ maxWidth: "var(--content-measure)" }}>
              {running && <RunningIndicator />}
              <EventStream events={events} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

const reviewButton: CSSProperties = {
  padding: "var(--space-2) var(--space-4)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-hairline)",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: "var(--fs-13)",
};

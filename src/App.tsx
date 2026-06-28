import { useState } from "react";
import { PromptBar } from "./components/PromptBar";
import { EventStream } from "./components/EventStream";
import { startSession, type AgentEvent } from "./lib/agent";

export default function App() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);

  async function handleStart(prompt: string) {
    setEvents([]);
    setRunning(true);
    try {
      await startSession({
        prompt,
        repo: ".", // MVP: current dir as the target repo; a repo picker comes later
        onEvent: (event) => setEvents((prev) => [...prev, event]),
      });
    } catch (err) {
      // startSession rejects on fatal failures (e.g. the agent CLI can't spawn).
      // Surface it in the stream instead of an uncaught rejection.
      setEvents((prev) => [...prev, { kind: "error", data: { message: String(err) } }]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "var(--sidebar-w) 1fr", height: "100vh" }}>
      <aside style={{ borderRight: "1px solid var(--border-hairline)", background: "var(--bg-surface)", padding: "var(--space-4)" }}>
        <h1 style={{ fontSize: "var(--fs-14)", color: "var(--text-primary)" }}>agent-editor</h1>
        <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-13)" }}>Sessions (coming soon)</p>
      </aside>
      <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <PromptBar onStart={handleStart} running={running} />
        <div style={{ flex: 1, overflow: "auto" }}>
          <EventStream events={events} />
        </div>
      </main>
    </div>
  );
}

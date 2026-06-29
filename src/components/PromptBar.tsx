import { useState } from "react";

interface PromptBarProps {
  onStart: (prompt: string) => void;
  running: boolean;
}

export function PromptBar({ onStart, running }: PromptBarProps) {
  const [text, setText] = useState("");
  const canStart = !running && text.trim().length > 0;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canStart) return;
    onStart(text.trim());
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: "flex", gap: "var(--space-2)", padding: "var(--space-3)" }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask the agent to do something…"
        aria-label="Agent prompt"
        disabled={running}
        style={{
          flex: 1, padding: "var(--space-3)", borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-hairline)", background: "var(--bg-card)",
          color: "var(--text-primary)", fontSize: "var(--fs-14)",
        }}
      />
      <button
        type="submit"
        disabled={!canStart}
        style={{
          padding: "var(--space-3) var(--space-4)", borderRadius: "var(--radius-md)",
          border: "none", background: "var(--status-running)", color: "var(--bg-canvas)",
          fontWeight: 500, cursor: canStart ? "pointer" : "not-allowed",
          opacity: canStart ? 1 : 0.45, transition: "opacity var(--dur-fast) var(--ease-out)",
        }}
      >
        {running ? "Running…" : "Start"}
      </button>
    </form>
  );
}

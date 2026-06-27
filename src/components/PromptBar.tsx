import { useState } from "react";

interface PromptBarProps {
  onStart: (prompt: string) => void;
  running: boolean;
}

export function PromptBar({ onStart, running }: PromptBarProps) {
  const [text, setText] = useState("");

  function handleStart() {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onStart(trimmed);
  }

  return (
    <div style={{ display: "flex", gap: "var(--space-2)", padding: "var(--space-3)" }}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask the agent to do something…"
        style={{
          flex: 1, padding: "var(--space-3)", borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-hairline)", background: "var(--bg-card)",
          color: "var(--text-primary)", fontSize: "var(--fs-14)",
        }}
      />
      <button
        onClick={handleStart}
        disabled={running}
        style={{
          padding: "var(--space-3) var(--space-4)", borderRadius: "var(--radius-md)",
          border: "none", background: "var(--status-running)", color: "var(--bg-canvas)",
          fontWeight: 500, cursor: running ? "default" : "pointer",
        }}
      >
        {running ? "Running…" : "Start"}
      </button>
    </div>
  );
}

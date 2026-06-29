import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { AgentEvent } from "../lib/agent";
import { EventStream } from "./EventStream";
import { EmptyState } from "./EmptyState";
import { RunningIndicator } from "./RunningIndicator";

export interface Turn {
  prompt: string;
  events: AgentEvent[];
}

interface ConversationProps {
  turns: Turn[];
  running: boolean;
}

export function Conversation({ turns, running }: ConversationProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      bottomRef.current?.scrollIntoView({ block: "end" });
    } catch {
      /* jsdom: no-op */
    }
  }, [turns, running]);

  if (turns.length === 0 && !running) {
    return (
      <EmptyState
        heading="No activity yet."
        hint="Message the agent below to start a session."
      />
    );
  }

  return (
    <div style={thread}>
      {turns.map((turn, i) => (
        <div key={i} style={turnGroup}>
          {/* User message: a subtle tinted card so "what I asked" is scannable. */}
          <section style={turnBlock}>
            <div style={role}>You</div>
            <div style={userCard}>{turn.prompt}</div>
          </section>
          {/* Agent message: plain on the canvas — room for prose, chips, code. */}
          {turn.events.length > 0 && (
            <section style={turnBlock}>
              <div style={role}>Agent</div>
              <EventStream events={turn.events} />
            </section>
          )}
        </div>
      ))}
      {running && <RunningIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}

// Bigger gap between turns than within one (research: "more space around a group
// than within it"); no divider lines anywhere.
const thread: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--space-6)", padding: "var(--space-4)" };
const turnGroup: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--space-3)" };
const turnBlock: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--space-2)" };
const role: CSSProperties = {
  fontSize: "var(--fs-12)", textTransform: "uppercase", letterSpacing: "0.04em",
  fontWeight: 600, color: "var(--text-muted)",
};
const userCard: CSSProperties = {
  background: "var(--surface-raised)",
  border: "1px solid var(--border-hairline)",
  borderRadius: "var(--radius-md)",
  padding: "var(--space-3) var(--space-4)",
  color: "var(--text-primary)",
  whiteSpace: "pre-wrap",
};

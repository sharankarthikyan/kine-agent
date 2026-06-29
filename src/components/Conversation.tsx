import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { AgentEvent } from "../lib/agent";
import { EventStream } from "./EventStream";
import { EmptyState } from "./EmptyState";
import { RunningIndicator } from "./RunningIndicator";

interface ConversationProps {
  prompt: string | null;
  events: AgentEvent[];
  running: boolean;
}

/**
 * The per-session thread: the user's prompt as one turn, the agent's activity
 * (events + a working indicator) as the next. Auto-scrolls to the newest content.
 */
export function Conversation({ prompt, events, running }: ConversationProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // scrollIntoView is a no-op/absent under jsdom — guard so tests don't throw.
    try {
      bottomRef.current?.scrollIntoView({ block: "end" });
    } catch {
      /* ignore */
    }
  }, [prompt, events.length, running]);

  if (!prompt && events.length === 0 && !running) {
    return (
      <EmptyState
        heading="No activity yet."
        hint="Message the agent below to start a session."
      />
    );
  }

  return (
    <div style={thread}>
      {prompt && (
        <section style={turn}>
          <div style={role}>You</div>
          <div style={{ color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>{prompt}</div>
        </section>
      )}
      {(events.length > 0 || running) && (
        <section style={turn}>
          <div style={role}>Agent</div>
          {events.length > 0 && <EventStream events={events} />}
          {running && <RunningIndicator />}
        </section>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

const thread: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  padding: "var(--space-3)",
};

const turn: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

const role: CSSProperties = {
  fontSize: "var(--fs-12)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-muted)",
};

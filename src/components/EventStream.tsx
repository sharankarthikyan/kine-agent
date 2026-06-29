import type { CSSProperties } from "react";
import type { AgentEvent } from "../lib/agent";
import { EmptyState } from "./EmptyState";

interface EventStreamProps {
  events: AgentEvent[];
}

export function EventStream({ events }: EventStreamProps) {
  if (events.length === 0) {
    return (
      <EmptyState
        heading="No activity yet."
        hint="Describe a task above and press Start to run an agent."
      />
    );
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: "var(--space-2)" }}>
      {/* index key is safe: the stream is append-only (events are never
          reordered or removed). Revisit if a clear/filter feature is added. */}
      {events.map((event, i) => (
        <li key={i} style={rowStyle}>
          {renderEvent(event)}
        </li>
      ))}
    </ul>
  );
}

const rowStyle: CSSProperties = {
  padding: "var(--space-2) var(--space-3)",
  borderBottom: "1px solid var(--border-hairline)",
  minHeight: "var(--row-h)",
};

function renderEvent(event: AgentEvent) {
  switch (event.kind) {
    case "token":
      return <span style={{ color: "var(--text-body)" }}>{event.data.text}</span>;
    case "toolCall":
      return (
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--status-running)" }}>
          {event.data.name}({event.data.input})
        </span>
      );
    case "fileWrite":
      return (
        <span style={{ fontFamily: "var(--font-mono)" }}>
          wrote {event.data.path}
        </span>
      );
    case "approvalNeeded":
      return (
        <span style={{ color: "var(--status-waiting)" }}>
          Needs approval: {event.data.prompt}
        </span>
      );
    case "done":
      return (
        <span style={{ color: "var(--status-success)" }}>
          Done: {event.data.summary}
        </span>
      );
    case "error":
      return (
        <span role="alert" style={{ color: "var(--status-error)" }}>
          {event.data.message}
        </span>
      );
    default: {
      // Exhaustiveness guard: adding a new AgentEvent variant without a case
      // above becomes a compile error here instead of silently rendering nothing.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

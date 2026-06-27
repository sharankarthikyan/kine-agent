import type { CSSProperties } from "react";
import type { AgentEvent } from "../lib/agent";

interface EventStreamProps {
  events: AgentEvent[];
}

export function EventStream({ events }: EventStreamProps) {
  if (events.length === 0) {
    return (
      <p style={{ color: "var(--text-muted)", padding: "var(--space-4)" }}>
        No activity yet.
      </p>
    );
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: "var(--space-2)" }}>
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
  }
}

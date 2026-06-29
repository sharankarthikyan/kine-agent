import type { CSSProperties } from "react";
import { Fragment } from "react";
import type { AgentEvent } from "../lib/agent";
import { EmptyState } from "./EmptyState";
import { Markdown } from "./Markdown";

interface EventStreamProps {
  events: AgentEvent[];
}

/**
 * Renders one agent turn's activity as a single cohesive flow — prose as the
 * dominant element, tool calls / file writes as compact muted chips, errors as a
 * red-accented block. No per-event dividers (research: separate with space, not
 * lines). The `done` result is NOT re-rendered when prose already exists — the
 * streamed text is the answer; it's only shown when the turn produced no prose.
 */
export function EventStream({ events }: EventStreamProps) {
  if (events.length === 0) {
    return (
      <EmptyState
        heading="No activity yet."
        hint="Describe a task above and press Start to run an agent."
      />
    );
  }
  const hasProse = events.some((e) => e.kind === "token");
  return (
    <div style={flow}>
      {events.map((event, i) => (
        <Fragment key={i}>{renderEvent(event, hasProse)}</Fragment>
      ))}
    </div>
  );
}

const flow: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "var(--space-3)",
};

function renderEvent(event: AgentEvent, hasProse: boolean) {
  switch (event.kind) {
    case "token":
      // Agent prose is Markdown and is the dominant element of the turn.
      return <Markdown>{event.data.text}</Markdown>;
    case "toolCall":
      return (
        <span style={chip} title={event.data.input}>
          <span style={{ color: "var(--status-running)" }}>{event.data.name}</span>
          <span style={{ color: "var(--text-muted)" }}>{summarize(event.data.input)}</span>
        </span>
      );
    case "fileWrite":
      return (
        <span style={chip}>
          <span style={{ color: "var(--text-muted)" }}>✎</span>
          <span>{event.data.path}</span>
        </span>
      );
    case "approvalNeeded":
      // The one event that earns a real card — it's an interactive gate.
      return (
        <div style={approvalCard}>
          <div style={{ color: "var(--status-waiting)", fontWeight: 500, marginBottom: "var(--space-1)" }}>
            Needs approval
          </div>
          <div style={{ color: "var(--text-body)" }}>{event.data.prompt}</div>
        </div>
      );
    case "done":
      // Don't echo the final text — the prose already showed it. Only render the
      // summary when the turn produced no prose at all.
      return hasProse ? null : <Markdown>{event.data.summary}</Markdown>;
    case "error":
      return (
        <div role="alert" style={errorBlock}>
          {event.data.message}
        </div>
      );
    default: {
      // Exhaustiveness guard: a new AgentEvent variant without a case becomes a
      // compile error here instead of silently rendering nothing.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** Compact one-line preview of a tool's JSON input for the chip. */
function summarize(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "{}") return "";
  const oneLine = trimmed.replace(/\s+/g, " ");
  return ` ${oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine}`;
}

const chip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  maxWidth: "100%",
  padding: "2px 8px",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-card)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-12)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const approvalCard: CSSProperties = {
  width: "100%",
  padding: "var(--space-3)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--status-waiting)",
  background: "var(--bg-card)",
  fontSize: "var(--fs-13)",
};

const errorBlock: CSSProperties = {
  width: "100%",
  paddingLeft: "var(--space-3)",
  borderLeft: "2px solid var(--status-error)",
  color: "var(--status-error)",
  fontSize: "var(--fs-13)",
  whiteSpace: "pre-wrap",
};

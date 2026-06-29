import { Fragment } from "react";
import type { AgentEvent } from "../lib/agent";
import { EmptyState } from "./EmptyState";
import { Markdown } from "./Markdown";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Wrench, Pencil } from "lucide-react";

interface EventStreamProps {
  events: AgentEvent[];
}

/**
 * Renders one agent turn's activity as a single cohesive flow — prose as the
 * dominant element, tool calls / file writes as compact muted chips, errors as a
 * destructive Alert. No per-event dividers (space, not lines). The `done` result
 * is NOT re-rendered when prose already exists — the streamed text is the answer;
 * it's only shown when the turn produced no prose.
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
    <div className="flex flex-col items-start gap-3">
      {events.map((event, i) => (
        <Fragment key={i}>{renderEvent(event, hasProse)}</Fragment>
      ))}
    </div>
  );
}

function renderEvent(event: AgentEvent, hasProse: boolean) {
  switch (event.kind) {
    case "token":
      // Agent prose is Markdown and is the dominant element of the turn.
      return <Markdown>{event.data.text}</Markdown>;

    case "toolCall":
      return (
        <Badge
          variant="secondary"
          className="gap-1 max-w-full overflow-hidden font-mono font-normal"
          title={event.data.input}
        >
          <Wrench aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">
            {event.data.name}
            {summarize(event.data.input)}
          </span>
        </Badge>
      );

    case "fileWrite":
      return (
        <Badge
          variant="secondary"
          className="gap-1 max-w-full overflow-hidden font-mono font-normal"
        >
          <Pencil aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{event.data.path}</span>
        </Badge>
      );

    case "approvalNeeded":
      // The one event that earns a real card — it's an interactive gate.
      return (
        <Alert className="w-full">
          <AlertTitle>Needs approval</AlertTitle>
          <AlertDescription>{event.data.prompt}</AlertDescription>
        </Alert>
      );

    case "done":
      // Don't echo the final text — the prose already showed it. Only render the
      // summary when the turn produced no prose at all.
      return hasProse ? null : <Markdown>{event.data.summary}</Markdown>;

    case "error":
      return (
        <Alert variant="destructive" className="w-full">
          <AlertDescription>{event.data.message}</AlertDescription>
        </Alert>
      );

    case "usage":
      // Rendered by the Context panel, not the chat stream. Ignore here.
      return null;

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

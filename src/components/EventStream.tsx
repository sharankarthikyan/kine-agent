import { Fragment, type KeyboardEvent } from "react";
import type { AgentEvent } from "../lib/agent";
import { EmptyState } from "./EmptyState";
import { Markdown } from "./Markdown";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Wrench, Pencil } from "lucide-react";

interface EventStreamProps {
  events: AgentEvent[];
  /** Open a file's diff when a file-related tool chip is clicked. */
  onOpenFile?: (path: string) => void;
}

/**
 * Renders one agent turn's activity as a single cohesive flow — prose as the
 * dominant element, tool calls / file writes as compact muted chips, errors as a
 * destructive Alert. No per-event dividers (space, not lines). The `done` result
 * is NOT re-rendered when prose already exists — the streamed text is the answer;
 * it's only shown when the turn produced no prose.
 */
export function EventStream({ events, onOpenFile }: EventStreamProps) {
  if (events.length === 0) {
    return (
      <EmptyState
        heading="No activity yet."
        hint="Describe a task above and press Start to run an agent."
      />
    );
  }
  const hasProse = events.some((e) => e.kind === "token");
  const groups = groupChipRuns(events);
  return (
    <div className="flex flex-col items-start gap-3">
      {groups.map((group, i) =>
        group.kind === "chips" ? (
          // A burst of tool/file calls flows inline and wraps, instead of one
          // chip per line — far less vertical noise when an agent reads N files.
          <div key={i} className="flex w-full flex-wrap gap-1.5">
            {group.events.map((event, j) => (
              <Fragment key={j}>{renderEvent(event, hasProse, onOpenFile)}</Fragment>
            ))}
          </div>
        ) : (
          <Fragment key={i}>{renderEvent(group.event, hasProse, onOpenFile)}</Fragment>
        )
      )}
    </div>
  );
}

type ChipGroup =
  | { kind: "chips"; events: AgentEvent[] }
  | { kind: "single"; event: AgentEvent };

/** Coalesce consecutive tool/file-write events into one wrapping chip cluster. */
function groupChipRuns(events: AgentEvent[]): ChipGroup[] {
  const groups: ChipGroup[] = [];
  for (const event of events) {
    const isChip = event.kind === "toolCall" || event.kind === "fileWrite";
    const last = groups[groups.length - 1];
    if (isChip && last && last.kind === "chips") {
      last.events.push(event);
    } else if (isChip) {
      groups.push({ kind: "chips", events: [event] });
    } else {
      groups.push({ kind: "single", event });
    }
  }
  return groups;
}

function renderEvent(
  event: AgentEvent,
  hasProse: boolean,
  onOpenFile?: (path: string) => void,
) {
  switch (event.kind) {
    case "token":
      // Agent prose is Markdown and is the dominant element of the turn.
      return <Markdown>{event.data.text}</Markdown>;

    case "toolCall": {
      const summary = describeToolCall(event.data.name, event.data.input);
      const filePath = fileTargetPath(event.data.name, event.data.input);
      const clickable = filePath !== null && onOpenFile !== undefined;
      return (
        <Badge
          variant="secondary"
          className={`gap-1.5 max-w-full overflow-hidden font-normal ${
            clickable ? "cursor-pointer hover:bg-secondary/70" : ""
          }`}
          title={event.data.input}
          {...(clickable
            ? {
                role: "button",
                tabIndex: 0,
                onClick: () => onOpenFile!(filePath!),
                onKeyDown: (e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenFile!(filePath!);
                  }
                },
              }
            : {})}
        >
          <Wrench aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">
            <span className="font-medium">{event.data.name}</span>
            {summary && (
              <span className="text-muted-foreground font-mono"> · {summary}</span>
            )}
          </span>
        </Badge>
      );
    }

    case "fileWrite": {
      const clickable = onOpenFile !== undefined && event.data.path !== "";
      return (
        <Badge
          variant="secondary"
          className={`gap-1 max-w-full overflow-hidden font-mono font-normal ${
            clickable ? "cursor-pointer hover:bg-secondary/70" : ""
          }`}
          {...(clickable
            ? {
                role: "button",
                tabIndex: 0,
                onClick: () => onOpenFile!(event.data.path),
                onKeyDown: (e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenFile!(event.data.path);
                  }
                },
              }
            : {})}
        >
          <Pencil aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{event.data.path}</span>
        </Badge>
      );
    }

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

/**
 * Human-readable summary of a tool call's most meaningful argument — e.g.
 * `Read · App.tsx`, `Bash · npm test`, `Agent · Review portfolio UI/UX`.
 * Falls back to "" (chip shows just the tool name) when nothing useful parses.
 */
/**
 * The file path a tool acted on, for the file tools whose chip should open a
 * diff on click (Read/Write/Edit/NotebookEdit). Returns null for non-file tools.
 */
function fileTargetPath(name: string, input: string): string | null {
  if (!["Read", "Write", "Edit", "NotebookEdit"].includes(name)) return null;
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object") return null;
    const args = parsed as Record<string, unknown>;
    const path = args.file_path ?? args.path ?? args.notebook_path;
    return typeof path === "string" && path.trim() !== "" ? path : null;
  } catch {
    return null;
  }
}

function describeToolCall(name: string, input: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    return "";
  }
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  const basename = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit": {
      const path = str(args.file_path) ?? str(args.path) ?? str(args.notebook_path);
      return path ? basename(path) : "";
    }
    case "Bash":
      return str(args.command) ?? "";
    case "Grep":
    case "Glob":
      return str(args.pattern) ?? "";
    case "Task":
    case "Agent":
      return str(args.description) ?? str(args.subagent_type) ?? "";
    case "WebFetch":
      return str(args.url) ?? "";
    case "WebSearch":
      return str(args.query) ?? "";
    default: {
      const firstString = Object.values(args).find(
        (value): value is string => typeof value === "string" && value.trim() !== ""
      );
      return firstString ?? "";
    }
  }
}

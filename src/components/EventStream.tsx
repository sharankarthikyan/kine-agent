import { Fragment } from "react";
import type { AgentEvent } from "../lib/agent";
import { EmptyState } from "./EmptyState";
import { Markdown } from "./Markdown";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Wrench, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

interface EventStreamProps {
  events: AgentEvent[];
  /** Open a file's diff when a file-related tool chip is clicked. */
  onOpenFile?: (path: string) => void;
  /**
   * Answer a pending approval request. When provided, an `approvalNeeded` event renders
   * Approve/Deny buttons; when omitted (e.g. historical turns), it renders a read-only
   * notice. Agent-agnostic: any agent that raises an approval is answered the same way.
   */
  onApprovalRespond?: (requestId: string, approve: boolean) => void;
}

/**
 * Renders one agent turn's activity as a single cohesive flow — prose as the
 * dominant element, tool calls / file writes as compact muted chips, errors as a
 * destructive Alert. No per-event dividers (space, not lines). The `done` result
 * is NOT re-rendered when prose already exists — the streamed text is the answer;
 * it's only shown when the turn produced no prose.
 */
export function EventStream({ events, onOpenFile, onApprovalRespond }: EventStreamProps) {
  if (events.length === 0) {
    return (
      <EmptyState
        heading="No activity yet."
        hint="Describe a task above and press Start to run an agent."
      />
    );
  }
  const hasProse = events.some((e) => e.kind === "token");
  const groups = groupEventRuns(events);
  return (
    <div className="flex flex-col items-start gap-3">
      {groups.map((group, i) =>
        group.kind === "chips" ? (
          // A burst of tool/file calls flows inline and wraps, instead of one
          // chip per line — far less vertical noise when an agent reads N files.
          <div key={i} className="flex w-full flex-wrap gap-1.5">
            {group.events.map((event, j) => (
              <Fragment key={j}>
                {renderEvent(event, hasProse, onOpenFile, onApprovalRespond)}
              </Fragment>
            ))}
          </div>
        ) : group.kind === "prose" ? (
          <Markdown key={i}>{group.text}</Markdown>
        ) : (
          <Fragment key={i}>
            {renderEvent(group.event, hasProse, onOpenFile, onApprovalRespond)}
          </Fragment>
        )
      )}
    </div>
  );
}

type ChipGroup =
  | { kind: "chips"; events: AgentEvent[] }
  | { kind: "prose"; text: string }
  | { kind: "single"; event: AgentEvent };

/** Coalesce streaming text and chip bursts so a live turn reads as one stable flow. */
function groupEventRuns(events: AgentEvent[]): ChipGroup[] {
  const groups: ChipGroup[] = [];
  for (const event of events) {
    const isChip = event.kind === "toolCall" || event.kind === "fileWrite";
    const last = groups[groups.length - 1];
    if (event.kind === "token" && last && last.kind === "prose") {
      last.text += event.data.text;
    } else if (event.kind === "token") {
      groups.push({ kind: "prose", text: event.data.text });
    } else if (isChip && last && last.kind === "chips") {
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
  onApprovalRespond?: (requestId: string, approve: boolean) => void,
) {
  switch (event.kind) {
    case "token":
      // Agent prose is Markdown and is the dominant element of the turn.
      return <Markdown>{event.data.text}</Markdown>;

    case "status":
      return (
        <div className="text-sm font-medium text-muted-foreground">
          {event.data.text}
        </div>
      );

    case "toolCall": {
      const summary = describeToolCall(event.data.name, event.data.input);
      const filePath = fileTargetPath(event.data.name, event.data.input);
      const clickable = filePath !== null && onOpenFile !== undefined;
      const className = "gap-1.5 max-w-full overflow-hidden font-normal";
      const content = (
        <>
          <Wrench aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">
            <span className="font-medium">{event.data.name}</span>
            {summary && (
              <span className="text-muted-foreground font-mono"> · {summary}</span>
            )}
          </span>
        </>
      );
      return clickable ? (
        <button
          type="button"
          className={cn(badgeVariants({ variant: "secondary" }), className, "cursor-pointer hover:bg-secondary/70")}
          title={event.data.input}
          onClick={() => onOpenFile!(filePath!)}
        >
          {content}
        </button>
      ) : (
        <Badge variant="secondary" className={className} title={event.data.input}>
          {content}
        </Badge>
      );
    }

    case "fileWrite": {
      const clickable = onOpenFile !== undefined && event.data.path !== "";
      const className = "gap-1 max-w-full overflow-hidden font-mono font-normal";
      const content = (
        <>
          <Pencil aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{event.data.path}</span>
        </>
      );
      return clickable ? (
        <button
          type="button"
          className={cn(badgeVariants({ variant: "secondary" }), className, "cursor-pointer hover:bg-secondary/70")}
          onClick={() => onOpenFile!(event.data.path)}
        >
          {content}
        </button>
      ) : (
        <Badge variant="secondary" className={className}>
          {content}
        </Badge>
      );
    }

    case "approvalNeeded":
      // A gated tool call awaiting the user's decision. When an answer handler is wired
      // (a live run), show Approve/Deny; otherwise (historical turns, or an agent with no
      // answerable gate) show a read-only notice so the card never implies a dead button.
      return (
        <Alert className="w-full">
          <AlertTitle>Approval required</AlertTitle>
          <AlertDescription>{event.data.prompt}</AlertDescription>
          {onApprovalRespond && (
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                onClick={() => onApprovalRespond(event.data.requestId, true)}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onApprovalRespond(event.data.requestId, false)}
              >
                Deny
              </Button>
            </div>
          )}
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
      // Compile-time exhaustiveness stays (a new union member without a case is a
      // type error on the next line), but at RUNTIME an unknown persisted kind —
      // written by a newer backend — must degrade to nothing, not crash the render.
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
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
  // Separator-agnostic: agent tool-call file paths may be absolute Windows paths.
  const basename = (path: string): string =>
    path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

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

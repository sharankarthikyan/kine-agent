import { Fragment } from "react";
import type { AgentEvent } from "../lib/agent";
import { EmptyState } from "./EmptyState";
import { Markdown } from "./Markdown";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Wrench, Pencil, Check, Loader2, X, Circle } from "lucide-react";
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
  // Last-write-wins status per tool call id; toolStatus rows never render
  // themselves — they upgrade the chip with the matching id.
  const statusById = new Map<string, string>();
  for (const e of events) {
    if (e.kind === "toolStatus") statusById.set(e.data.toolCallId, e.data.status);
  }
  const lastPlanIndex = events.reduce(
    (acc, e, i) => (e.kind === "plan" ? i : acc),
    -1,
  );
  const visible = events.filter(
    (e, i) => e.kind !== "toolStatus" && (e.kind !== "plan" || i === lastPlanIndex),
  );
  const hasProse = visible.some((e) => e.kind === "token");
  const groups = groupEventRuns(visible);
  return (
    <div className="flex flex-col items-start gap-3">
      {groups.map((group, i) =>
        group.kind === "chips" ? (
          // A burst of tool/file calls flows inline and wraps, instead of one
          // chip per line — far less vertical noise when an agent reads N files.
          <div key={i} className="flex w-full flex-wrap gap-1.5">
            {group.events.map((event, j) => (
              <Fragment key={j}>
                {renderEvent(event, hasProse, statusById, onOpenFile, onApprovalRespond)}
              </Fragment>
            ))}
          </div>
        ) : group.kind === "prose" ? (
          <Markdown key={i}>{group.text}</Markdown>
        ) : group.kind === "thought" ? (
          // Reasoning stream: present but quiet — collapsed by default, native
          // disclosure so no state is needed and historical turns behave identically.
          <details key={i} className="w-full text-sm text-muted-foreground">
            <summary className="cursor-pointer select-none italic">Thinking…</summary>
            <div className="mt-1 border-l-2 border-muted pl-3">
              <Markdown>{group.text}</Markdown>
            </div>
          </details>
        ) : (
          <Fragment key={i}>
            {renderEvent(group.event, hasProse, statusById, onOpenFile, onApprovalRespond)}
          </Fragment>
        )
      )}
    </div>
  );
}

type ChipGroup =
  | { kind: "chips"; events: AgentEvent[] }
  | { kind: "prose"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "single"; event: AgentEvent };

/** Coalesce streaming text and chip bursts so a live turn reads as one stable flow. */
function groupEventRuns(events: AgentEvent[]): ChipGroup[] {
  const groups: ChipGroup[] = [];
  for (const event of events) {
    const isChip = event.kind === "toolCall" || event.kind === "fileWrite";
    const last = groups[groups.length - 1];
    if (event.kind === "thought" && last && last.kind === "thought") {
      last.text += event.data.text;
    } else if (event.kind === "thought") {
      groups.push({ kind: "thought", text: event.data.text });
    } else if (event.kind === "token" && last && last.kind === "prose") {
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
  statusById: Map<string, string>,
  onOpenFile?: (path: string) => void,
  onApprovalRespond?: (requestId: string, approve: boolean) => void,
) {
  switch (event.kind) {
    case "token":
      // Unreachable in practice: groupEventRuns coalesces every token run into a
      // "prose" group rendered directly. Kept because removing the case would send
      // "token" into the default arm and break its `never` exhaustiveness check.
      return <Markdown>{event.data.text}</Markdown>;

    case "thought":
      // Unreachable: groupEventRuns coalesces thought runs into a "thought" group.
      return null;

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
      const status = event.data.toolCallId
        ? statusById.get(event.data.toolCallId)
        : undefined;
      const icon =
        status === "completed" ? (
          <Check aria-hidden="true" className="size-3 shrink-0" />
        ) : status === "failed" ? (
          <X aria-hidden="true" className="size-3 shrink-0 text-destructive" />
        ) : status === "pending" || status === "in_progress" ? (
          <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : (
          <Wrench aria-hidden="true" className="size-3 shrink-0" />
        );
      const content = (
        <span
          data-testid={event.data.toolCallId ? `tool-status-${event.data.toolCallId}` : undefined}
          data-status={status}
          className="flex items-center gap-1.5 min-w-0"
        >
          {icon}
          <span className="truncate">
            <span className="font-medium">{event.data.name}</span>
            {summary && (
              <span className="text-muted-foreground font-mono"> · {summary}</span>
            )}
          </span>
        </span>
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

    case "commands":
      // Feeds the composer's `/` autocomplete (via App state), not the transcript.
      return null;

    case "toolStatus":
      // Filtered out of `visible` before grouping — this event never renders
      // its own row, it only decorates the matching toolCall chip. Case kept
      // purely for the `never` exhaustiveness check below.
      return null;

    case "plan": {
      let entries: { content: string; status: string }[];
      try {
        const parsed = JSON.parse(event.data.entriesJson);
        if (!Array.isArray(parsed)) return null;
        entries = parsed.filter(
          (e): e is { content: string; status: string } =>
            !!e && typeof e === "object" && typeof (e as Record<string, unknown>).content === "string",
        );
      } catch {
        return null; // malformed agent output degrades to nothing (convention)
      }
      if (entries.length === 0) return null;
      return (
        <div className="w-full rounded-md border p-3 text-sm">
          <div className="mb-2 font-medium text-muted-foreground">Plan</div>
          <ul className="flex flex-col gap-1.5">
            {entries.map((entry, i) => (
              <li
                key={i}
                className={cn(
                  "flex items-start gap-2",
                  entry.status === "completed" && "text-muted-foreground line-through",
                  entry.status === "in_progress" && "font-medium",
                )}
              >
                {entry.status === "completed" ? (
                  <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                ) : entry.status === "in_progress" ? (
                  <Loader2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Circle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span>{entry.content}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    }

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

import { Fragment, useState } from "react";
import type { AgentEvent } from "../lib/agent";
import { EmptyState } from "./EmptyState";
import { Markdown } from "./Markdown";
import { TerminalView } from "./TerminalView";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Wrench,
  Pencil,
  Check,
  Loader2,
  X,
  Circle,
  ChevronDown,
  ShieldQuestion,
  Terminal,
  Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DiffLineKind } from "@/lib/parsePatch";

interface EventStreamProps {
  events: AgentEvent[];
  /** Open a file's diff when a file-related tool chip is clicked. */
  onOpenFile?: (path: string) => void;
  /** Open the agent's real interactive login flow when auth is required. */
  onOpenAuthLogin?: (agent: string) => void;
  /**
   * Answer a pending approval request. When provided, an `approvalNeeded` event renders
   * one button per option; when omitted (e.g. historical turns), it renders a read-only
   * notice. Agent-agnostic: any agent that raises an approval is answered the same way.
   */
  onApprovalRespond?: (requestId: string, selectedOptionId: string) => void;
}

/**
 * Renders one agent turn's activity as a single cohesive flow — prose as the
 * dominant element, tool calls / file writes as compact muted chips, errors as a
 * destructive Alert. No per-event dividers (space, not lines). The `done` result
 * is NOT re-rendered when prose already exists — the streamed text is the answer;
 * it's only shown when the turn produced no prose.
 */
export function EventStream({ events, onOpenFile, onOpenAuthLogin, onApprovalRespond }: EventStreamProps) {
  const [openToolKey, setOpenToolKey] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const handleCopyCommand = (command: string) => {
    void navigator.clipboard?.writeText(command).catch(() => undefined);
    setCopiedCommand(command);
    window.setTimeout(() => {
      setCopiedCommand((current) => (current === command ? null : current));
    }, 1400);
  };
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
  // Ordered concat of terminal output per tool call; exit metadata last-write-wins.
  const terminalTextById = new Map<string, string>();
  const terminalExitById = new Map<string, { exitCode: number | null; signal: string | null; droppedBytes?: number }>();
  for (const e of events) {
    if (e.kind === "terminalOutput") {
      terminalTextById.set(e.data.toolCallId, (terminalTextById.get(e.data.toolCallId) ?? "") + e.data.data);
    }
    if (e.kind === "terminalExit") {
      terminalExitById.set(e.data.toolCallId, {
        exitCode: e.data.exitCode ?? null,
        signal: e.data.signal ?? null,
        droppedBytes: e.data.droppedBytes,
      });
    }
  }
  // Last-write-wins answer per approval request id; approvalResolved rows never
  // render themselves — they flip the matching approvalNeeded card to answered.
  const resolvedApprovals = new Map<string, string>();
  for (const e of events) {
    if (e.kind === "approvalResolved") resolvedApprovals.set(e.data.requestId, e.data.selectedOptionId);
  }
  const lastPlanIndex = events.reduce(
    (acc, e, i) => (e.kind === "plan" ? i : acc),
    -1,
  );
  const visible = events.filter(
    (e, i) =>
      e.kind !== "toolStatus" &&
      e.kind !== "terminalOutput" &&
      e.kind !== "terminalExit" &&
      e.kind !== "approvalResolved" &&
      (e.kind !== "plan" || i === lastPlanIndex),
  );
  const hasProse = visible.some((e) => e.kind === "token");
  const groups = groupEventRuns(visible);
  return (
    <div className="flex flex-col items-start gap-3">
      {groups.map((group, i) =>
        group.kind === "chips" ? (
          // A burst of tool/file calls flows inline and wraps, instead of one
          // chip per line — far less vertical noise when an agent reads N files.
          <ToolChipRun
            key={i}
            runKey={`run-${i}`}
            events={group.events}
            hasProse={hasProse}
            statusById={statusById}
            resolvedApprovals={resolvedApprovals}
            terminalTextById={terminalTextById}
            terminalExitById={terminalExitById}
            openToolKey={openToolKey}
            onToggleTool={setOpenToolKey}
            onOpenFile={onOpenFile}
            onApprovalRespond={onApprovalRespond}
            copiedCommand={copiedCommand}
            onCopyCommand={handleCopyCommand}
          />
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
            {renderEvent(
              group.event,
              hasProse,
              statusById,
              resolvedApprovals,
              onOpenFile,
              onOpenAuthLogin,
              onApprovalRespond,
              openToolKey,
              setOpenToolKey,
              undefined,
              copiedCommand,
              handleCopyCommand,
            )}
          </Fragment>
        )
      )}
    </div>
  );
}

interface ToolChipRunProps {
  runKey: string;
  events: AgentEvent[];
  hasProse: boolean;
  statusById: Map<string, string>;
  resolvedApprovals: Map<string, string>;
  terminalTextById: Map<string, string>;
  terminalExitById: Map<string, { exitCode: number | null; signal: string | null; droppedBytes?: number }>;
  openToolKey: string | null;
  onToggleTool: (key: string | null) => void;
  onOpenFile?: (path: string) => void;
  onOpenAuthLogin?: (agent: string) => void;
  onApprovalRespond?: (requestId: string, selectedOptionId: string) => void;
  copiedCommand: string | null;
  onCopyCommand: (command: string) => void;
}

function ToolChipRun({
  runKey,
  events,
  hasProse,
  statusById,
  resolvedApprovals,
  terminalTextById,
  terminalExitById,
  openToolKey,
  onToggleTool,
  onOpenFile,
  onOpenAuthLogin,
  onApprovalRespond,
  copiedCommand,
  onCopyCommand,
}: ToolChipRunProps) {
  const openIndex = events.findIndex(
    (event, index) => toolKey(event, index, runKey) === openToolKey,
  );
  const openEvent = openIndex >= 0 ? events[openIndex] : null;
  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex w-full flex-wrap gap-1.5">
        {events.map((event, j) => (
          <Fragment key={j}>
            {renderEvent(
              event,
              hasProse,
              statusById,
              resolvedApprovals,
              onOpenFile,
              onOpenAuthLogin,
              onApprovalRespond,
              openToolKey,
              onToggleTool,
              toolKey(event, j, runKey),
              copiedCommand,
              onCopyCommand,
            )}
          </Fragment>
        ))}
      </div>
      {events
        .filter(
          (e) =>
            e.kind === "toolCall" &&
            e.data.toolCallId &&
            terminalTextById.has(e.data.toolCallId) &&
            ["pending", "in_progress"].includes(statusById.get(e.data.toolCallId) ?? ""),
        )
        .map((e) =>
          e.kind === "toolCall" && e.data.toolCallId ? (
            <TerminalView
              key={`term-${e.data.toolCallId}`}
              text={terminalTextById.get(e.data.toolCallId) ?? ""}
              running
              maxLines={12}
            />
          ) : null,
        )}
      {openEvent && (
        <ToolDetails
          event={openEvent}
          status={
            openEvent.kind === "toolCall" && openEvent.data.toolCallId
              ? statusById.get(openEvent.data.toolCallId)
              : undefined
          }
          terminalText={
            openEvent.kind === "toolCall" && openEvent.data.toolCallId
              ? terminalTextById.get(openEvent.data.toolCallId)
              : undefined
          }
          terminalExit={
            openEvent.kind === "toolCall" && openEvent.data.toolCallId
              ? terminalExitById.get(openEvent.data.toolCallId)
              : undefined
          }
          onClose={() => onToggleTool(null)}
        />
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
  resolvedApprovals: Map<string, string>,
  onOpenFile?: (path: string) => void,
  onOpenAuthLogin?: (agent: string) => void,
  onApprovalRespond?: (requestId: string, selectedOptionId: string) => void,
  openToolKey?: string | null,
  onToggleTool?: (key: string | null) => void,
  eventKey?: string,
  copiedCommand?: string | null,
  onCopyCommand?: (command: string) => void,
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
      const hasInlineDetails = editDetailsFromToolInput(event.data.name, event.data.input) !== null;
      const clickable = filePath !== null && onOpenFile !== undefined && !hasInlineDetails;
      const key = eventKey ?? toolKey(event, 0);
      const detailsOpen = openToolKey === key;
      const className = "gap-1.5 max-w-full overflow-hidden font-normal transition-colors";
      const status = event.data.toolCallId
        ? statusById.get(event.data.toolCallId)
        : undefined;
      const label = displayToolName(event.data.name);
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
          className="flex min-w-0 items-center gap-1.5"
        >
          {icon}
          <span className="truncate">
            <span className="font-medium">{label}</span>
            {summary && (
              <span className="font-mono text-muted-foreground"> · {summary}</span>
            )}
          </span>
          {!clickable && (
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform",
                detailsOpen && "rotate-180",
              )}
            />
          )}
        </span>
      );
      return clickable ? (
        <button
          type="button"
          className={cn(badgeVariants({ variant: "secondary" }), className, "cursor-pointer hover:bg-secondary/70")}
          title={`Open ${summary || label}`}
          onClick={() => onOpenFile!(filePath!)}
        >
          {content}
        </button>
      ) : (
        <button
          type="button"
          aria-expanded={detailsOpen}
          className={cn(badgeVariants({ variant: "secondary" }), className, "cursor-pointer hover:bg-secondary/70")}
          onClick={() => onToggleTool?.(detailsOpen ? null : key)}
        >
          {content}
        </button>
      );
    }

    case "fileWrite": {
      const clickable = onOpenFile !== undefined && event.data.path !== "";
      const className = "gap-1 max-w-full overflow-hidden font-mono font-normal";
      const content = (
        <>
          <Pencil aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{compactPath(event.data.path)}</span>
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

    case "approvalNeeded": {
      // A gated tool call awaiting the user's decision. One button per option the
      // agent offered (pipe emits a fixed Allow/Deny pair; ACP supplies its own).
      // Legacy persisted events predate options — fall back to the binary pair.
      const options =
        event.data.options && event.data.options.length > 0
          ? event.data.options
          : [
              { id: "allow", label: "Allow", kind: "allow_once" },
              { id: "deny", label: "Deny", kind: "reject_once" },
            ];
      const answeredId = resolvedApprovals.get(event.data.requestId);
      const answeredLabel =
        answeredId !== undefined
          ? (options.find((o) => o.id === answeredId)?.label ?? answeredId)
          : undefined;
      return (
        <div className="w-full max-w-2xl rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-sm">
          <div className="flex items-start gap-2">
            <ShieldQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">Approval needed</div>
              <div className="mt-0.5 break-words text-muted-foreground">{event.data.prompt}</div>
            </div>
          </div>
          {answeredLabel !== undefined ? (
            <div className="mt-2 flex items-center gap-1.5 pl-6 text-xs text-muted-foreground">
              <Check aria-hidden="true" className="size-3.5 shrink-0" />
              {answeredLabel}
            </div>
          ) : (
            onApprovalRespond && (
              <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
                {options.map((option) => (
                  <Button
                    key={option.id}
                    size="sm"
                    variant={option.kind.startsWith("reject") ? "outline" : "default"}
                    className="h-7 px-2 text-xs"
                    onClick={() => onApprovalRespond(event.data.requestId, option.id)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            )
          )}
        </div>
      );
    }

    case "approvalResolved":
      // Filtered out of `visible` before grouping — it only flips the matching
      // approvalNeeded card to its answered state. Case kept purely for the
      // `never` exhaustiveness check below.
      return null;

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

    case "authRequired": {
      const isAntigravity = event.data.agent === "antigravity";
      const title = isAntigravity ? "Antigravity login needed" : "Sign in required";
      const commandLabel = isAntigravity ? "Manual terminal command" : "Run in terminal";
      const commandCopied = copiedCommand === event.data.command;
      return (
        <div className="w-full max-w-2xl rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5 text-sm">
          <div className="flex items-start gap-2">
            <Terminal aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{title}</div>
              <div className="mt-0.5 break-words text-muted-foreground">
                {event.data.message}
              </div>
              {isAntigravity && (
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                  <li>Open Antigravity's login terminal from Kineloop.</li>
                  <li>Choose a login method in that terminal.</li>
                  <li>Finish the browser step.</li>
                  <li>Paste the browser access code into the terminal prompt, then retry here.</li>
                </ol>
              )}
              {isAntigravity && onOpenAuthLogin && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => onOpenAuthLogin(event.data.agent)}
                  >
                    Open login terminal
                  </Button>
                  <div className="text-xs text-muted-foreground">
                    Kineloop does not accept the code in chat.
                  </div>
                </div>
              )}
              <div className="mt-2 min-w-0">
                <div className="mb-1 text-xs font-medium text-muted-foreground">{commandLabel}</div>
                <div className="flex min-w-0 items-center gap-1.5">
                  <code className="min-w-0 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
                    {event.data.command}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "size-7 shrink-0 transition-colors",
                      commandCopied && "text-foreground",
                    )}
                    aria-label={
                      commandCopied
                        ? `Copied ${event.data.agent} sign-in command`
                        : `Copy ${event.data.agent} sign-in command`
                    }
                    onClick={() => onCopyCommand?.(event.data.command)}
                  >
                    {commandCopied ? (
                      <Check aria-hidden="true" className="size-3.5" />
                    ) : (
                      <Copy aria-hidden="true" className="size-3.5" />
                    )}
                  </Button>
                  {commandCopied && (
                    <span className="shrink-0 text-xs text-muted-foreground">Copied</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    case "notice":
      // Adapter-surfaced note (e.g. resume fallback). Quiet by design — it is
      // context, not an error.
      return (
        <p className="text-xs italic text-muted-foreground">{event.data.message}</p>
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

    case "terminalOutput":
    case "terminalExit":
      // Filtered out of `visible`; they decorate the matching toolCall chip
      // (renderer lands with the TerminalView task). Kept for exhaustiveness.
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

function toolKey(event: AgentEvent, index: number, scope = "single"): string {
  if (event.kind === "toolCall") {
    return event.data.toolCallId
      ? `tool:${event.data.toolCallId}`
      : `tool:${scope}:${index}:${event.data.name}`;
  }
  if (event.kind === "fileWrite") return `file:${scope}:${index}:${event.data.path}`;
  return `${event.kind}:${scope}:${index}`;
}

function displayToolName(name: string): string {
  const trimmed = name.trim().replace(/^Tool:\s*/i, "");
  const mcp = trimmed.match(/^mcp__([^_]+)__(.+)$/);
  if (mcp) return `${mcp[1]}/${mcp[2]}`;
  const actionWithPath = trimmed.match(/^(Read|Write|Edit|NotebookEdit)\s+.+$/);
  if (actionWithPath) return actionWithPath[1];
  return trimmed;
}

function compactPath(path: string): string {
  const cleaned = path.trim().replace(/[\\/]+$/, "");
  if (cleaned === "") return path;
  return cleaned.split(/[\\/]/).pop() || cleaned;
}

function ToolDetails({
  event,
  status,
  terminalText,
  terminalExit,
  onClose,
}: {
  event: AgentEvent;
  status?: string;
  terminalText?: string;
  terminalExit?: { exitCode: number | null; signal: string | null; droppedBytes?: number };
  onClose: () => void;
}) {
  if (event.kind !== "toolCall" && event.kind !== "fileWrite") return null;
  const label = event.kind === "toolCall" ? displayToolName(event.data.name) : "File write";
  const summary =
    event.kind === "toolCall" ? describeToolCall(event.data.name, event.data.input) : compactPath(event.data.path);
  const editDetails = event.kind === "toolCall" ? editDetailsFromToolInput(event.data.name, event.data.input) : null;
  const details = event.kind === "toolCall" ? formatToolInput(event.data.input) : event.data.path;
  return (
    <div className="w-full max-w-3xl rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-foreground">{label}</span>
            {status && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {statusLabel(status)}
              </span>
            )}
          </div>
          {summary && <div className="mt-1 break-words font-mono">{summary}</div>}
          {terminalText !== undefined && (
            <TerminalView
              text={terminalText}
              running={status === "pending" || status === "in_progress"}
              exitCode={terminalExit?.exitCode ?? null}
              signal={terminalExit?.signal ?? null}
              droppedBytes={terminalExit?.droppedBytes}
            />
          )}
          {editDetails ? (
            <ToolEditDiff details={editDetails} />
          ) : (
            details &&
            details !== summary &&
            // An empty "{}" input under a terminal is noise — the terminal IS the output.
            !(terminalText !== undefined && details === "{}") && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/60 p-2 font-mono text-[11px] leading-relaxed text-foreground shadow-inner dark:bg-background/70">
                {details}
              </pre>
            )
          )}
        </div>
        <button
          type="button"
          aria-label="Close tool details"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

interface ToolEditFile {
  path: string;
  type: string | null;
  movePath: string | null;
  lines: { kind: DiffLineKind; text: string }[];
}

interface ToolEditDetails {
  files: ToolEditFile[];
  autoApproved: boolean | null;
}

function ToolEditDiff({ details }: { details: ToolEditDetails }) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {details.autoApproved !== null && (
        <div className="text-[11px] text-muted-foreground">
          {details.autoApproved ? "Auto approved" : "Approval required"}
        </div>
      )}
      {details.files.map((file) => (
        <section
          key={`${file.path}:${file.movePath ?? ""}`}
          className="overflow-hidden rounded-md border border-border/70 bg-background shadow-inner dark:bg-background/70"
        >
          <div className="flex min-w-0 items-center gap-2 border-b border-border/70 bg-muted/50 px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={file.path}>
              {displayWorktreePath(file.path)}
            </span>
            {file.type && (
              <span className="rounded-full bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {file.type}
              </span>
            )}
          </div>
          {file.movePath && (
            <div className="border-b border-border/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
              moved to {displayWorktreePath(file.movePath)}
            </div>
          )}
          {file.lines.length > 0 ? (
            <div className="max-h-52 overflow-auto py-1">
              {file.lines.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    "grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 px-2 font-mono text-[11px] leading-5",
                    line.kind === "add" && "bg-[color-mix(in_oklch,var(--status-success)_14%,transparent)] text-foreground",
                    line.kind === "del" && "bg-[color-mix(in_oklch,var(--status-error)_12%,transparent)] text-foreground",
                    (line.kind === "hunk" || line.kind === "meta") && "text-muted-foreground",
                  )}
                >
                  <span className="select-none text-right text-muted-foreground">
                    {diffPrefix(line.kind)}
                  </span>
                  <span className="min-w-0 whitespace-pre-wrap break-words">{displayDiffText(line)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-2 py-2 text-[11px] text-muted-foreground">No inline diff available.</div>
          )}
        </section>
      ))}
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "in_progress":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    default:
      return status;
  }
}

function formatToolInput(input: string): string {
  try {
    const parsed = JSON.parse(input);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return input;
  }
}

function editDetailsFromToolInput(name: string, input: string): ToolEditDetails | null {
  const normalizedName = displayToolName(name);
  if (!["Edit", "Write", "NotebookEdit"].includes(normalizedName)) return null;

  const parsed = parseToolInput(input);
  if (!parsed) return null;

  const files: ToolEditFile[] = [];
  const changes = parsed.changes;
  if (changes && typeof changes === "object" && !Array.isArray(changes)) {
    for (const [path, rawChange] of Object.entries(changes as Record<string, unknown>)) {
      if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) continue;
      const change = rawChange as Record<string, unknown>;
      const diff = typeof change.unified_diff === "string" ? change.unified_diff : "";
      files.push({
        path,
        type: typeof change.type === "string" ? change.type : null,
        movePath: typeof change.move_path === "string" ? change.move_path : null,
        lines: classifyUnifiedDiff(diff),
      });
    }
  } else {
    const path = firstString(parsed.file_path, parsed.path, parsed.notebook_path);
    const diff = firstString(parsed.unified_diff, parsed.diff, parsed.patch);
    if (path && diff) {
      files.push({
        path,
        type: normalizedName === "Write" ? "write" : "update",
        movePath: null,
        lines: classifyUnifiedDiff(diff),
      });
    }
  }

  if (files.length === 0) return null;
  return {
    files,
    autoApproved: typeof parsed.auto_approved === "boolean" ? parsed.auto_approved : null,
  };
}

function parseToolInput(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function classifyUnifiedDiff(diff: string): { kind: DiffLineKind; text: string }[] {
  const lines: { kind: DiffLineKind; text: string }[] = [];
  for (const raw of diff.split("\n")) {
    if (raw === "") continue;
    let kind: DiffLineKind;
    if (raw.startsWith("@@")) kind = "hunk";
    else if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff --git") || raw.startsWith("index ")) kind = "meta";
    else if (raw.startsWith("+")) kind = "add";
    else if (raw.startsWith("-")) kind = "del";
    else kind = "context";
    lines.push({ kind, text: raw });
  }
  return lines;
}

function diffPrefix(kind: DiffLineKind): string {
  if (kind === "add") return "+";
  if (kind === "del") return "-";
  return "";
}

function displayDiffText(line: { kind: DiffLineKind; text: string }): string {
  if ((line.kind === "add" || line.kind === "del") && line.text.length > 0) {
    return line.text.slice(1) || " ";
  }
  return line.text || " ";
}

function displayWorktreePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const match = normalized.match(/\/(?:\.(?:kineloop|agent-editor)|Kineloop)\/worktrees\/[^/]+\/(.+)$/);
  return match ? match[1] : normalized;
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
  const normalizedName = displayToolName(name);
  if (!["Read", "Write", "Edit", "NotebookEdit"].includes(normalizedName)) return null;
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object") return null;
    const args = parsed as Record<string, unknown>;
    const path = args.file_path ?? args.path ?? args.notebook_path;
    if (typeof path === "string" && path.trim() !== "") return path;
    if (args.changes && typeof args.changes === "object" && !Array.isArray(args.changes)) {
      const firstPath = Object.keys(args.changes as Record<string, unknown>)[0];
      return firstPath && firstPath.trim() !== "" ? firstPath : null;
    }
    return null;
  } catch {
    return null;
  }
}

function describeToolCall(name: string, input: string): string {
  const normalizedName = displayToolName(name);
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    return "";
  }
  const str = (value: unknown): string | undefined => cleanSummary(value);

  switch (normalizedName) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit": {
      const path = str(args.file_path) ?? str(args.path) ?? str(args.notebook_path);
      if (!path && args.changes && typeof args.changes === "object" && !Array.isArray(args.changes)) {
        const firstPath = Object.keys(args.changes as Record<string, unknown>)[0];
        return firstPath ? displayWorktreePath(firstPath) : "";
      }
      return path ? compactPath(path) : "";
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
      const preferredKeys = [
        "file_path",
        "path",
        "notebook_path",
        "command",
        "pattern",
        "query",
        "url",
        "description",
        "prompt",
        "subagent_type",
      ];
      for (const key of preferredKeys) {
        const value = str(args[key]);
        if (value) return summarizeValueForKey(key, value);
      }
      const firstString = Object.entries(args).find(([key, value]) => {
        if (isNoisySummaryKey(key)) return false;
        return cleanSummary(value) !== undefined;
      });
      return firstString ? cleanSummary(firstString[1]) ?? "" : "";
    }
  }
}

function summarizeValueForKey(key: string, value: string): string {
  if (["file_path", "path", "notebook_path"].includes(key)) return compactPath(value);
  return value;
}

function cleanSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = stripAnsi(value)
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "" || /^call_[A-Za-z0-9_-]+$/.test(cleaned)) return undefined;
  return cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned;
}

function isNoisySummaryKey(key: string): boolean {
  return /(?:^|_)(?:id|uuid|request|call)(?:_|$)/i.test(key);
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

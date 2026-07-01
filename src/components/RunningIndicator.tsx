import { useEffect, useMemo, useState } from "react";
import type { AgentEvent } from "../lib/agent";
import { Clock3, Loader2 } from "lucide-react";

interface RunningIndicatorProps {
  events?: AgentEvent[];
}

export function RunningIndicator({ events = [] }: RunningIndicatorProps) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const activity = useMemo(() => summarizeActivity(events), [events]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = formatElapsed(now - startedAt);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex w-full max-w-2xl flex-col gap-1 py-2 pl-1 pr-2 text-sm text-muted-foreground"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Loader2
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
        />
        <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground">
          {activity.title}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground/80">
          <Clock3 aria-hidden="true" className="size-3" />
          {elapsed}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2 pl-5 text-xs text-muted-foreground/80">
        <span className="min-w-0 truncate">{activity.detail}</span>
        {activity.counts !== "no activity yet" && (
          <>
            <span aria-hidden="true" className="shrink-0">
              ·
            </span>
            <span className="shrink-0 tabular-nums">{activity.counts}</span>
          </>
        )}
      </div>
    </div>
  );
}

type ActivitySummary = {
  title: string;
  detail: string;
  counts: string;
};

function summarizeActivity(events: AgentEvent[]): ActivitySummary {
  const toolCount = events.filter((event) => event.kind === "toolCall").length;
  const fileCount = events.filter((event) => event.kind === "fileWrite").length;
  const messageCount = events.filter((event) => event.kind === "token").length;
  const counts = [
    toolCount > 0 ? plural(toolCount, "tool") : null,
    fileCount > 0 ? plural(fileCount, "file") : null,
    messageCount > 0 ? plural(messageCount, "message") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "toolCall") {
      const detail = describeToolCall(event.data.name, event.data.input);
      return {
        title: `Running ${event.data.name}`,
        detail: detail || "Tool is still active.",
        counts: counts || "no activity yet",
      };
    }
    if (event.kind === "fileWrite") {
      return {
        title: "Updating files",
        detail: basename(event.data.path),
        counts: counts || "no activity yet",
      };
    }
    if (event.kind === "token") {
      return {
        title: "Streaming response",
        detail: lastLine(event.data.text) || "The agent is writing.",
        counts: counts || "no activity yet",
      };
    }
    if (event.kind === "approvalNeeded") {
      return {
        title: "Waiting for approval",
        detail: event.data.prompt,
        counts: counts || "no activity yet",
      };
    }
  }

  return {
    title: "Starting agent",
    detail: "Waiting for the first response.",
    counts: "no activity yet",
  };
}

function describeToolCall(name: string, input: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    return input.trim();
  }

  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

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
      return str(args.pattern) ?? "";
    case "Agent":
      return str(args.description) ?? str(args.prompt) ?? "";
    default:
      return str(args.description) ?? str(args.command) ?? str(args.prompt) ?? "";
  }
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

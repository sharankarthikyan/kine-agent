import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { clampTail, RENDER_TAIL_CHARS, sanitizeTerminalText } from "@/lib/terminal";

interface TerminalViewProps {
  text: string;
  running: boolean;
  exitCode?: number | null;
  signal?: string | null;
  droppedBytes?: number;
  /** When set, show only the last N lines (live tail under a running chip). */
  maxLines?: number;
  className?: string;
}

function formatKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function TerminalView({ text, running, exitCode, signal, droppedBytes, maxLines, className }: TerminalViewProps) {
  const { text: display, clamped } = useMemo(() => {
    const sanitized = sanitizeTerminalText(text);
    const tail = clampTail(sanitized, RENDER_TAIL_CHARS);
    if (maxLines === undefined) return tail;
    const lines = tail.text.split("\n");
    if (lines.length <= maxLines) return tail;
    return { text: lines.slice(lines.length - maxLines).join("\n"), clamped: true };
  }, [text, maxLines]);

  const exitLabel = running
    ? null
    : signal
      ? `killed by ${signal}`
      : exitCode !== null && exitCode !== undefined
        ? `exit ${exitCode}`
        : null;

  return (
    <div className={cn("w-full min-w-0 overflow-hidden rounded-md border bg-muted/40", className)}>
      {clamped && (
        <div className="border-b px-2 py-0.5 text-[10px] text-muted-foreground">earlier output trimmed</div>
      )}
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-xs leading-relaxed">
        {display}
      </pre>
      {(exitLabel || droppedBytes !== undefined) && (
        <div
          className={cn(
            "flex items-center gap-2 border-t px-2 py-0.5 font-mono text-[10px] text-muted-foreground",
            exitCode !== null && exitCode !== undefined && exitCode !== 0 && "text-destructive",
          )}
        >
          {exitLabel}
          {droppedBytes !== undefined && <span>{formatKb(droppedBytes)} dropped (output cap)</span>}
        </div>
      )}
    </div>
  );
}

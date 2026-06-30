import { useRef, useState } from "react";
import { PanelRight, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Diffstat } from "@/lib/conductor";
import type { SessionStatus } from "@/lib/sessions";
import { AgentLogo } from "./AgentLogo";

type StatusConfig = { label: string; color: string };

const STATUS_CONFIG: Record<SessionStatus, StatusConfig> = {
  running: { label: "Running", color: "var(--status-running)" },
  idle: { label: "Idle", color: "var(--status-success)" },
  error: { label: "Error", color: "var(--status-error)" },
};

const FALLBACK_CONFIG: StatusConfig = {
  label: "Unknown",
  color: "var(--muted-foreground)",
};

export interface SessionHeaderProps {
  title: string;
  agent: string;
  repo: string | null;
  status: string;
  source: "kineloop" | "external";
  diffstat: Diffstat | null;
  onClose: () => void;
  onCleanup: () => void;
  onTogglePanel: () => void;
  panelOpen: boolean;
  /** Persist a new title for this session. When omitted, the title is read-only. */
  onRename?: (title: string) => void;
}

export function SessionHeader({
  title,
  agent,
  repo,
  status,
  source,
  diffstat,
  onClose,
  onCleanup,
  onTogglePanel,
  panelOpen,
  onRename,
}: SessionHeaderProps) {
  const config = STATUS_CONFIG[status as SessionStatus] ?? FALLBACK_CONFIG;

  // Inline title editing — mirrors the sidebar. A double-click is detected from two
  // clicks (the macOS webview suppresses native dblclick on non-selectable text), and
  // a hover pencil offers a discoverable affordance. Only enabled when onRename is set
  // and there's a title to edit.
  const editable = typeof onRename === "function" && title.length > 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const committedRef = useRef(false);
  const lastClickRef = useRef(0);

  const startEdit = () => {
    committedRef.current = false;
    setDraft(title);
    setEditing(true);
  };
  const cancelEdit = () => {
    committedRef.current = true;
    setEditing(false);
  };
  const commitEdit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) onRename?.(next);
  };
  const handleTitleClick = () => {
    if (!editable) return;
    const now = Date.now();
    if (now - lastClickRef.current < 400) {
      lastClickRef.current = 0;
      startEdit();
    } else {
      lastClickRef.current = now;
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border shrink-0">
      {/* Left: two-line info block — status dot, title, status label, repo/diffstat */}
      <div className="flex flex-col min-w-0 flex-1 gap-0.5">
        {/* Top row: agent logo + status dot + title — color-coded dot carries status */}
        <span className="flex items-center gap-2 min-w-0">
          <AgentLogo agent={agent} className="size-4" />
          <span
            role="img"
            aria-label={`Status: ${config.label}`}
            title={config.label}
            className="size-2 rounded-full shrink-0"
            style={{ background: config.color }}
          />
          {editing ? (
            <input
              value={draft}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              onBlur={commitEdit}
              maxLength={60}
              // Hug the content (capped) instead of filling the header. `size` is the
              // text-width in characters — clamped to a sane min and the 60-char max.
              size={Math.min(Math.max(draft.length + 1, 8), 60)}
              aria-label="Session title"
              className="max-w-full -my-0.5 rounded-md border border-input bg-background px-1.5 py-0.5 text-sm font-medium leading-tight outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[2px]"
            />
          ) : (
            <span
              className={cn(
                "text-sm font-medium truncate flex-1 select-none",
                editable && "cursor-pointer"
              )}
              onClick={editable ? handleTitleClick : undefined}
              onDoubleClick={editable ? startEdit : undefined}
              title={editable ? "Double-click to rename" : undefined}
            >
              {title}
            </span>
          )}
        </span>

        {/* Secondary line: repo and/or diffstat — omitted when both are null */}
        {(repo !== null || diffstat !== null || source === "external") && (
          <span className="text-xs text-muted-foreground tabular-nums pl-4 flex items-center gap-1">
            {source === "external" && <span>CLI history</span>}
            {source === "external" && repo !== null && <span aria-hidden>·</span>}
            {repo !== null && <span>{repo}</span>}
            {repo !== null && diffstat !== null && <span aria-hidden>·</span>}
            {diffstat !== null && (
              <>
                <span style={{ color: "var(--status-success)" }}>+{diffstat.additions}</span>
                <span style={{ color: "var(--status-error)" }}>−{diffstat.deletions}</span>
              </>
            )}
          </span>
        )}
      </div>

      {/* Right: action buttons */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Panel toggle — opens/closes the right pane for the focused session. */}
        <Button
          variant={panelOpen ? "secondary" : "ghost"}
          size="sm"
          aria-label="Toggle context panel"
          aria-pressed={panelOpen}
          className="h-9 gap-1.5 px-2"
          onClick={onTogglePanel}
        >
          <PanelRight data-icon="inline-start" />
          <span className="max-[1300px]:sr-only">Context</span>
        </Button>
        {source !== "external" && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Clean up worktree"
            className={cn("size-9 text-muted-foreground hover:text-destructive")}
            onClick={onCleanup}
          >
            <Trash2 data-icon />
          </Button>
        )}
        {/* Close — deselects the session */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close session"
          className="size-9"
          onClick={onClose}
        >
          <X data-icon />
        </Button>
      </div>
    </div>
  );
}

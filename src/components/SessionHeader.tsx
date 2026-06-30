import { PanelRight, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Diffstat } from "@/lib/conductor";
import type { SessionStatus } from "@/lib/sessions";

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
  repo: string | null;
  status: string;
  source: "kineloop" | "external";
  diffstat: Diffstat | null;
  onClose: () => void;
  onCleanup: () => void;
  onTogglePanel: () => void;
  panelOpen: boolean;
}

export function SessionHeader({
  title,
  repo,
  status,
  source,
  diffstat,
  onClose,
  onCleanup,
  onTogglePanel,
  panelOpen,
}: SessionHeaderProps) {
  const config = STATUS_CONFIG[status as SessionStatus] ?? FALLBACK_CONFIG;

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border shrink-0">
      {/* Left: two-line info block — status dot, title, status label, repo/diffstat */}
      <div className="flex flex-col min-w-0 flex-1 gap-0.5">
        {/* Top row: status dot + title — color-coded dot carries status, no duplicate label */}
        <span className="flex items-center gap-2 min-w-0">
          <span
            role="img"
            aria-label={`Status: ${config.label}`}
            title={config.label}
            className="size-2 rounded-full shrink-0"
            style={{ background: config.color }}
          />
          <span className="text-sm font-medium truncate flex-1">{title}</span>
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
        {/* Panel toggle — opens/closes the right pane */}
        <Button
          variant={panelOpen ? "secondary" : "ghost"}
          size="icon"
          aria-label="Toggle panel"
          aria-pressed={panelOpen}
          className="size-9"
          onClick={onTogglePanel}
          disabled={source === "external"}
        >
          <PanelRight data-icon />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Clean up worktree"
          className={cn("size-9 text-muted-foreground hover:text-destructive")}
          onClick={onCleanup}
          disabled={source === "external"}
        >
          <Trash2 data-icon />
        </Button>
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

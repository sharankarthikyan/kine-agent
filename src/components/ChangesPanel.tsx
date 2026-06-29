import { useState } from "react";
import type { BranchChanges } from "@/lib/conductor";
import type { ChangeStatus } from "@/lib/review";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

export type { BranchChanges };

const STATUS_LETTER: Record<ChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};

const STATUS_COLOR_VAR: Record<ChangeStatus, string> = {
  added: "var(--status-success)",
  modified: "var(--status-running)",
  deleted: "var(--status-error)",
};

export interface ChangesPanelProps {
  branch: BranchChanges | null;
  onCommit: (message: string) => void;
  onOpenFile: (path: string) => void;
  committing: boolean;
}

export function ChangesPanel({ branch, onCommit, onOpenFile, committing }: ChangesPanelProps) {
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState("");

  const hasChanges = branch !== null && branch.files.length > 0;
  const totalAdditions = hasChanges
    ? branch.files.reduce((sum, f) => sum + f.additions, 0)
    : 0;
  const totalDeletions = hasChanges
    ? branch.files.reduce((sum, f) => sum + f.deletions, 0)
    : 0;

  function handleCommitClick() {
    setComposing(true);
  }

  function handleConfirm() {
    if (!message.trim() || committing) return;
    onCommit(message.trim());
  }

  function handleCancel() {
    setMessage("");
    setComposing(false);
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Header: summary + primary action ─────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2">
        <p className="flex-1 text-sm tabular-nums text-muted-foreground">
          Branch Changes
          {hasChanges && (
            <>
              {"  "}
              <span style={{ color: "var(--status-success)" }}>+{totalAdditions}</span>
              {" "}
              <span style={{ color: "var(--status-error)" }}>−{totalDeletions}</span>
              {" · "}
              {branch.aheadCount} ahead
            </>
          )}
        </p>
        {!composing && (
          <Button
            size="sm"
            disabled={!hasChanges || committing}
            onClick={handleCommitClick}
            aria-label="Commit changes"
          >
            {committing ? "Committing…" : "Commit"}
          </Button>
        )}
      </div>

      {/* ── Inline commit composer ─────────────────────────────────────── */}
      {composing && (
        <div className="shrink-0 flex items-center gap-2 px-3 pb-2">
          <Input
            className="flex-1 h-8 text-sm"
            placeholder="Commit message…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConfirm();
              if (e.key === "Escape") handleCancel();
            }}
            disabled={committing}
            autoFocus
            aria-label="Commit message"
          />
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={!message.trim() || committing}
            aria-label="Confirm commit"
          >
            {committing ? "Committing…" : "Commit"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleCancel}
            disabled={committing}
            aria-label="Cancel commit"
          >
            Cancel
          </Button>
        </div>
      )}

      {/* ── File list or empty state ──────────────────────────────────── */}
      {!hasChanges ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">No changes</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 mx-3 mb-3 rounded-lg border border-border bg-muted/20 overflow-hidden">
          <ScrollArea className="h-full">
            <ul className="list-none p-1 m-0 flex flex-col gap-0.5">
              {branch.files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted/50 cursor-pointer text-left rounded-md"
                    onClick={() => onOpenFile(file.path)}
                    aria-label={`Open ${file.path}`}
                  >
                    {/* Status letter — never color-only */}
                    <span
                      className="shrink-0 font-mono text-xs font-semibold w-4 text-center"
                      style={{ color: STATUS_COLOR_VAR[file.status] }}
                      title={file.status}
                    >
                      {STATUS_LETTER[file.status]}
                    </span>
                    <span className="flex-1 font-mono text-xs truncate">{file.path}</span>
                    <span
                      className="tabular-nums text-xs shrink-0"
                      style={{ color: "var(--status-success)" }}
                    >
                      +{file.additions}
                    </span>
                    <span
                      className="tabular-nums text-xs shrink-0"
                      style={{ color: "var(--status-error)" }}
                    >
                      -{file.deletions}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

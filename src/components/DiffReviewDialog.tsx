import { useEffect, useMemo, useState } from "react";
import { FileMinus, FilePen, FilePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { parsePatch, type DiffLineKind, type PatchFile } from "@/lib/parsePatch";
import type { ChangeStatus, FileChange, SessionDiff } from "@/lib/review";

interface DiffReviewDialogProps {
  open: boolean;
  diff: SessionDiff | null;
  selectedPath: string | null;
  committing: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectPath: (path: string) => void;
  onCommit: (message: string) => Promise<boolean> | boolean;
}

const STATUS_ICON: Record<ChangeStatus, typeof FilePlus> = {
  added: FilePlus,
  modified: FilePen,
  deleted: FileMinus,
};

const STATUS_COLOR_VAR: Record<ChangeStatus, string> = {
  added: "var(--status-success)",
  modified: "var(--status-running)",
  deleted: "var(--status-error)",
};

function displayPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const match = normalized.match(/\/(?:\.(?:kineloop|agent-editor)|Kineloop)\/worktrees\/[^/]+\/(.+)$/);
  return match ? match[1] : normalized;
}

function patchPathMatches(filePath: string, selectedPath: string): boolean {
  const file = displayPath(filePath);
  const selected = displayPath(selectedPath);
  return file === selected || file.endsWith(`/${selected}`) || selected.endsWith(`/${file}`);
}

function selectedPatchFile(patchFiles: PatchFile[], selectedPath: string | null): PatchFile | null {
  if (patchFiles.length === 0) return null;
  if (!selectedPath) return patchFiles[0];
  return patchFiles.find((file) => patchPathMatches(file.path, selectedPath)) ?? patchFiles[0];
}

function selectedFile(files: FileChange[], selectedPath: string | null): FileChange | null {
  if (files.length === 0) return null;
  if (!selectedPath) return files[0];
  return files.find((file) => patchPathMatches(file.path, selectedPath)) ?? files[0];
}

function lineClass(kind: DiffLineKind): string {
  if (kind === "add") {
    return "bg-[color-mix(in_oklch,var(--status-success)_14%,transparent)] text-foreground";
  }
  if (kind === "del") {
    return "bg-[color-mix(in_oklch,var(--status-error)_12%,transparent)] text-foreground";
  }
  if (kind === "hunk" || kind === "meta") return "text-muted-foreground";
  return "text-foreground";
}

function lineMarker(kind: DiffLineKind): string {
  if (kind === "add") return "+";
  if (kind === "del") return "-";
  return "";
}

function lineText(kind: DiffLineKind, text: string): string {
  if ((kind === "add" || kind === "del") && text.length > 0) return text.slice(1) || " ";
  return text || " ";
}

function totals(files: FileChange[]): { additions: number; deletions: number } {
  return files.reduce(
    (acc, file) => ({
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function DiffReviewDialog({
  open,
  diff,
  selectedPath,
  committing,
  onOpenChange,
  onSelectPath,
  onCommit,
}: DiffReviewDialogProps) {
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState("");
  const patchFiles = useMemo(() => parsePatch(diff?.patch ?? ""), [diff?.patch]);
  const activePatch = selectedPatchFile(patchFiles, selectedPath);
  const activeFile = selectedFile(diff?.files ?? [], selectedPath);
  const hasChanges = (diff?.files.length ?? 0) > 0;
  const count = diff?.files.length ?? 0;
  const summary = totals(diff?.files ?? []);

  useEffect(() => {
    if (!open) {
      setComposing(false);
      setMessage("");
    }
  }, [open]);

  async function handleCommit() {
    if (!message.trim() || committing) return;
    const ok = await onCommit(message.trim());
    if (ok) {
      setComposing(false);
      setMessage("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(860px,calc(100vh-2rem))] w-[min(1240px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border/70 px-5 py-4">
          <div className="flex min-w-0 items-start gap-4 pr-8">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate font-mono text-base">
                {activeFile ? displayPath(activeFile.path) : "Changes"}
              </DialogTitle>
              <DialogDescription className="mt-1 flex flex-wrap items-center gap-2 text-xs tabular-nums">
                <span>
                  {count} {count === 1 ? "file" : "files"} changed
                </span>
                {hasChanges && (
                  <>
                    <span style={{ color: "var(--status-success)" }}>+{summary.additions}</span>
                    <span style={{ color: "var(--status-error)" }}>-{summary.deletions}</span>
                  </>
                )}
              </DialogDescription>
            </div>
            {!composing && (
              <Button
                size="sm"
                disabled={!hasChanges || committing}
                onClick={() => setComposing(true)}
              >
                {committing ? "Committing..." : "Commit"}
              </Button>
            )}
          </div>
          {composing && (
            <div className="mt-3 flex items-center gap-2 pr-8">
              <Input
                className="h-8 flex-1 text-sm"
                placeholder="Commit message..."
                value={message}
                disabled={committing}
                autoFocus
                aria-label="Commit message"
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleCommit();
                  if (event.key === "Escape") {
                    setComposing(false);
                    setMessage("");
                  }
                }}
              />
              <Button
                size="sm"
                disabled={!message.trim() || committing}
                onClick={() => void handleCommit()}
              >
                {committing ? "Committing..." : "Commit"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={committing}
                onClick={() => {
                  setComposing(false);
                  setMessage("");
                }}
              >
                Cancel
              </Button>
            </div>
          )}
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="min-h-0 border-b border-border/70 md:border-b-0 md:border-r">
            <ScrollArea className="h-full">
              {hasChanges ? (
                <ul className="flex list-none flex-col gap-0.5 p-2">
                  {diff!.files.map((file) => {
                    const Icon = STATUS_ICON[file.status];
                    const active = activeFile?.path === file.path;
                    return (
                      <li key={file.path}>
                        <button
                          type="button"
                          className={cn(
                            "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            active && "bg-muted",
                          )}
                          onClick={() => onSelectPath(file.path)}
                          aria-current={active ? "true" : undefined}
                        >
                          <Icon
                            aria-hidden="true"
                            className="size-3.5 shrink-0"
                            style={{ color: STATUS_COLOR_VAR[file.status] }}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
                            {displayPath(file.path)}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums" style={{ color: "var(--status-success)" }}>
                            +{file.additions}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums" style={{ color: "var(--status-error)" }}>
                            -{file.deletions}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="p-4 text-sm text-muted-foreground">No changes</p>
              )}
            </ScrollArea>
          </aside>

          <section className="min-h-0 min-w-0 bg-background">
            {activePatch ? (
              <ScrollArea className="h-full">
                <div className="min-w-0 py-3">
                  <div className="sticky top-0 z-10 border-b border-border/70 bg-background/95 px-4 py-2 backdrop-blur">
                    <p className="truncate font-mono text-sm font-medium">
                      {displayPath(activeFile?.path ?? activePatch.path)}
                    </p>
                    {activeFile && (
                      <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                        <span style={{ color: "var(--status-success)" }}>+{activeFile.additions}</span>
                        {" "}
                        <span style={{ color: "var(--status-error)" }}>-{activeFile.deletions}</span>
                      </p>
                    )}
                  </div>
                  <div className="py-2">
                    {activePatch.lines.map((line, index) => (
                      <div
                        key={index}
                        className={cn(
                          "grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3 px-4 font-mono text-xs leading-5",
                          lineClass(line.kind),
                        )}
                      >
                        <span className="select-none text-right text-muted-foreground">
                          {lineMarker(line.kind)}
                        </span>
                        <span className="min-w-0 whitespace-pre-wrap break-words">
                          {lineText(line.kind, line.text)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </ScrollArea>
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                No inline diff available for this file.
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

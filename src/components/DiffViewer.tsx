import type { CSSProperties, ElementType } from "react";
import { FileMinus, FilePen, FilePlus, FileX } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { parsePatch, type DiffLineKind } from "@/lib/parsePatch";
import type { ChangeStatus, SessionDiff } from "@/lib/review";

interface DiffViewerProps {
  diff: SessionDiff;
}

const STATUS_ICON: Record<ChangeStatus, ElementType> = {
  added: FilePlus,
  modified: FilePen,
  deleted: FileMinus,
};

const STATUS_COLOR_VAR: Record<ChangeStatus, string> = {
  added: "var(--status-success)",
  modified: "var(--status-running)",
  deleted: "var(--status-error)",
};

function patchLineBg(kind: DiffLineKind): CSSProperties {
  if (kind === "add") {
    return { backgroundColor: "color-mix(in oklch, var(--status-success) 12%, transparent)" };
  }
  if (kind === "del") {
    return { backgroundColor: "color-mix(in oklch, var(--status-error) 12%, transparent)" };
  }
  return {};
}

export function DiffViewer({ diff }: DiffViewerProps) {
  if (diff.files.length === 0) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <Empty>
          <EmptyMedia variant="icon">
            <FileX />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No changes</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const count = diff.files.length;
  const patchFiles = parsePatch(diff.patch);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Summary header */}
      <p className="shrink-0 px-3 py-2 text-sm text-muted-foreground">
        {count} {count === 1 ? "file" : "files"} changed
      </p>

      <Separator />

      {/* Changed-files list */}
      <ul className="shrink-0 list-none p-0 m-0">
        {diff.files.map((file) => {
          const Icon = STATUS_ICON[file.status];
          return (
            <li
              key={file.path}
              className="flex items-center gap-2 px-3 py-1 text-sm border-b border-border"
            >
              <Icon
                className="size-3.5 shrink-0"
                style={{ color: STATUS_COLOR_VAR[file.status] }}
              />
              <span className="font-mono flex-1 truncate">{file.path}</span>
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
            </li>
          );
        })}
      </ul>

      <Separator />

      {/* Unified patch */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="py-2">
          {patchFiles.map((pf) => (
            <section key={pf.path} className="mb-3">
              <div
                className="sticky top-0 bg-background px-3 py-0.5 font-mono text-xs text-muted-foreground"
                aria-hidden="true"
              >
                {pf.path.split("/").pop() ?? pf.path}
              </div>
              {pf.lines.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    "whitespace-pre px-3 font-mono text-xs leading-5",
                    (line.kind === "hunk" || line.kind === "meta") &&
                      "text-muted-foreground",
                  )}
                  style={patchLineBg(line.kind)}
                >
                  {line.text || " "}
                </div>
              ))}
            </section>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

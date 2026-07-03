import { FileText, Loader2, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CodeBlock } from "@/components/CodeBlock";

export interface FilePreviewState {
  path: string;
  content: string | null;
  status: "loading" | "ready" | "error";
  error?: string;
}

interface FilePreviewDialogProps {
  preview: FilePreviewState | null;
  onOpenChange: (open: boolean) => void;
}

function displayPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const match = normalized.match(/\/(?:\.(?:kineloop|agent-editor)|Kineloop)\/worktrees\/[^/]+\/(.+)$/);
  return match ? match[1] : normalized;
}

export function FilePreviewDialog({ preview, onOpenChange }: FilePreviewDialogProps) {
  const open = preview !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(820px,calc(100vh-2rem))] w-[min(1040px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border/70 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3 pr-8">
            <FileText
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <div className="min-w-0">
              <DialogTitle className="truncate font-mono text-base">
                {preview ? displayPath(preview.path) : "File"}
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs">
                Read-only worktree preview
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 bg-muted/20">
          {preview?.status === "loading" && (
            <div
              role="status"
              className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
            >
              <Loader2
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
              Loading file...
            </div>
          )}

          {preview?.status === "error" && (
            <div className="flex h-full items-center justify-center p-6">
              <div className="flex max-w-md items-start gap-3 rounded-lg border border-border bg-background p-4 text-sm">
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                />
                <div>
                  <p className="font-medium">Couldn&apos;t preview this file</p>
                  <p className="mt-1 text-muted-foreground">
                    {preview.error ?? "The file is unavailable or is not readable text."}
                  </p>
                </div>
              </div>
            </div>
          )}

          {preview?.status === "ready" && (
            <ScrollArea className="h-full">
              <CodeBlock
                content={preview.content ?? ""}
                path={preview.path}
                className="min-h-full bg-background p-5"
              />
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

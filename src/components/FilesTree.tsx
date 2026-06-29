import { useState } from "react";
import type { TreeNode } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

export type { TreeNode };

// Raw git short-codes from the backend (conductor.ts TreeEntry.status)
const STATUS_COLOR_VAR: Record<string, string> = {
  M: "var(--status-running)",   // modified → sky/blue
  A: "var(--status-success)",   // added → emerald
  D: "var(--status-error)",     // deleted → red
};

export interface FilesTreeProps {
  nodes: TreeNode[];
  onOpenFile: (path: string) => void;
}

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  onOpenFile: (path: string) => void;
}

function TreeNodeRow({ node, depth, onOpenFile }: TreeNodeRowProps) {
  const [open, setOpen] = useState(true);

  const statusColor = node.status
    ? (STATUS_COLOR_VAR[node.status] ?? "var(--muted-foreground)")
    : undefined;

  const indentStyle = { paddingLeft: `${8 + depth * 12}px` };

  if (node.isDir) {
    return (
      <>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 py-0.5 pr-2 text-sm hover:bg-muted/50 cursor-pointer text-left"
          style={indentStyle}
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-label={node.name}
        >
          <ChevronRight
            data-icon
            className={cn("size-3.5 shrink-0 transition-transform duration-150", open && "rotate-90")}
          />
          {open ? (
            <FolderOpen data-icon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder data-icon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1 text-xs truncate">{node.name}</span>
          {/* Status letter — not color-only */}
          {node.status && (
            <span
              className="shrink-0 font-mono text-xs font-semibold ml-1"
              style={{ color: statusColor }}
              title={node.status}
            >
              {node.status}
            </span>
          )}
        </button>
        {open &&
          node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              onOpenFile={onOpenFile}
            />
          ))}
      </>
    );
  }

  return (
    <button
      type="button"
      className="flex w-full items-center gap-1.5 py-0.5 pr-2 text-sm hover:bg-muted/50 cursor-pointer text-left"
      style={indentStyle}
      onClick={() => onOpenFile(node.path)}
      aria-label={`Open ${node.name}`}
    >
      {/* Spacer aligned with chevron */}
      <span className="size-3.5 shrink-0" aria-hidden="true" />
      <File
        data-icon
        className="size-3.5 shrink-0"
        style={statusColor ? { color: statusColor } : undefined}
      />
      <span
        className="flex-1 text-xs truncate font-mono"
        style={statusColor ? { color: statusColor } : undefined}
      >
        {node.name}
      </span>
      {/* Status letter — not color-only */}
      {node.status && (
        <span
          className="shrink-0 font-mono text-xs font-semibold ml-1"
          style={{ color: statusColor }}
          title={node.status}
        >
          {node.status}
        </span>
      )}
    </button>
  );
}

export function FilesTree({ nodes, onOpenFile }: FilesTreeProps) {
  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">No files</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="py-1">
        {nodes.map((node) => (
          <TreeNodeRow key={node.path} node={node} depth={0} onOpenFile={onOpenFile} />
        ))}
      </div>
    </ScrollArea>
  );
}

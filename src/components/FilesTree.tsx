import { useEffect, useMemo, useState } from "react";
import type { TreeNode } from "@/lib/tree";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  GitCompare,
  ListCollapse,
  ListTree,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

export type { TreeNode };

// Full-word git statuses from the backend (conductor.ts TreeEntry.status:
// "modified" | "added" | "deleted" | "untracked").
const STATUS_COLOR_VAR: Record<string, string> = {
  modified: "var(--status-running)",     // sky/blue
  added: "var(--status-success)",        // emerald
  deleted: "var(--status-error)",        // red
  untracked: "var(--muted-foreground)",  // muted
};

// Single-letter badge per status — keeps the tree "not color-only".
const STATUS_LETTER: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "?",
};

export interface FilesTreeProps {
  nodes: TreeNode[];
  onOpenFile: (path: string, node: TreeNode) => void;
}

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  onOpenFile: (path: string, node: TreeNode) => void;
  expandMode: "smart" | "all" | "none";
  expandVersion: number;
}

function hasChangedDescendant(node: TreeNode): boolean {
  if (node.status !== null) return true;
  return node.children.some(hasChangedDescendant);
}

function flattenFiles(nodes: TreeNode[]): TreeNode[] {
  const files: TreeNode[] = [];
  for (const node of nodes) {
    if (node.isDir) files.push(...flattenFiles(node.children));
    else files.push(node);
  }
  return files;
}

function countNodes(nodes: TreeNode[]): { files: number; changed: number } {
  return flattenFiles(nodes).reduce(
    (acc, node) => ({
      files: acc.files + 1,
      changed: acc.changed + (node.status ? 1 : 0),
    }),
    { files: 0, changed: 0 },
  );
}

function defaultOpen(node: TreeNode, depth: number): boolean {
  return depth === 0 ? hasChangedDescendant(node) : hasChangedDescendant(node);
}

function TreeNodeRow({ node, depth, onOpenFile, expandMode, expandVersion }: TreeNodeRowProps) {
  const [open, setOpen] = useState(() => defaultOpen(node, depth));

  useEffect(() => {
    if (expandMode === "all") setOpen(true);
    else if (expandMode === "none") setOpen(false);
    else setOpen(defaultOpen(node, depth));
  }, [depth, expandMode, expandVersion, node]);

  const statusColor = node.status
    ? (STATUS_COLOR_VAR[node.status] ?? "var(--muted-foreground)")
    : undefined;

  const indentStyle = { paddingLeft: `${8 + depth * 14}px` };

  if (node.isDir) {
    return (
      <>
        <button
          type="button"
          className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          <span className="min-w-0 flex-1 truncate text-xs">{node.name}</span>
          {/* Status letter — not color-only */}
          {node.status && (
            <span
              className="shrink-0 font-mono text-xs font-semibold ml-1"
              style={{ color: statusColor }}
              title={node.status}
            >
              {STATUS_LETTER[node.status] ?? node.status}
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
              expandMode={expandMode}
              expandVersion={expandVersion}
            />
          ))}
      </>
    );
  }

  return (
    <button
      type="button"
      className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={indentStyle}
      onClick={() => onOpenFile(node.path, node)}
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
        className="min-w-0 flex-1 truncate font-mono text-xs"
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
          {STATUS_LETTER[node.status] ?? node.status}
        </span>
      )}
    </button>
  );
}

export function FilesTree({ nodes, onOpenFile }: FilesTreeProps) {
  const [query, setQuery] = useState("");
  const [expandMode, setExpandMode] = useState<"smart" | "all" | "none">("smart");
  const [expandVersion, setExpandVersion] = useState(0);
  const stats = useMemo(() => countNodes(nodes), [nodes]);
  const queryText = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      queryText
        ? flattenFiles(nodes).filter((node) => node.path.toLowerCase().includes(queryText))
        : [],
    [nodes, queryText],
  );

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">No files</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/60 p-2">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find files..."
            aria-label="Find files"
            className="h-8 pl-7 text-sm"
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {stats.files} files
            {stats.changed > 0 && ` · ${stats.changed} changed`}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              aria-label="Collapse tree"
              title="Collapse tree"
              onClick={() => {
                setExpandMode("none");
                setExpandVersion((value) => value + 1);
              }}
            >
              <ListCollapse aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              aria-label="Show changed files"
              title="Show changed files"
              onClick={() => {
                setExpandMode("smart");
                setExpandVersion((value) => value + 1);
              }}
            >
              <GitCompare aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              aria-label="Expand all"
              title="Expand all"
              onClick={() => {
                setExpandMode("all");
                setExpandVersion((value) => value + 1);
              }}
            >
              <ListTree aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          {queryText ? (
            matches.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No matching files</p>
            ) : (
              <ul className="flex list-none flex-col gap-0.5 p-0">
                {matches.map((node) => {
                  const statusColor = node.status
                    ? (STATUS_COLOR_VAR[node.status] ?? "var(--muted-foreground)")
                    : undefined;
                  return (
                    <li key={node.path}>
                      <button
                        type="button"
                        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => onOpenFile(node.path, node)}
                        aria-label={`Open ${node.path}`}
                      >
                        <File
                          data-icon
                          className="size-3.5 shrink-0"
                          style={statusColor ? { color: statusColor } : undefined}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={node.path}>
                          {node.path}
                        </span>
                        {node.status && (
                          <span
                            className="shrink-0 font-mono text-xs font-semibold"
                            style={{ color: statusColor }}
                            title={node.status}
                          >
                            {STATUS_LETTER[node.status] ?? node.status}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          ) : (
            <div className="py-1">
              {nodes.map((node) => (
                <TreeNodeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  onOpenFile={onOpenFile}
                  expandMode={expandMode}
                  expandVersion={expandVersion}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

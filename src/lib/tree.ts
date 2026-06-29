import type { TreeEntry } from "./conductor";

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  status: string | null;
  children: TreeNode[];
}

/**
 * Sort comparator: directories before files, then alphabetically by name.
 */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Build a nested directory/file tree from a flat list of TreeEntry records.
 * Within each directory level, dirs appear before files and each group is
 * sorted alphabetically by name.
 * PURE: no side effects.
 */
export function buildTree(entries: TreeEntry[]): TreeNode[] {
  // Normalize: strip trailing slashes from paths for consistent splitting.
  const normalized = entries.map((entry) => ({
    ...entry,
    path: entry.path.replace(/\/+$/, ""),
  }));

  // Build a lookup of path → TreeEntry for quick status resolution.
  const entryByPath = new Map<string, TreeEntry>();
  for (const entry of normalized) {
    entryByPath.set(entry.path, entry);
  }

  // Collect all unique paths including implicit parent dirs.
  const allPaths = new Set<string>();
  for (const entry of normalized) {
    allPaths.add(entry.path);
    // Ensure every ancestor directory is represented.
    const parts = entry.path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      allPaths.add(parts.slice(0, depth).join("/"));
    }
  }

  // We build the tree top-down. The root is a virtual container for top-level nodes.
  const rootChildren: TreeNode[] = [];
  // nodeByPath stores the TreeNode for each path already created.
  const nodeByPath = new Map<string, TreeNode>();

  // Sort paths so parents are always processed before children.
  const sortedPaths = Array.from(allPaths).sort();

  for (const path of sortedPaths) {
    const parts = path.split("/");
    const name = parts[parts.length - 1];
    const backendEntry = entryByPath.get(path);

    // A path is a directory if either the backend said so, or if it has children
    // (i.e., there is a child path starting with `path + "/"`). We determine
    // isDir from the backend when available; otherwise, treat it as a directory
    // because we only added it as an implicit ancestor.
    const isDir = backendEntry ? backendEntry.isDir : true;
    const status = backendEntry ? backendEntry.status : null;

    const node: TreeNode = { name, path, isDir, status, children: [] };
    nodeByPath.set(path, node);

    if (parts.length === 1) {
      rootChildren.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join("/");
      const parent = nodeByPath.get(parentPath);
      if (parent) {
        parent.children.push(node);
      }
    }
  }

  // Sort each level: dirs first, then files, each group alphabetical.
  function sortLevel(nodes: TreeNode[]): void {
    nodes.sort(compareNodes);
    for (const node of nodes) {
      if (node.children.length > 0) sortLevel(node.children);
    }
  }

  sortLevel(rootChildren);
  return rootChildren;
}

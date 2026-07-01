import { invoke } from "@tauri-apps/api/core";
import { assertDesktop } from "./agent";
import type { FileChange } from "./review";

export type { FileChange };

/** Counts of per-session Claude customization files discovered in the worktree. */
export interface CustomizationCounts {
  agents: number;
  skills: number;
  instructions: number;
  hooks: number;
  mcpServers: number;
}

/** Aggregate line-count diff for the session's worktree against its base branch. */
export interface Diffstat {
  additions: number;
  deletions: number;
  filesChanged: number;
}

/** A single entry in the worktree file tree. */
export interface TreeEntry {
  path: string;
  isDir: boolean;
  /** Full-word git status ("modified" | "added" | "deleted" | "untracked"), or null for clean entries and directories. */
  status: string | null;
}

/** Branch-level changes relative to the session's base branch. */
export interface BranchChanges {
  aheadCount: number;
  files: FileChange[];
}

/** Result of a successful commit operation. */
export interface CommitResult {
  sha: string;
}

/** A single configured hook rule (leaf command) from a Claude settings file. */
export interface HookEntry {
  event: string;
  matcher: string | null;
  command: string;
  source: "project" | "user";
}

/** A single MCP server declaration from `.mcp.json` or `~/.claude.json`. */
export interface McpServerEntry {
  name: string;
  detail: string | null;
  source: "project" | "user";
}

/** A single installed Claude Code plugin from `~/.claude/plugins/installed_plugins.json`. */
export interface PluginEntry {
  name: string;
  /** Marketplace identifier (e.g. "claude-plugins-official"), or null when unavailable. */
  detail: string | null;
  source: "project" | "user";
}

/** Return all hook rules configured for a session (worktree project + user ~/.claude).
 *  Pass `null` to list only the user's global ~/.claude scope (no session). */
export async function listHooks(sessionId: string | null): Promise<HookEntry[]> {
  assertDesktop();
  return invoke<HookEntry[]>("list_hooks", { sessionId });
}

/** Return all MCP servers declared for a session (worktree .mcp.json + user ~/.claude.json).
 *  Pass `null` to list only the user's global ~/.claude.json scope (no session). */
export async function listMcpServers(sessionId: string | null): Promise<McpServerEntry[]> {
  assertDesktop();
  return invoke<McpServerEntry[]>("list_mcp_servers", { sessionId });
}

/** Return installed Claude Code plugins from ~/.claude/plugins/installed_plugins.json.
 *  Plugins are always user-scope; `sessionId` may be `null`. */
export async function listPlugins(sessionId: string | null): Promise<PluginEntry[]> {
  assertDesktop();
  return invoke<PluginEntry[]>("list_plugins", { sessionId });
}

/** Return customization file counts (agents, skills, instructions, hooks, MCP servers)
 *  for a session, or — when `sessionId` is `null` — for the user's global ~/.claude scope. */
export async function customizationsCounts(
  sessionId: string | null,
): Promise<CustomizationCounts> {
  assertDesktop();
  return invoke<CustomizationCounts>("customizations_counts", { sessionId });
}

/** Return the aggregate additions/deletions/files-changed diffstat for a session's worktree. */
export async function sessionDiffstat(sessionId: string): Promise<Diffstat> {
  assertDesktop();
  return invoke<Diffstat>("session_diffstat", { sessionId });
}

/** Return the flat file tree for a session's worktree. */
export async function worktreeTree(sessionId: string): Promise<TreeEntry[]> {
  assertDesktop();
  return invoke<TreeEntry[]>("worktree_tree", { sessionId });
}

/** Read a text file from within a session's worktree, for inlining `@file` mentions when
 *  the target agent doesn't resolve them natively. Path is validated server-side against
 *  traversal; content over 512 KiB is truncated. */
export async function readWorktreeFile(sessionId: string, path: string): Promise<string> {
  assertDesktop();
  return invoke<string>("read_worktree_file", { sessionId, path });
}

/** One immediate child of a browsed directory (for `@/` and `@~/` filesystem mentions). */
export interface DirEntry {
  name: string;
  isDir: boolean;
}

/** List a directory's immediate children for filesystem `@` browsing. `~` expands to home.
 *  Read-only, non-recursive, capped. Reaches outside the repo — user-initiated only. */
export async function listDir(path: string): Promise<DirEntry[]> {
  assertDesktop();
  return invoke<DirEntry[]>("list_dir", { path });
}

/** Read a text file at an absolute or `~`-expanded path, for inlining a global `@` mention.
 *  Regular files only; content over 512 KiB is truncated. */
export async function readAnyFile(path: string): Promise<string> {
  assertDesktop();
  return invoke<string>("read_any_file", { path });
}

/** Return the changed files and ahead-count for the session's branch relative to its base. */
export async function branchChanges(sessionId: string): Promise<BranchChanges> {
  assertDesktop();
  return invoke<BranchChanges>("branch_changes", { sessionId });
}

/** Commit all staged and unstaged changes in the session's worktree with the given message. */
export async function commitSession(sessionId: string, message: string): Promise<CommitResult> {
  assertDesktop();
  return invoke<CommitResult>("commit_session", { sessionId, message });
}

/** Open the session's worktree in the system's default editor (e.g. VS Code). */
export async function openInEditor(sessionId: string): Promise<void> {
  assertDesktop();
  return invoke<void>("open_in_editor", { sessionId });
}

/** Open a terminal pointed at the session's worktree directory. */
export async function openTerminal(sessionId: string): Promise<void> {
  assertDesktop();
  return invoke<void>("open_terminal", { sessionId });
}

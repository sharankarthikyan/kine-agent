import type { SessionSummary } from "./sessions";

export interface WorkspaceGroup {
  workspace: string;
  sessions: SessionSummary[];
}

/**
 * Extract the workspace name from a repo path.
 * Workspace = basename of the repo path (last non-empty path segment).
 * If the repo is empty or resolves to ".", return ".".
 */
function workspaceName(repo: string): string {
  const trimmed = repo.replace(/\/+$/, ""); // strip trailing slashes
  if (!trimmed || trimmed === ".") return ".";
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1) || ".";
}

/**
 * Group sessions by workspace (basename of `repo`).
 * Within each group, sessions are ordered by `updatedAt` descending (most-recent first).
 * Groups are ordered by their most-recent session's `updatedAt` descending.
 */
export function groupByWorkspace(sessions: SessionSummary[]): WorkspaceGroup[] {
  const map = new Map<string, SessionSummary[]>();

  for (const session of sessions) {
    const workspace = workspaceName(session.repo);
    const existing = map.get(workspace);
    if (existing) {
      existing.push(session);
    } else {
      map.set(workspace, [session]);
    }
  }

  const groups: WorkspaceGroup[] = [];
  for (const [workspace, groupSessions] of map) {
    groupSessions.sort((a, b) => b.updatedAt - a.updatedAt);
    groups.push({ workspace, sessions: groupSessions });
  }

  groups.sort((a, b) => {
    const aLatest = a.sessions[0]?.updatedAt ?? 0;
    const bLatest = b.sessions[0]?.updatedAt ?? 0;
    return bLatest - aLatest;
  });

  return groups;
}

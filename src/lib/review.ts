import { invoke } from "@tauri-apps/api/core";

export type ChangeStatus = "added" | "modified" | "deleted";

export interface FileChange {
  path: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
}

export interface SessionDiff {
  files: FileChange[];
  patch: string;
}

export interface ReviewSessionArgs {
  sessionId: string;
}

/** Fetch the diff of a session's worktree for review. */
export async function reviewSession({ sessionId }: ReviewSessionArgs): Promise<SessionDiff> {
  return invoke<SessionDiff>("review_session", { sessionId });
}

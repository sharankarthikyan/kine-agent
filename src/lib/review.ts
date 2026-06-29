import { invoke } from "@tauri-apps/api/core";
import { assertDesktop } from "./agent";

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
  assertDesktop();
  return invoke<SessionDiff>("review_session", { sessionId });
}

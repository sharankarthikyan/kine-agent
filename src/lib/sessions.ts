import { invoke } from "@tauri-apps/api/core";
import { assertDesktop } from "./agent";

export type SessionStatus = "running" | "idle" | "error";

export interface SessionSummary {
  id: string;
  agent: string;
  repo: string;
  branch: string;
  title: string;
  status: SessionStatus;
  source: "kineloop" | "external";
  turnCount: number | null;
  toolCallCount: number | null;
  fileActionCount: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredEvent {
  seq: number;
  kind: string;
  payloadJson: string;
  ts: number;
}

/** All sessions for the list pane, most-recently-updated first. */
export async function listSessions(): Promise<SessionSummary[]> {
  assertDesktop();
  return invoke<SessionSummary[]>("list_sessions");
}

/** A session's persisted events, in order (for rehydrating its conversation). */
export async function sessionEvents(sessionId: string): Promise<StoredEvent[]> {
  assertDesktop();
  return invoke<StoredEvent[]>("session_events", { sessionId });
}

import { invoke } from "@tauri-apps/api/core";
import { assertDesktop } from "./agent";

export type SessionStatus = "running" | "idle" | "error" | "auth";

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
  /**
   * The unified permission mode last used for this session, or null before any run
   * recorded one (and always null for external CLI-history sessions). Optional so test
   * fixtures needn't set it; the backend always sends it for Kineloop sessions.
   */
  permissionMode?: string | null;
  /** Antigravity terminal-sandbox toggle last used. Absent ⇒ false. */
  sandboxTerminal?: boolean;
  /** Streaming engine the session runs on ("pipe" | "acp"). Optional so test
   * fixtures needn't set it; absent ⇒ "pipe" (see `engineForSession`). */
  engine?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredEvent {
  seq: number;
  kind: string;
  payloadJson: string;
  ts: number;
}

export interface SessionEventsPage {
  events: StoredEvent[];
  nextOffset: number;
  hasMore: boolean;
}

/** All sessions for the list pane, most-recently-updated first. */
export async function listSessions(): Promise<SessionSummary[]> {
  assertDesktop();
  return invoke<SessionSummary[]>("list_sessions");
}

/**
 * Rename a session. The backend trims and caps the title at 60 chars and returns the
 * canonical stored form; empty titles are rejected. Kineloop sessions are renamed in
 * place; external CLI-history sessions get a stored title override (their on-disk
 * transcript is never modified), so both kinds are renameable.
 */
export async function renameSession(sessionId: string, title: string): Promise<string> {
  assertDesktop();
  return invoke<string>("rename_session", { sessionId, title });
}

/** A session's persisted events, in order (for rehydrating its conversation). */
export async function sessionEvents(sessionId: string): Promise<StoredEvent[]> {
  assertDesktop();
  return invoke<StoredEvent[]>("session_events", { sessionId });
}

/** A page of persisted events, in order. Used to lazy-load large imported sessions. */
export async function sessionEventsPage(
  sessionId: string,
  offset: number,
  limit: number,
): Promise<SessionEventsPage> {
  assertDesktop();
  return invoke<SessionEventsPage>("session_events_page", { sessionId, offset, limit });
}

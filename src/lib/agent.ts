import { invoke, Channel } from "@tauri-apps/api/core";

/**
 * The agent backend only exists inside the Tauri desktop window (where
 * `window.__TAURI_INTERNALS__` is injected). Calling IPC from a plain browser
 * preview (e.g. opening the Vite URL in Chrome) would otherwise fail with a
 * cryptic "transformCallback" error — throw an actionable message instead.
 */
export function assertDesktop(): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    throw new Error(
      "Agents run only in the agent-editor desktop app. Launch it with `npm run tauri dev` — the browser preview can't reach the backend.",
    );
  }
}

export type AgentEvent =
  | { kind: "token"; data: { text: string } }
  | { kind: "toolCall"; data: { name: string; input: string } }
  | { kind: "fileWrite"; data: { path: string } }
  | { kind: "approvalNeeded"; data: { prompt: string } }
  | { kind: "done"; data: { summary: string } }
  | { kind: "error"; data: { message: string } };

export interface StartSessionArgs {
  prompt: string;
  repo: string;
  onEvent: (event: AgentEvent) => void;
}

/**
 * Start a session against `repo`. A fresh session id is generated, the backend
 * creates an isolated worktree for it, and events stream back via `onEvent`.
 * Returns the session id so the caller can later `cleanupSession`.
 */
export async function startSession({ prompt, repo, onEvent }: StartSessionArgs): Promise<string> {
  assertDesktop();
  const sessionId = crypto.randomUUID();
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  await invoke("start_session", { prompt, repo, sessionId, onEvent: channel });
  return sessionId;
}

export interface CleanupSessionArgs {
  repo: string;
  sessionId: string;
}

/** Remove the worktree and branch for a finished session. */
export async function cleanupSession({ repo, sessionId }: CleanupSessionArgs): Promise<void> {
  assertDesktop();
  await invoke("cleanup_session", { repo, sessionId });
}

export interface SendMessageArgs {
  sessionId: string;
  prompt: string;
  onEvent: (event: AgentEvent) => void;
}

/** Continue an existing session with a follow-up message. */
export async function sendMessage({ sessionId, prompt, onEvent }: SendMessageArgs): Promise<void> {
  assertDesktop();
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  await invoke("send_message", { sessionId, prompt, onEvent: channel });
}

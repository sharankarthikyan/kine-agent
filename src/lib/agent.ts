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
      "Agents run only in the Kineloop desktop app. Launch it with `npm run tauri dev` — the browser preview can't reach the backend.",
    );
  }
}

export type AgentEvent =
  | { kind: "token"; data: { text: string } }
  | { kind: "toolCall"; data: { name: string; input: string } }
  | { kind: "fileWrite"; data: { path: string } }
  | { kind: "approvalNeeded"; data: { prompt: string } }
  | { kind: "done"; data: { summary: string } }
  | { kind: "error"; data: { message: string } }
  | {
      kind: "usage";
      data: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        costUsd: number | null;
        model: string | null;
      };
    };

export interface StartSessionArgs {
  prompt: string;
  repo: string;
  sessionId: string;
  /** Which agent CLI to spawn ("claude" | "codex" | "antigravity"). Omit ⇒ "claude". */
  agent?: string;
  /** Model id/alias forwarded to the agent CLI's --model. Omit to use the CLI default. */
  model?: string;
  /** Permission mode forwarded to the agent CLI. The backend only allows default, acceptEdits, and plan. */
  permissionMode?: string;
  onEvent: (event: AgentEvent) => void;
}

/**
 * Start a session against `repo`. The caller owns the session id (typically
 * generated with `crypto.randomUUID()` before calling this, so the UI can
 * render an optimistic row immediately). The backend creates an isolated
 * worktree for the session and events stream back via `onEvent`.
 */
export async function startSession({ prompt, repo, sessionId, agent, model, permissionMode, onEvent }: StartSessionArgs): Promise<void> {
  assertDesktop();
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  await invoke("start_session", { prompt, repo, sessionId, agent, model, permissionMode, onEvent: channel });
}

/** Remove the worktree and branch for a finished session. */
export async function cleanupSession(sessionId: string): Promise<void> {
  assertDesktop();
  await invoke("cleanup_session", { sessionId });
}

export interface SendMessageArgs {
  sessionId: string;
  prompt: string;
  /** Claude CLI model alias (e.g. "opus", "sonnet", "haiku"). Omit to use the CLI default. */
  model?: string;
  /** Permission mode forwarded to the agent CLI. The backend only allows default, acceptEdits, and plan. */
  permissionMode?: string;
  onEvent: (event: AgentEvent) => void;
}

/** Open the native folder picker and return a backend-trusted git repository root. */
export async function pickRepository(): Promise<string | null> {
  assertDesktop();
  return invoke<string | null>("pick_repository");
}

/** Repositories previously selected through the backend-owned native picker. */
export async function listTrustedRepos(): Promise<string[]> {
  assertDesktop();
  return invoke<string[]>("list_trusted_repos");
}

/** Continue an existing session with a follow-up message. */
export async function sendMessage({ sessionId, prompt, model, permissionMode, onEvent }: SendMessageArgs): Promise<void> {
  assertDesktop();
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  await invoke("send_message", { sessionId, prompt, model, permissionMode, onEvent: channel });
}

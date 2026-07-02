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

/** One selectable answer to an approval request (pipe: fixed allow/deny; ACP: agent-supplied). */
export interface ApprovalOption {
  id: string;
  label: string;
  kind: string;
}

export type AgentEvent =
  | { kind: "token"; data: { text: string } }
  | { kind: "thought"; data: { text: string } }
  | { kind: "status"; data: { text: string } }
  | { kind: "toolCall"; data: { name: string; input: string; toolCallId?: string } }
  | { kind: "toolStatus"; data: { toolCallId: string; status: string; detail: string } }
  | { kind: "plan"; data: { entriesJson: string } }
  | { kind: "commands"; data: { commandsJson: string } }
  | { kind: "fileWrite"; data: { path: string } }
  | {
      kind: "approvalNeeded";
      data: {
        requestId: string;
        tool: string;
        input: string;
        prompt: string;
        options?: ApprovalOption[];
      };
    }
  | { kind: "approvalResolved"; data: { requestId: string; selectedOptionId: string } }
  | { kind: "done"; data: { summary: string } }
  | { kind: "error"; data: { message: string } }
  | { kind: "notice"; data: { message: string } }
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
  /**
   * Unified permission mode forwarded to the agent CLI. One of: default, acceptEdits,
   * plan, full, dontAsk, auto. Each adapter maps it onto that CLI's real flags.
   */
  permissionMode?: string;
  /** Antigravity-only: restrict terminal commands' network/disk access (`agy --sandbox`). */
  sandboxTerminal?: boolean;
  /** Streaming engine: "pipe" (default, CLI adapters) | "acp" (beta, claude + codex). */
  engine?: Engine;
  onEvent: (event: AgentEvent) => void;
}

/** Streaming engines a session can run on. Backend re-validates per agent. */
export type Engine = "pipe" | "acp";

/** ACP-capable agents are claude (M1) + codex (M6): switching a draft between
 * them keeps the chosen engine; any other agent resets to pipe. Gemini joins
 * in M7. Single home for the rule — widen it here. */
export function engineForAgentSwitch(nextAgentId: string, currentEngine: Engine): Engine {
  return nextAgentId === "claude" || nextAgentId === "codex" ? currentEngine : "pipe";
}

/**
 * Start a session against `repo`. The caller owns the session id (typically
 * generated with `crypto.randomUUID()` before calling this, so the UI can
 * render an optimistic row immediately). The backend creates an isolated
 * worktree for the session and events stream back via `onEvent`.
 */
export async function startSession({ prompt, repo, sessionId, agent, model, permissionMode, sandboxTerminal, engine, onEvent }: StartSessionArgs): Promise<void> {
  assertDesktop();
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  await invoke("start_session", { prompt, repo, sessionId, agent, model, permissionMode, sandboxTerminal, engine, onEvent: channel });
}

/** Remove the worktree and branch for a finished session. */
export async function cleanupSession(sessionId: string): Promise<void> {
  assertDesktop();
  await invoke("cleanup_session", { sessionId });
}

/**
 * Answer a pending tool-approval request with the option the user selected (per-option
 * buttons). Resolves the request the agent's approval bridge is blocking on. Returns true
 * when a matching pending request for this session was found; an unknown/stale id is a
 * harmless no-op. Agent-agnostic.
 */
export async function respondToApproval(
  sessionId: string,
  requestId: string,
  selectedOptionId: string,
  message?: string,
): Promise<boolean> {
  assertDesktop();
  return invoke<boolean>("respond_to_approval", { sessionId, requestId, selectedOptionId, message });
}

/**
 * Request cancellation of an in-flight run. Resolves to true if a run was signalled to
 * stop, false if nothing was running. The backend kills the agent's child process and
 * marks the session idle (a user stop is not a failure).
 */
export async function stopSession(sessionId: string): Promise<boolean> {
  assertDesktop();
  return invoke<boolean>("stop_session", { sessionId });
}

export interface SendMessageArgs {
  sessionId: string;
  prompt: string;
  /** Claude CLI model alias (e.g. "opus", "sonnet", "haiku"). Omit to use the CLI default. */
  model?: string;
  /** Unified permission mode: default, acceptEdits, plan, full, dontAsk, or auto. */
  permissionMode?: string;
  /** Antigravity-only: restrict terminal commands' network/disk access. */
  sandboxTerminal?: boolean;
  onEvent: (event: AgentEvent) => void;
}

export interface ContinueExternalSessionArgs {
  externalSessionId: string;
  prompt: string;
  sessionId: string;
  /** Supported Kineloop agent used for the writable continuation. */
  agent?: string;
  /** Model id/alias forwarded to the adopted session's agent CLI. */
  model?: string;
  /** Unified permission mode forwarded to the adopted session's agent CLI. */
  permissionMode?: string;
  /** Antigravity-only: restrict terminal commands' network/disk access. */
  sandboxTerminal?: boolean;
  /** The originating CLI-history session's title, so the continuation inherits it. */
  title?: string;
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
export async function sendMessage({ sessionId, prompt, model, permissionMode, sandboxTerminal, onEvent }: SendMessageArgs): Promise<void> {
  assertDesktop();
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  await invoke("send_message", { sessionId, prompt, model, permissionMode, sandboxTerminal, onEvent: channel });
}

/** Adopt an imported CLI history session into a new writable Kineloop continuation. */
export async function continueExternalSession({
  externalSessionId,
  prompt,
  sessionId,
  agent,
  model,
  permissionMode,
  sandboxTerminal,
  title,
  onEvent,
}: ContinueExternalSessionArgs): Promise<void> {
  assertDesktop();
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  await invoke("continue_external_session", {
    externalSessionId,
    prompt,
    sessionId,
    agent,
    model,
    permissionMode,
    sandboxTerminal,
    title,
    onEvent: channel,
  });
}

import { invoke, Channel } from "@tauri-apps/api/core";

export type AgentEvent =
  | { kind: "token"; data: { text: string } }
  | { kind: "toolCall"; data: { name: string; input: string } }
  | { kind: "fileWrite"; data: { path: string } }
  | { kind: "approvalNeeded"; data: { prompt: string } }
  | { kind: "done"; data: { summary: string } }
  | { kind: "error"; data: { message: string } };

export interface StartSessionArgs {
  prompt: string;
  cwd: string;
  onEvent: (event: AgentEvent) => void;
}

export async function startSession({ prompt, cwd, onEvent }: StartSessionArgs): Promise<void> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  await invoke("start_session", { prompt, cwd, onEvent: channel });
}

import { invoke } from "@tauri-apps/api/core";
import { assertDesktop } from "./agent";

/** Mirrors the Rust `AgentInfo` struct (serde camelCase). */
export interface AgentInfo {
  id: string;
  label: string;
  installed: boolean;
}

/**
 * Mirrors the Rust `ModelInfo` struct (serde camelCase).
 * `value` is what gets forwarded to the CLI `--model` flag — a family alias
 * (`opus`/`sonnet`/`haiku`) that the CLI resolves to the latest version.
 * `label` upgrades from the bare family name ("Claude Opus") to the resolved
 * versioned name ("Claude Opus 4.8") once `refreshModels` resolves it.
 * `description` carries the resolved full model id (`claude-opus-4-8`) when known.
 */
export interface ModelInfo {
  value: string;
  label: string;
  agent: string;
  description: string | null;
  disabled: boolean;
  contextWindow: number | null;
}

/**
 * Agent ids Kineloop can currently spawn. Any other detected agent (e.g. the
 * deprecated standalone Gemini CLI) still appears in the pickers for
 * discoverability but is disabled with a "coming soon" hint until its spawn
 * adapter lands. Keep in sync with the backend's `start_session` dispatch /
 * `SPAWNABLE_AGENTS`.
 */
export const SPAWNABLE_AGENT_IDS = new Set<string>([
  "claude",
  "codex",
  "antigravity",
]);

/** Whether Kineloop can currently launch a session with this agent. */
export function isAgentSpawnable(agentId: string): boolean {
  return SPAWNABLE_AGENT_IDS.has(agentId);
}

/** Discover which agent CLIs are installed on this machine. */
export async function detectAgents(): Promise<AgentInfo[]> {
  assertDesktop();
  return invoke<AgentInfo[]>("detect_agents");
}

/** List available models for a given agent. Returns [] for agents with no model discovery. */
export async function listModels(agent: string): Promise<ModelInfo[]> {
  assertDesktop();
  return invoke<ModelInfo[]>("list_models", { agent });
}

/**
 * Re-resolve a model list against the CLI under the user's subscription auth,
 * upgrading alias labels to versioned names (e.g. "Claude Opus 4.8"). May spawn
 * CLI subprocesses, so it can take a few seconds on a cold cache — call it in
 * the background after `listModels` rather than blocking initial render.
 */
export async function refreshModels(agent: string): Promise<ModelInfo[]> {
  assertDesktop();
  return invoke<ModelInfo[]>("refresh_models", { agent });
}

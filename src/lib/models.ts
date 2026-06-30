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

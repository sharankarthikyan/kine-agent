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
 * `value` is what gets forwarded to the CLI `--model` flag.
 * `source` is "api" when pulled from the live Anthropic catalog, "fallback" when hardcoded defaults.
 */
export interface ModelInfo {
  value: string;
  label: string;
  agent: string;
  description: string | null;
  source: "api" | "fallback";
  disabled: boolean;
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

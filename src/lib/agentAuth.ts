// BYOK ("bring your own key") API-key auth for spawnable agents.
//
// Kine Agent's default stays "drive the vendor CLI under your own login". This is the opt-in
// alternative: for agents whose CLI honors an API key (Claude, Codex — NOT Antigravity),
// the user can save a key and Kine Agent injects it at spawn as metered, first-party billing.
//
// The key never round-trips to the frontend: it crosses to the backend once on save
// (write-only) and is stored in the OS keychain. These wrappers only ever move the
// non-secret status (which mode, whether a key exists) back to the UI.

import { invoke } from "@tauri-apps/api/core";

export type AuthMode = "subscription" | "apikey";

export interface AgentAuthStatus {
  agent: string;
  /** Whether this agent's CLI can authenticate with an API key at all. */
  supportsApiKey: boolean;
  /** The persisted choice. */
  mode: AuthMode;
  /** Whether a key is stored in the OS keychain (the key itself is never returned). */
  hasKey: boolean;
}

/** Read an agent's auth status (mode + whether a key is stored). Never returns the key. */
export async function getAgentAuthStatus(agent: string): Promise<AgentAuthStatus> {
  return invoke<AgentAuthStatus>("agent_auth_status", { agent });
}

/** Save (or replace) an agent's API key and switch it to API-key mode. */
export async function setAgentApiKey(agent: string, key: string): Promise<void> {
  await invoke("set_agent_api_key", { agent, key });
}

/** Delete an agent's stored key and revert it to subscription mode. */
export async function clearAgentApiKey(agent: string): Promise<void> {
  await invoke("clear_agent_api_key", { agent });
}

/** Switch an agent between subscription and API-key auth (API-key requires a saved key). */
export async function setAgentAuthMode(agent: string, mode: AuthMode): Promise<void> {
  await invoke("set_agent_auth_mode", { agent, mode });
}

import { invoke } from "@tauri-apps/api/core";
import { assertDesktop } from "./agent";

export interface RuleFile {
  path: string;
  label: string;
  scope: "project" | "global";
  exists: boolean;
}

export interface Capability {
  name: string;
  description: string | null;
  source: "project" | "user";
}

export interface Capabilities {
  skills: Capability[];
  subagents: Capability[];
  commands: Capability[];
}

/** Return the rule/config files (CLAUDE.md, .rules, etc.) visible to this session's worktree. */
export async function inspectRules(sessionId: string): Promise<RuleFile[]> {
  assertDesktop();
  return invoke<RuleFile[]>("inspect_rules", { sessionId });
}

/** Read a text file from within the session's worktree. */
export async function readTextFile(sessionId: string, path: string): Promise<string> {
  assertDesktop();
  return invoke<string>("read_text_file", { sessionId, path });
}

/** List the skills, subagents, and slash-commands available to a given agent in this session. */
export async function listCapabilities(sessionId: string, agent: string): Promise<Capabilities> {
  assertDesktop();
  return invoke<Capabilities>("list_capabilities", { sessionId, agent });
}

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
  /** Absolute path to the capability's backing file on disk. Empty string when unknown. */
  path: string;
}

export interface Capabilities {
  skills: Capability[];
  subagents: Capability[];
  commands: Capability[];
}

/** Return the rule/config files (CLAUDE.md, .rules, etc.) visible to this session's
 *  worktree. Pass `null` to inspect only the user's global `~/.claude` scope (no session). */
export async function inspectRules(sessionId: string | null): Promise<RuleFile[]> {
  assertDesktop();
  return invoke<RuleFile[]>("inspect_rules", { sessionId });
}

/** Read a text file from within the session's worktree, or — when `sessionId` is `null` —
 *  from the user's global `~/.claude` scope. */
export async function readTextFile(sessionId: string | null, path: string): Promise<string> {
  assertDesktop();
  return invoke<string>("read_text_file", { sessionId, path });
}

/** Write content to a rule/config or capability file within the session's worktree.
 *  The path must already exist and be within the identical allowlist as readTextFile —
 *  only files discovered by rule_candidates or list_capabilities (resolved inside the
 *  worktree or ~/.claude) are writable. Content exceeding 1 MiB is rejected server-side.
 */
export async function writeTextFile(
  sessionId: string,
  path: string,
  content: string,
): Promise<void> {
  assertDesktop();
  return invoke<void>("write_text_file", { sessionId, path, content });
}

/** List the skills, subagents, and slash-commands available to a given agent in this
 *  session. Pass `null` for `sessionId` to list only the user's global `~/.claude` scope. */
export async function listCapabilities(
  sessionId: string | null,
  agent: string,
): Promise<Capabilities> {
  assertDesktop();
  return invoke<Capabilities>("list_capabilities", { sessionId, agent });
}

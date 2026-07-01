/**
 * Unified permission model shared by the New Session composer and the per-turn PromptBar.
 *
 * Each agent CLI exposes a different permission vocabulary, so the UI offers only the
 * subset an agent truly supports and coerces anything unsupported to a safe nearest mode.
 * The wire ids here match the backend's `PermissionMode` (src-tauri/src/permission.rs).
 */

export type PermissionMode =
  | "plan"
  | "default"
  | "acceptEdits"
  | "full"
  | "dontAsk";

/** The safe default: read freely, edits/commands not auto-approved. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

export interface PermissionModeMeta {
  value: PermissionMode;
  label: string;
  /** Generic, agent-independent description shown in the dropdown. */
  description: string;
  /** Full access. Needs an explicit confirmation and warning styling. */
  danger?: boolean;
  /** Grouped under an "Advanced" heading (Claude-only extras). */
  advanced?: boolean;
}

export const PERMISSION_MODE_META: Record<PermissionMode, PermissionModeMeta> = {
  plan: {
    value: "plan",
    label: "Plan only",
    description: "Reads and proposes a plan. Won't change files.",
  },
  default: {
    value: "default",
    label: "Ask before edits",
    description: "Reads freely. Edits and commands aren't auto-approved.",
  },
  acceptEdits: {
    value: "acceptEdits",
    label: "Auto-edit",
    description: "Applies file edits automatically. Risky shell/network stays gated where supported.",
  },
  full: {
    value: "full",
    label: "Full access",
    description:
      "Auto-approves everything, including shell commands. Runs only inside this session's isolated worktree.",
    danger: true,
  },
  dontAsk: {
    value: "dontAsk",
    label: "Locked-down (CI)",
    description: "Auto-denies anything needing approval; only pre-allowed tools and read-only commands run.",
    advanced: true,
  },
};

/**
 * Modes each agent supports, in display order (core first, then advanced). Derived from
 * each CLI's real capabilities: Claude has the full set; Codex has three tiers (no
 * plan/approval flag in headless exec); Antigravity is all-or-nothing (Ask vs Full).
 */
const AGENT_MODES: Record<string, PermissionMode[]> = {
  claude: ["plan", "default", "acceptEdits", "full", "dontAsk"],
  codex: ["default", "acceptEdits", "full"],
  antigravity: ["default", "full"],
};

/** Modes offered for an agent. Unknown agents fall back to the safe common tier. */
export function permissionModesForAgent(agent: string): PermissionMode[] {
  return AGENT_MODES[agent] ?? ["default", "acceptEdits", "full"];
}

export function isPermissionModeSupported(mode: PermissionMode, agent: string): boolean {
  return permissionModesForAgent(agent).includes(mode);
}

export function permissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODE_META[mode]?.label ?? mode;
}

/**
 * Coerce a mode to one the agent supports. Always resolves DOWN to the safe `default`
 * (never auto-escalates to Full on an incidental agent switch), so switching agents can't
 * silently widen blast radius. `changed` lets the caller surface a note.
 */
export function coercePermissionMode(
  mode: PermissionMode,
  agent: string,
): { mode: PermissionMode; changed: boolean } {
  if (isPermissionModeSupported(mode, agent)) return { mode, changed: false };
  const supported = permissionModesForAgent(agent);
  const fallback = supported.includes(DEFAULT_PERMISSION_MODE)
    ? DEFAULT_PERMISSION_MODE
    : supported[0];
  return { mode: fallback, changed: true };
}

/**
 * A short per-agent qualifier for the currently-selected mode, surfaced under the control
 * so the same label's materially different blast radius per agent is never a surprise.
 * Returns null when the generic description already says enough.
 */
export function permissionQualifier(mode: PermissionMode, agent: string): string | null {
  if (agent === "codex") {
    if (mode === "default") return "Codex: read-only. Pick Auto-edit to let it write.";
    if (mode === "acceptEdits") return "Codex: writes in an OS sandbox (network off).";
    if (mode === "full") return "Codex: removes the sandbox entirely.";
  }
  if (agent === "antigravity") {
    if (mode === "default") return "Antigravity: edits stay gated and may stall in headless runs.";
    if (mode === "full") return "Antigravity: the only tier that lets it edit autonomously.";
  }
  if (agent === "claude" && mode === "full") {
    return "Claude: bypasses all permission checks.";
  }
  return null;
}

// Per-agent enablement preferences (frontend-only, like recents.ts / acpNotice.ts).
//
// Kine Agent drives each vendor's official CLI under the user's OWN subscription
// login — it never handles a token or calls a vendor API itself. For OpenAI Codex
// that is an officially supported, scriptable path. For Claude Code, Anthropic has
// stated that `claude -p` / ACP / third-party apps built on the Agent SDK keep
// working with subscriptions (June 2026) — a stated position, not a guarantee.
// For Antigravity, Google's terms flatly bar third-party access and Google has
// permanently banned paid subscribers for it. So the app ships with only Codex
// enabled and asks for a deliberate, informed choice before enabling the other two.
//
// This is a user preference, not a security boundary: the backend still validates
// which agents are spawnable. Disabling an agent only governs starting NEW sessions
// with it — sessions already running keep working (a disable is never a kill switch).

/** How risky it is to drive this agent under a consumer subscription via Kine Agent. */
export type AgentRisk = "compliant" | "warn" | "high";

export interface AgentMeta {
  id: string;
  label: string;
  risk: AgentRisk;
  /** Short muted line shown beside the agent in Settings. */
  note: string;
  /** Official install/setup docs — linked when the CLI isn't installed. */
  installDocsUrl: string;
  /** One-time acknowledgement shown before enabling; null when no consent is needed. */
  consent: { title: string; body: string } | null;
}

/**
 * The spawnable agents shown in Settings, in display order: the compliant default
 * (Codex) first, then the two that require an informed opt-in. Install URLs are the
 * vendors' official setup docs (they track the current per-OS install method, so
 * they don't go stale the way a hardcoded command would).
 */
export const AGENT_META: AgentMeta[] = [
  {
    id: "codex",
    label: "OpenAI Codex",
    risk: "compliant",
    note: "Scriptable under your ChatGPT plan — the supported path.",
    installDocsUrl: "https://developers.openai.com/codex/cli",
    consent: null,
  },
  {
    id: "claude",
    label: "Claude Code",
    risk: "warn",
    note: "Reads your Claude subscription login.",
    installDocsUrl: "https://code.claude.com/docs/en/setup",
    consent: {
      title: "Before you enable Claude Code",
      body: "Anthropic's Consumer Terms bar third-party tools from routing subscription requests themselves — taking your OAuth token and calling the API as if they were Claude Code. Kine Agent does not do that: it spawns the official claude binary, which authenticates itself, and Anthropic has said that claude -p, ACP, and third-party apps built on the Agent SDK continue to work with Claude subscriptions, with advance notice before any change. That is a stated position, not a guarantee — terms and limits can change. Adding an API key in Settings puts you on the path Anthropic documents for developers.",
    },
  },
  {
    id: "antigravity",
    label: "Antigravity",
    risk: "high",
    note: "Reads your Antigravity subscription login.",
    installDocsUrl: "https://antigravity.google/docs/cli-install",
    consent: {
      title: "Before you enable Antigravity",
      body: "Antigravity signs in with your Google account. Google's terms don't cover automated use through third-party tools like Kine Agent, and Google actively enforces this: paid subscribers have had their accounts permanently banned, without warning, for using third-party tools. Antigravity's CLI has no API-key alternative, so enable it only if you accept that risk for your own Google account.",
    },
  },
];

/** Look up an agent's metadata, or undefined for an unknown id. */
export function agentMeta(id: string): AgentMeta | undefined {
  return AGENT_META.find((m) => m.id === id);
}

const STORAGE_KEY = "kine-agent.agentPrefs";
// Pre-rename storage key. Read as a fallback so an existing user's agent enable/acknowledge
// choices survive the rename; the next write lands under the new key.
const LEGACY_STORAGE_KEY = "kineloop.agentPrefs";

// Agents enabled on a fresh install. Only Codex — everything else, including any
// future agent not yet in a stored prefs blob, defaults OFF until the user opts in.
const DEFAULT_ENABLED = new Set<string>(["codex"]);

export interface AgentPrefs {
  /** id → user's explicit enable/disable choice. Absent ⇒ the built-in default. */
  enabled: Record<string, boolean>;
  /** id → whether the one-time risk acknowledgement has been given. */
  acknowledged: Record<string, boolean>;
}

// A minimal storage surface so tests can inject a fake and the reads/writes stay
// pure — mirrors the `storage` param in acpNotice.ts.
type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

/**
 * Read the persisted prefs, merging over safe defaults. Never throws: a missing,
 * corrupt, partial, or unavailable store falls back to defaults (Codex on, others
 * off), exactly like getRecentRepos().
 */
export function readAgentPrefs(
  storage: ReadableStorage = window.localStorage,
): AgentPrefs {
  const prefs: AgentPrefs = { enabled: {}, acknowledged: {} };
  try {
    const raw = storage.getItem(STORAGE_KEY) ?? storage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return prefs;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return prefs;
    const obj = parsed as Partial<AgentPrefs>;
    if (obj.enabled && typeof obj.enabled === "object") {
      for (const [id, v] of Object.entries(obj.enabled)) {
        if (typeof v === "boolean") prefs.enabled[id] = v;
      }
    }
    if (obj.acknowledged && typeof obj.acknowledged === "object") {
      for (const [id, v] of Object.entries(obj.acknowledged)) {
        if (typeof v === "boolean") prefs.acknowledged[id] = v;
      }
    }
  } catch {
    // Malformed JSON or storage access error → safe defaults.
  }
  return prefs;
}

/** Persist prefs. Silently no-ops if storage is unavailable (in-memory only). */
export function writeAgentPrefs(
  prefs: AgentPrefs,
  storage: WritableStorage = window.localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode, quota) — the in-memory prefs still apply.
  }
}

/**
 * Whether an agent may be picked for a NEW session. An id with no explicit choice
 * falls back to the built-in default (only Codex on), so a brand-new agent added in
 * a future release is off until the user turns it on.
 */
export function isAgentEnabled(id: string, prefs: AgentPrefs): boolean {
  const choice = prefs.enabled[id];
  return choice === undefined ? DEFAULT_ENABLED.has(id) : choice;
}

/** Whether the one-time risk acknowledgement has already been given for this agent. */
export function hasAcknowledged(id: string, prefs: AgentPrefs): boolean {
  return prefs.acknowledged[id] === true;
}

/** Return prefs with `id` enabled/disabled. Enabling also records the acknowledgement. */
export function setAgentEnabled(prefs: AgentPrefs, id: string, on: boolean): AgentPrefs {
  return {
    enabled: { ...prefs.enabled, [id]: on },
    acknowledged: on
      ? { ...prefs.acknowledged, [id]: true }
      : prefs.acknowledged,
  };
}

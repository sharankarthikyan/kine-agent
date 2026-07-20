// Per-agent customization (frontend-only, like agentPrefs.ts): icon color,
// default model, and the user's curated model list (hide / add custom / reorder).
//
// The model picker never renders the raw discovered list — it renders
// composeModels(discovered, config), so a user's curation applies everywhere
// from one pure function. The stored config never names an invisible default:
// updateAgentConfig clears defaultModel when the patch hides or removes it.

import { useSyncExternalStore } from "react";
import type { ModelInfo } from "./models";

export interface CustomModel {
  value: string;
  label: string | null;
}

export interface AgentConfig {
  /** Curated color token ("amber" | ...), or null for the built-in tint. */
  color: string | null;
  /** Model `value` preselected for new sessions; null = auto (first enabled). */
  defaultModel: string | null;
  /** Discovered model values hidden from the picker. */
  hiddenModels: string[];
  /** User-added model ids, forwarded verbatim to the CLI's --model. */
  customModels: CustomModel[];
  /** Model values in display order; values not listed append after. */
  modelOrder: string[];
}

export type AgentConfigMap = Record<string, AgentConfig>;

export const AGENT_COLOR_TOKENS = [
  "amber", "teal", "blue", "violet", "rose",
  "emerald", "orange", "cyan", "pink", "indigo",
] as const;

// Literal class strings so Tailwind's JIT sees them; never build these dynamically.
export const AGENT_COLOR_CLASSES: Record<string, string> = {
  amber: "text-amber-500",
  teal: "text-teal-500",
  blue: "text-blue-500",
  violet: "text-violet-500",
  rose: "text-rose-500",
  emerald: "text-emerald-500",
  orange: "text-orange-500",
  cyan: "text-cyan-500",
  pink: "text-pink-500",
  indigo: "text-indigo-500",
};

const STORAGE_KEY = "kine-agent.agentConfig";
export const CONFIG_CHANGED_EVENT = "kine-agent:agent-config-changed";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function emptyAgentConfig(): AgentConfig {
  return { color: null, defaultModel: null, hiddenModels: [], customModels: [], modelOrder: [] };
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function customModels(v: unknown): CustomModel[] {
  if (!Array.isArray(v)) return [];
  const out: CustomModel[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== "object") continue;
    const { value, label } = entry as Partial<CustomModel>;
    if (typeof value !== "string" || value.length === 0) continue;
    out.push({ value, label: typeof label === "string" ? label : null });
  }
  return out;
}

function parseAgentConfig(v: unknown): AgentConfig | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Partial<AgentConfig>;
  return {
    color: typeof obj.color === "string" ? obj.color : null,
    defaultModel: typeof obj.defaultModel === "string" ? obj.defaultModel : null,
    hiddenModels: stringArray(obj.hiddenModels),
    customModels: customModels(obj.customModels),
    modelOrder: stringArray(obj.modelOrder),
  };
}

/** Read all stored configs. Never throws: corrupt/missing storage → {}. */
export function readAgentConfigs(
  storage: ReadableStorage = window.localStorage,
): AgentConfigMap {
  const map: AgentConfigMap = {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return map;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return map;
    for (const [id, v] of Object.entries(parsed)) {
      const cfg = parseAgentConfig(v);
      if (cfg) map[id] = cfg;
    }
  } catch {
    // Malformed JSON or storage access error → safe defaults.
  }
  return map;
}

/** Persist configs and notify subscribers (useAgentConfigs). No-ops on failure. */
export function writeAgentConfigs(
  map: AgentConfigMap,
  storage: WritableStorage = window.localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable — in-memory state still applies for this session.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CONFIG_CHANGED_EVENT));
  }
}

export function getAgentConfig(map: AgentConfigMap, agentId: string): AgentConfig {
  return map[agentId] ?? emptyAgentConfig();
}

/**
 * Return a new map with `patch` applied to `agentId`. Enforces the invariant
 * that defaultModel never names a hidden model or a removed custom model.
 * If `discoveredValues` is provided, clearing is skipped when the removed
 * custom value is still present among discovered models.
 */
export function updateAgentConfig(
  map: AgentConfigMap,
  agentId: string,
  patch: Partial<AgentConfig>,
  discoveredValues?: readonly string[],
): AgentConfigMap {
  const current = getAgentConfig(map, agentId);
  const next: AgentConfig = { ...current, ...patch };
  if (next.defaultModel !== null) {
    const hidden = next.hiddenModels.includes(next.defaultModel);
    const wasCustom = current.customModels.some((m) => m.value === next.defaultModel);
    const stillCustom = next.customModels.some((m) => m.value === next.defaultModel);
    const stillDiscovered = discoveredValues?.includes(next.defaultModel) ?? false;
    if (hidden || (wasCustom && !stillCustom && !stillDiscovered)) next.defaultModel = null;
  }
  return { ...map, [agentId]: next };
}

/**
 * The picker's list: discovered ⊕ custom, deduped by value (discovered wins,
 * a non-null custom label overrides), hidden filtered out, ordered by
 * modelOrder with unlisted values appended in merged order.
 */
export function composeModels(
  discovered: ModelInfo[],
  config: AgentConfig,
  agentId: string,
): ModelInfo[] {
  const byValue = new Map<string, ModelInfo>();
  for (const m of discovered) byValue.set(m.value, m);
  for (const custom of config.customModels) {
    const existing = byValue.get(custom.value);
    if (existing) {
      if (custom.label) byValue.set(custom.value, { ...existing, label: custom.label });
      continue;
    }
    byValue.set(custom.value, {
      value: custom.value,
      label: custom.label ?? custom.value,
      agent: agentId,
      description: null,
      disabled: false,
      contextWindow: null,
    });
  }
  const merged = [...byValue.values()].filter(
    (m) => !config.hiddenModels.includes(m.value),
  );
  if (config.modelOrder.length === 0) return merged;
  const rank = new Map(config.modelOrder.map((v, i) => [v, i]));
  return [...merged].sort((a, b) => {
    const ra = rank.get(a.value) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.value) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return merged.indexOf(a) - merged.indexOf(b);
  });
}

/** Composer preselection: configured default if visible and enabled, else first enabled. */
export function pickDefaultModel(
  composed: ModelInfo[],
  config: AgentConfig,
): ModelInfo | null {
  const configured =
    config.defaultModel !== null
      ? composed.find((m) => m.value === config.defaultModel && !m.disabled)
      : undefined;
  return configured ?? composed.find((m) => !m.disabled) ?? composed[0] ?? null;
}

// ---- reactive read (module tail) ----------------------------------------

// Cache keyed on the raw string so getSnapshot returns a stable reference
// between writes (useSyncExternalStore requires referential stability).
let snapshotRaw: string | null | undefined;
let snapshotMap: AgentConfigMap = {};

function getSnapshot(): AgentConfigMap {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshotMap = readAgentConfigs();
  }
  return snapshotMap;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CONFIG_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CONFIG_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Reactive view of all agent configs; updates on any writeAgentConfigs call. */
export function useAgentConfigs(): AgentConfigMap {
  return useSyncExternalStore(subscribe, getSnapshot, () => snapshotMap);
}

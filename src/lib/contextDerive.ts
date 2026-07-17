import type { StoredEvent } from "./sessions";
import type { Capabilities, RuleFile } from "./inspect";
import type { McpServerEntry } from "./conductor";

export type FileAction = "read" | "edited" | "created";

export interface SessionFile {
  path: string;
  action: FileAction;
}

export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  model: string | null;
  /** ACP-reported context occupancy (tokens in window); null on pipe events. */
  contextUsed: number | null;
  /** ACP-reported context window size; null on pipe events. */
  contextWindow: number | null;
}

export interface UsageSummary {
  latest: UsageData | null;
  totals: UsageData;
  eventCount: number;
}

export interface ActivityCounts {
  turnCount: number;
  toolCallCount: number;
  fileActionCount: number;
}

export interface ContextFootprintItem {
  id: string;
  label: string;
  tokens: number;
  detail: string;
}

export interface ContextFootprint {
  totalTokens: number;
  items: ContextFootprintItem[];
}

export interface ContextFootprintInput {
  events: StoredEvent[];
  files: SessionFile[];
  rules: RuleFile[];
  capabilities: Capabilities | null;
  mcpServers: McpServerEntry[];
  resourceTokens: Record<string, number>;
  /** Latest turn's measured context load (from usage telemetry), if known. */
  measuredContextTokens?: number | null;
}

/**
 * Tokens loaded into the context window for one turn. Claude reports cache
 * read/write as separate input buckets. Codex's cached value is a subset of
 * input_tokens, so adding it would double-count.
 */
export function contextLoadTokens(usage: UsageData, agent: string): number {
  // ACP agents report occupancy directly — authoritative over the split heuristic.
  if (usage.contextUsed !== null) return usage.contextUsed;
  if (agent === "claude") {
    return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  }
  return usage.inputTokens;
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  // Cross-model approximation for UI sizing, not billing: English/code average is
  // roughly 3-5 chars/token. Use 4 chars/token and never report sub-token noise.
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

const rank: Record<FileAction, number> = { read: 0, edited: 1, created: 2 };

/**
 * Files the agent touched this session, derived from tool/file events.
 * A path read then written shows as "edited" (strongest action wins).
 * Order = first seen. Assumes events are in seq order.
 */
export function filesFromEvents(events: StoredEvent[]): SessionFile[] {
  const order: string[] = [];
  const action = new Map<string, FileAction>();

  const note = (path: string, a: FileAction) => {
    if (!path) return;
    if (!action.has(path)) order.push(path);
    const current = action.get(path);
    if (!current || rank[a] > rank[current]) action.set(path, a);
  };

  for (const event of events) {
    const data = safeParse(event.payloadJson);

    if (event.kind === "fileWrite") {
      note(String(data.path ?? ""), "edited");
      continue;
    }

    if (event.kind === "toolCall") {
      const name = String(data.name ?? "");
      const input = safeParse(typeof data.input === "string" ? (data.input as string) : "{}");
      const path = String(input.file_path ?? input.path ?? "");
      if (!path) continue;

      if (name === "Read") note(path, "read");
      else if (name === "Write") note(path, "created");
      else if (name === "Edit" || name === "MultiEdit") note(path, "edited");
    }
  }

  return order.map((path) => ({ path, action: action.get(path)! }));
}

/** Coerce an unknown value to a finite number, falling back to 0. */
function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The most recent usage event's data, or null. Every numeric field is validated and
 * coerced — a malformed or partial stored payload (e.g. missing `costUsd`) must never
 * produce `undefined` that later crashes `.toFixed()`/`.toLocaleString()` in the UI.
 */
export function latestUsage(events: StoredEvent[]): UsageData | null {
  return usageSummaryFromEvents(events).latest;
}

export function activityCountsFromEvents(events: StoredEvent[]): ActivityCounts {
  return {
    turnCount: events.filter((event) => event.kind === "prompt").length,
    toolCallCount: events.filter((event) => event.kind === "toolCall").length,
    fileActionCount: filesFromEvents(events).length,
  };
}

function usageFromPayload(payloadJson: string): UsageData {
  const raw = safeParse(payloadJson);
  return {
    inputTokens: asNumber(raw.inputTokens),
    outputTokens: asNumber(raw.outputTokens),
    cacheReadTokens: asNumber(raw.cacheReadTokens),
    cacheCreationTokens: asNumber(raw.cacheCreationTokens),
    costUsd: typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd) ? raw.costUsd : null,
    model: typeof raw.model === "string" ? raw.model : null,
    contextUsed:
      typeof raw.contextUsed === "number" && Number.isFinite(raw.contextUsed)
        ? raw.contextUsed
        : null,
    contextWindow:
      typeof raw.contextWindow === "number" && Number.isFinite(raw.contextWindow)
        ? raw.contextWindow
        : null,
  };
}

/**
 * A sample with every count at zero comes from a turn that made no API call
 * (e.g. a local /usage or /status slash command) — it is not a real
 * measurement and must not become the "latest completed turn".
 */
function isEmptyUsage(usage: UsageData): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheReadTokens === 0 &&
    usage.cacheCreationTokens === 0 &&
    (usage.contextUsed === null || usage.contextUsed === 0) &&
    (usage.costUsd === null || usage.costUsd === 0)
  );
}

export function usageSummaryFromEvents(events: StoredEvent[]): UsageSummary {
  let latest: UsageData | null = null;
  const totals: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
    model: null,
    contextUsed: null,
    contextWindow: null,
  };
  let eventCount = 0;

  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "usage") {
      const usage = usageFromPayload(events[i].payloadJson);
      if (isEmptyUsage(usage)) continue;
      latest = usage;
      break;
    }
  }

  for (const event of events) {
    if (event.kind !== "usage") continue;
    const usage = usageFromPayload(event.payloadJson);
    if (isEmptyUsage(usage)) continue;
    eventCount += 1;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheCreationTokens += usage.cacheCreationTokens;
    if (usage.costUsd !== null) {
      totals.costUsd = (totals.costUsd ?? 0) + usage.costUsd;
    }
  }

  totals.model = latest?.model ?? null;
  return { latest, totals, eventCount };
}

export function contextFootprintFromSources(input: ContextFootprintInput): ContextFootprint {
  const items: ContextFootprintItem[] = [];
  const add = (id: string, label: string, tokens: number, detail: string) => {
    if (tokens <= 0) return;
    items.push({ id, label, tokens, detail });
  };

  let userText = "";
  let agentText = "";
  let toolText = "";
  let usedAgentText = "";
  let usedSkillText = "";
  let usedMcpText = "";
  let usedCommandText = "";
  let observedCapabilityText = "";
  for (const event of input.events) {
    const data = safeParse(event.payloadJson);
    if (event.kind === "prompt" && typeof data.text === "string") {
      userText += `\n${data.text}`;
      const command = data.text.trim().match(/^\/([A-Za-z0-9_-]+)/)?.[1];
      if (command) usedCommandText += `\n/${command}`;
    }
    if (event.kind === "token" && typeof data.text === "string") agentText += `\n${data.text}`;
    if (event.kind === "done" && typeof data.summary === "string") agentText += `\n${data.summary}`;
    if (event.kind === "status" && typeof data.text === "string") agentText += `\n${data.text}`;
    if (event.kind === "toolCall") {
      const name = String(data.name ?? "");
      const text = `${name} ${String(data.input ?? "")}`;
      toolText += `\n${text}`;
      observedCapabilityText += `\n${text}`;
      if (name === "Agent" || name === "Task") usedAgentText += `\n${text}`;
      if (name.startsWith("mcp__")) usedMcpText += `\n${text}`;
    }
  }
  for (const file of input.files) {
    observedCapabilityText += `\n${file.path}`;
  }

  const usedSkillNames = new Set<string>();
  for (const skill of input.capabilities?.skills ?? []) {
    if (skill.path && observedCapabilityText.includes(skill.path)) {
      usedSkillNames.add(skill.name);
    }
  }
  for (const match of observedCapabilityText.matchAll(/[\\/]skills[\\/]([^\\/]+)[\\/](?:SKILL\.md|skill\.md)/gi)) {
    usedSkillNames.add(match[1]);
  }
  if (usedSkillNames.size > 0) {
    usedSkillText = Array.from(usedSkillNames).sort().join("\n");
  }

  add("user", "User messages", estimateTokens(userText), "Visible prompts in this session");
  add("agent", "Agent output", estimateTokens(agentText), "Visible assistant text stored by Kine Agent");
  add("tools", "Tool calls", estimateTokens(toolText), "Tool names and arguments stored in the transcript");

  const ruleTokens = input.rules
    .filter((rule) => rule.exists)
    .reduce((sum, rule) => sum + (input.resourceTokens[rule.path] ?? estimateTokens(`${rule.label} ${rule.path}`)), 0);
  add("rules", "Rules & config", ruleTokens, `${input.rules.filter((rule) => rule.exists).length} files`);

  add("agents-used", "Agents used", estimateTokens(usedAgentText), "Observed subagent calls in this transcript");
  add("skills-used", "Skills used", estimateTokens(usedSkillText), `${usedSkillNames.size} observed in this transcript`);
  add("mcp-used", "MCP tools used", estimateTokens(usedMcpText), "Observed MCP tool calls in this transcript");
  add("commands-used", "Commands used", estimateTokens(usedCommandText), "Slash commands observed in user turns");

  const fileTokens = input.files.reduce(
    (sum, file) => sum + estimateTokens(`${file.action} ${file.path}`),
    0,
  );
  add("files", "Files referenced", fileTokens, `${input.files.length} paths observed`);

  // Reconcile with the measured window load: everything Kine Agent cannot see
  // (the CLI's system prompt, tool schemas, injected context) goes into one
  // explicit bucket so the estimate and the telemetry never look contradictory.
  const estimatedTotal = items.reduce((sum, item) => sum + item.tokens, 0);
  const measured = input.measuredContextTokens ?? 0;
  add(
    "unattributed",
    "System & unobserved",
    measured - estimatedTotal,
    "CLI system prompt, tool schemas, and context not visible to Kine Agent",
  );

  return {
    totalTokens: items.reduce((sum, item) => sum + item.tokens, 0),
    items: items.sort((a, b) => b.tokens - a.tokens),
  };
}

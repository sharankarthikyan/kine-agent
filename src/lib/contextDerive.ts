import type { StoredEvent } from "./sessions";

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
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "usage") {
      const raw = safeParse(events[i].payloadJson);
      return {
        inputTokens: asNumber(raw.inputTokens),
        outputTokens: asNumber(raw.outputTokens),
        cacheReadTokens: asNumber(raw.cacheReadTokens),
        cacheCreationTokens: asNumber(raw.cacheCreationTokens),
        costUsd: typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd) ? raw.costUsd : null,
        model: typeof raw.model === "string" ? raw.model : null,
      };
    }
  }
  return null;
}

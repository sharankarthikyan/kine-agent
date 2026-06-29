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

/** The most recent usage event's data, or null. */
export function latestUsage(events: StoredEvent[]): UsageData | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "usage") {
      return safeParse(events[i].payloadJson) as unknown as UsageData;
    }
  }
  return null;
}

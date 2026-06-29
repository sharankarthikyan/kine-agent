import type { AgentEvent } from "./agent";
import type { StoredEvent } from "./sessions";
import type { Turn } from "../components/Conversation";

/**
 * Rebuild a session's ordered turns from its persisted events. A "prompt" row opens
 * a new turn; every other row appends to the current turn (creating an empty-prompt
 * turn first if the stream starts with agent output). Malformed payloads degrade to
 * an empty `data` object rather than throwing.
 *
 * Input is assumed to be in seq order — `seq` and `ts` fields are not consulted.
 * `kind` is trusted as written by the persistence layer; no re-validation is done here.
 */
export function turnsFromEvents(events: StoredEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const event of events) {
    if (event.kind === "prompt") {
      const data = safeParse(event.payloadJson) as { text?: string };
      turns.push({ prompt: typeof data.text === "string" ? data.text : "", events: [] });
      continue;
    }
    if (turns.length === 0) turns.push({ prompt: "", events: [] });
    const data = safeParse(event.payloadJson);
    const currentTurn = turns[turns.length - 1];
    currentTurn.events.push({ kind: event.kind, data } as AgentEvent);
  }
  return turns;
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

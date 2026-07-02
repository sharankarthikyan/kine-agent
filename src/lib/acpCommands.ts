import type { StoredEvent } from "./sessions";

/** One slash command advertised by an ACP agent (`available_commands_update`). */
export interface AcpCommand {
  name: string;
  description: string;
}

// The newest commands StoredEvent object survives appends (arrays are recreated,
// their elements aren't), so caching per event object keeps the returned array
// reference stable across renders AND across unrelated event appends — a fresh
// reference would churn usePromptAutocomplete's deps and reset the open popover.
const cache = new WeakMap<StoredEvent, AcpCommand[]>();

/**
 * The newest ACP command list persisted in a session's events, or undefined when
 * the session never received one (pipe sessions, pre-M2 history). Scans from the
 * end — the latest `commands` event always wins. Malformed payloads degrade to
 * undefined rather than throwing (transcripts may hold data from newer builds).
 */
export function lastAcpCommands(events: StoredEvent[]): AcpCommand[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind !== "commands") continue;
    const cached = cache.get(event);
    if (cached) return cached;
    try {
      const data = JSON.parse(event.payloadJson) as { commandsJson?: string };
      if (typeof data.commandsJson !== "string") return undefined;
      const parsed: unknown = JSON.parse(data.commandsJson);
      if (!Array.isArray(parsed)) return undefined;
      const commands = parsed
        .filter(
          (c): c is { name: string; description?: string } =>
            !!c && typeof c === "object" && typeof (c as Record<string, unknown>).name === "string",
        )
        .map((c) => ({
          name: c.name,
          description: typeof c.description === "string" ? c.description : "",
        }));
      cache.set(event, commands);
      return commands;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

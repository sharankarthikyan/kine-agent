import type { StoredEvent } from "./sessions";

/** One slash command advertised by an ACP agent (`available_commands_update`). */
export interface AcpCommand {
  name: string;
  description: string;
}

/**
 * The newest ACP command list persisted in a session's events, or undefined when
 * the session never received one (pipe sessions, pre-M2 history). Scans from the
 * end — the latest `commands` event always wins. Malformed payloads degrade to
 * undefined rather than throwing (transcripts may hold data from newer builds).
 */
export function lastAcpCommands(events: StoredEvent[]): AcpCommand[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind !== "commands") continue;
    try {
      const data = JSON.parse(events[i].payloadJson) as { commandsJson?: string };
      if (typeof data.commandsJson !== "string") return undefined;
      const parsed: unknown = JSON.parse(data.commandsJson);
      if (!Array.isArray(parsed)) return undefined;
      return parsed
        .filter(
          (c): c is { name: string; description?: string } =>
            !!c && typeof c === "object" && typeof (c as Record<string, unknown>).name === "string",
        )
        .map((c) => ({
          name: c.name,
          description: typeof c.description === "string" ? c.description : "",
        }));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

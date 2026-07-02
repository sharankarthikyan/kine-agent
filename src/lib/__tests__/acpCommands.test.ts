import { describe, expect, it } from "vitest";
import { lastAcpCommands } from "../acpCommands";
import type { StoredEvent } from "../sessions";

const ev = (kind: string, payload: unknown, seq: number): StoredEvent => ({
  seq,
  kind,
  payloadJson: JSON.stringify(payload),
  ts: 0,
});

describe("lastAcpCommands", () => {
  it("returns the newest commands event's parsed list", () => {
    const events = [
      ev("commands", { commandsJson: JSON.stringify([{ name: "old", description: "" }]) }, 1),
      ev("token", { text: "hi" }, 2),
      ev("commands", { commandsJson: JSON.stringify([{ name: "web", description: "Search" }]) }, 3),
    ];
    expect(lastAcpCommands(events)).toEqual([{ name: "web", description: "Search" }]);
  });

  it("returns undefined when no commands event exists", () => {
    expect(lastAcpCommands([ev("token", { text: "hi" }, 1)])).toBeUndefined();
  });

  it("returns a stable array reference across calls and unrelated appends", () => {
    const commandsEvent = ev("commands", { commandsJson: JSON.stringify([{ name: "web", description: "" }]) }, 1);
    const first = lastAcpCommands([commandsEvent]);
    // Same event object inside a NEW array (how appendStoredEvent updates state).
    const second = lastAcpCommands([commandsEvent, ev("token", { text: "hi" }, 2)]);
    expect(second).toBe(first);
  });

  it("degrades malformed payloads to undefined, never throws", () => {
    const events = [{ seq: 1, kind: "commands", payloadJson: "{broken", ts: 0 }];
    expect(lastAcpCommands(events)).toBeUndefined();
  });
});

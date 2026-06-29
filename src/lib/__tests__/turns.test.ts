import { describe, it, expect } from "vitest";
import { turnsFromEvents } from "../turns";
import type { StoredEvent } from "../sessions";

const ev = (seq: number, kind: string, payloadJson: string): StoredEvent => ({ seq, kind, payloadJson, ts: seq });

describe("turnsFromEvents", () => {
  it("returns no turns for an empty stream", () => {
    expect(turnsFromEvents([])).toEqual([]);
  });

  it("starts a new turn at each prompt and appends agent events to it", () => {
    const turns = turnsFromEvents([
      ev(0, "prompt", '{"text":"first"}'),
      ev(1, "token", '{"text":"working"}'),
      ev(2, "done", '{"summary":"done one"}'),
      ev(3, "prompt", '{"text":"second"}'),
      ev(4, "token", '{"text":"again"}'),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].prompt).toBe("first");
    expect(turns[0].events).toEqual([
      { kind: "token", data: { text: "working" } },
      { kind: "done", data: { summary: "done one" } },
    ]);
    expect(turns[1].prompt).toBe("second");
    expect(turns[1].events).toEqual([{ kind: "token", data: { text: "again" } }]);
  });

  it("tolerates leading agent events with no preceding prompt", () => {
    const turns = turnsFromEvents([ev(0, "token", '{"text":"orphan"}')]);
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("");
    expect(turns[0].events).toEqual([{ kind: "token", data: { text: "orphan" } }]);
  });

  it("survives malformed payload json", () => {
    const turns = turnsFromEvents([ev(0, "prompt", "{not json"), ev(1, "token", "also bad")]);
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("");
    expect(turns[0].events).toEqual([{ kind: "token", data: {} }]);
  });

  it("opens a fresh turn for each prompt even with no agent events between", () => {
    const turns = turnsFromEvents([ev(0, "prompt", '{"text":"a"}'), ev(1, "prompt", '{"text":"b"}')]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ prompt: "a", events: [] });
    expect(turns[1]).toEqual({ prompt: "b", events: [] });
  });

  it("falls back to empty prompt when a valid payload lacks text", () => {
    const turns = turnsFromEvents([ev(0, "prompt", '{"foo":1}')]);
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("");
  });
});

import { describe, it, expect } from "vitest";
import { filesFromEvents, latestUsage } from "../contextDerive";
import type { StoredEvent } from "../sessions";

const ev = (seq: number, kind: string, payloadJson: string): StoredEvent => ({ seq, kind, payloadJson, ts: seq });

describe("filesFromEvents", () => {
  it("classifies reads vs edits/writes, dedupes keeping the strongest action, order = first seen", () => {
    const files = filesFromEvents([
      ev(0, "toolCall", JSON.stringify({ name: "Read", input: '{"file_path":"src/a.ts"}' })),
      ev(1, "fileWrite", JSON.stringify({ path: "src/a.ts" })),
      ev(2, "toolCall", JSON.stringify({ name: "Read", input: '{"file_path":"src/b.ts"}' })),
    ]);
    expect(files).toEqual([
      { path: "src/a.ts", action: "edited" },
      { path: "src/b.ts", action: "read" },
    ]);
  });

  it("returns [] when no file events", () => {
    expect(filesFromEvents([ev(0, "token", '{"text":"hi"}')])).toEqual([]);
  });
});

describe("latestUsage", () => {
  it("returns null when no usage event", () => {
    expect(latestUsage([ev(0, "token", "{}")])).toBeNull();
  });

  it("returns the most recent usage data", () => {
    const u = latestUsage([
      ev(0, "usage", JSON.stringify({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01, model: "opus" })),
      ev(1, "usage", JSON.stringify({ inputTokens: 50, outputTokens: 9, cacheReadTokens: 1, cacheCreationTokens: 0, costUsd: 0.04, model: "opus" })),
    ]);
    expect(u?.inputTokens).toBe(50);
    expect(u?.costUsd).toBe(0.04);
  });
});

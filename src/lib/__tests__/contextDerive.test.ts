import { describe, it, expect } from "vitest";
import {
  activityCountsFromEvents,
  contextFootprintFromSources,
  contextLoadTokens,
  estimateTokens,
  filesFromEvents,
  latestUsage,
  usageSummaryFromEvents,
} from "../contextDerive";
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

  it("summarizes latest turn and session totals separately", () => {
    const summary = usageSummaryFromEvents([
      ev(0, "usage", JSON.stringify({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, costUsd: 0.01, model: "opus" })),
      ev(1, "token", '{"text":"ignored"}'),
      ev(2, "usage", JSON.stringify({ inputTokens: 50, outputTokens: 9, cacheReadTokens: 1, cacheCreationTokens: 0, costUsd: 0.04, model: "sonnet" })),
    ]);
    expect(summary.eventCount).toBe(2);
    expect(summary.latest?.model).toBe("sonnet");
    expect(summary.latest?.inputTokens).toBe(50);
    expect(summary.totals.inputTokens).toBe(60);
    expect(summary.totals.outputTokens).toBe(11);
    expect(summary.totals.cacheReadTokens).toBe(4);
    expect(summary.totals.cacheCreationTokens).toBe(4);
    expect(summary.totals.costUsd).toBeCloseTo(0.05);
    expect(summary.totals.model).toBe("sonnet");
  });

  it("ignores empty usage samples from turns that made no API call (e.g. /usage, /status)", () => {
    const summary = usageSummaryFromEvents([
      ev(0, "usage", JSON.stringify({ inputTokens: 22410, outputTokens: 31, cacheReadTokens: 15053, cacheCreationTokens: 8619, costUsd: 0.2065, model: "opus" })),
      ev(1, "usage", JSON.stringify({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, model: null })),
    ]);
    expect(summary.latest?.inputTokens).toBe(22410);
    expect(summary.latest?.outputTokens).toBe(31);
    expect(summary.eventCount).toBe(1);
    expect(summary.totals.costUsd).toBeCloseTo(0.2065);
    expect(summary.totals.model).toBe("opus");
  });

  it("returns an empty summary when every usage sample is empty", () => {
    const summary = usageSummaryFromEvents([
      ev(0, "usage", JSON.stringify({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, model: null })),
    ]);
    expect(summary.latest).toBeNull();
    expect(summary.eventCount).toBe(0);
    expect(summary.totals.costUsd).toBeNull();
  });

  it("returns an empty summary when no usage events exist", () => {
    const summary = usageSummaryFromEvents([ev(0, "token", "{}")]);
    expect(summary.latest).toBeNull();
    expect(summary.eventCount).toBe(0);
    expect(summary.totals.outputTokens).toBe(0);
    expect(summary.totals.costUsd).toBeNull();
  });
});

describe("activityCountsFromEvents", () => {
  it("counts visible turns, tool calls, and deduped files separately from usage samples", () => {
    const counts = activityCountsFromEvents([
      ev(0, "prompt", JSON.stringify({ text: "hi" })),
      ev(1, "usage", JSON.stringify({ inputTokens: 1 })),
      ev(2, "toolCall", JSON.stringify({ name: "Read", input: '{"file_path":"src/a.ts"}' })),
      ev(3, "fileWrite", JSON.stringify({ path: "src/a.ts" })),
      ev(4, "prompt", JSON.stringify({ text: "again" })),
    ]);
    expect(counts).toEqual({ turnCount: 2, toolCallCount: 1, fileActionCount: 1 });
  });
});

describe("contextFootprintFromSources", () => {
  it("estimates transcript, customization, capability, MCP, and file-source tokens", () => {
    expect(estimateTokens("abcd")).toBe(1);
    const footprint = contextFootprintFromSources({
      events: [
        ev(0, "prompt", JSON.stringify({ text: "/compact" })),
        ev(1, "token", JSON.stringify({ text: "reading files" })),
        ev(2, "toolCall", JSON.stringify({ name: "Read", input: '{"file_path":"src/App.tsx"}' })),
        ev(3, "toolCall", JSON.stringify({ name: "Agent", input: '{"subagent_type":"code-reviewer"}' })),
        ev(4, "toolCall", JSON.stringify({ name: "mcp__github__search", input: '{"q":"repo"}' })),
        ev(5, "toolCall", JSON.stringify({ name: "Read", input: '{"file_path":"/Users/me/.agents/skills/shadcn/SKILL.md"}' })),
      ],
      files: [{ path: "src/App.tsx", action: "read" }],
      rules: [{ path: "/repo/CLAUDE.md", label: "CLAUDE.md", scope: "project", exists: true }],
      capabilities: {
        skills: [{ name: "shadcn", description: "UI components", source: "user", path: "/skills/shadcn/SKILL.md" }],
        subagents: [{ name: "reviewer", description: "Reviews code", source: "user", path: "/agents/reviewer.md" }],
        commands: [{ name: "compact", description: "Summarize context", source: "user", path: "" }],
      },
      mcpServers: [{ name: "github", detail: "GitHub tools", source: "user" }],
      resourceTokens: {
        "/repo/CLAUDE.md": 20,
        "/skills/shadcn/SKILL.md": 30,
        "/agents/reviewer.md": 40,
      },
    });

    expect(footprint.totalTokens).toBeGreaterThan(70);
    expect(footprint.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(["rules", "tools", "user", "agent", "files", "agents-used", "skills-used", "mcp-used", "commands-used"]),
    );
    expect(footprint.items.map((item) => item.id)).not.toEqual(expect.arrayContaining(["skills", "subagents", "commands", "mcp"]));
    expect(footprint.items[0].tokens).toBeGreaterThanOrEqual(footprint.items[1].tokens);
  });

  const minimalInput = {
    events: [ev(0, "prompt", JSON.stringify({ text: "Hi" }))],
    files: [],
    rules: [],
    capabilities: null,
    mcpServers: [],
    resourceTokens: {},
  };

  it("reconciles against the measured context load with an unattributed item", () => {
    const footprint = contextFootprintFromSources({
      ...minimalInput,
      measuredContextTokens: 46_082,
    });
    const unattributed = footprint.items.find((item) => item.id === "unattributed");
    expect(unattributed).toBeDefined();
    expect(footprint.totalTokens).toBe(46_082);
    expect(unattributed!.tokens).toBe(46_082 - (footprint.totalTokens - unattributed!.tokens));
  });

  it("adds no unattributed item when there is no measured load or estimates already cover it", () => {
    expect(
      contextFootprintFromSources(minimalInput).items.find((item) => item.id === "unattributed"),
    ).toBeUndefined();
    expect(
      contextFootprintFromSources({ ...minimalInput, measuredContextTokens: 1 }).items.find(
        (item) => item.id === "unattributed",
      ),
    ).toBeUndefined();
  });
});

describe("contextLoadTokens", () => {
  const usage = {
    inputTokens: 22410,
    outputTokens: 31,
    cacheReadTokens: 15053,
    cacheCreationTokens: 8619,
    costUsd: 0.2,
    model: null,
  };

  it("counts cache read/write as loaded input for claude", () => {
    expect(contextLoadTokens(usage, "claude")).toBe(46_082);
  });

  it("does not double-count codex cached tokens (subset of input)", () => {
    expect(contextLoadTokens(usage, "codex")).toBe(22_410);
  });
});

import { describe, test, expect, vi } from "vitest";
import { buildPromptForAgent, needsPromptTransform, type Mention } from "../mentions";

const fileMentions: Mention[] = [
  { kind: "file", token: "@src/a.ts", path: "src/a.ts" },
  { kind: "file", token: "@src/b.ts", path: "src/b.ts" },
];
const agentMentions: Mention[] = [
  { kind: "agent", token: "@agent-code-reviewer", name: "code-reviewer" },
];

describe("needsPromptTransform", () => {
  test("claude needs a transform only for agent mentions, not files", () => {
    expect(needsPromptTransform("see @src/a.ts", fileMentions, "claude")).toBe(false);
    expect(needsPromptTransform("run @agent-code-reviewer", agentMentions, "claude")).toBe(true);
  });
  test("codex/agy need a transform for file mentions", () => {
    expect(needsPromptTransform("see @src/a.ts", fileMentions, "codex")).toBe(true);
    expect(needsPromptTransform("see @src/a.ts", fileMentions, "antigravity")).toBe(true);
  });
  test("no transform when the mention token was edited away", () => {
    expect(needsPromptTransform("nothing here", fileMentions, "codex")).toBe(false);
    expect(needsPromptTransform("nothing here", agentMentions, "claude")).toBe(false);
  });
});

describe("buildPromptForAgent — claude", () => {
  test("expands an @agent token to the natural-language nudge, never reads files", async () => {
    const readFile = vi.fn();
    const out = await buildPromptForAgent(
      "review @agent-code-reviewer now",
      agentMentions,
      "claude",
      readFile,
    );
    expect(out).toBe('review the "code-reviewer" subagent now');
    expect(readFile).not.toHaveBeenCalled();
  });

  test("passes @file tokens through unchanged (CLI resolves them)", async () => {
    const readFile = vi.fn();
    const out = await buildPromptForAgent("see @src/a.ts", fileMentions, "claude", readFile);
    expect(out).toBe("see @src/a.ts");
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe("buildPromptForAgent — codex/antigravity", () => {
  test("inlines the contents of mentioned files still present in the text", async () => {
    const readFile = vi.fn(async (p: string) => `contents of ${p}`);
    const out = await buildPromptForAgent("check @src/a.ts", fileMentions, "codex", readFile);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith("src/a.ts");
    expect(out).toContain("===== src/a.ts =====");
    expect(out).toContain("contents of src/a.ts");
    expect(out).toContain("check @src/a.ts");
    expect(out).not.toContain("src/b.ts");
  });

  test("de-duplicates by path", async () => {
    const dupes: Mention[] = [
      { kind: "file", token: "@src/a.ts", path: "src/a.ts" },
      { kind: "file", token: "@src/a.ts", path: "src/a.ts" },
    ];
    const readFile = vi.fn(async (p: string) => `X${p}`);
    const out = await buildPromptForAgent("@src/a.ts @src/a.ts", dupes, "antigravity", readFile);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(out.match(/===== src\/a\.ts =====/g)).toHaveLength(1);
  });

  test("returns plain text when no file mention remains", async () => {
    const readFile = vi.fn();
    const out = await buildPromptForAgent("no mentions here", fileMentions, "codex", readFile);
    expect(out).toBe("no mentions here");
    expect(readFile).not.toHaveBeenCalled();
  });

  test("skips files that fail to read, leaving the token as a bare reference", async () => {
    const readFile = vi.fn(async () => {
      throw new Error("unreadable");
    });
    const out = await buildPromptForAgent("look @src/a.ts", fileMentions, "codex", readFile);
    expect(out).toBe("look @src/a.ts");
  });
});

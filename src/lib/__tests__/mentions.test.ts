import { describe, test, expect, vi } from "vitest";
import { agentResolvesMentions, buildPromptForAgent, type Mention } from "../mentions";

describe("agentResolvesMentions", () => {
  test("only claude resolves @ natively", () => {
    expect(agentResolvesMentions("claude")).toBe(true);
    expect(agentResolvesMentions("codex")).toBe(false);
    expect(agentResolvesMentions("antigravity")).toBe(false);
  });
});

describe("buildPromptForAgent", () => {
  const mentions: Mention[] = [
    { token: "@src/a.ts", path: "src/a.ts" },
    { token: "@src/b.ts", path: "src/b.ts" },
  ];

  test("claude passes text through unchanged and never reads files", async () => {
    const readFile = vi.fn();
    const out = await buildPromptForAgent("see @src/a.ts", mentions, "claude", readFile);
    expect(out).toBe("see @src/a.ts");
    expect(readFile).not.toHaveBeenCalled();
  });

  test("codex inlines the contents of mentioned files that still appear in the text", async () => {
    const readFile = vi.fn(async (p: string) => `contents of ${p}`);
    const out = await buildPromptForAgent("check @src/a.ts", mentions, "codex", readFile);
    expect(readFile).toHaveBeenCalledTimes(1); // only @src/a.ts remains in the text
    expect(readFile).toHaveBeenCalledWith("src/a.ts");
    expect(out).toContain("===== src/a.ts =====");
    expect(out).toContain("contents of src/a.ts");
    expect(out).toContain("check @src/a.ts");
    expect(out).not.toContain("src/b.ts");
  });

  test("antigravity inlines multiple files, de-duplicated by path", async () => {
    const dupes: Mention[] = [
      { token: "@src/a.ts", path: "src/a.ts" },
      { token: "@src/a.ts", path: "src/a.ts" },
    ];
    const readFile = vi.fn(async (p: string) => `X${p}`);
    const out = await buildPromptForAgent("@src/a.ts twice @src/a.ts", dupes, "antigravity", readFile);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(out.match(/===== src\/a\.ts =====/g)).toHaveLength(1);
  });

  test("returns plain text when no mentions remain in the text", async () => {
    const readFile = vi.fn();
    const out = await buildPromptForAgent("no mentions here", mentions, "codex", readFile);
    expect(out).toBe("no mentions here");
    expect(readFile).not.toHaveBeenCalled();
  });

  test("skips files that fail to read, leaving the token as a bare reference", async () => {
    const readFile = vi.fn(async () => {
      throw new Error("unreadable");
    });
    const out = await buildPromptForAgent("look @src/a.ts", mentions, "codex", readFile);
    expect(out).toBe("look @src/a.ts"); // no inlined block, original text preserved
  });
});

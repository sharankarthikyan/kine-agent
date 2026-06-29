import { describe, it, expect, vi, beforeEach } from "vitest";
import { inspectRules, readTextFile, listCapabilities, type RuleFile, type Capabilities } from "../inspect";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("inspect client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inspectRules invokes inspect_rules with sessionId", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const rows: RuleFile[] = [{ path: "/wt/CLAUDE.md", label: "CLAUDE.md", scope: "project", exists: true }];
    vi.mocked(invoke).mockResolvedValue(rows);
    expect(await inspectRules("s1")).toEqual(rows);
    expect(invoke).toHaveBeenCalledWith("inspect_rules", { sessionId: "s1" });
  });

  it("readTextFile invokes read_text_file with sessionId + path", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue("contents");
    expect(await readTextFile("s1", "/wt/CLAUDE.md")).toBe("contents");
    expect(invoke).toHaveBeenCalledWith("read_text_file", { sessionId: "s1", path: "/wt/CLAUDE.md" });
  });

  it("listCapabilities invokes list_capabilities with sessionId + agent", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const caps: Capabilities = { skills: [], subagents: [], commands: [] };
    vi.mocked(invoke).mockResolvedValue(caps);
    expect(await listCapabilities("s1", "claude")).toEqual(caps);
    expect(invoke).toHaveBeenCalledWith("list_capabilities", { sessionId: "s1", agent: "claude" });
  });
});

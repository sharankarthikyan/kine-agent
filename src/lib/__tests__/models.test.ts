import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectAgents, listModels, type AgentInfo, type ModelInfo } from "../models";

// The factory is hoisted above imports, so the mock must be defined inline.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

describe("detectAgents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes detect_agents with no extra args", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const agents: AgentInfo[] = [
      { id: "claude", label: "Claude Code", installed: true },
      { id: "codex",  label: "Codex",       installed: false },
    ];
    vi.mocked(invoke).mockResolvedValueOnce(agents);

    const result = await detectAgents();

    expect(invoke).toHaveBeenCalledWith("detect_agents");
    expect(result).toEqual(agents);
  });

  it("returns an empty array when no agents are detected", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce([]);

    const result = await detectAgents();

    expect(result).toEqual([]);
  });
});

describe("listModels", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes list_models with the given agent id", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const models: ModelInfo[] = [
      { value: "opus",   label: "Claude Opus 4.8",   agent: "claude", description: null, disabled: false, contextWindow: null },
      { value: "sonnet", label: "Claude Sonnet 4.6", agent: "claude", description: null, disabled: false, contextWindow: null },
      { value: "haiku",  label: "Claude Haiku 4.5",  agent: "claude", description: null, disabled: false, contextWindow: null },
    ];
    vi.mocked(invoke).mockResolvedValueOnce(models);

    const result = await listModels("claude");

    expect(invoke).toHaveBeenCalledWith("list_models", { agent: "claude" });
    expect(result).toEqual(models);
  });

  it("returns an empty array for agents with no model discovery", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce([]);

    const result = await listModels("codex");

    expect(invoke).toHaveBeenCalledWith("list_models", { agent: "codex" });
    expect(result).toEqual([]);
  });
});

import {
  AGENT_COLOR_CLASSES,
  AGENT_COLOR_TOKENS,
  composeModels,
  emptyAgentConfig,
  getAgentConfig,
  pickDefaultModel,
  readAgentConfigs,
  updateAgentConfig,
  writeAgentConfigs,
} from "../agentConfig";
import type { ModelInfo } from "../models";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

function model(value: string, over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    value,
    label: value,
    agent: "claude",
    description: null,
    disabled: false,
    contextWindow: null,
    ...over,
  };
}

describe("readAgentConfigs / writeAgentConfigs", () => {
  it("returns empty map when nothing stored", () => {
    expect(readAgentConfigs(fakeStorage())).toEqual({});
  });

  it("round-trips a written map", () => {
    const s = fakeStorage();
    const map = { claude: { ...emptyAgentConfig(), color: "rose" } };
    writeAgentConfigs(map, s);
    expect(readAgentConfigs(s)).toEqual(map);
  });

  it("survives corrupt JSON", () => {
    const s = fakeStorage({ "kine-agent.agentConfig": "{nope" });
    expect(readAgentConfigs(s)).toEqual({});
  });

  it("drops malformed per-agent entries but keeps valid ones", () => {
    const s = fakeStorage({
      "kine-agent.agentConfig": JSON.stringify({
        claude: { color: "amber", defaultModel: null, hiddenModels: [], customModels: [], modelOrder: [] },
        codex: "not-an-object",
      }),
    });
    const map = readAgentConfigs(s);
    expect(map.claude?.color).toBe("amber");
    expect(map.codex).toBeUndefined();
  });

  it("fills missing fields with defaults (forward compat)", () => {
    const s = fakeStorage({
      "kine-agent.agentConfig": JSON.stringify({ claude: { color: "teal" } }),
    });
    expect(readAgentConfigs(s).claude).toEqual({ ...emptyAgentConfig(), color: "teal" });
  });
});

describe("getAgentConfig", () => {
  it("falls back to the empty config for unknown agents", () => {
    expect(getAgentConfig({}, "claude")).toEqual(emptyAgentConfig());
  });
});

describe("composeModels", () => {
  it("appends custom models after discovered ones", () => {
    const cfg = { ...emptyAgentConfig(), customModels: [{ value: "my-model", label: null }] };
    const out = composeModels([model("opus")], cfg, "claude");
    expect(out.map((m) => m.value)).toEqual(["opus", "my-model"]);
    expect(out[1]).toMatchObject({ label: "my-model", agent: "claude", disabled: false });
  });

  it("dedupes a custom value colliding with a discovered one — discovered wins, custom label overrides", () => {
    const cfg = { ...emptyAgentConfig(), customModels: [{ value: "opus", label: "My Opus" }] };
    const out = composeModels([model("opus", { description: "claude-opus-4-8" })], cfg, "claude");
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("My Opus");
    expect(out[0].description).toBe("claude-opus-4-8");
  });

  it("filters hidden models", () => {
    const cfg = { ...emptyAgentConfig(), hiddenModels: ["haiku"] };
    const out = composeModels([model("opus"), model("haiku")], cfg, "claude");
    expect(out.map((m) => m.value)).toEqual(["opus"]);
  });

  it("orders by modelOrder, unknown values append in merged order", () => {
    const cfg = { ...emptyAgentConfig(), modelOrder: ["haiku", "opus"] };
    const out = composeModels([model("opus"), model("sonnet"), model("haiku")], cfg, "claude");
    expect(out.map((m) => m.value)).toEqual(["haiku", "opus", "sonnet"]);
  });
});

describe("updateAgentConfig", () => {
  it("applies a patch without touching other agents", () => {
    const map = { codex: { ...emptyAgentConfig(), color: "teal" } };
    const next = updateAgentConfig(map, "claude", { color: "rose" });
    expect(next.claude.color).toBe("rose");
    expect(next.codex.color).toBe("teal");
  });

  it("clears defaultModel when it becomes hidden", () => {
    const map = { claude: { ...emptyAgentConfig(), defaultModel: "opus" } };
    const next = updateAgentConfig(map, "claude", { hiddenModels: ["opus"] });
    expect(next.claude.defaultModel).toBeNull();
  });

  it("clears defaultModel when its custom entry is removed", () => {
    const map = {
      claude: {
        ...emptyAgentConfig(),
        defaultModel: "my-model",
        customModels: [{ value: "my-model", label: null }],
      },
    };
    const next = updateAgentConfig(map, "claude", { customModels: [] });
    expect(next.claude.defaultModel).toBeNull();
  });

  it("keeps defaultModel when unrelated fields change", () => {
    const map = { claude: { ...emptyAgentConfig(), defaultModel: "opus" } };
    const next = updateAgentConfig(map, "claude", { color: "cyan" });
    expect(next.claude.defaultModel).toBe("opus");
  });

  it("keeps defaultModel when its custom entry is removed but the value is still discovered", () => {
    const map = {
      claude: {
        ...emptyAgentConfig(),
        defaultModel: "opus",
        customModels: [{ value: "opus", label: "My Opus" }],
      },
    };
    const next = updateAgentConfig(map, "claude", { customModels: [] }, ["opus", "sonnet"]);
    expect(next.claude.defaultModel).toBe("opus");
  });
});

describe("pickDefaultModel", () => {
  it("returns the configured default when present and enabled", () => {
    const cfg = { ...emptyAgentConfig(), defaultModel: "sonnet" };
    expect(pickDefaultModel([model("opus"), model("sonnet")], cfg)?.value).toBe("sonnet");
  });

  it("falls back to the first enabled model when the default is absent", () => {
    const cfg = { ...emptyAgentConfig(), defaultModel: "gone" };
    expect(pickDefaultModel([model("opus", { disabled: true }), model("sonnet")], cfg)?.value).toBe("sonnet");
  });

  it("returns null for an empty list", () => {
    expect(pickDefaultModel([], emptyAgentConfig())).toBeNull();
  });
});

describe("color tokens", () => {
  it("every token has a static class", () => {
    for (const t of AGENT_COLOR_TOKENS) {
      expect(AGENT_COLOR_CLASSES[t]).toMatch(/^text-[a-z]+-500$/);
    }
  });
});

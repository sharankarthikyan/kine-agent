import {
  readAgentPrefs,
  writeAgentPrefs,
  isAgentEnabled,
  hasAcknowledged,
  setAgentEnabled,
  type AgentPrefs,
} from "../agentPrefs";

// A minimal in-memory Storage stand-in so reads/writes stay pure and hermetic.
function fakeStorage(initial?: string) {
  let value: string | null = initial ?? null;
  return {
    getItem: (_key: string) => value,
    setItem: (_key: string, v: string) => {
      value = v;
    },
    read: () => value,
  };
}

// ── readAgentPrefs ──────────────────────────────────────────────────────────────

test("returns empty prefs when nothing is stored", () => {
  const prefs = readAgentPrefs(fakeStorage());
  expect(prefs).toEqual({ enabled: {}, acknowledged: {} });
});

test("parses a well-formed stored blob", () => {
  const store = fakeStorage(
    JSON.stringify({ enabled: { claude: true }, acknowledged: { claude: true } }),
  );
  const prefs = readAgentPrefs(store);
  expect(prefs.enabled.claude).toBe(true);
  expect(prefs.acknowledged.claude).toBe(true);
});

test("falls back to defaults on corrupt JSON", () => {
  const prefs = readAgentPrefs(fakeStorage("{ not json"));
  expect(prefs).toEqual({ enabled: {}, acknowledged: {} });
});

test("ignores non-boolean and non-object fields, keeping only valid entries", () => {
  const store = fakeStorage(
    JSON.stringify({ enabled: { claude: "yes", codex: false }, acknowledged: 42 }),
  );
  const prefs = readAgentPrefs(store);
  expect(prefs.enabled).toEqual({ codex: false }); // "yes" dropped, false kept
  expect(prefs.acknowledged).toEqual({});
});

// ── isAgentEnabled defaults ──────────────────────────────────────────────────────

test("Codex is enabled by default; Claude and Antigravity are not", () => {
  const prefs = readAgentPrefs(fakeStorage());
  expect(isAgentEnabled("codex", prefs)).toBe(true);
  expect(isAgentEnabled("claude", prefs)).toBe(false);
  expect(isAgentEnabled("antigravity", prefs)).toBe(false);
});

test("an unknown/future agent defaults to disabled", () => {
  const prefs = readAgentPrefs(fakeStorage());
  expect(isAgentEnabled("some-future-agent", prefs)).toBe(false);
});

test("an explicit choice overrides the default in both directions", () => {
  const prefs: AgentPrefs = {
    enabled: { codex: false, claude: true },
    acknowledged: {},
  };
  expect(isAgentEnabled("codex", prefs)).toBe(false);
  expect(isAgentEnabled("claude", prefs)).toBe(true);
});

// ── setAgentEnabled / hasAcknowledged ────────────────────────────────────────────

test("enabling an agent records its acknowledgement", () => {
  const before: AgentPrefs = { enabled: {}, acknowledged: {} };
  const after = setAgentEnabled(before, "claude", true);
  expect(isAgentEnabled("claude", after)).toBe(true);
  expect(hasAcknowledged("claude", after)).toBe(true);
});

test("disabling an agent leaves a prior acknowledgement intact (no re-prompt on re-enable)", () => {
  const acked: AgentPrefs = { enabled: { claude: true }, acknowledged: { claude: true } };
  const disabled = setAgentEnabled(acked, "claude", false);
  expect(isAgentEnabled("claude", disabled)).toBe(false);
  expect(hasAcknowledged("claude", disabled)).toBe(true);
});

test("setAgentEnabled does not mutate the input prefs", () => {
  const before: AgentPrefs = { enabled: {}, acknowledged: {} };
  setAgentEnabled(before, "codex", false);
  expect(before).toEqual({ enabled: {}, acknowledged: {} });
});

// ── round-trip ────────────────────────────────────────────────────────────────

test("writeAgentPrefs then readAgentPrefs round-trips", () => {
  const store = fakeStorage();
  const prefs = setAgentEnabled({ enabled: {}, acknowledged: {} }, "antigravity", true);
  writeAgentPrefs(prefs, store);
  expect(readAgentPrefs(store)).toEqual(prefs);
});

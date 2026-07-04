import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewSession } from "../NewSession";
import type { AgentInfo, ModelInfo } from "../../lib/models";
import type { AgentPrefs } from "../../lib/agentPrefs";

// Most existing tests select Claude, so treat every agent as enabled unless a test
// overrides prefs to exercise the enablement gate.
const ALL_ENABLED: AgentPrefs = {
  enabled: { claude: true, codex: true, antigravity: true },
  acknowledged: { claude: true, antigravity: true },
};
// Ships-default posture: only Codex enabled.
const CODEX_ONLY: AgentPrefs = {
  enabled: { codex: true, claude: false, antigravity: false },
  acknowledged: {},
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const claudeAgent: AgentInfo = { id: "claude", label: "Claude Code", installed: true };
const geminiAgent: AgentInfo = { id: "gemini", label: "Gemini CLI", installed: true };
const codexAgent: AgentInfo = { id: "codex", label: "Codex", installed: false };
const codexAgentInstalled: AgentInfo = { id: "codex", label: "Codex", installed: true };

const FIXTURE_AGENTS: AgentInfo[] = [claudeAgent, geminiAgent, codexAgent];

const opus: ModelInfo = {
  value: "opus",
  label: "Claude Opus 4.8",
  agent: "claude",
  description: null,
  disabled: false,
  contextWindow: null,
};

const sonnet: ModelInfo = {
  value: "sonnet",
  label: "Claude Sonnet 4.6",
  agent: "claude",
  description: null,
  disabled: false,
  contextWindow: null,
};

const FIXTURE_MODELS: ModelInfo[] = [opus, sonnet];

const RECENT_PATHS = ["/home/user/projects/alpha", "/home/user/projects/beta"];
const REPO_PATH = "/home/user/projects/my-app";

const PLACEHOLDER = "Describe the task…";

function setup(overrides: Partial<React.ComponentProps<typeof NewSession>> = {}) {
  const onPickRepo = vi.fn();
  const onPickRecent = vi.fn();
  const onAgentChange = vi.fn();
  const onModelChange = vi.fn();
  const onPermissionModeChange = vi.fn();
  const onSandboxTerminalChange = vi.fn();
  const onStart = vi.fn();
  const onOpenSettings = vi.fn();

  render(
    <NewSession
      repo={null}
      recents={RECENT_PATHS}
      agents={FIXTURE_AGENTS}
      agent={claudeAgent}
      models={FIXTURE_MODELS}
      model={opus}
      permissionMode="default"
      sandboxTerminal={false}
      running={false}
      agentPrefs={ALL_ENABLED}
      onPickRepo={onPickRepo}
      onPickRecent={onPickRecent}
      onAgentChange={onAgentChange}
      onModelChange={onModelChange}
      onPermissionModeChange={onPermissionModeChange}
      onSandboxTerminalChange={onSandboxTerminalChange}
      onStart={onStart}
      onOpenSettings={onOpenSettings}
      {...overrides}
    />,
  );

  return {
    onPickRepo,
    onPickRecent,
    onAgentChange,
    onModelChange,
    onPermissionModeChange,
    onSandboxTerminalChange,
    onStart,
    onOpenSettings,
  };
}

// ── Textarea basics ────────────────────────────────────────────────────────────

test("renders the composer placeholder", () => {
  setup();
  expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
});

// ── Send disabled / enabled states ────────────────────────────────────────────

test("Send is disabled when repo is null and text is empty", () => {
  setup({ repo: null });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("Send is disabled when repo is null even with text", async () => {
  setup({ repo: null });
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "add auth");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("Send is disabled when repo is set but text is empty", () => {
  setup({ repo: REPO_PATH });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("Send is disabled while running", () => {
  setup({ running: true });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("Send calls onStart with trimmed text when repo is set and text is non-empty", async () => {
  const { onStart } = setup({ repo: REPO_PATH });
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "add auth");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onStart).toHaveBeenCalledWith("add auth");
});

test("Send does not call onStart when disabled (no repo)", async () => {
  const { onStart } = setup({ repo: null });
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onStart).not.toHaveBeenCalled();
});

// ── Repo dropdown ──────────────────────────────────────────────────────────────

test('"Choose folder…" menu item calls onPickRepo', async () => {
  const { onPickRepo } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Choose a repository folder/i }));
  // "Choose folder…" appears in both trigger and menu; target the menuitem role
  await userEvent.click(screen.getByRole("menuitem", { name: /Choose folder/i }));
  expect(onPickRepo).toHaveBeenCalled();
});

test("choosing a recent path calls onPickRecent with the full path", async () => {
  const { onPickRecent } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Choose a repository folder/i }));
  // "alpha" is the basename of RECENT_PATHS[0]
  await userEvent.click(screen.getByRole("menuitem", { name: "alpha" }));
  expect(onPickRecent).toHaveBeenCalledWith(RECENT_PATHS[0]);
});

test("shows the repo basename in the trigger when repo is set", () => {
  setup({ repo: REPO_PATH });
  expect(screen.getByRole("button", { name: /Repository: my-app/i })).toBeInTheDocument();
});

// ── Agent dropdown ─────────────────────────────────────────────────────────────

test("agent trigger shows the current agent label", () => {
  setup();
  expect(screen.getByRole("button", { name: /Agent: Claude Code/i })).toBeInTheDocument();
});

test("selecting a spawnable agent calls onAgentChange", async () => {
  const { onAgentChange } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Agent:/i }));
  // Claude is the only spawnable agent today, so it's the only enabled item.
  await userEvent.click(screen.getByRole("menuitem", { name: claudeAgent.label }));
  expect(onAgentChange).toHaveBeenCalledWith(expect.objectContaining({ id: "claude" }));
});

test("an installed-but-not-spawnable agent is disabled with a 'coming soon' hint", async () => {
  const { onAgentChange } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Agent:/i }));
  // Gemini is installed but has no spawn adapter yet → disabled, "coming soon".
  expect(screen.getByText("coming soon")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("menuitem", { name: /Gemini CLI/i }));
  expect(onAgentChange).not.toHaveBeenCalled();
});

test("clicking a not-installed agent item does not call onAgentChange", async () => {
  const { onAgentChange } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Agent:/i }));
  // Radix suppresses onSelect for disabled items even when clicked
  await userEvent.click(screen.getByRole("menuitem", { name: /Codex/i }));
  expect(onAgentChange).not.toHaveBeenCalled();
});

// ── Model dropdown ─────────────────────────────────────────────────────────────

test("model trigger shows the current model label", () => {
  setup();
  // The model label appears in the trigger; getAllByText since it also appears after opening
  expect(screen.getByText(opus.label)).toBeInTheDocument();
});

test("selecting a model calls onModelChange", async () => {
  const { onModelChange } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Model:/i }));
  await userEvent.click(screen.getByText(sonnet.label));
  expect(onModelChange).toHaveBeenCalledWith(expect.objectContaining({ value: "sonnet" }));
});

test("model trigger shows the versioned model label", () => {
  setup({ model: opus });
  expect(screen.getByText(opus.label)).toBeInTheDocument();
});

// ── Permission mode dropdown ─────────────────────────────────────────────────────

test("permission trigger reflects the current mode", () => {
  setup({ permissionMode: "default" });
  expect(
    screen.getByRole("button", { name: /Permission mode: Ask before edits/i }),
  ).toBeInTheDocument();
});

test("selecting Auto-edit calls onPermissionModeChange with 'acceptEdits'", async () => {
  const { onPermissionModeChange } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Permission mode:/i }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /Auto-edit/i }));
  expect(onPermissionModeChange).toHaveBeenCalledWith("acceptEdits");
});

test("selecting Full access requires confirmation before it applies", async () => {
  const { onPermissionModeChange } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Permission mode:/i }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /Full access/i }));
  // Not applied yet — a confirmation is required first.
  expect(onPermissionModeChange).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: /Enable full access/i }));
  expect(onPermissionModeChange).toHaveBeenCalledWith("full");
});

test("Claude offers the advanced 'Locked-down (CI)' mode", async () => {
  setup({ agent: claudeAgent });
  await userEvent.click(screen.getByRole("button", { name: /Permission mode:/i }));
  expect(screen.getByRole("menuitemradio", { name: /Locked-down/i })).toBeInTheDocument();
});

// ── No engine choice in the UI ─────────────────────────────────────────────────
// The engine is fully derived (ACP for claude/codex when Node is present, pipe
// otherwise) — users never pick it, so no ACP control renders for any agent.

test("renders no ACP streaming control for claude — the engine is automatic", () => {
  setup({ agent: claudeAgent });
  expect(screen.queryByRole("switch", { name: /acp streaming/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/acp streaming/i)).not.toBeInTheDocument();
});

test("renders no ACP streaming control for codex either", () => {
  setup({ agent: codexAgent });
  expect(screen.queryByRole("switch", { name: /acp streaming/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/acp streaming/i)).not.toBeInTheDocument();
});

// ── Model picker ───────────────────────────────────────────────────────────────
// The ACP adapter forwards the pick via session/set_config_option, so drafts on
// EVERY engine get the interactive picker (no more "CLI default" pinning).

test("drafts keep the interactive model picker (ACP forwards the pick)", async () => {
  setup({ agent: claudeAgent });
  const trigger = screen.getByRole("button", { name: `Model: ${opus.label}` });
  expect(trigger).toBeEnabled();
  expect(screen.queryByText("CLI default")).not.toBeInTheDocument();
  await userEvent.click(trigger);
  expect(screen.getByRole("menuitem", { name: new RegExp(sonnet.label) })).toBeInTheDocument();
});

test("Antigravity offers only Ask before edits + Full access (no Auto-edit or advanced)", async () => {
  const antigravityAgent: AgentInfo = { id: "antigravity", label: "Antigravity", installed: true };
  setup({ agent: antigravityAgent });
  await userEvent.click(screen.getByRole("button", { name: /Permission mode:/i }));
  expect(screen.getByRole("menuitemradio", { name: /Full access/i })).toBeInTheDocument();
  expect(screen.queryByRole("menuitemradio", { name: /Auto-edit/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("menuitemradio", { name: /Locked-down/i })).not.toBeInTheDocument();
});

// ── Agent enablement gate ──────────────────────────────────────────────────────
// Only agents the user has enabled in Settings may start a session. Claude and
// Antigravity ship disabled; the composer blocks Send and points to Settings.

test("Send is disabled when the selected agent is disabled, even with repo + text", async () => {
  setup({ repo: REPO_PATH, agent: claudeAgent, agentPrefs: CODEX_ONLY });
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "add auth");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("a disabled agent surfaces a hint that opens Settings", async () => {
  const { onOpenSettings, onStart } = setup({
    repo: REPO_PATH,
    agent: claudeAgent,
    agentPrefs: CODEX_ONLY,
  });
  const hint = screen.getByRole("button", { name: /Claude Code is disabled/i });
  await userEvent.click(hint);
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
  expect(onStart).not.toHaveBeenCalled();
});

test("a disabled-but-installed agent shows a 'disabled' hint in the picker and isn't selectable", async () => {
  const { onAgentChange } = setup({ agent: codexAgentInstalled, agentPrefs: CODEX_ONLY });
  await userEvent.click(screen.getByRole("button", { name: /Agent:/i }));
  // Claude is installed + spawnable but disabled in CODEX_ONLY → "disabled" hint.
  expect(screen.getByText("disabled")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("menuitem", { name: /Claude Code/i }));
  expect(onAgentChange).not.toHaveBeenCalled();
});

test("an enabled agent sends normally", async () => {
  const { onStart } = setup({
    repo: REPO_PATH,
    agent: codexAgentInstalled,
    agentPrefs: CODEX_ONLY,
  });
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "ship it");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onStart).toHaveBeenCalledWith("ship it");
});

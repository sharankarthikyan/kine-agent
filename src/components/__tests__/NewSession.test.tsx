import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewSession } from "../NewSession";
import type { AgentInfo, ModelInfo } from "../../lib/models";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const claudeAgent: AgentInfo = { id: "claude", label: "Claude Code", installed: true };
const geminiAgent: AgentInfo = { id: "gemini", label: "Gemini CLI", installed: true };
const codexAgent: AgentInfo = { id: "codex", label: "Codex", installed: false };

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
  const onAutoEditChange = vi.fn();
  const onStart = vi.fn();

  render(
    <NewSession
      repo={null}
      recents={RECENT_PATHS}
      agents={FIXTURE_AGENTS}
      agent={claudeAgent}
      models={FIXTURE_MODELS}
      model={opus}
      autoEdit={false}
      running={false}
      onPickRepo={onPickRepo}
      onPickRecent={onPickRecent}
      onAgentChange={onAgentChange}
      onModelChange={onModelChange}
      onAutoEditChange={onAutoEditChange}
      onStart={onStart}
      {...overrides}
    />,
  );

  return { onPickRepo, onPickRecent, onAgentChange, onModelChange, onAutoEditChange, onStart };
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

test("selecting an installed agent calls onAgentChange", async () => {
  const { onAgentChange } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Agent:/i }));
  await userEvent.click(screen.getByRole("menuitem", { name: geminiAgent.label }));
  expect(onAgentChange).toHaveBeenCalledWith(expect.objectContaining({ id: "gemini" }));
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

// ── Autonomy switch ────────────────────────────────────────────────────────────

test("Switch calls onAutoEditChange(true) when toggled on", async () => {
  const { onAutoEditChange } = setup({ autoEdit: false });
  await userEvent.click(screen.getByRole("switch", { name: /Edit automatically/i }));
  expect(onAutoEditChange).toHaveBeenCalledWith(true);
});

test("Switch calls onAutoEditChange(false) when toggled off", async () => {
  const { onAutoEditChange } = setup({ autoEdit: true });
  await userEvent.click(screen.getByRole("switch", { name: /Edit automatically/i }));
  expect(onAutoEditChange).toHaveBeenCalledWith(false);
});

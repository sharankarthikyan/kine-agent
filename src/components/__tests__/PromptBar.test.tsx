import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptBar } from "../PromptBar";
import type { ModelInfo } from "../../lib/models";

const PLACEHOLDER = "Message the agent…";

// ── Fixtures ──────────────────────────────────────────────────────────────────

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

const disabledCodex: ModelInfo = {
  value: "gpt-5",
  label: "OpenAI Codex (GPT-5)",
  agent: "codex",
  description: null,
  disabled: true,
  contextWindow: null,
};

const FIXTURE_MODELS: ModelInfo[] = [opus, sonnet, disabledCodex];

function setup(overrides: Partial<React.ComponentProps<typeof PromptBar>> = {}) {
  const onStart = vi.fn();
  const onModelChange = vi.fn();
  const onPermissionModeChange = vi.fn();
  render(
    <PromptBar
      onStart={onStart}
      running={false}
      models={FIXTURE_MODELS}
      model={opus}
      onModelChange={onModelChange}
      agent="claude"
      permissionMode="default"
      onPermissionModeChange={onPermissionModeChange}
      {...overrides}
    />,
  );
  return { onStart, onModelChange, onPermissionModeChange };
}

// ── Textarea basics ────────────────────────────────────────────────────────────

test("renders the composer placeholder", () => {
  setup();
  expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
});

// ── Honest model display for ACP sessions ──────────────────────────────────────
// The ACP adapter runs the agent CLI's default model — it does not forward a
// model pick yet — so ACP sessions must not display a user-picked model.

test("ACP sessions show 'CLI default' instead of a user-picked model", () => {
  setup({ engine: "acp" });
  const trigger = screen.getByRole("button", { name: "Model: CLI default" });
  expect(trigger).toBeDisabled();
  expect(screen.queryByText(opus.label)).not.toBeInTheDocument();
});

test("pipe sessions (and callers that pass no engine) keep the interactive picker", () => {
  setup();
  expect(screen.getByRole("button", { name: `Model: ${opus.label}` })).toBeEnabled();
  expect(screen.queryByText("CLI default")).not.toBeInTheDocument();
});

test("renders external CLI continuation mode distinctly", () => {
  setup({ mode: "external-continuation" });
  expect(screen.getByPlaceholderText("Continue this CLI history…")).toBeInTheDocument();
  expect(
    screen.getByText("Replies start a writable Kineloop continuation."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Continue in Kineloop" }),
  ).toBeDisabled();
});

test("calls onStart with the typed text and the current model on Send click", async () => {
  const { onStart } = setup();
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "fix the bug");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onStart).toHaveBeenCalledWith("fix the bug", opus);
});

test("clears the textarea after sending", async () => {
  setup();
  const ta = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  await userEvent.type(ta, "do the thing");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(ta.value).toBe("");
});

test("calls onStart on Enter (sends with the current model)", async () => {
  const { onStart } = setup();
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "ship it{enter}");
  expect(onStart).toHaveBeenCalledWith("ship it", opus);
});

test("Shift+Enter inserts a newline without sending", async () => {
  const { onStart } = setup();
  const ta = screen.getByPlaceholderText(PLACEHOLDER);
  await userEvent.type(ta, "line one");
  await userEvent.type(ta, "{shift>}{enter}{/shift}");
  await userEvent.type(ta, "line two");
  expect(onStart).not.toHaveBeenCalled();
  expect((ta as HTMLTextAreaElement).value).toContain("\n");
});

// ── Disabled states ────────────────────────────────────────────────────────────

test("Send button is disabled when the textarea is empty", () => {
  setup();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("Send button is disabled while running", () => {
  setup({ running: true });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("does not call onStart when the textarea is empty", async () => {
  const { onStart } = setup();
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onStart).not.toHaveBeenCalled();
});

test("textarea is disabled while running", () => {
  setup({ running: true });
  expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeDisabled();
});

// ── Stop button ─────────────────────────────────────────────────────────────────

test("shows a Stop button instead of Send while running when onStop is provided", () => {
  setup({ running: true, onStop: vi.fn() });
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
});

test("clicking Stop calls onStop", async () => {
  const onStop = vi.fn();
  setup({ running: true, onStop });
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(onStop).toHaveBeenCalledTimes(1);
});

test("shows Send (not Stop) when idle even if onStop is provided", () => {
  setup({ running: false, onStop: vi.fn() });
  expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
});

// ── Model selector trigger ─────────────────────────────────────────────────────

test("trigger shows the currently selected model label", () => {
  setup();
  expect(screen.getByText(opus.label)).toBeInTheDocument();
});

test("trigger shows 'No models' when models list is empty and model is null", () => {
  setup({ models: [], model: null });
  expect(screen.getByText("No models")).toBeInTheDocument();
});

test("trigger shows the versioned model label", () => {
  setup({ model: opus });
  expect(screen.getByText("Claude Opus 4.8")).toBeInTheDocument();
});

// ── Dropdown menu interaction ──────────────────────────────────────────────────
// Radix portals render to document.body; Testing Library queries the full document.

test("opening the model menu lists all model labels", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Model:/i }));
  for (const m of FIXTURE_MODELS) {
    // The active model label appears in both trigger and menu — use getAllByText
    expect(screen.getAllByText(m.label).length).toBeGreaterThanOrEqual(1);
  }
});

test("shows 'No models available' when the models list is empty", async () => {
  setup({ models: [], model: null });
  await userEvent.click(screen.getByRole("button", { name: /Model:/i }));
  expect(screen.getByText("No models available")).toBeInTheDocument();
});

test("selecting an available model calls onModelChange", async () => {
  const { onModelChange } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Model:/i }));
  await userEvent.click(screen.getByText(sonnet.label));
  expect(onModelChange).toHaveBeenCalledWith(expect.objectContaining({ value: "sonnet" }));
});

test("clicking a disabled model item does not call onModelChange", async () => {
  const { onModelChange } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Model:/i }));
  // Radix suppresses onSelect for disabled items even when the user clicks them
  await userEvent.click(screen.getByText(disabledCodex.label));
  expect(onModelChange).not.toHaveBeenCalled();
});

test("onStart receives null when model is null (browser preview / no-agent case)", async () => {
  const { onStart } = setup({ models: [], model: null });
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "hello");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onStart).toHaveBeenCalledWith("hello", null);
});

// ── Permission mode dropdown ─────────────────────────────────────────────────────

test("permission trigger reflects the session's mode", () => {
  setup({ permissionMode: "acceptEdits" });
  expect(
    screen.getByRole("button", { name: /Permission mode: Auto-edit/i }),
  ).toBeInTheDocument();
});

test("changing the permission mode calls onPermissionModeChange", async () => {
  const { onPermissionModeChange } = setup({ permissionMode: "default" });
  await userEvent.click(screen.getByRole("button", { name: /Permission mode:/i }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /Plan only/i }));
  expect(onPermissionModeChange).toHaveBeenCalledWith("plan");
});

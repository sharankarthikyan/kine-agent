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
  source: "fallback",
  disabled: false,
  contextWindow: null,
};

const sonnet: ModelInfo = {
  value: "sonnet",
  label: "Claude Sonnet 4.6",
  agent: "claude",
  description: null,
  source: "fallback",
  disabled: false,
  contextWindow: null,
};

const disabledCodex: ModelInfo = {
  value: "gpt-5",
  label: "OpenAI Codex (GPT-5)",
  agent: "codex",
  description: null,
  source: "fallback",
  disabled: true,
  contextWindow: null,
};

const FIXTURE_MODELS: ModelInfo[] = [opus, sonnet, disabledCodex];

function setup(overrides: Partial<React.ComponentProps<typeof PromptBar>> = {}) {
  const onStart = vi.fn();
  const onModelChange = vi.fn();
  render(
    <PromptBar
      onStart={onStart}
      running={false}
      models={FIXTURE_MODELS}
      model={opus}
      onModelChange={onModelChange}
      {...overrides}
    />,
  );
  return { onStart, onModelChange };
}

// ── Textarea basics ────────────────────────────────────────────────────────────

test("renders the composer placeholder", () => {
  setup();
  expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
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

// ── Model selector trigger ─────────────────────────────────────────────────────

test("trigger shows the currently selected model label", () => {
  setup();
  expect(screen.getByText(opus.label)).toBeInTheDocument();
});

test("trigger shows 'No models' when models list is empty and model is null", () => {
  setup({ models: [], model: null });
  expect(screen.getByText("No models")).toBeInTheDocument();
});

test("trigger shows the fallback badge when model source is fallback", () => {
  setup({ model: { ...opus, source: "fallback" } });
  expect(screen.getByText("fallback")).toBeInTheDocument();
});

test("trigger does not show any badge when model source is api", () => {
  setup({ model: { ...opus, source: "api" } });
  expect(screen.queryByText("fallback")).not.toBeInTheDocument();
  expect(screen.queryByText("api")).not.toBeInTheDocument();
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

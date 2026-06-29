import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptBar } from "../PromptBar";
import { DEFAULT_MODEL, MODELS } from "../../lib/models";

const PLACEHOLDER = "Message the agent…";

function setup(overrides: Partial<React.ComponentProps<typeof PromptBar>> = {}) {
  const onStart = vi.fn();
  const onModelChange = vi.fn();
  render(
    <PromptBar
      onStart={onStart}
      running={false}
      model={DEFAULT_MODEL}
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
  expect(onStart).toHaveBeenCalledWith("fix the bug", DEFAULT_MODEL);
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
  expect(onStart).toHaveBeenCalledWith("ship it", DEFAULT_MODEL);
});

test("Shift+Enter inserts a newline without sending", async () => {
  const { onStart } = setup();
  const ta = screen.getByPlaceholderText(PLACEHOLDER);
  // type a line, then shift-enter, then another line
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

test("trigger shows the current model label", () => {
  setup();
  expect(screen.getByText(DEFAULT_MODEL.label)).toBeInTheDocument();
});

test("trigger shows the tier badge for models with a tier", () => {
  setup();
  // DEFAULT_MODEL is opus with tier "MAX"
  expect(screen.getByText("MAX")).toBeInTheDocument();
});

test("trigger does not show a tier badge for models without a tier", () => {
  const tierlesModel = MODELS.find((m) => !m.tier && m.available)!;
  setup({ model: tierlesModel });
  expect(screen.queryByText("MAX")).not.toBeInTheDocument();
});

// ── Dropdown menu interaction ──────────────────────────────────────────────────
// Radix portals render to document.body; Testing Library queries the full document.

test("opening the model menu lists all model labels", async () => {
  setup();
  // Click the trigger button (identified by its aria-label)
  await userEvent.click(screen.getByRole("button", { name: /Model:/i }));
  for (const m of MODELS) {
    // The current model label appears in both the trigger and the menu, so use getAllByText
    expect(screen.getAllByText(m.label).length).toBeGreaterThanOrEqual(1);
  }
});

test("unavailable models show 'Coming soon' text", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: /Model:/i }));
  const unavailable = MODELS.filter((m) => !m.available);
  const comingSoon = screen.getAllByText("Coming soon");
  expect(comingSoon).toHaveLength(unavailable.length);
});

test("selecting an available model calls onModelChange", async () => {
  const { onModelChange } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Model:/i }));
  // Pick "Claude Sonnet 4.6" (available, not the default)
  const sonnet = MODELS.find((m) => m.id === "sonnet")!;
  await userEvent.click(screen.getByText(sonnet.label));
  expect(onModelChange).toHaveBeenCalledWith(expect.objectContaining({ id: "sonnet" }));
});

test("clicking a disabled (unavailable) model item does not call onModelChange", async () => {
  const { onModelChange } = setup();
  await userEvent.click(screen.getByRole("button", { name: /Model:/i }));
  // "Gemini" is unavailable
  const gemini = MODELS.find((m) => m.id === "gemini")!;
  // Radix marks disabled items with data-disabled; userEvent will still fire a click
  // but onSelect is suppressed by Radix for disabled items.
  const geminiEl = screen.getByText(gemini.label);
  await userEvent.click(geminiEl);
  expect(onModelChange).not.toHaveBeenCalled();
});

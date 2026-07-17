import { render, screen, fireEvent } from "@testing-library/react";
import { SessionHeader } from "../SessionHeader";

function setup(overrides: Partial<React.ComponentProps<typeof SessionHeader>> = {}) {
  const onClose = vi.fn();
  const onCleanup = vi.fn();
  const onTogglePanel = vi.fn();
  render(
    <SessionHeader
      title="Fix the login bug"
      agent="claude"
      repo="my-repo"
      status="idle"
      source="kine-agent"
      onClose={onClose}
      onCleanup={onCleanup}
      onTogglePanel={onTogglePanel}
      panelOpen={false}
      {...overrides}
    />,
  );
  return { onClose, onCleanup, onTogglePanel };
}

// ── Title and repo ────────────────────────────────────────────────────────────

test("renders the session title", () => {
  setup();
  expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
});

test("renders the repo name in the secondary line", () => {
  setup();
  expect(screen.getByText("my-repo")).toBeInTheDocument();
});

// ── Inline rename ───────────────────────────────────────────────────────────────

test("double-clicking the title opens an inline editor seeded with the title", async () => {
  setup({ onRename: vi.fn() });
  fireEvent.doubleClick(screen.getByText("Fix the login bug"));
  const input = (await screen.findByRole("textbox", {
    name: /session title/i,
  })) as HTMLInputElement;
  expect(input.value).toBe("Fix the login bug");
});

test("two quick clicks on the title also open the editor (webview dblclick fallback)", async () => {
  setup({ onRename: vi.fn() });
  const title = screen.getByText("Fix the login bug");
  fireEvent.click(title);
  fireEvent.click(title);
  expect(await screen.findByRole("textbox", { name: /session title/i })).toBeInTheDocument();
});

test("Enter commits a renamed title via onRename with the trimmed value", async () => {
  const onRename = vi.fn();
  setup({ onRename });
  fireEvent.doubleClick(screen.getByText("Fix the login bug"));
  const input = await screen.findByRole("textbox", { name: /session title/i });
  fireEvent.change(input, { target: { value: "  Fix login redirect  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onRename).toHaveBeenCalledWith("Fix login redirect");
});

test("Escape cancels editing without calling onRename", async () => {
  const onRename = vi.fn();
  setup({ onRename });
  fireEvent.doubleClick(screen.getByText("Fix the login bug"));
  const input = await screen.findByRole("textbox", { name: /session title/i });
  fireEvent.change(input, { target: { value: "discarded" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(onRename).not.toHaveBeenCalled();
  expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
});

test("the title is not editable when onRename is omitted", () => {
  setup();
  fireEvent.doubleClick(screen.getByText("Fix the login bug"));
  expect(screen.queryByRole("textbox", { name: /session title/i })).not.toBeInTheDocument();
});

// ── Diffstat is not shown in the header ─────────────────────────────────────────
// The live diff moved to the Changes tab; the header stays a clean identity line.

test("never renders diff additions/deletions in the header", () => {
  setup();
  expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^−\d/)).not.toBeInTheDocument();
});

test("renders gracefully with no secondary line when repo is null", () => {
  setup({ repo: null });
  expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
  // No secondary line rendered
  expect(screen.queryByText("my-repo")).not.toBeInTheDocument();
});

// ── Close button ──────────────────────────────────────────────────────────────

test("close button calls onClose", () => {
  const { onClose } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Close session" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

test("cleanup button calls onCleanup", () => {
  const { onCleanup } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Clean up worktree" }));
  expect(onCleanup).toHaveBeenCalledTimes(1);
});

test("external CLI sessions keep context available but hide cleanup", () => {
  const { onCleanup } = setup({ source: "external" });
  expect(screen.getByText("CLI history")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Clean up worktree" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Toggle context panel" })).toBeInTheDocument();
  expect(onCleanup).not.toHaveBeenCalled();
});

// ── Panel toggle ──────────────────────────────────────────────────────────────

test("panel toggle calls onTogglePanel", () => {
  const { onTogglePanel } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Toggle context panel" }));
  expect(onTogglePanel).toHaveBeenCalledTimes(1);
});

test("panel toggle reflects panelOpen via aria-pressed", () => {
  setup({ panelOpen: true });
  expect(screen.getByRole("button", { name: "Toggle context panel" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

// ── Status indicator ──────────────────────────────────────────────────────────
// Status is conveyed by a single color-coded dot; the label is exposed to
// assistive tech via the dot's accessible name (no duplicate visible text).

test("exposes the status via the dot's accessible label for a known status", () => {
  setup({ status: "running" });
  expect(screen.getByRole("img", { name: "Status: Running" })).toBeInTheDocument();
});

test("exposes Idle status without relying on color alone", () => {
  setup({ status: "idle" });
  expect(screen.getByRole("img", { name: "Status: Idle" })).toBeInTheDocument();
});

test("exposes 'Unknown' status for an unrecognised status", () => {
  setup({ status: "pending" });
  expect(screen.getByRole("img", { name: "Status: Unknown" })).toBeInTheDocument();
});

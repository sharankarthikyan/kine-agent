import { render, screen, fireEvent } from "@testing-library/react";
import { SessionHeader } from "../SessionHeader";
import type { Diffstat } from "../../lib/conductor";

const DIFFSTAT: Diffstat = { additions: 12, deletions: 3, filesChanged: 5 };

function setup(overrides: Partial<React.ComponentProps<typeof SessionHeader>> = {}) {
  const onClose = vi.fn();
  const onCleanup = vi.fn();
  const onTogglePanel = vi.fn();
  render(
    <SessionHeader
      title="Fix the login bug"
      repo="my-repo"
      status="idle"
      diffstat={DIFFSTAT}
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

// ── Diffstat ──────────────────────────────────────────────────────────────────

test("renders diffstat additions and deletions", () => {
  setup();
  expect(screen.getByText("+12")).toBeInTheDocument();
  expect(screen.getByText("−3")).toBeInTheDocument();
});

test("omits additions/deletions when diffstat is null", () => {
  setup({ diffstat: null });
  expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^−\d/)).not.toBeInTheDocument();
});

test("renders gracefully when both repo and diffstat are null", () => {
  setup({ repo: null, diffstat: null });
  expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
  // No secondary line rendered
  expect(screen.queryByText("my-repo")).not.toBeInTheDocument();
});

test("renders repo without diffstat when diffstat is null", () => {
  setup({ diffstat: null });
  expect(screen.getByText("my-repo")).toBeInTheDocument();
  expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument();
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

// ── Panel toggle ──────────────────────────────────────────────────────────────

test("panel toggle calls onTogglePanel", () => {
  const { onTogglePanel } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));
  expect(onTogglePanel).toHaveBeenCalledTimes(1);
});

test("panel toggle reflects panelOpen via aria-pressed", () => {
  setup({ panelOpen: true });
  expect(screen.getByRole("button", { name: "Toggle panel" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

// ── Status label ──────────────────────────────────────────────────────────────

test("renders the status label for a known status", () => {
  setup({ status: "running" });
  expect(screen.getByText("Running")).toBeInTheDocument();
});

test("renders Idle instead of relying on color alone", () => {
  setup({ status: "idle" });
  expect(screen.getByText("Idle")).toBeInTheDocument();
});

test("renders 'Unknown' label for an unrecognised status", () => {
  setup({ status: "pending" });
  expect(screen.getByText("Unknown")).toBeInTheDocument();
});

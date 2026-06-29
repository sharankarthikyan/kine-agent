import { render, screen, fireEvent } from "@testing-library/react";
import { SessionHeader } from "../SessionHeader";
import type { Diffstat } from "../../lib/conductor";

const DIFFSTAT: Diffstat = { additions: 12, deletions: 3, filesChanged: 5 };

function setup(overrides: Partial<React.ComponentProps<typeof SessionHeader>> = {}) {
  const onClose = vi.fn();
  render(
    <SessionHeader
      title="Fix the login bug"
      repo="my-repo"
      status="idle"
      diffstat={DIFFSTAT}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onClose };
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

// ── Inert stubs (approve / pin) ───────────────────────────────────────────────

test("approve button has aria-disabled", () => {
  setup();
  expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("pin button has aria-disabled", () => {
  setup();
  expect(screen.getByRole("button", { name: "Pin" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("clicking approve does not invoke onClose", () => {
  const { onClose } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(onClose).not.toHaveBeenCalled();
});

test("clicking pin does not invoke onClose", () => {
  const { onClose } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Pin" }));
  expect(onClose).not.toHaveBeenCalled();
});

// ── Status label ──────────────────────────────────────────────────────────────

test("renders the status label for a known status", () => {
  setup({ status: "running" });
  expect(screen.getByText("Running")).toBeInTheDocument();
});

test("renders 'Unknown' label for an unrecognised status", () => {
  setup({ status: "pending" });
  expect(screen.getByText("Unknown")).toBeInTheDocument();
});

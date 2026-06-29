import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangesPanel } from "../ChangesPanel";
import type { BranchChanges } from "../../lib/conductor";

const BRANCH: BranchChanges = {
  aheadCount: 2,
  files: [
    { path: "src/app.ts", status: "modified", additions: 5, deletions: 2 },
    { path: "src/new.ts", status: "added", additions: 10, deletions: 0 },
    { path: "old.ts", status: "deleted", additions: 0, deletions: 7 },
  ],
};

const noop = () => {};

// ── Empty states ───────────────────────────────────────────────────────────────

test("shows 'No changes' when branch is null", () => {
  render(
    <ChangesPanel branch={null} onCommit={noop} onOpenFile={noop} committing={false} />,
  );
  expect(screen.getByText("No changes")).toBeInTheDocument();
});

test("shows 'No changes' when branch has no files", () => {
  render(
    <ChangesPanel
      branch={{ aheadCount: 0, files: [] }}
      onCommit={noop}
      onOpenFile={noop}
      committing={false}
    />,
  );
  expect(screen.getByText("No changes")).toBeInTheDocument();
});

// ── File rows ──────────────────────────────────────────────────────────────────

test("renders each file path", () => {
  render(
    <ChangesPanel branch={BRANCH} onCommit={noop} onOpenFile={noop} committing={false} />,
  );
  expect(screen.getByText("src/app.ts")).toBeInTheDocument();
  expect(screen.getByText("src/new.ts")).toBeInTheDocument();
  expect(screen.getByText("old.ts")).toBeInTheDocument();
});

test("shows per-file addition and deletion counts", () => {
  render(
    <ChangesPanel branch={BRANCH} onCommit={noop} onOpenFile={noop} committing={false} />,
  );
  // First file: +5, -2
  expect(screen.getByText("+5")).toBeInTheDocument();
  expect(screen.getByText("-2")).toBeInTheDocument();
});

test("clicking a file row calls onOpenFile with the file path", async () => {
  const onOpenFile = vi.fn();
  render(
    <ChangesPanel branch={BRANCH} onCommit={noop} onOpenFile={onOpenFile} committing={false} />,
  );
  await userEvent.click(screen.getByRole("button", { name: /Open src\/app\.ts/i }));
  expect(onOpenFile).toHaveBeenCalledWith("src/app.ts");
});

// ── Summary line ───────────────────────────────────────────────────────────────

test("shows ahead count in the summary", () => {
  render(
    <ChangesPanel branch={BRANCH} onCommit={noop} onOpenFile={noop} committing={false} />,
  );
  expect(screen.getByText(/2 ahead/)).toBeInTheDocument();
});

// ── Commit flow ────────────────────────────────────────────────────────────────

test("Commit button reveals the message input", async () => {
  render(
    <ChangesPanel branch={BRANCH} onCommit={noop} onOpenFile={noop} committing={false} />,
  );
  expect(screen.queryByLabelText("Commit message")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Commit changes" }));
  expect(screen.getByLabelText("Commit message")).toBeInTheDocument();
});

test("confirm is disabled when message is empty", async () => {
  render(
    <ChangesPanel branch={BRANCH} onCommit={noop} onOpenFile={noop} committing={false} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Commit changes" }));
  expect(screen.getByRole("button", { name: "Confirm commit" })).toBeDisabled();
});

test("confirm is disabled when message is only whitespace", async () => {
  render(
    <ChangesPanel branch={BRANCH} onCommit={noop} onOpenFile={noop} committing={false} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Commit changes" }));
  await userEvent.type(screen.getByLabelText("Commit message"), "   ");
  expect(screen.getByRole("button", { name: "Confirm commit" })).toBeDisabled();
});

test("confirming calls onCommit with the typed message", async () => {
  const onCommit = vi.fn();
  render(
    <ChangesPanel branch={BRANCH} onCommit={onCommit} onOpenFile={noop} committing={false} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Commit changes" }));
  await userEvent.type(screen.getByLabelText("Commit message"), "fix: add tests");
  await userEvent.click(screen.getByRole("button", { name: "Confirm commit" }));
  expect(onCommit).toHaveBeenCalledWith("fix: add tests");
});

// ── Committing busy state ──────────────────────────────────────────────────────

test("commit button is disabled while committing", () => {
  render(
    <ChangesPanel branch={BRANCH} onCommit={noop} onOpenFile={noop} committing={true} />,
  );
  // The initial commit button shows "Committing…" and is disabled
  expect(screen.getByRole("button", { name: "Commit changes" })).toBeDisabled();
});

test("confirm commit button is disabled while committing", async () => {
  const { rerender } = render(
    <ChangesPanel branch={BRANCH} onCommit={noop} onOpenFile={noop} committing={false} />,
  );
  // Open the composer and type a message so confirm would normally be enabled
  await userEvent.click(screen.getByRole("button", { name: "Commit changes" }));
  await userEvent.type(screen.getByLabelText("Commit message"), "fix: something");
  // Simulate commit in-flight — confirm must become disabled
  rerender(
    <ChangesPanel branch={BRANCH} onCommit={noop} onOpenFile={noop} committing={true} />,
  );
  expect(screen.getByRole("button", { name: "Confirm commit" })).toBeDisabled();
});

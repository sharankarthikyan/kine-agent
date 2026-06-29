import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilesTree } from "../FilesTree";
import type { TreeNode } from "../../lib/tree";

const FILE_NODE: TreeNode = {
  name: "index.ts",
  path: "src/index.ts",
  isDir: false,
  status: "modified",
  children: [],
};

const DIR_NODE: TreeNode = {
  name: "src",
  path: "src",
  isDir: true,
  status: null,
  children: [FILE_NODE],
};

const noop = () => {};

// ── Empty state ────────────────────────────────────────────────────────────────

test("shows 'No files' when nodes is empty", () => {
  render(<FilesTree nodes={[]} onOpenFile={noop} />);
  expect(screen.getByText("No files")).toBeInTheDocument();
});

// ── Rendering ──────────────────────────────────────────────────────────────────

test("renders a top-level file node", () => {
  render(<FilesTree nodes={[FILE_NODE]} onOpenFile={noop} />);
  expect(screen.getByText("index.ts")).toBeInTheDocument();
});

test("renders a nested structure: directory name and child file name are both visible", () => {
  render(<FilesTree nodes={[DIR_NODE]} onOpenFile={noop} />);
  expect(screen.getByText("src")).toBeInTheDocument();
  expect(screen.getByText("index.ts")).toBeInTheDocument();
});

test("maps a full-word status to its single-letter badge with a status color", () => {
  render(<FilesTree nodes={[FILE_NODE]} onOpenFile={noop} />);
  // Full-word "modified" renders as the letter "M", not the raw word.
  const badge = screen.getByText("M");
  expect(badge).toBeInTheDocument();
  expect(badge).toHaveAttribute("title", "modified");
  // A status color is applied (not the muted-foreground fallback for unknown statuses).
  expect(badge).toHaveStyle({ color: "var(--status-running)" });
  expect(screen.queryByText("modified")).not.toBeInTheDocument();
});

// ── File interaction ───────────────────────────────────────────────────────────

test("clicking a file node calls onOpenFile with the file path", async () => {
  const onOpenFile = vi.fn();
  render(<FilesTree nodes={[FILE_NODE]} onOpenFile={onOpenFile} />);
  await userEvent.click(screen.getByRole("button", { name: /Open index\.ts/i }));
  expect(onOpenFile).toHaveBeenCalledWith("src/index.ts");
});

test("clicking a file inside a directory calls onOpenFile with the file path", async () => {
  const onOpenFile = vi.fn();
  render(<FilesTree nodes={[DIR_NODE]} onOpenFile={onOpenFile} />);
  await userEvent.click(screen.getByRole("button", { name: /Open index\.ts/i }));
  expect(onOpenFile).toHaveBeenCalledWith("src/index.ts");
});

// ── Directory interaction ──────────────────────────────────────────────────────

test("clicking a directory collapses its children", async () => {
  render(<FilesTree nodes={[DIR_NODE]} onOpenFile={noop} />);
  // Children are visible initially (open by default)
  expect(screen.getByText("index.ts")).toBeInTheDocument();

  // Click the dir button to collapse
  await userEvent.click(screen.getByRole("button", { name: "src" }));
  expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
});

test("clicking a collapsed directory expands its children", async () => {
  render(<FilesTree nodes={[DIR_NODE]} onOpenFile={noop} />);

  // Collapse
  await userEvent.click(screen.getByRole("button", { name: "src" }));
  expect(screen.queryByText("index.ts")).not.toBeInTheDocument();

  // Expand again
  await userEvent.click(screen.getByRole("button", { name: "src" }));
  expect(screen.getByText("index.ts")).toBeInTheDocument();
});

test("clicking a directory does NOT call onOpenFile", async () => {
  const onOpenFile = vi.fn();
  render(<FilesTree nodes={[DIR_NODE]} onOpenFile={onOpenFile} />);
  await userEvent.click(screen.getByRole("button", { name: "src" }));
  expect(onOpenFile).not.toHaveBeenCalled();
});

test("directory button exposes aria-expanded reflecting open state", async () => {
  render(<FilesTree nodes={[DIR_NODE]} onOpenFile={noop} />);
  const dirBtn = screen.getByRole("button", { name: "src" });
  expect(dirBtn).toHaveAttribute("aria-expanded", "true");

  await userEvent.click(dirBtn);
  expect(dirBtn).toHaveAttribute("aria-expanded", "false");
});

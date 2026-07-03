import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { DiffReviewDialog } from "../DiffReviewDialog";
import type { SessionDiff } from "../../lib/review";

const DIFF: SessionDiff = {
  files: [
    { path: "src/a.ts", status: "modified", additions: 2, deletions: 1 },
    { path: "src/new.ts", status: "added", additions: 1, deletions: 0 },
  ],
  patch: [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1,2 @@",
    "-old",
    "+new",
    "+extra",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1 @@",
    "+created",
  ].join("\n"),
};

function setup(overrides: Partial<ComponentProps<typeof DiffReviewDialog>> = {}) {
  const onOpenChange = vi.fn();
  const onSelectPath = vi.fn();
  const onCommit = vi.fn().mockResolvedValue(true);
  render(
    <DiffReviewDialog
      open
      diff={DIFF}
      selectedPath="src/a.ts"
      committing={false}
      onOpenChange={onOpenChange}
      onSelectPath={onSelectPath}
      onCommit={onCommit}
      {...overrides}
    />,
  );
  return { onOpenChange, onSelectPath, onCommit };
}

test("renders a changed-file rail and selected file diff", () => {
  setup();
  expect(screen.getAllByText("src/a.ts").length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText("src/new.ts")).toBeInTheDocument();
  expect(screen.getByText("old")).toBeInTheDocument();
  expect(screen.getByText("new")).toBeInTheDocument();
});

test("selecting a file calls onSelectPath", async () => {
  const { onSelectPath } = setup();
  await userEvent.click(screen.getByRole("button", { name: /src\/new.ts/ }));
  expect(onSelectPath).toHaveBeenCalledWith("src/new.ts");
});

test("commit composer calls onCommit with the typed message", async () => {
  const { onCommit } = setup();
  await userEvent.click(screen.getByRole("button", { name: "Commit" }));
  await userEvent.type(screen.getByLabelText("Commit message"), "add smoke doc");
  await userEvent.click(screen.getByRole("button", { name: "Commit" }));
  expect(onCommit).toHaveBeenCalledWith("add smoke doc");
});

import { render, screen } from "@testing-library/react";
import { DiffViewer } from "../DiffViewer";
import type { SessionDiff } from "../../lib/review";

const sample: SessionDiff = {
  files: [
    { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
    { path: "src/new.ts", status: "added", additions: 5, deletions: 0 },
    { path: "old.ts", status: "deleted", additions: 0, deletions: 4 },
  ],
  patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
};

test("shows empty state when no files changed", () => {
  render(<DiffViewer diff={{ files: [], patch: "" }} />);
  expect(screen.getByText("No changes.")).toBeInTheDocument();
});

test("lists each changed file with its path", () => {
  render(<DiffViewer diff={sample} />);
  expect(screen.getByText("src/a.ts")).toBeInTheDocument();
  expect(screen.getByText("src/new.ts")).toBeInTheDocument();
  expect(screen.getByText("old.ts")).toBeInTheDocument();
});

test("shows a summary count of changed files", () => {
  render(<DiffViewer diff={sample} />);
  expect(screen.getByText(/3 files? changed/i)).toBeInTheDocument();
});

test("renders the patch text", () => {
  render(<DiffViewer diff={sample} />);
  expect(screen.getByText(/diff --git a\/src\/a.ts/)).toBeInTheDocument();
});

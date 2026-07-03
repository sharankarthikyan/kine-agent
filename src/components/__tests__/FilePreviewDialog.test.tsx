import { render, screen } from "@testing-library/react";
import { FilePreviewDialog } from "../FilePreviewDialog";

test("shows a loading state while a file preview is loading", () => {
  render(
    <FilePreviewDialog
      preview={{ path: "src/app.tsx", content: null, status: "loading" }}
      onOpenChange={vi.fn()}
    />,
  );

  expect(screen.getByRole("status")).toHaveTextContent("Loading file...");
});

test("renders read-only file content", () => {
  render(
    <FilePreviewDialog
      preview={{ path: "src/app.tsx", content: "export const ok = true;\n", status: "ready" }}
      onOpenChange={vi.fn()}
    />,
  );

  expect(screen.getByText("src/app.tsx")).toBeInTheDocument();
  expect(screen.getByText("export").closest("pre")?.textContent).toContain("export const ok = true;");
});

test("renders file preview errors", () => {
  render(
    <FilePreviewDialog
      preview={{ path: "src/app.tsx", content: null, status: "error", error: "not text" }}
      onOpenChange={vi.fn()}
    />,
  );

  expect(screen.getByText("Couldn't preview this file")).toBeInTheDocument();
  expect(screen.getByText("not text")).toBeInTheDocument();
});

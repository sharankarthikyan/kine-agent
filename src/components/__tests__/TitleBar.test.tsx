import { render, screen, fireEvent } from "@testing-library/react";
import { TitleBar } from "../TitleBar";

// ── Session pill rendering ────────────────────────────────────────────────────

test('renders "New Session" pill when title is null', () => {
  render(<TitleBar />);
  expect(screen.getByText("New Session")).toBeInTheDocument();
});

test("renders title and repo in the session pill", () => {
  render(<TitleBar title="Foo" repo="myrepo" />);
  expect(screen.getByText("Foo · myrepo")).toBeInTheDocument();
});

test("renders title without repo suffix when repo is null", () => {
  render(<TitleBar title="My Task" />);
  expect(screen.getByText("My Task")).toBeInTheDocument();
});

// ── Sidebar toggle ────────────────────────────────────────────────────────────

test("calls onToggleSidebar when the sidebar toggle button is clicked", () => {
  const onToggleSidebar = vi.fn();
  render(<TitleBar onToggleSidebar={onToggleSidebar} />);
  fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(onToggleSidebar).toHaveBeenCalledTimes(1);
});

test("shows 'Show sidebar' label when sidebarCollapsed is true", () => {
  render(<TitleBar sidebarCollapsed={true} />);
  expect(screen.getByRole("button", { name: "Show sidebar" })).toBeInTheDocument();
});

// ── Editor and terminal buttons ───────────────────────────────────────────────

test("calls onOpenEditor when the open-in-editor button is clicked", () => {
  const onOpenEditor = vi.fn();
  render(<TitleBar onOpenEditor={onOpenEditor} />);
  fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
  expect(onOpenEditor).toHaveBeenCalledTimes(1);
});

test("calls onOpenTerminal when the open-terminal button is clicked", () => {
  const onOpenTerminal = vi.fn();
  render(<TitleBar onOpenTerminal={onOpenTerminal} />);
  fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
  expect(onOpenTerminal).toHaveBeenCalledTimes(1);
});

// ── Inert stubs ───────────────────────────────────────────────────────────────

test("renders the run stub with aria-disabled and tabIndex=-1 (skipped by keyboard Tab)", () => {
  render(<TitleBar />);
  const stub = screen.getByRole("button", { name: "Run (coming soon)" });
  expect(stub).toHaveAttribute("aria-disabled", "true");
  expect(stub).toHaveAttribute("tabindex", "-1");
});

test("renders the split stub with aria-disabled", () => {
  render(<TitleBar />);
  expect(screen.getByRole("button", { name: "Split (coming soon)" })).toHaveAttribute(
    "aria-disabled",
    "true"
  );
});

test("renders the account stub with aria-disabled", () => {
  render(<TitleBar />);
  expect(screen.getByRole("button", { name: "Account (coming soon)" })).toHaveAttribute(
    "aria-disabled",
    "true"
  );
});

test("clicking an inert stub does not invoke any handler", () => {
  const onToggleSidebar = vi.fn();
  const onOpenEditor = vi.fn();
  const onOpenTerminal = vi.fn();
  render(
    <TitleBar
      onToggleSidebar={onToggleSidebar}
      onOpenEditor={onOpenEditor}
      onOpenTerminal={onOpenTerminal}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Run (coming soon)" }));
  fireEvent.click(screen.getByRole("button", { name: "Split (coming soon)" }));
  fireEvent.click(screen.getByRole("button", { name: "Account (coming soon)" }));
  // No provided callbacks should have fired
  expect(onToggleSidebar).not.toHaveBeenCalled();
  expect(onOpenEditor).not.toHaveBeenCalled();
  expect(onOpenTerminal).not.toHaveBeenCalled();
});

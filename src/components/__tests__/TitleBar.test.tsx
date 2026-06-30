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

test("split buttons call their handlers when workspace splitting is available", () => {
  const onSplitVertical = vi.fn();
  const onSplitHorizontal = vi.fn();
  render(
    <TitleBar
      canSplit
      onSplitVertical={onSplitVertical}
      onSplitHorizontal={onSplitHorizontal}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Split right" }));
  fireEvent.click(screen.getByRole("button", { name: "Split down" }));
  expect(onSplitVertical).toHaveBeenCalledTimes(1);
  expect(onSplitHorizontal).toHaveBeenCalledTimes(1);
});

test("hides split buttons when workspace splitting is unavailable", () => {
  render(<TitleBar canSplit={false} />);
  expect(screen.queryByRole("button", { name: "Split right" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Split down" })).not.toBeInTheDocument();
});

// ── Unimplemented actions ─────────────────────────────────────────────────────

test("does not expose placeholder actions as controls", () => {
  render(<TitleBar />);
  expect(screen.queryByRole("button", { name: "Run (coming soon)" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Split (coming soon)" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Account (coming soon)" })).not.toBeInTheDocument();
});

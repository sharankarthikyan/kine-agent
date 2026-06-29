import { render, screen, fireEvent } from "@testing-library/react";
import { SessionList } from "../SessionList";
import type { SessionSummary } from "../../lib/sessions";
import type { CustomizationCounts, Diffstat } from "../../lib/conductor";

const sessions: SessionSummary[] = [
  {
    id: "a",
    agent: "claude",
    repo: "/repos/my-app",
    branch: "agent/a",
    title: "add auth",
    status: "idle",
    createdAt: 1000,
    updatedAt: 3000,
  },
  {
    id: "b",
    agent: "claude",
    repo: "/repos/my-app",
    branch: "agent/b",
    title: "fix bug",
    status: "running",
    createdAt: 2000,
    updatedAt: 4000,
  },
];

const groups = [{ workspace: "my-app", sessions }];

const diffstats: Record<string, Diffstat> = {
  a: { additions: 12, deletions: 3, filesChanged: 2 },
};

const counts: CustomizationCounts = {
  agents: 2,
  skills: 5,
  instructions: 1,
  hooks: 3,
  mcpServers: 4,
};

const defaultProps = {
  groups,
  activeId: null as string | null,
  onSelect: () => {},
  onNew: () => {},
  counts: null as CustomizationCounts | null,
  diffstats: {} as Record<string, Diffstat>,
  search: "",
  onSearchChange: () => {},
  onOpenCustomization: () => {},
};

test("renders workspace header", () => {
  render(<SessionList {...defaultProps} />);
  expect(screen.getByText("my-app")).toBeInTheDocument();
});

test("renders each session title", () => {
  render(<SessionList {...defaultProps} />);
  expect(screen.getByText("add auth")).toBeInTheDocument();
  expect(screen.getByText("fix bug")).toBeInTheDocument();
});

test("shows diffstat additions and deletions for a session", () => {
  render(<SessionList {...defaultProps} diffstats={diffstats} />);
  // additions and deletions are now separate colored spans
  expect(screen.getByText("+12")).toBeInTheDocument();
  expect(screen.getByText("−3")).toBeInTheDocument();
});

test("shows +0 −0 for sessions without diffstat data", () => {
  render(<SessionList {...defaultProps} diffstats={{}} />);
  // each session row renders a +0 additions span
  const addZeros = screen.getAllByText("+0");
  expect(addZeros.length).toBeGreaterThan(0);
});

test("shows relative time for each session row", () => {
  render(<SessionList {...defaultProps} />);
  // Timestamps far in the past relative to now — any "ago" text is correct
  const timeLabels = screen.getAllByText(/ago|just now/i);
  expect(timeLabels.length).toBeGreaterThan(0);
});

test("calls onSelect with the session id when a row is clicked", () => {
  const onSelect = vi.fn();
  render(<SessionList {...defaultProps} onSelect={onSelect} />);
  fireEvent.click(screen.getByText("add auth"));
  expect(onSelect).toHaveBeenCalledWith("a");
});

test("marks the active session row with aria-current", () => {
  render(<SessionList {...defaultProps} activeId="b" />);
  const active = screen.getByText("fix bug").closest("[aria-current]");
  expect(active).toHaveAttribute("aria-current", "true");
});

test("calls onNew when the New button in the header is clicked", () => {
  const onNew = vi.fn();
  render(<SessionList {...defaultProps} onNew={onNew} />);
  // Header button accessible name is "New ⌘N"; empty state is not rendered here
  fireEvent.click(screen.getByRole("button", { name: /^new/i }));
  expect(onNew).toHaveBeenCalled();
});

test("renders all five customization labels and their counts", () => {
  render(<SessionList {...defaultProps} counts={counts} />);
  expect(screen.getByText("Agents")).toBeInTheDocument();
  expect(screen.getByText("Skills")).toBeInTheDocument();
  expect(screen.getByText("Instructions")).toBeInTheDocument();
  expect(screen.getByText("Hooks")).toBeInTheDocument();
  expect(screen.getByText("MCP Servers")).toBeInTheDocument();
  expect(screen.getByText("2")).toBeInTheDocument(); // agents count
  expect(screen.getByText("5")).toBeInTheDocument(); // skills count
  expect(screen.getByText("1")).toBeInTheDocument(); // instructions count
  expect(screen.getByText("3")).toBeInTheDocument(); // hooks count
  expect(screen.getByText("4")).toBeInTheDocument(); // mcpServers count
});

test("shows muted dashes for all five rows when counts is null", () => {
  render(<SessionList {...defaultProps} counts={null} />);
  const dashes = screen.getAllByText("—");
  expect(dashes.length).toBe(5);
});

test("clicking a Customizations row calls onOpenCustomization with the right section", () => {
  const onOpenCustomization = vi.fn();
  render(<SessionList {...defaultProps} counts={counts} onOpenCustomization={onOpenCustomization} />);
  fireEvent.click(screen.getByRole("button", { name: /open agents customizations/i }));
  expect(onOpenCustomization).toHaveBeenCalledWith("agents");
});

test("clicking Skills Customizations row fires with 'skills' section", () => {
  const onOpenCustomization = vi.fn();
  render(<SessionList {...defaultProps} counts={counts} onOpenCustomization={onOpenCustomization} />);
  fireEvent.click(screen.getByRole("button", { name: /open skills customizations/i }));
  expect(onOpenCustomization).toHaveBeenCalledWith("skills");
});

test("clicking MCP Servers row fires with 'mcp' section", () => {
  const onOpenCustomization = vi.fn();
  render(<SessionList {...defaultProps} counts={counts} onOpenCustomization={onOpenCustomization} />);
  fireEvent.click(screen.getByRole("button", { name: /open mcp servers customizations/i }));
  expect(onOpenCustomization).toHaveBeenCalledWith("mcp");
});

test("calls onSearchChange when typing in the search input", () => {
  const onSearchChange = vi.fn();
  render(<SessionList {...defaultProps} onSearchChange={onSearchChange} />);
  // Open the search input first
  fireEvent.click(screen.getByRole("button", { name: /search sessions/i }));
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "auth" } });
  expect(onSearchChange).toHaveBeenCalledWith("auth");
});

test("shows empty state when groups is empty", () => {
  render(<SessionList {...defaultProps} groups={[]} />);
  expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument();
});

test("empty state New session button calls onNew", () => {
  const onNew = vi.fn();
  render(<SessionList {...defaultProps} groups={[]} onNew={onNew} />);
  // Header btn is "New ⌘N"; empty state btn is exactly "New session" — use exact match
  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  expect(onNew).toHaveBeenCalled();
});

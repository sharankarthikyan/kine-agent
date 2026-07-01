import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionList } from "../SessionList";
import type { SessionSummary } from "../../lib/sessions";
import type { CustomizationCounts } from "../../lib/conductor";

const sessions: SessionSummary[] = [
  {
    id: "a",
    agent: "claude",
    repo: "/repos/my-app",
    branch: "agent/a",
    title: "add auth",
    status: "idle",
    source: "kineloop",
    turnCount: null,
    toolCallCount: null,
    fileActionCount: null,
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
    source: "kineloop",
    turnCount: null,
    toolCallCount: null,
    fileActionCount: null,
    createdAt: 2000,
    updatedAt: 4000,
  },
];

const groups = [{ workspace: "my-app", sessions }];

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
  search: "",
  onSearchChange: () => {},
  statusFilter: "all" as const,
  sourceFilter: "all" as const,
  onStatusFilterChange: () => {},
  onSourceFilterChange: () => {},
  onOpenCustomization: () => {},
  onRename: () => {},
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

test("does not render a git diffstat on Kineloop session rows", () => {
  // The live diff moved to the Changes tab; sidebar rows show only a relative time.
  render(<SessionList {...defaultProps} />);
  expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^−\d/)).not.toBeInTheDocument();
});

test("shows relative time for each session row", () => {
  render(<SessionList {...defaultProps} />);
  // Sidebar rows use compact timestamps so metadata survives narrow panel widths.
  const timeLabels = screen.getAllByText(/\d+d|\d+h|\d+m|now/i);
  expect(timeLabels.length).toBeGreaterThan(0);
});

test("shows turns · tools · files on Kineloop rows, like CLI rows", () => {
  render(
    <SessionList
      {...defaultProps}
      groups={[
        {
          workspace: "my-app",
          sessions: [
            { ...sessions[0], turnCount: 2, toolCallCount: 3, fileActionCount: 2 },
          ],
        },
      ]}
    />,
  );
  expect(screen.getByText(/2t · 3 tools · 2f/)).toBeInTheDocument();
  // Still no git diffstat — that lives in the Changes tab.
  expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument();
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

test("labels external CLI sessions distinctly", () => {
  render(
    <SessionList
      {...defaultProps}
      groups={[
        {
          workspace: "cli",
          sessions: [
            {
              ...sessions[0],
              id: "external:claude:1",
              source: "external",
              turnCount: 4,
              toolCallCount: 9,
              fileActionCount: 3,
            },
          ],
        },
      ]}
    />,
  );
  expect(screen.getByText("CLI")).toBeInTheDocument();
  expect(screen.getByText(/4t · 9 tools · 3f/)).toBeInTheDocument();
  expect(screen.queryByText("+0")).not.toBeInTheDocument();
});

test("double-clicking a session title opens an inline editor seeded with the title", async () => {
  render(<SessionList {...defaultProps} />);
  fireEvent.doubleClick(screen.getByText("add auth"));
  const input = (await screen.findByRole("textbox", {
    name: /session title/i,
  })) as HTMLInputElement;
  expect(input.value).toBe("add auth");
});

test("two quick clicks on a row open the inline editor (WKWebView dblclick fallback)", async () => {
  // The macOS webview doesn't fire dblclick on <button> descendants, so the row
  // detects a double-click from two clicks. This path must work independently of
  // the native onDoubleClick handler.
  render(<SessionList {...defaultProps} />);
  const title = screen.getByText("add auth");
  fireEvent.click(title);
  fireEvent.click(title);
  const input = (await screen.findByRole("textbox", {
    name: /session title/i,
  })) as HTMLInputElement;
  expect(input.value).toBe("add auth");
});

test("Enter commits a renamed title via onRename with the trimmed value", async () => {
  const onRename = vi.fn();
  render(<SessionList {...defaultProps} onRename={onRename} />);
  fireEvent.doubleClick(screen.getByText("add auth"));
  const input = await screen.findByRole("textbox", { name: /session title/i });
  await userEvent.clear(input);
  await userEvent.type(input, "  add auth flow  ");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onRename).toHaveBeenCalledWith("a", "add auth flow");
});

test("Escape cancels editing without calling onRename", async () => {
  const onRename = vi.fn();
  render(<SessionList {...defaultProps} onRename={onRename} />);
  fireEvent.doubleClick(screen.getByText("add auth"));
  const input = await screen.findByRole("textbox", { name: /session title/i });
  await userEvent.clear(input);
  await userEvent.type(input, "discarded");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(onRename).not.toHaveBeenCalled();
  expect(screen.getByText("add auth")).toBeInTheDocument();
});

test("committing an unchanged title does not call onRename", async () => {
  const onRename = vi.fn();
  render(<SessionList {...defaultProps} onRename={onRename} />);
  fireEvent.doubleClick(screen.getByText("add auth"));
  const input = await screen.findByRole("textbox", { name: /session title/i });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onRename).not.toHaveBeenCalled();
});

test("renaming is double-click only — no edit icon affordance is rendered", () => {
  render(<SessionList {...defaultProps} />);
  expect(screen.queryByRole("button", { name: /rename/i })).not.toBeInTheDocument();
});

test("double-clicking an external CLI session title opens its inline editor", async () => {
  render(
    <SessionList
      {...defaultProps}
      groups={[
        {
          workspace: "cli",
          sessions: [
            { ...sessions[0], id: "external:claude:1", title: "scan logs", source: "external" },
          ],
        },
      ]}
    />,
  );
  fireEvent.doubleClick(screen.getByText("scan logs"));
  const input = (await screen.findByRole("textbox", {
    name: /session title/i,
  })) as HTMLInputElement;
  expect(input.value).toBe("scan logs");
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

test("selecting a status in the filter menu calls onStatusFilterChange", async () => {
  const onStatusFilterChange = vi.fn();
  render(
    <SessionList {...defaultProps} onStatusFilterChange={onStatusFilterChange} />,
  );
  await userEvent.click(screen.getByRole("button", { name: /filter sessions/i }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Running" }));
  expect(onStatusFilterChange).toHaveBeenCalledWith("running");
});

test("selecting a source in the filter menu calls onSourceFilterChange", async () => {
  const onSourceFilterChange = vi.fn();
  render(
    <SessionList {...defaultProps} onSourceFilterChange={onSourceFilterChange} />,
  );
  await userEvent.click(screen.getByRole("button", { name: /filter sessions/i }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "CLI history" }));
  expect(onSourceFilterChange).toHaveBeenCalledWith("external");
});

test("an active filter marks the filter button and empty state offers to clear", () => {
  const onStatusFilterChange = vi.fn();
  const onSourceFilterChange = vi.fn();
  const onSearchChange = vi.fn();
  render(
    <SessionList
      {...defaultProps}
      groups={[]}
      statusFilter="running"
      onStatusFilterChange={onStatusFilterChange}
      onSourceFilterChange={onSourceFilterChange}
      onSearchChange={onSearchChange}
    />,
  );
  // Funnel reflects the active filter via its aria-label.
  expect(
    screen.getByRole("button", { name: /filter sessions \(active\)/i }),
  ).toBeInTheDocument();
  // Empty state is the "no matches" variant, not onboarding.
  expect(screen.getByText(/no matching sessions/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
  expect(onStatusFilterChange).toHaveBeenCalledWith("all");
  expect(onSourceFilterChange).toHaveBeenCalledWith("all");
  expect(onSearchChange).toHaveBeenCalledWith("");
});

test("empty state New session button calls onNew", () => {
  const onNew = vi.fn();
  render(<SessionList {...defaultProps} groups={[]} onNew={onNew} />);
  // Header btn is "New ⌘N"; empty state btn is exactly "New session" — use exact match
  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  expect(onNew).toHaveBeenCalled();
});

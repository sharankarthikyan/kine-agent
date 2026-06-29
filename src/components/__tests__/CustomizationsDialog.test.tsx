import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomizationsDialog } from "../CustomizationsDialog";
import type { CustomizationCounts } from "../../lib/conductor";
import type { Capabilities, RuleFile } from "../../lib/inspect";
import { readTextFile } from "../../lib/inspect";

vi.mock("../../lib/inspect", () => ({
  readTextFile: vi.fn(),
}));

const counts: CustomizationCounts = {
  agents: 2,
  skills: 5,
  instructions: 1,
  hooks: 3,
  mcpServers: 4,
};

const capabilities: Capabilities = {
  skills: [
    { name: "shadcn", description: "Add shadcn components", source: "user", path: "" },
    { name: "deep-research", description: "Multi-source research", source: "project", path: "" },
  ],
  subagents: [
    { name: "code-reviewer", description: "Reviews code for bugs", source: "user", path: "" },
  ],
  commands: [],
};

// Capabilities with non-empty paths — used for detail-view tests.
const capabilitiesWithPaths: Capabilities = {
  skills: [
    { name: "shadcn", description: "Add shadcn/ui components", source: "user", path: "/home/.claude/skills/shadcn/SKILL.md" },
    { name: "deep-research", description: "Multi-source web research", source: "project", path: "" },
  ],
  subagents: [
    { name: "code-reviewer", description: "Reviews code for bugs", source: "user", path: "/home/.claude/agents/code-reviewer.md" },
    { name: "data-engineer", description: "Data pipelines", source: "project", path: "" },
  ],
  commands: [],
};

const rules: RuleFile[] = [
  { path: "/wt/CLAUDE.md", label: "CLAUDE.md", scope: "project", exists: true },
  { path: "/wt/global.md", label: "global.md", scope: "global", exists: true },
  { path: "/wt/missing.md", label: "missing.md", scope: "project", exists: false },
];

const noop = () => {};

const defaultProps = {
  open: true,
  onOpenChange: noop,
  initialSection: "overview" as const,
  counts,
  capabilities,
  rules,
  onOpenRule: noop,
  sessionId: "s1",
};

// Helper that returns the left-nav element after confirming it exists.
function getNav() {
  return screen.getByRole("navigation", { name: /customization sections/i });
}

// Radix Dialog renders into a portal (document.body). screen.* searches the full
// document, so portal content is reachable from all queries.

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readTextFile).mockResolvedValue("");
});

test("renders the dialog when open is true", () => {
  render(<CustomizationsDialog {...defaultProps} />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("does not render the dialog when open is false", () => {
  render(<CustomizationsDialog {...defaultProps} open={false} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("renders all left-nav section labels", () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  expect(within(nav).getByText("Overview")).toBeInTheDocument();
  expect(within(nav).getByText("Agents")).toBeInTheDocument();
  expect(within(nav).getByText("Skills")).toBeInTheDocument();
  expect(within(nav).getByText("Instructions")).toBeInTheDocument();
  expect(within(nav).getByText("Hooks")).toBeInTheDocument();
  expect(within(nav).getByText("MCP Servers")).toBeInTheDocument();
  expect(within(nav).getByText("Plugins")).toBeInTheDocument();
});

test("shows counts in the left nav for agents, skills, instructions, hooks, mcp", () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  // counts: agents=2, skills=5, instructions=1, hooks=3, mcpServers=4
  expect(within(nav).getByText("2")).toBeInTheDocument(); // agents
  expect(within(nav).getByText("5")).toBeInTheDocument(); // skills
  expect(within(nav).getByText("1")).toBeInTheDocument(); // instructions
  expect(within(nav).getByText("3")).toBeInTheDocument(); // hooks
  expect(within(nav).getByText("4")).toBeInTheDocument(); // MCP servers
});

test("overview is the default active section and shows overview heading", () => {
  render(<CustomizationsDialog {...defaultProps} />);
  // The overview section heading should be visible (distinct from the sr-only dialog title)
  expect(screen.getByRole("heading", { name: /^customizations$/i })).toBeInTheDocument();
});

test("overview section shows inert action stubs that are aria-disabled", () => {
  render(<CustomizationsDialog {...defaultProps} />);
  // Each overview card has a unique inert action button — test one
  const stub = screen.getByRole("button", { name: /^new agent\.\.\.$/i });
  expect(stub).toHaveAttribute("aria-disabled", "true");
  expect(stub).toHaveAttribute("tabindex", "-1");
});

test("switching to Agents section shows agent subagent list", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /agents/i }));
  expect(screen.getByText("code-reviewer")).toBeInTheDocument();
  expect(screen.getByText("Reviews code for bugs")).toBeInTheDocument();
});

test("switching to Skills section shows skills list", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /skills/i }));
  expect(screen.getByText("shadcn")).toBeInTheDocument();
  expect(screen.getByText("deep-research")).toBeInTheDocument();
});

test("switching to Instructions shows existing rule files and hides non-existent ones", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  expect(screen.getByText("CLAUDE.md")).toBeInTheDocument();
  expect(screen.getByText("global.md")).toBeInTheDocument();
  // Non-existent rule should not be rendered
  expect(screen.queryByText("missing.md")).not.toBeInTheDocument();
});

// ─── In-dialog file viewer ────────────────────────────────────────────────────

test("clicking an instruction row opens the in-dialog file viewer", async () => {
  vi.mocked(readTextFile).mockResolvedValue("# Project rules\nKeep it minimal.");
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  await userEvent.click(screen.getByText("CLAUDE.md"));
  expect(readTextFile).toHaveBeenCalledWith("s1", "/wt/CLAUDE.md");
  expect(await screen.findByRole("button", { name: /back/i })).toBeInTheDocument();
});

test("file viewer shows file content after readTextFile resolves", async () => {
  vi.mocked(readTextFile).mockResolvedValue("line one\nline two");
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  await userEvent.click(screen.getByText("CLAUDE.md"));
  // Wait for async content to appear
  expect(await screen.findByText("line one")).toBeInTheDocument();
  expect(screen.getByText("line two")).toBeInTheDocument();
});

test("back button returns from file viewer to the section list", async () => {
  vi.mocked(readTextFile).mockResolvedValue("some content");
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  await userEvent.click(screen.getByText("CLAUDE.md"));
  const backBtn = await screen.findByRole("button", { name: /back/i });
  await userEvent.click(backBtn);
  // Back to the instructions list
  expect(screen.getByText("CLAUDE.md")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /back/i })).not.toBeInTheDocument();
});

test("file viewer shows error message when readTextFile rejects", async () => {
  vi.mocked(readTextFile).mockRejectedValue(new Error("permission denied"));
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  await userEvent.click(screen.getByText("CLAUDE.md"));
  expect(await screen.findByText(/couldn't read this file/i)).toBeInTheDocument();
});

test("clicking an agent row with a path opens the file viewer", async () => {
  vi.mocked(readTextFile).mockResolvedValue("agent spec content");
  render(<CustomizationsDialog {...defaultProps} capabilities={capabilitiesWithPaths} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /agents/i }));
  await userEvent.click(screen.getByText("code-reviewer"));
  expect(readTextFile).toHaveBeenCalledWith("s1", "/home/.claude/agents/code-reviewer.md");
  expect(await screen.findByRole("button", { name: /back/i })).toBeInTheDocument();
});

test("agent row with empty path is not rendered as a button", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /agents/i }));
  // "code-reviewer" has empty path — closest <button> ancestor should not exist
  const textEl = screen.getByText("code-reviewer");
  expect(textEl.closest("button")).toBeNull();
});

test("skill row with a path opens the file viewer", async () => {
  vi.mocked(readTextFile).mockResolvedValue("skill content");
  render(<CustomizationsDialog {...defaultProps} capabilities={capabilitiesWithPaths} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /skills/i }));
  await userEvent.click(screen.getByText("shadcn"));
  expect(readTextFile).toHaveBeenCalledWith("s1", "/home/.claude/skills/shadcn/SKILL.md");
  expect(await screen.findByRole("button", { name: /back/i })).toBeInTheDocument();
});

test("switching sections resets the detail view", async () => {
  vi.mocked(readTextFile).mockResolvedValue("content");
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  await userEvent.click(screen.getByText("CLAUDE.md"));
  await screen.findByRole("button", { name: /back/i });
  // Navigate away — detail should reset
  await userEvent.click(within(nav).getByRole("button", { name: /skills/i }));
  expect(screen.queryByRole("button", { name: /back/i })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /^skills$/i })).toBeInTheDocument();
});

// ─── Per-section search ───────────────────────────────────────────────────────

test("Agents search filters by agent name", async () => {
  const manyAgents: Capabilities = {
    skills: [],
    subagents: [
      { name: "code-reviewer", description: "Reviews code", source: "user", path: "" },
      { name: "data-engineer", description: "Data pipelines", source: "project", path: "" },
    ],
    commands: [],
  };
  render(<CustomizationsDialog {...defaultProps} capabilities={manyAgents} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /agents/i }));
  const searchInput = screen.getByPlaceholderText(/type to search/i);
  await userEvent.type(searchInput, "code");
  expect(screen.getByText("code-reviewer")).toBeInTheDocument();
  expect(screen.queryByText("data-engineer")).not.toBeInTheDocument();
});

test("Agents search shows 'No matches' when filter empties the list", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /agents/i }));
  const searchInput = screen.getByPlaceholderText(/type to search/i);
  await userEvent.type(searchInput, "zzzzz");
  expect(screen.getByText("No matches")).toBeInTheDocument();
});

test("Skills search filters by skill name", async () => {
  const manySkills: Capabilities = {
    skills: [
      { name: "shadcn", description: "Add shadcn/ui", source: "user", path: "" },
      { name: "deep-research", description: "Multi-source research", source: "project", path: "" },
      { name: "code-review", description: "Review code quality", source: "user", path: "" },
    ],
    subagents: [],
    commands: [],
  };
  render(<CustomizationsDialog {...defaultProps} capabilities={manySkills} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /skills/i }));
  const searchInput = screen.getByPlaceholderText(/type to search/i);
  await userEvent.type(searchInput, "research");
  expect(screen.getByText("deep-research")).toBeInTheDocument();
  expect(screen.queryByText("shadcn")).not.toBeInTheDocument();
  expect(screen.queryByText("code-review")).not.toBeInTheDocument();
});

test("Skills search shows 'No matches' when filter empties the list", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /skills/i }));
  const searchInput = screen.getByPlaceholderText(/type to search/i);
  await userEvent.type(searchInput, "zzzzz");
  expect(screen.getByText("No matches")).toBeInTheDocument();
});

test("Instructions search filters by label", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  const searchInput = screen.getByPlaceholderText(/type to search/i);
  await userEvent.type(searchInput, "global");
  expect(screen.getByText("global.md")).toBeInTheDocument();
  expect(screen.queryByText("CLAUDE.md")).not.toBeInTheDocument();
});

test("Instructions search shows 'No matches' when filter empties the list", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  const searchInput = screen.getByPlaceholderText(/type to search/i);
  await userEvent.type(searchInput, "zzzzz");
  expect(screen.getByText("No matches")).toBeInTheDocument();
});

test("search query resets when switching sections", async () => {
  const manyAgents: Capabilities = {
    skills: [
      { name: "shadcn", description: "Add shadcn/ui", source: "user", path: "" },
      { name: "deep-research", description: "Research", source: "project", path: "" },
    ],
    subagents: [
      { name: "code-reviewer", description: "Reviews code", source: "user", path: "" },
      { name: "data-engineer", description: "Data", source: "project", path: "" },
    ],
    commands: [],
  };
  render(<CustomizationsDialog {...defaultProps} capabilities={manyAgents} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /agents/i }));
  await userEvent.type(screen.getByPlaceholderText(/type to search/i), "code");
  expect(screen.queryByText("data-engineer")).not.toBeInTheDocument();
  // Switch to Skills — search should be cleared
  await userEvent.click(within(nav).getByRole("button", { name: /skills/i }));
  expect(screen.getByText("shadcn")).toBeInTheDocument();
  expect(screen.getByText("deep-research")).toBeInTheDocument();
  // Search input should be empty
  expect(screen.getByPlaceholderText(/type to search/i)).toHaveValue("");
});

// ─── Existing tests ───────────────────────────────────────────────────────────

test("Hooks section shows count and coming-soon message", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /hooks/i }));
  // counts.hooks = 3 — check the count-label text which is unique to the content area
  expect(screen.getByText("hooks configured")).toBeInTheDocument();
  expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
});

test("MCP Servers section shows count and coming-soon message", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /mcp servers/i }));
  // counts.mcpServers = 4 — check the count-label text which is unique to the content area
  expect(screen.getByText("MCP servers configured")).toBeInTheDocument();
  expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
});

test("Plugins section shows 0 count and coming-soon message", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /plugins/i }));
  expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  expect(screen.getByText("0")).toBeInTheDocument();
});

test("empty Agents list shows 'No agents found' message", async () => {
  render(
    <CustomizationsDialog
      {...defaultProps}
      capabilities={{ skills: [], subagents: [], commands: [] }}
    />,
  );
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /agents/i }));
  expect(screen.getByText(/no agents found/i)).toBeInTheDocument();
});

test("empty Skills list shows 'No skills found' message", async () => {
  render(
    <CustomizationsDialog
      {...defaultProps}
      capabilities={{ skills: [], subagents: [], commands: [] }}
    />,
  );
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /skills/i }));
  expect(screen.getByText(/no skills found/i)).toBeInTheDocument();
});

test("empty Instructions list shows 'No instruction files found'", async () => {
  render(<CustomizationsDialog {...defaultProps} rules={[]} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  expect(screen.getByText(/no instruction files found/i)).toBeInTheDocument();
});

test("opens to initialSection when initialSection is 'agents'", () => {
  render(<CustomizationsDialog {...defaultProps} initialSection="agents" />);
  // The Agents section heading should be visible on open
  expect(screen.getByRole("heading", { name: /^agents$/i })).toBeInTheDocument();
});

test("clicking an overview card navigates to that section", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  // The agents card description is unique — use it to locate the card's nav button
  const agentsCard = screen
    .getByText("Subagents available in this session")
    .closest("button");
  expect(agentsCard).not.toBeNull();
  fireEvent.click(agentsCard!);
  expect(screen.getByRole("heading", { name: /^agents$/i })).toBeInTheDocument();
});

test("active nav row has aria-current=page", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  const skillsBtn = within(nav).getByRole("button", { name: /skills/i });
  await userEvent.click(skillsBtn);
  // Re-query after click to get the updated element
  expect(within(nav).getByRole("button", { name: /skills/i })).toHaveAttribute(
    "aria-current",
    "page"
  );
});

test("initialSection resets when open changes to true", async () => {
  const { rerender } = render(
    <CustomizationsDialog {...defaultProps} open={false} initialSection="agents" />,
  );
  rerender(
    <CustomizationsDialog {...defaultProps} open={true} initialSection="skills" />,
  );
  // After re-opening with initialSection="skills", the Skills heading should be visible
  expect(screen.getByRole("heading", { name: /^skills$/i })).toBeInTheDocument();
});

test("null capabilities renders empty state in Agents section", async () => {
  render(<CustomizationsDialog {...defaultProps} capabilities={null} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /agents/i }));
  expect(screen.getByText(/no agents found/i)).toBeInTheDocument();
});

test("scope badge is shown for instruction rules", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  // CLAUDE.md is scope=project, global.md is scope=global
  expect(screen.getByText("project")).toBeInTheDocument();
  expect(screen.getByText("global")).toBeInTheDocument();
});

test("source badge is shown for skill items", async () => {
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /skills/i }));
  // shadcn is source=user, deep-research is source=project
  expect(screen.getByText("user")).toBeInTheDocument();
  expect(screen.getByText("project")).toBeInTheDocument();
});

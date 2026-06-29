import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomizationsDialog } from "../CustomizationsDialog";
import type { CustomizationCounts } from "../../lib/conductor";
import type { Capabilities, RuleFile } from "../../lib/inspect";

const counts: CustomizationCounts = {
  agents: 2,
  skills: 5,
  instructions: 1,
  hooks: 3,
  mcpServers: 4,
};

const capabilities: Capabilities = {
  skills: [
    { name: "shadcn", description: "Add shadcn components", source: "user" },
    { name: "deep-research", description: "Multi-source research", source: "project" },
  ],
  subagents: [
    { name: "code-reviewer", description: "Reviews code for bugs", source: "user" },
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
};

// Helper that returns the left-nav element after confirming it exists.
function getNav() {
  return screen.getByRole("navigation", { name: /customization sections/i });
}

// Radix Dialog renders into a portal (document.body). screen.* searches the full
// document, so portal content is reachable from all queries.

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

test("clicking an instruction row calls onOpenRule with the rule", async () => {
  const onOpenRule = vi.fn();
  render(<CustomizationsDialog {...defaultProps} onOpenRule={onOpenRule} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  await userEvent.click(screen.getByText("CLAUDE.md"));
  expect(onOpenRule).toHaveBeenCalledWith(
    expect.objectContaining({ label: "CLAUDE.md", path: "/wt/CLAUDE.md" })
  );
});

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

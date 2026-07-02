import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomizationsDialog } from "../CustomizationsDialog";
import type { CustomizationCounts, HookEntry, McpServerEntry, PluginEntry } from "../../lib/conductor";
import type { Capabilities, RuleFile } from "../../lib/inspect";
import {
  createCustomization,
  deleteCustomization,
  readTextFile,
  writeTextFile,
} from "../../lib/inspect";
import { addHook, addMcpServer, deleteHook, deleteMcpServer } from "../../lib/conductor";
import { toast } from "sonner";

vi.mock("../../lib/inspect", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  createCustomization: vi.fn(),
  deleteCustomization: vi.fn(),
}));

vi.mock("../../lib/conductor", () => ({
  addHook: vi.fn(),
  deleteHook: vi.fn(),
  addMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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

const sampleHooks: HookEntry[] = [
  { event: "PreToolUse", matcher: null, command: "echo pre", source: "project" },
  { event: "PostToolUse", matcher: "/edit", command: "git add -A && git commit -m auto", source: "user" },
];

const sampleMcpServers: McpServerEntry[] = [
  { name: "context7", detail: "npx @context7/mcp", source: "project" },
  { name: "playwright", detail: null, source: "user" },
];

const samplePlugins: PluginEntry[] = [
  { name: "memory-plugin", detail: "claude-plugins-official", source: "user" },
  { name: "search-plugin", detail: null, source: "project" },
];

const noop = () => {};

const defaultProps = {
  open: true,
  onOpenChange: noop,
  initialSection: "overview" as const,
  counts,
  capabilities,
  rules,
  sessionId: "s1",
  hooks: [],
  mcpServers: [],
  plugins: [],
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
  vi.mocked(writeTextFile).mockResolvedValue(undefined);
  vi.mocked(createCustomization).mockResolvedValue("/wt/.claude/agents/new.md");
  vi.mocked(deleteCustomization).mockResolvedValue(undefined);
  vi.mocked(addHook).mockResolvedValue(undefined);
  vi.mocked(deleteHook).mockResolvedValue(undefined);
  vi.mocked(addMcpServer).mockResolvedValue(undefined);
  vi.mocked(deleteMcpServer).mockResolvedValue(undefined);
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
  // The overview section heading should be visible (distinct from the title-bar heading)
  expect(screen.getByRole("heading", { name: /^overview$/i })).toBeInTheDocument();
});

test("overview section shows cards for each non-overview section", () => {
  render(<CustomizationsDialog {...defaultProps} />);
  // Each non-overview section renders a navigable card — verify a few by their description text
  expect(screen.getByText("Subagents available in this session")).toBeInTheDocument();
  expect(screen.getByText("Slash commands and reusable skill scripts")).toBeInTheDocument();
  // No action stubs ("New agent…" etc.) should be rendered
  expect(screen.queryByRole("button", { name: /new agent/i })).toBeNull();
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
  // react-syntax-highlighter wraps tokens in spans; check dialog textContent
  // rather than exact element text to stay robust against DOM structure changes.
  const dialog = screen.getByRole("dialog");
  await waitFor(() => {
    expect(dialog.textContent).toContain("line one");
    expect(dialog.textContent).toContain("line two");
  });
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

// ─── File viewer edit mode ────────────────────────────────────────────────────

test("Edit button appears in file viewer header", async () => {
  vi.mocked(readTextFile).mockResolvedValue("original content");
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  await userEvent.click(screen.getByText("CLAUDE.md"));
  expect(await screen.findByRole("button", { name: /edit/i })).toBeInTheDocument();
});

test("clicking Edit switches to textarea mode with Save and Cancel buttons", async () => {
  vi.mocked(readTextFile).mockResolvedValue("original content");
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  await userEvent.click(screen.getByText("CLAUDE.md"));
  await screen.findByRole("button", { name: /edit/i });
  await userEvent.click(screen.getByRole("button", { name: /edit/i }));
  expect(screen.getByRole("textbox", { name: /file content editor/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
});

test("textarea is prefilled with current file content", async () => {
  vi.mocked(readTextFile).mockResolvedValue("hello world");
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  await userEvent.click(screen.getByText("CLAUDE.md"));
  await screen.findByRole("button", { name: /edit/i });
  await userEvent.click(screen.getByRole("button", { name: /edit/i }));
  const textarea = screen.getByRole("textbox", { name: /file content editor/i });
  expect(textarea).toHaveValue("hello world");
});

test("Save calls writeTextFile, shows toast, and returns to read view", async () => {
  vi.mocked(readTextFile).mockResolvedValue("original");
  vi.mocked(writeTextFile).mockResolvedValue(undefined);
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  await userEvent.click(screen.getByText("CLAUDE.md"));
  await screen.findByRole("button", { name: /edit/i });
  await userEvent.click(screen.getByRole("button", { name: /edit/i }));
  const textarea = screen.getByRole("textbox", { name: /file content editor/i });
  await userEvent.clear(textarea);
  await userEvent.type(textarea, "updated content");
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
  await waitFor(() => {
    expect(writeTextFile).toHaveBeenCalledWith("s1", "/wt/CLAUDE.md", "updated content");
  });
  expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Saved CLAUDE.md");
  // Returns to read view — textarea gone, Edit button back
  await waitFor(() => {
    expect(screen.queryByRole("textbox", { name: /file content editor/i })).not.toBeInTheDocument();
  });
  expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
});

test("Save error shows toast.error and stays in edit mode", async () => {
  vi.mocked(readTextFile).mockResolvedValue("original");
  vi.mocked(writeTextFile).mockRejectedValue(new Error("write denied"));
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  await userEvent.click(screen.getByText("CLAUDE.md"));
  await screen.findByRole("button", { name: /edit/i });
  await userEvent.click(screen.getByRole("button", { name: /edit/i }));
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
  await waitFor(() => {
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Error: write denied");
  });
  // Still in edit mode
  expect(screen.getByRole("textbox", { name: /file content editor/i })).toBeInTheDocument();
});

test("Cancel discards edits and returns to read view", async () => {
  vi.mocked(readTextFile).mockResolvedValue("original");
  render(<CustomizationsDialog {...defaultProps} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /instructions/i }));
  await userEvent.click(screen.getByText("CLAUDE.md"));
  await screen.findByRole("button", { name: /edit/i });
  await userEvent.click(screen.getByRole("button", { name: /edit/i }));
  const textarea = screen.getByRole("textbox", { name: /file content editor/i });
  await userEvent.type(textarea, "do not save this");
  await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
  expect(screen.queryByRole("textbox", { name: /file content editor/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
  expect(writeTextFile).not.toHaveBeenCalled();
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

// ─── Hooks section ────────────────────────────────────────────────────────────

test("Hooks section renders rows from props", async () => {
  render(<CustomizationsDialog {...defaultProps} hooks={sampleHooks} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /hooks/i }));
  expect(screen.getByText("PreToolUse")).toBeInTheDocument();
  expect(screen.getByText("echo pre")).toBeInTheDocument();
  expect(screen.getByText("PostToolUse")).toBeInTheDocument();
  expect(screen.getByText("/edit")).toBeInTheDocument();
  expect(screen.getByText("git add -A && git commit -m auto")).toBeInTheDocument();
});

test("Hooks section shows empty state when no hooks configured", async () => {
  render(<CustomizationsDialog {...defaultProps} hooks={[]} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /hooks/i }));
  expect(screen.getByText("No hooks configured.")).toBeInTheDocument();
});

test("Hooks section search filters by event name", async () => {
  render(<CustomizationsDialog {...defaultProps} hooks={sampleHooks} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /hooks/i }));
  await userEvent.type(screen.getByPlaceholderText(/type to search/i), "Pre");
  expect(screen.getByText("PreToolUse")).toBeInTheDocument();
  expect(screen.queryByText("PostToolUse")).not.toBeInTheDocument();
});

test("Hooks section search filters by command", async () => {
  render(<CustomizationsDialog {...defaultProps} hooks={sampleHooks} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /hooks/i }));
  await userEvent.type(screen.getByPlaceholderText(/type to search/i), "echo");
  expect(screen.getByText("PreToolUse")).toBeInTheDocument();
  expect(screen.queryByText("PostToolUse")).not.toBeInTheDocument();
});

test("Hooks section source badge is shown", async () => {
  render(<CustomizationsDialog {...defaultProps} hooks={sampleHooks} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /hooks/i }));
  expect(screen.getByText("project")).toBeInTheDocument();
  expect(screen.getByText("user")).toBeInTheDocument();
});

// ─── MCP Servers section ──────────────────────────────────────────────────────

test("MCP Servers section renders rows from props", async () => {
  render(<CustomizationsDialog {...defaultProps} mcpServers={sampleMcpServers} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /mcp servers/i }));
  expect(screen.getByText("context7")).toBeInTheDocument();
  expect(screen.getByText("npx @context7/mcp")).toBeInTheDocument();
  expect(screen.getByText("playwright")).toBeInTheDocument();
});

test("MCP Servers section shows empty state when no servers configured", async () => {
  render(<CustomizationsDialog {...defaultProps} mcpServers={[]} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /mcp servers/i }));
  expect(screen.getByText("No MCP servers configured.")).toBeInTheDocument();
});

test("MCP Servers search filters by server name", async () => {
  render(<CustomizationsDialog {...defaultProps} mcpServers={sampleMcpServers} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /mcp servers/i }));
  await userEvent.type(screen.getByPlaceholderText(/type to search/i), "context");
  expect(screen.getByText("context7")).toBeInTheDocument();
  expect(screen.queryByText("playwright")).not.toBeInTheDocument();
});

test("MCP Servers search filters by detail", async () => {
  render(<CustomizationsDialog {...defaultProps} mcpServers={sampleMcpServers} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /mcp servers/i }));
  await userEvent.type(screen.getByPlaceholderText(/type to search/i), "npx");
  expect(screen.getByText("context7")).toBeInTheDocument();
  expect(screen.queryByText("playwright")).not.toBeInTheDocument();
});

// ─── Plugins section ──────────────────────────────────────────────────────────

test("Plugins section renders rows from props", async () => {
  render(<CustomizationsDialog {...defaultProps} plugins={samplePlugins} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /plugins/i }));
  expect(screen.getByText("memory-plugin")).toBeInTheDocument();
  expect(screen.getByText("claude-plugins-official")).toBeInTheDocument();
  expect(screen.getByText("search-plugin")).toBeInTheDocument();
});

test("Plugins section shows empty state when no plugins installed", async () => {
  render(<CustomizationsDialog {...defaultProps} plugins={[]} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /plugins/i }));
  expect(screen.getByText("No plugins installed.")).toBeInTheDocument();
});

test("Plugins section search filters by name", async () => {
  render(<CustomizationsDialog {...defaultProps} plugins={samplePlugins} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /plugins/i }));
  await userEvent.type(screen.getByPlaceholderText(/type to search/i), "memory");
  expect(screen.getByText("memory-plugin")).toBeInTheDocument();
  expect(screen.queryByText("search-plugin")).not.toBeInTheDocument();
});

test("Plugins nav count shows plugins.length", () => {
  render(<CustomizationsDialog {...defaultProps} plugins={samplePlugins} />);
  const nav = getNav();
  // samplePlugins has 2 entries — nav should show "2" for plugins
  const pluginsBtn = within(nav).getByRole("button", { name: /plugins/i });
  expect(pluginsBtn.textContent).toContain("2");
});

test("Plugins nav count shows 0 when no plugins", () => {
  render(<CustomizationsDialog {...defaultProps} plugins={[]} />);
  const nav = getNav();
  const pluginsBtn = within(nav).getByRole("button", { name: /plugins/i });
  expect(pluginsBtn.textContent).toContain("0");
});

// ─── Existing general tests ───────────────────────────────────────────────────

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

// ─── CRUD: capabilities (agents/skills) ────────────────────────────────────────

const capsWithPaths = {
  skills: [
    { name: "shadcn", description: "Add shadcn", source: "user" as const, path: "/home/.claude/skills/shadcn/SKILL.md" },
  ],
  subagents: [
    { name: "code-reviewer", description: "Reviews code", source: "user" as const, path: "/home/.claude/agents/code-reviewer.md" },
  ],
  commands: [],
};

test("Add in Agents section scaffolds a capability then opens it in the editor", async () => {
  vi.mocked(createCustomization).mockResolvedValue("/wt/.claude/agents/triage.md");
  vi.mocked(readTextFile).mockResolvedValue("---\nname: triage\n---\n");
  const onChanged = vi.fn();
  render(<CustomizationsDialog {...defaultProps} capabilities={capsWithPaths} onChanged={onChanged} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /agents/i }));

  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  await userEvent.type(screen.getByPlaceholderText(/new agent name/i), "triage");
  // Scope has no default — a session-active Create stays disabled until one is picked.
  expect(screen.getByRole("button", { name: /^create$/i })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: /^project$/i }));
  await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

  await waitFor(() =>
    expect(createCustomization).toHaveBeenCalledWith("s1", "agent", "triage"),
  );
  expect(onChanged).toHaveBeenCalled();
  // Drops into the editor on the created file.
  await waitFor(() => expect(readTextFile).toHaveBeenCalledWith("s1", "/wt/.claude/agents/triage.md"));
});

test("Add uses global scope (null session) when the Global toggle is chosen", async () => {
  vi.mocked(createCustomization).mockResolvedValue("/home/.claude/skills/x/SKILL.md");
  render(<CustomizationsDialog {...defaultProps} capabilities={capsWithPaths} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /skills/i }));

  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  await userEvent.type(screen.getByPlaceholderText(/new skill name/i), "x");
  await userEvent.click(screen.getByRole("button", { name: /^global$/i }));
  await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

  await waitFor(() => expect(createCustomization).toHaveBeenCalledWith(null, "skill", "x"));
});

test("deleting a capability confirms, calls deleteCustomization, and refreshes", async () => {
  const onChanged = vi.fn();
  render(<CustomizationsDialog {...defaultProps} capabilities={capsWithPaths} onChanged={onChanged} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /agents/i }));

  await userEvent.click(screen.getByRole("button", { name: /delete code-reviewer/i }));
  // Two-step confirm.
  await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

  await waitFor(() =>
    expect(deleteCustomization).toHaveBeenCalledWith("s1", "/home/.claude/agents/code-reviewer.md"),
  );
  expect(onChanged).toHaveBeenCalled();
});

// ─── CRUD: editing works in global scope (null session) ─────────────────────────

test("Edit is offered for a global (null-session) file and Save targets null scope", async () => {
  vi.mocked(readTextFile).mockResolvedValue("body");
  render(<CustomizationsDialog {...defaultProps} sessionId={null} capabilities={capsWithPaths} />);
  const nav = getNav();
  await userEvent.click(within(nav).getByRole("button", { name: /agents/i }));
  await userEvent.click(screen.getByText("code-reviewer"));

  await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

  await waitFor(() =>
    expect(writeTextFile).toHaveBeenCalledWith(null, "/home/.claude/agents/code-reviewer.md", "body"),
  );
});

// ─── CRUD: hooks ────────────────────────────────────────────────────────────────

test("Add hook opens a panel, constrains the event, and submits", async () => {
  const onChanged = vi.fn();
  render(<CustomizationsDialog {...defaultProps} initialSection="hooks" onChanged={onChanged} />);

  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  // Event is a constrained dropdown, not free text.
  await userEvent.selectOptions(screen.getByRole("combobox", { name: /hook event/i }), "PreToolUse");
  // A tool event reveals a tool-matcher input (blank = all tools).
  await userEvent.type(screen.getByPlaceholderText(/all tools/i), "Bash");
  await userEvent.type(screen.getByPlaceholderText(/npm run lint/i), "echo hi");
  await userEvent.click(screen.getByRole("button", { name: /^project$/i }));
  await userEvent.click(screen.getByRole("button", { name: /add hook/i }));

  await waitFor(() => expect(addHook).toHaveBeenCalledWith("s1", "PreToolUse", "Bash", "echo hi"));
  expect(onChanged).toHaveBeenCalled();
});

test("hook matcher input is hidden for events that ignore it", async () => {
  render(<CustomizationsDialog {...defaultProps} initialSection="hooks" />);
  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  // Stop has no matcher — no matcher control should render.
  await userEvent.selectOptions(screen.getByRole("combobox", { name: /hook event/i }), "Stop");
  expect(screen.queryByPlaceholderText(/all tools/i)).toBeNull();
  expect(screen.queryByRole("combobox", { name: /hook matcher/i })).toBeNull();
});

test("deleting a hook passes its source and identifying fields", async () => {
  render(<CustomizationsDialog {...defaultProps} initialSection="hooks" hooks={sampleHooks} />);

  await userEvent.click(screen.getByRole("button", { name: /delete PostToolUse hook/i }));
  await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

  await waitFor(() =>
    expect(deleteHook).toHaveBeenCalledWith(
      "s1",
      "user",
      "PostToolUse",
      "/edit",
      "git add -A && git commit -m auto",
    ),
  );
});

// ─── CRUD: MCP servers ──────────────────────────────────────────────────────────

test("Add MCP server (stdio) splits args on whitespace and refreshes", async () => {
  const onChanged = vi.fn();
  render(<CustomizationsDialog {...defaultProps} initialSection="mcp" onChanged={onChanged} />);

  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  await userEvent.type(screen.getByPlaceholderText(/e\.g\. context7/i), "ctx");
  await userEvent.type(screen.getByPlaceholderText(/e\.g\. npx/i), "npx");
  await userEvent.type(screen.getByPlaceholderText(/@context7\/mcp/i), "-y @context7/mcp");
  await userEvent.click(screen.getByRole("button", { name: /^project$/i }));
  await userEvent.click(screen.getByRole("button", { name: /add server/i }));

  await waitFor(() =>
    expect(addMcpServer).toHaveBeenCalledWith("s1", "ctx", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@context7/mcp"],
    }),
  );
  expect(onChanged).toHaveBeenCalled();
});

test("Add MCP server (remote http) submits a url transport", async () => {
  render(<CustomizationsDialog {...defaultProps} initialSection="mcp" />);

  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  await userEvent.type(screen.getByPlaceholderText(/e\.g\. context7/i), "remote");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: /mcp transport/i }), "http");
  await userEvent.type(screen.getByPlaceholderText(/https/i), "https://example.com/mcp");
  await userEvent.click(screen.getByRole("button", { name: /^project$/i }));
  await userEvent.click(screen.getByRole("button", { name: /add server/i }));

  await waitFor(() =>
    expect(addMcpServer).toHaveBeenCalledWith("s1", "remote", {
      transport: "http",
      url: "https://example.com/mcp",
    }),
  );
});

test("deleting an MCP server passes its source and name", async () => {
  render(<CustomizationsDialog {...defaultProps} initialSection="mcp" mcpServers={sampleMcpServers} />);

  await userEvent.click(screen.getByRole("button", { name: /delete playwright/i }));
  await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

  await waitFor(() => expect(deleteMcpServer).toHaveBeenCalledWith("s1", "user", "playwright"));
});

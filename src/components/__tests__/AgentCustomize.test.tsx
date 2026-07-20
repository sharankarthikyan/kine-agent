import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentCustomize } from "../AgentCustomize";
import { emptyAgentConfig, readAgentConfigs, writeAgentConfigs } from "../../lib/agentConfig";

const CLAUDE_MODELS = [
  { value: "opus", label: "Claude Opus", agent: "claude", description: null, disabled: false, contextWindow: 200000 },
  { value: "sonnet", label: "Claude Sonnet", agent: "claude", description: null, disabled: false, contextWindow: 200000 },
  { value: "haiku", label: "Claude Haiku", agent: "claude", description: null, disabled: false, contextWindow: 200000 },
];

// Module-scoped switches the tests flip.
let authStatus: { agent: string; supportsApiKey: boolean; mode: string; hasKey: boolean } = {
  agent: "claude",
  supportsApiKey: true,
  mode: "subscription",
  hasKey: false,
};
let providerResult: unknown[] | { error: string } = [];

const invoke = vi.fn(async (cmd: string, args?: unknown) => {
  if (cmd === "list_models") return CLAUDE_MODELS;
  if (cmd === "agent_auth_status") {
    return { ...authStatus, agent: (args as { agent?: string } | undefined)?.agent };
  }
  if (cmd === "list_provider_models") {
    if (!Array.isArray(providerResult)) throw providerResult.error;
    return providerResult;
  }
  throw new Error(`unexpected command ${cmd}`);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));

afterEach(() => {
  window.localStorage.clear();
  invoke.mockClear();
  authStatus = { agent: "claude", supportsApiKey: true, mode: "subscription", hasKey: false };
  providerResult = [];
});

test("collapsed by default; expanding reveals the color swatches", async () => {
  render(<AgentCustomize agentId="claude" />);
  expect(screen.queryByText("Icon color")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  expect(screen.getByText("Icon color")).toBeInTheDocument();
});

test("selecting a swatch persists the token", async () => {
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  await userEvent.click(screen.getByRole("radio", { name: "rose" }));
  expect(readAgentConfigs().claude?.color).toBe("rose");
});

test("the Default swatch clears the token", async () => {
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  await userEvent.click(screen.getByRole("radio", { name: "rose" }));
  await userEvent.click(screen.getByRole("radio", { name: "Default" }));
  expect(readAgentConfigs().claude?.color).toBeNull();
});

test("ArrowRight moves the roving tab stop and selects the next swatch, wrapping", async () => {
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  await userEvent.click(screen.getByRole("radio", { name: "rose" }));

  expect(screen.getAllByRole("radio").filter((r) => r.tabIndex === 0)).toHaveLength(1);

  screen.getByRole("radio", { name: "rose" }).focus();
  await userEvent.keyboard("{ArrowRight}");

  expect(readAgentConfigs().claude?.color).toBe("emerald");
  const emerald = screen.getByRole("radio", { name: "emerald" });
  expect(emerald).toHaveAttribute("aria-checked", "true");
  expect(emerald).toHaveFocus();
  expect(emerald.tabIndex).toBe(0);
  const tabbableRadios = screen.getAllByRole("radio").filter((r) => r.tabIndex === 0);
  expect(tabbableRadios).toHaveLength(1);
  expect(tabbableRadios[0]).toBe(emerald);
});

test("renders discovered models with visibility toggles", async () => {
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  // "Claude Opus" also appears as a <select> option (the Default model
  // picker), so scope to the curation list to disambiguate.
  const list = await screen.findByRole("list");
  expect(within(list).getByText("Claude Opus")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Hide Claude Sonnet" })).toBeInTheDocument();
});

test("hiding a model persists and flips the row to muted/Show", async () => {
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  await userEvent.click(await screen.findByRole("button", { name: "Hide Claude Haiku" }));
  expect(readAgentConfigs().claude?.hiddenModels).toEqual(["haiku"]);
  expect(screen.getByRole("button", { name: "Show Claude Haiku" })).toBeInTheDocument();
});

test("hiding the configured default clears it back to Auto", async () => {
  writeAgentConfigs({ claude: { ...emptyAgentConfig(), defaultModel: "opus" } });
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  await userEvent.click(await screen.findByRole("button", { name: "Hide Claude Opus" }));
  expect(readAgentConfigs().claude?.defaultModel).toBeNull();
});

test("move-down persists the full visible order", async () => {
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  await userEvent.click(await screen.findByRole("button", { name: "Move Claude Opus down" }));
  expect(readAgentConfigs().claude?.modelOrder).toEqual(["sonnet", "opus", "haiku"]);
});

test("adding a custom model appends it with a custom badge and remove button", async () => {
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  await screen.findByRole("list");
  await userEvent.type(screen.getByPlaceholderText("model id (e.g. claude-opus-4-8)"), "claude-opus-4-6");
  await userEvent.click(screen.getByRole("button", { name: "Add model" }));
  expect(readAgentConfigs().claude?.customModels).toEqual([{ value: "claude-opus-4-6", label: null }]);
  expect(screen.getByText("custom")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove claude-opus-4-6" })).toBeInTheDocument();
});

// NOTE: this project's `ui/select.tsx` is a styled native <select> (not Radix —
// there is no @radix-ui/react-select dependency in this repo), so the
// interaction follows the project's established convention for it
// (userEvent.selectOptions against a combobox role), matching
// CustomizationsDialog.test.tsx rather than a Radix open/click-option flow.
test("default model select persists a choice and offers Auto", async () => {
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  await screen.findByRole("list");
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "Default model" }),
    "Claude Sonnet",
  );
  expect(readAgentConfigs().claude?.defaultModel).toBe("sonnet");
});

test("browse button hidden in subscription mode", async () => {
  authStatus = { agent: "claude", supportsApiKey: true, mode: "subscription", hasKey: false };
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  // "Claude Opus" text is ambiguous (also renders as a <select> option — see
  // the note on "renders discovered models" above); wait on the list instead.
  await screen.findByRole("list");
  expect(screen.queryByRole("button", { name: "Browse provider models" })).not.toBeInTheDocument();
});

test("browse fetches and adds a provider model as custom", async () => {
  authStatus = { agent: "claude", supportsApiKey: true, mode: "apikey", hasKey: true };
  providerResult = [
    { value: "claude-opus-4-8", label: "Claude Opus 4.8", agent: "claude", description: "claude-opus-4-8", disabled: false, contextWindow: null },
  ];
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  await userEvent.click(await screen.findByRole("button", { name: "Browse provider models" }));
  await userEvent.click(await screen.findByRole("button", { name: "Add claude-opus-4-8" }));
  expect(readAgentConfigs().claude?.customModels).toEqual([
    { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
  ]);
});

test("already-present values show a disabled Added button", async () => {
  authStatus = { agent: "claude", supportsApiKey: true, mode: "apikey", hasKey: true };
  providerResult = [
    { value: "opus", label: "Claude Opus", agent: "claude", description: null, disabled: false, contextWindow: null },
  ];
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  await userEvent.click(await screen.findByRole("button", { name: "Browse provider models" }));
  expect(await screen.findByRole("button", { name: "Added" })).toBeDisabled();
});

test("fetch errors render inline with mapped copy", async () => {
  authStatus = { agent: "claude", supportsApiKey: true, mode: "apikey", hasKey: true };
  providerResult = { error: "bad-key" };
  render(<AgentCustomize agentId="claude" />);
  await userEvent.click(screen.getByRole("button", { name: "Customize" }));
  await userEvent.click(await screen.findByRole("button", { name: "Browse provider models" }));
  expect(
    await screen.findByText("The stored API key was rejected by the provider."),
  ).toBeInTheDocument();
});

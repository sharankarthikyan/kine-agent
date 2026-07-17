import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsDialog } from "../SettingsDialog";
import type { AgentInfo } from "../../lib/models";
import type { AgentPrefs } from "../../lib/agentPrefs";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => Promise.resolve("0.1.3")),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// A stateful fake backend: agent_auth_status reflects the keys stored / mode set by the
// other commands, so the UI's optimistic reload sees real transitions.
type Rec = { supportsApiKey: boolean; mode: "subscription" | "apikey"; hasKey: boolean };
const state: Record<string, Rec> = {};
const calls: Array<{ cmd: string; args: unknown }> = [];

const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  calls.push({ cmd, args });
  const agent = args.agent as string;
  const rec = state[agent];
  switch (cmd) {
    case "agent_auth_status":
      return { agent, ...rec };
    case "set_agent_api_key":
      rec.hasKey = true;
      rec.mode = "apikey";
      return undefined;
    case "clear_agent_api_key":
      rec.hasKey = false;
      rec.mode = "subscription";
      return undefined;
    case "set_agent_auth_mode":
      rec.mode = args.mode as "subscription" | "apikey";
      return undefined;
    default:
      return undefined;
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a: never) => invoke(c, a) }));

const AGENTS: AgentInfo[] = [
  { id: "codex", label: "OpenAI Codex", installed: true },
  { id: "claude", label: "Claude Code", installed: true },
  { id: "antigravity", label: "Antigravity", installed: true },
];

// Codex + Antigravity enabled so both auth controls render; Claude off.
const PREFS: AgentPrefs = {
  enabled: { codex: true, antigravity: true },
  acknowledged: { antigravity: true },
};

// All three enabled + acknowledged, for cases that need Claude's control rendered.
const ALL_ON: AgentPrefs = {
  enabled: { codex: true, claude: true, antigravity: true },
  acknowledged: { claude: true, antigravity: true },
};

function setup(prefs: AgentPrefs = PREFS) {
  render(
    <SettingsDialog
      open
      onOpenChange={vi.fn()}
      agents={AGENTS}
      prefs={prefs}
      onPrefsChange={vi.fn()}
    />,
  );
}

beforeEach(() => {
  invoke.mockClear();
  calls.length = 0;
  state.codex = { supportsApiKey: true, mode: "subscription", hasKey: false };
  state.claude = { supportsApiKey: true, mode: "subscription", hasKey: false };
  state.antigravity = { supportsApiKey: false, mode: "subscription", hasKey: false };
});

test("a key-capable agent shows the subscription/API-key toggle", async () => {
  setup();
  const codexRow = (await screen.findByText("OpenAI Codex")).closest("div.rounded-lg")!;
  await waitFor(() =>
    expect(within(codexRow as HTMLElement).getByRole("radio", { name: /API key/i })).toBeInTheDocument(),
  );
  expect(
    within(codexRow as HTMLElement).getByRole("radio", { name: /Subscription login/i }),
  ).toBeInTheDocument();
});

test("Antigravity states it is subscription-only with no key field", async () => {
  setup();
  await screen.findByText("Antigravity");
  expect(await screen.findByText(/no API-key option/i)).toBeInTheDocument();
  // No key toggle for an agent that can't take one.
  const antigravityRow = screen.getByText("Antigravity").closest("div.rounded-lg")!;
  expect(
    within(antigravityRow as HTMLElement).queryByRole("radio", { name: /API key/i }),
  ).not.toBeInTheDocument();
});

test("Claude shows the ToS warning on the subscription tab, hidden in API-key mode", async () => {
  setup(ALL_ON);
  const claudeRow = (await screen.findByText("Claude Code")).closest("div.rounded-lg")! as HTMLElement;
  await waitFor(() => within(claudeRow).getByRole("radio", { name: /Subscription login/i }));
  // Subscription is the default selection → the Anthropic-terms warning is visible.
  expect(within(claudeRow).getByText(/Anthropic's Consumer Terms/i)).toBeInTheDocument();

  // Switching to API key (a key is stored below) removes the subscription warning.
  state.claude.hasKey = true;
  await userEvent.click(within(claudeRow).getByRole("radio", { name: /API key/i }));
  await waitFor(() =>
    expect(within(claudeRow).queryByText(/Anthropic's Consumer Terms/i)).not.toBeInTheDocument(),
  );
});

test("saving an API key persists it and flips the row to compliant", async () => {
  setup();
  const codexRow = (await screen.findByText("OpenAI Codex")).closest("div.rounded-lg")! as HTMLElement;
  await waitFor(() =>
    within(codexRow).getByRole("radio", { name: /API key/i }),
  );
  await userEvent.click(within(codexRow).getByRole("radio", { name: /API key/i }));
  await userEvent.type(within(codexRow).getByPlaceholderText(/Paste your API key/i), "sk-test-123");
  await userEvent.click(within(codexRow).getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(calls.some((c) => c.cmd === "set_agent_api_key")).toBe(true),
  );
  // The saved key is sent write-only via the command; it never round-trips back.
  const saveCall = calls.find((c) => c.cmd === "set_agent_api_key")!;
  expect(saveCall.args).toMatchObject({ agent: "codex", key: "sk-test-123" });
  // After reload the header reflects API-key mode.
  expect(await within(codexRow).findByText(/Authenticating with your API key/i)).toBeInTheDocument();
});

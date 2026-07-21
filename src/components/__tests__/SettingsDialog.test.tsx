import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsDialog } from "../SettingsDialog";
import type { AgentInfo } from "../../lib/models";
import type { AgentPrefs } from "../../lib/agentPrefs";
import { openUrl } from "@tauri-apps/plugin-opener";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => Promise.resolve("0.1.2")),
}));

const AGENTS: AgentInfo[] = [
  { id: "codex", label: "OpenAI Codex", installed: true },
  { id: "claude", label: "Claude Code", installed: true },
  { id: "antigravity", label: "Antigravity", installed: false },
];

// Ships-default posture: only Codex enabled, nothing acknowledged yet.
const CODEX_ONLY: AgentPrefs = { enabled: { codex: true }, acknowledged: {} };

function setup(overrides: Partial<React.ComponentProps<typeof SettingsDialog>> = {}) {
  const onPrefsChange = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <SettingsDialog
      open
      onOpenChange={onOpenChange}
      agents={AGENTS}
      prefs={CODEX_ONLY}
      onPrefsChange={onPrefsChange}
      {...overrides}
    />,
  );
  return { onPrefsChange, onOpenChange };
}

test("Codex ships enabled; Claude ships disabled", () => {
  setup();
  expect(screen.getByRole("switch", { name: /Disable OpenAI Codex/i })).toBeChecked();
  expect(screen.getByRole("switch", { name: /Enable Claude Code/i })).not.toBeChecked();
});

test("a not-installed agent shows an Install link to its official docs", async () => {
  setup();
  // Antigravity isn't installed → no switch, an Install action instead.
  expect(screen.queryByRole("switch", { name: /Antigravity/i })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Install/i }));
  expect(openUrl).toHaveBeenCalledWith("https://antigravity.google/docs/cli-install");
});

test("enabling Claude opens an inline acknowledgement before it takes effect", async () => {
  const { onPrefsChange } = setup();
  await userEvent.click(screen.getByRole("switch", { name: /Enable Claude Code/i }));
  // Consent shown, but nothing committed yet.
  expect(screen.getByText(/Before you enable Claude Code/i)).toBeInTheDocument();
  expect(onPrefsChange).not.toHaveBeenCalled();
});

test("confirming the acknowledgement enables Claude and records the ack", async () => {
  const { onPrefsChange } = setup();
  await userEvent.click(screen.getByRole("switch", { name: /Enable Claude Code/i }));
  await userEvent.click(screen.getByRole("button", { name: /I understand/i }));
  expect(onPrefsChange).toHaveBeenCalledTimes(1);
  const next = onPrefsChange.mock.calls[0][0] as AgentPrefs;
  expect(next.enabled.claude).toBe(true);
  expect(next.acknowledged.claude).toBe(true);
});

test("cancelling the acknowledgement leaves Claude disabled", async () => {
  const { onPrefsChange } = setup();
  await userEvent.click(screen.getByRole("switch", { name: /Enable Claude Code/i }));
  await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
  expect(onPrefsChange).not.toHaveBeenCalled();
  expect(screen.getByRole("switch", { name: /Enable Claude Code/i })).not.toBeChecked();
});

test("an already-acknowledged agent enables without re-prompting", async () => {
  const acked: AgentPrefs = {
    enabled: { codex: true, claude: false },
    acknowledged: { claude: true },
  };
  const { onPrefsChange } = setup({ prefs: acked });
  await userEvent.click(screen.getByRole("switch", { name: /Enable Claude Code/i }));
  expect(screen.queryByText(/Before you enable Claude Code/i)).not.toBeInTheDocument();
  expect(onPrefsChange).toHaveBeenCalledWith(
    expect.objectContaining({ enabled: expect.objectContaining({ claude: true }) }),
  );
});

test("disabling Codex is immediate and needs no acknowledgement", async () => {
  const { onPrefsChange } = setup();
  await userEvent.click(screen.getByRole("switch", { name: /Disable OpenAI Codex/i }));
  expect(onPrefsChange).toHaveBeenCalledTimes(1);
  const next = onPrefsChange.mock.calls[0][0] as AgentPrefs;
  expect(next.enabled.codex).toBe(false);
});

test("the About section carries the non-affiliation disclaimer and local-data disclosure", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "About" }));
  expect(
    screen.getByText(/not affiliated with, sponsored by, or endorsed by/i),
  ).toBeInTheDocument();
  expect(screen.getByText(/no telemetry, analytics, or accounts/i)).toBeInTheDocument();
});

test("the About section shows the app version", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "About" }));
  expect(await screen.findByText(/Kine Agent v0\.1\.2/i)).toBeInTheDocument();
});

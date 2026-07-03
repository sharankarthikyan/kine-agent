import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextPanel } from "../ContextPanel";

const base = {
  usage: null,
  files: [],
  rules: [],
  capabilities: null,
  model: null,
  onOpenRule: () => {},
};

test("explains usage availability when no usage has arrived", () => {
  render(<ContextPanel {...base} />);
  expect(screen.getByText(/usage appears after the agent finishes a turn/i)).toBeInTheDocument();
});

test("renders context usage with window pressure, output, cache, and cost", () => {
  render(
    <ContextPanel
      {...base}
      usage={{
        inputTokens: 50000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.12,
        model: "opus",
        contextUsed: null,
        contextWindow: null,
      }}
      usageSummary={{
        latest: {
          inputTokens: 50000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.12,
          model: "opus",
          contextUsed: null,
          contextWindow: null,
        },
        totals: {
          inputTokens: 50000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.12,
          model: "opus",
          contextUsed: null,
          contextWindow: null,
        },
        eventCount: 10,
      }}
      model={{
        value: "opus",
        label: "Claude Opus",
        agent: "claude",
        description: null,
        disabled: false,
        contextWindow: 200000,
      }}
      sessionTurnCount={4}
    />,
  );
  expect(screen.getByRole("progressbar")).toBeInTheDocument();
  expect(screen.getByText("10 usage samples")).toBeInTheDocument();
  expect(screen.getByText("Conversation turns")).toBeInTheDocument();
  expect(screen.getByText("4")).toBeInTheDocument();
  expect(screen.getByText(/\$0\.12/)).toBeInTheDocument();
  expect(screen.getByText(/25% of window/i)).toBeInTheDocument();
  expect(screen.getByText(/50,000 \/ 200,000|50000 \/ 200000/)).toBeInTheDocument();
  expect(screen.getByText("Generated output")).toBeInTheDocument();
  expect(screen.getAllByText(/1,000|1000/).length).toBeGreaterThan(0);
  expect(screen.getByText("Cache read")).toBeInTheDocument();
});

test("states Antigravity telemetry limits instead of showing fake usage", () => {
  render(<ContextPanel {...base} agent="antigravity" />);
  expect(screen.getByText(/antigravity does not emit token usage/i)).toBeInTheDocument();
  expect(screen.queryByText("Session output")).not.toBeInTheDocument();
});

test("renders real session settings", () => {
  render(
    <ContextPanel
      {...base}
      agent="codex"
      permissionMode="acceptEdits"
      sandboxTerminal
      model={{
        value: "gpt-5.5",
        label: "GPT-5.5",
        agent: "codex",
        description: "gpt-5.5",
        disabled: false,
        contextWindow: 272000,
      }}
    />,
  );
  expect(screen.getByText("codex")).toBeInTheDocument();
  expect(screen.getByText("GPT-5.5")).toBeInTheDocument();
  expect(screen.getByText("Auto-edit")).toBeInTheDocument();
  expect(screen.getByText("On")).toBeInTheDocument();
});

// ── Model picker ───────────────────────────────────────────────────────────────
// The ACP adapter forwards the pick via session/set_config_option, so the
// Settings row shows the picked model — no more "CLI default" pinning.

test("ACP sessions show the picked model in Settings — the pick is forwarded", () => {
  render(
    <ContextPanel
      {...base}
      agent="claude"
      model={{
        value: "opus",
        label: "Claude Opus",
        agent: "claude",
        description: null,
        disabled: false,
        contextWindow: 200000,
      }}
    />,
  );
  expect(screen.getByText("Claude Opus")).toBeInTheDocument();
  expect(screen.queryByText("CLI default")).not.toBeInTheDocument();
});

test("context meter uses the reported window over the model's", () => {
  render(
    <ContextPanel
      {...base}
      agent="codex"
      model={{
        value: "gpt-5.5",
        label: "GPT-5.5",
        agent: "codex",
        description: null,
        disabled: false,
        contextWindow: 272000,
      }}
      usage={{
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: null,
        model: null,
        contextUsed: 9500,
        contextWindow: 128000,
      }}
    />,
  );
  // 9500 / 128000 (reported) = 7%, not 9500 / 272000 (model) = 3%
  expect(screen.getByText("7% of window")).toBeInTheDocument();
});

test("token breakdown rows hide when the agent reports no split (context-only usage)", () => {
  render(
    <ContextPanel
      {...base}
      agent="codex"
      usage={{
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: null,
        model: null,
        contextUsed: 9500,
        contextWindow: 272000,
      }}
    />,
  );
  expect(screen.queryByText("Generated output")).not.toBeInTheDocument();
  expect(screen.queryByText("Cache read")).not.toBeInTheDocument();
});

test("renders estimated context source footprint", () => {
  render(
    <ContextPanel
      {...base}
      contextFootprint={{
        totalTokens: 70,
        items: [
          { id: "rules", label: "Rules & config", tokens: 40, detail: "1 files" },
          { id: "tools", label: "Tool calls", tokens: 30, detail: "Observed tool arguments" },
        ],
      }}
    />,
  );
  expect(screen.getByText("Estimated footprint")).toBeInTheDocument();
  expect(screen.getAllByText("Rules & config").length).toBeGreaterThan(0);
  expect(screen.getByText("Tool calls")).toBeInTheDocument();
  expect(screen.getByText("70")).toBeInTheDocument();
});

test("shows changed files up front and collapses reads behind a toggle", async () => {
  render(
    <ContextPanel
      {...base}
      files={[
        { path: "src/a.ts", action: "edited" },
        { path: "src/b.ts", action: "read" },
      ]}
    />,
  );
  // Changed file is visible immediately; read file is collapsed.
  expect(screen.getByText("src/a.ts")).toBeInTheDocument();
  expect(screen.queryByText("src/b.ts")).not.toBeInTheDocument();
  // Expanding the reads toggle reveals the read file.
  await userEvent.click(screen.getByText(/show 1 read file/i));
  expect(screen.getByText("src/b.ts")).toBeInTheDocument();
});

test("shows 'No files yet' when no files", () => {
  render(<ContextPanel {...base} />);
  expect(screen.getByText(/no files yet/i)).toBeInTheDocument();
});

test("lists existing rules and calls onOpenRule on click", async () => {
  const onOpenRule = vi.fn();
  render(
    <ContextPanel
      {...base}
      rules={[
        { path: "/wt/CLAUDE.md", label: "CLAUDE.md", scope: "project", exists: true },
        { path: "/wt/AGENTS.md", label: "AGENTS.md", scope: "project", exists: false },
      ]}
      onOpenRule={onOpenRule}
    />,
  );
  expect(screen.getByText("CLAUDE.md")).toBeInTheDocument();
  expect(screen.queryByText("AGENTS.md")).not.toBeInTheDocument(); // non-existent hidden
  await userEvent.click(screen.getByText("CLAUDE.md"));
  expect(onOpenRule).toHaveBeenCalled();
});

test("does not duplicate available capability inventory in the context panel", () => {
  render(
    <ContextPanel
      {...base}
      capabilities={{
        skills: [{ name: "shadcn", description: "ui", source: "user", path: "" }],
        subagents: [],
        commands: [],
      }}
    />,
  );
  expect(screen.queryByText("shadcn")).not.toBeInTheDocument();
  expect(screen.queryByText(/no capabilities found/i)).not.toBeInTheDocument();
});

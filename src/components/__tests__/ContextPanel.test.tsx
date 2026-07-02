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
      }}
      usageSummary={{
        latest: {
          inputTokens: 50000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.12,
          model: "opus",
        },
        totals: {
          inputTokens: 50000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.12,
          model: "opus",
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

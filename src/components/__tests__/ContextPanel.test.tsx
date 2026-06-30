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

test("shows 'Usage unavailable' when no usage", () => {
  render(<ContextPanel {...base} />);
  expect(screen.getByText(/usage unavailable/i)).toBeInTheDocument();
});

test("renders window usage with total tokens, progress, and cost", () => {
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
  expect(screen.getByRole("progressbar")).toBeInTheDocument();
  expect(screen.getByText(/\$0\.12/)).toBeInTheDocument();
  expect(screen.getByText(/51,000|51000/)).toBeInTheDocument(); // total tokens
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

test("renders capability names", () => {
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
  expect(screen.getByText("shadcn")).toBeInTheDocument();
});

test("shows 'No capabilities found' when capabilities present but all empty", () => {
  render(
    <ContextPanel {...base} capabilities={{ skills: [], subagents: [], commands: [] }} />,
  );
  expect(screen.getByText(/no capabilities found/i)).toBeInTheDocument();
});

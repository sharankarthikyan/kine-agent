import { render, screen, cleanup, act } from "@testing-library/react";
import { AgentLogo } from "../AgentLogo";
import { emptyAgentConfig, writeAgentConfigs } from "../../lib/agentConfig";

afterEach(() => {
  cleanup();
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.clear();
  }
});

test("uses the built-in tint when no color configured", () => {
  render(<AgentLogo agent="claude" />);
  expect(screen.getByLabelText("Claude Code")).toHaveClass("text-amber-500");
});

test("configured color token overrides the built-in tint", () => {
  act(() => {
    writeAgentConfigs({ claude: { ...emptyAgentConfig(), color: "rose" } });
  });
  render(<AgentLogo agent="claude" />);
  expect(screen.getByLabelText("Claude Code")).toHaveClass("text-rose-500");
});

test("unknown agent with no config falls back to muted", () => {
  render(<AgentLogo agent="mystery" />);
  expect(screen.getByLabelText("mystery")).toHaveClass("text-muted-foreground");
});

test("an unknown stored token falls back to the built-in tint", () => {
  act(() => {
    writeAgentConfigs({ claude: { ...emptyAgentConfig(), color: "nope" } });
  });
  render(<AgentLogo agent="claude" />);
  expect(screen.getByLabelText("Claude Code")).toHaveClass("text-amber-500");
});

test("re-renders when the config changes", () => {
  render(<AgentLogo agent="codex" />);
  expect(screen.getByLabelText("OpenAI Codex")).toHaveClass("text-teal-500");
  act(() => {
    writeAgentConfigs({ codex: { ...emptyAgentConfig(), color: "indigo" } });
  });
  expect(screen.getByLabelText("OpenAI Codex")).toHaveClass("text-indigo-500");
});

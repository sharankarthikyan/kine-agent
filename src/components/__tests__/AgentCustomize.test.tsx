import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentCustomize } from "../AgentCustomize";
import { readAgentConfigs } from "../../lib/agentConfig";

const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
  if (cmd === "list_models") return [];
  throw new Error(`unexpected command ${cmd}`);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));

afterEach(() => {
  window.localStorage.clear();
  invoke.mockClear();
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

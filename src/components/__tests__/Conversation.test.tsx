import { render, screen } from "@testing-library/react";
import { Conversation } from "../Conversation";
import type { AgentEvent } from "../../lib/agent";

test("shows the empty state when there is no prompt, no events, and not running", () => {
  render(<Conversation prompt={null} events={[]} running={false} />);
  expect(screen.getByText("No activity yet.")).toBeInTheDocument();
});

test("renders the user prompt as a 'You' turn", () => {
  render(<Conversation prompt="refactor auth" events={[]} running={false} />);
  expect(screen.getByText("You")).toBeInTheDocument();
  expect(screen.getByText("refactor auth")).toBeInTheDocument();
});

test("renders agent events under an 'Agent' turn", () => {
  const events: AgentEvent[] = [{ kind: "token", data: { text: "working on it" } }];
  render(<Conversation prompt="do x" events={events} running={false} />);
  expect(screen.getByText("Agent")).toBeInTheDocument();
  expect(screen.getByText("working on it")).toBeInTheDocument();
});

test("shows the running indicator while the agent is working", () => {
  render(<Conversation prompt="do x" events={[]} running={true} />);
  expect(screen.getByRole("status")).toHaveTextContent(/working/i);
});

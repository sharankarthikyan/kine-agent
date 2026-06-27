import { render, screen } from "@testing-library/react";
import { EventStream } from "../EventStream";
import type { AgentEvent } from "../../lib/agent";

test("shows empty state when no events", () => {
  render(<EventStream events={[]} />);
  expect(screen.getByText("No activity yet.")).toBeInTheDocument();
});

test("renders a token event's text", () => {
  const events: AgentEvent[] = [{ kind: "token", data: { text: "Hello" } }];
  render(<EventStream events={events} />);
  expect(screen.getByText("Hello")).toBeInTheDocument();
});

test("renders a tool call with its name", () => {
  const events: AgentEvent[] = [{ kind: "toolCall", data: { name: "Write", input: "{}" } }];
  render(<EventStream events={events} />);
  expect(screen.getByText(/Write/)).toBeInTheDocument();
});

test("renders an error event with alert role", () => {
  const events: AgentEvent[] = [{ kind: "error", data: { message: "boom" } }];
  render(<EventStream events={events} />);
  expect(screen.getByRole("alert")).toHaveTextContent("boom");
});

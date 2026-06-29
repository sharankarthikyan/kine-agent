import { render, screen } from "@testing-library/react";
import { Conversation, type Turn } from "../Conversation";

test("empty state when there are no turns and not running", () => {
  render(<Conversation turns={[]} running={false} />);
  expect(screen.getByText("No activity yet.")).toBeInTheDocument();
});

test("renders multiple turns with their prompts and events", () => {
  const turns: Turn[] = [
    { prompt: "first task", events: [{ kind: "done", data: { summary: "did first" } }] },
    { prompt: "second task", events: [{ kind: "token", data: { text: "working second" } }] },
  ];
  render(<Conversation turns={turns} running={false} />);
  expect(screen.getByText("first task")).toBeInTheDocument();
  expect(screen.getByText(/did first/)).toBeInTheDocument();
  expect(screen.getByText("second task")).toBeInTheDocument();
  expect(screen.getByText("working second")).toBeInTheDocument();
  expect(screen.getAllByText("You")).toHaveLength(2);
});

test("shows the running indicator while working", () => {
  const turns: Turn[] = [{ prompt: "x", events: [] }];
  render(<Conversation turns={turns} running={true} />);
  expect(screen.getByRole("status")).toHaveTextContent(/working/i);
});

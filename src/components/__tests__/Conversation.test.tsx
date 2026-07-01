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

test("does not render an empty user bubble for event-only turns", () => {
  const turns: Turn[] = [
    { prompt: "", events: [{ kind: "status", data: { text: "Compacted" } }] },
  ];
  render(<Conversation turns={turns} running={false} />);
  expect(screen.getByText("Compacted")).toBeInTheDocument();
  expect(screen.queryByText("You")).not.toBeInTheDocument();
});

test("shows the running indicator while working", () => {
  const turns: Turn[] = [{ prompt: "x", events: [] }];
  render(<Conversation turns={turns} running={true} />);
  expect(screen.getByRole("status")).toHaveTextContent(/starting agent/i);
  expect(screen.getByRole("status")).toHaveTextContent(/waiting for the first response/i);
});

test("running indicator summarizes latest activity", () => {
  const turns: Turn[] = [
    {
      prompt: "x",
      events: [
        {
          kind: "toolCall",
          data: { name: "Bash", input: '{"command":"npm test"}' },
        },
      ],
    },
  ];
  render(<Conversation turns={turns} running={true} />);
  expect(screen.getByRole("status")).toHaveTextContent(/running bash/i);
  expect(screen.getByRole("status")).toHaveTextContent(/npm test/i);
  expect(screen.getByRole("status")).toHaveTextContent(/1 tool/i);
});

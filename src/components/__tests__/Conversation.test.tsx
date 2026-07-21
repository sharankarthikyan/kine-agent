import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  // status events no longer render in the transcript, so the turn's visible
  // content is a durable notice instead.
  const turns: Turn[] = [
    { prompt: "", events: [{ kind: "notice", data: { message: "Compacted" } }] },
  ];
  render(<Conversation turns={turns} running={false} />);
  expect(screen.getByText("Compacted")).toBeInTheDocument();
  expect(screen.queryByText("You")).not.toBeInTheDocument();
});

test("agent header stays hidden while a turn holds only render-null events", () => {
  // An ACP turn's first event is often `commands` (autocomplete feed, renders
  // nothing) — the "Agent" header must not appear above empty space.
  const turns: Turn[] = [
    {
      prompt: "hi",
      events: [
        { kind: "commands", data: { commandsJson: '[{"name":"web","description":""}]' } },
        { kind: "usage", data: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, model: null } },
      ],
    },
  ];
  render(<Conversation turns={turns} running={true} />);
  expect(screen.queryByText("Agent")).not.toBeInTheDocument();
});

test("agent header appears once a renderable event lands", () => {
  const turns: Turn[] = [
    {
      prompt: "hi",
      events: [
        { kind: "commands", data: { commandsJson: "[]" } },
        { kind: "token", data: { text: "Hello" } },
      ],
    },
  ];
  render(<Conversation turns={turns} running={false} />);
  expect(screen.getByText("Agent")).toBeInTheDocument();
  expect(screen.getByText("Hello")).toBeInTheDocument();
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

test("does not force-scroll while the user is reading older output", async () => {
  const scrollIntoView = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;

  const initialTurns: Turn[] = [
    { prompt: "x", events: [{ kind: "token", data: { text: "first" } }] },
  ];
  const { rerender } = render(
    <div data-testid="scroller" style={{ overflowY: "auto", height: 100 }}>
      <Conversation turns={initialTurns} running />
    </div>,
  );
  const scroller = screen.getByTestId("scroller");
  Object.defineProperties(scroller, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 100, configurable: true },
    scrollTop: { value: 100, configurable: true, writable: true },
  });

  scrollIntoView.mockClear();
  fireEvent.scroll(scroller);
  expect(await screen.findByRole("button", { name: /latest/i })).toBeInTheDocument();

  rerender(
    <div data-testid="scroller" style={{ overflowY: "auto", height: 100 }}>
      <Conversation
        turns={[
          {
            prompt: "x",
            events: [
              { kind: "token", data: { text: "first" } },
              { kind: "token", data: { text: " second" } },
            ],
          },
        ]}
        running
      />
    </div>,
  );
  expect(scrollIntoView).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: /latest/i }));
  expect(scrollIntoView).toHaveBeenCalled();
  HTMLElement.prototype.scrollIntoView = original;
});

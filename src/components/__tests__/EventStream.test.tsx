import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventStream } from "../EventStream";
import type { AgentEvent } from "../../lib/agent";

const APPROVAL: AgentEvent = {
  kind: "approvalNeeded",
  data: { requestId: "req-1", tool: "Bash", input: '{"command":"rm -rf build"}', prompt: "Run rm -rf build?" },
};

test("shows empty state when no events", () => {
  render(<EventStream events={[]} />);
  expect(screen.getByText("No activity yet.")).toBeInTheDocument();
});

test("renders a token event's text", () => {
  const events: AgentEvent[] = [{ kind: "token", data: { text: "Hello" } }];
  render(<EventStream events={events} />);
  expect(screen.getByText("Hello")).toBeInTheDocument();
});

test("coalesces consecutive token chunks into one prose block", () => {
  const events: AgentEvent[] = [
    { kind: "token", data: { text: "Hello" } },
    { kind: "token", data: { text: " " } },
    { kind: "token", data: { text: "world" } },
  ];
  render(<EventStream events={events} />);
  expect(screen.getByText("Hello world")).toBeInTheDocument();
  expect(screen.queryByText("Hello")).not.toBeInTheDocument();
});

test("renders a transcript status event as inline text", () => {
  const events: AgentEvent[] = [{ kind: "status", data: { text: "Compacted" } }];
  render(<EventStream events={events} />);
  expect(screen.getByText("Compacted")).toBeInTheDocument();
});

test("renders agent token text as Markdown (bold, code)", () => {
  const events: AgentEvent[] = [
    { kind: "token", data: { text: "Use **bold** and `code` here" } },
  ];
  render(<EventStream events={events} />);
  // **bold** → <strong>, `code` → <code>
  const strong = screen.getByText("bold");
  expect(strong.tagName).toBe("STRONG");
  const code = screen.getByText("code");
  expect(code.tagName).toBe("CODE");
});

test("renders a tool call with its name", () => {
  const events: AgentEvent[] = [{ kind: "toolCall", data: { name: "Write", input: "{}" } }];
  render(<EventStream events={events} />);
  expect(screen.getByText(/Write/)).toBeInTheDocument();
});

test("upgrades a tool chip via toolStatus: spinner while running, check when done", () => {
  const events = [
    { kind: "toolCall", data: { name: "Read", input: "{}", toolCallId: "t1" } },
    { kind: "toolStatus", data: { toolCallId: "t1", status: "in_progress", detail: "" } },
  ] as AgentEvent[];
  const { rerender } = render(<EventStream events={events} />);
  expect(screen.getByTestId("tool-status-t1")).toHaveAttribute("data-status", "in_progress");
  rerender(
    <EventStream
      events={[
        ...events,
        { kind: "toolStatus", data: { toolCallId: "t1", status: "completed", detail: "" } } as AgentEvent,
      ]}
    />,
  );
  // Last status wins.
  expect(screen.getByTestId("tool-status-t1")).toHaveAttribute("data-status", "completed");
  // toolStatus events render no row of their own.
  expect(screen.queryByText("in_progress")).not.toBeInTheDocument();
});

test("tool chips without an id render as today (pipe engine unaffected)", () => {
  const events = [
    { kind: "toolCall", data: { name: "Write", input: "{}" } },
  ] as AgentEvent[];
  render(<EventStream events={events} />);
  expect(screen.getByText("Write")).toBeInTheDocument();
});

test("renders only the LATEST plan event as a checklist card", () => {
  const events = [
    {
      kind: "plan",
      data: { entriesJson: JSON.stringify([{ content: "OLD ENTRY", status: "pending", priority: "medium" }]) },
    },
    {
      kind: "plan",
      data: {
        entriesJson: JSON.stringify([
          { content: "Read the file", status: "completed", priority: "medium" },
          { content: "Edit it", status: "in_progress", priority: "high" },
        ]),
      },
    },
  ] as AgentEvent[];
  render(<EventStream events={events} />);
  expect(screen.queryByText("OLD ENTRY")).not.toBeInTheDocument(); // in-place update
  expect(screen.getByText("Read the file")).toBeInTheDocument();
  expect(screen.getByText("Edit it")).toBeInTheDocument();
});

test("malformed plan entriesJson renders nothing, not a crash", () => {
  const events = [
    { kind: "plan", data: { entriesJson: "{not json" } },
  ] as AgentEvent[];
  const { container } = render(<EventStream events={events} />);
  expect(container.textContent).not.toContain("not json");
});

test("renders an error event with alert role", () => {
  const events: AgentEvent[] = [{ kind: "error", data: { message: "boom" } }];
  render(<EventStream events={events} />);
  expect(screen.getByRole("alert")).toHaveTextContent("boom");
});

test("renders a done event with its summary", () => {
  const events: AgentEvent[] = [{ kind: "done", data: { summary: "all set" } }];
  render(<EventStream events={events} />);
  expect(screen.getByText(/all set/)).toBeInTheDocument();
});

test("renders an approvalNeeded event with its prompt", () => {
  render(<EventStream events={[APPROVAL]} />);
  expect(screen.getByText(/Run rm -rf build\?/)).toBeInTheDocument();
});

test("shows a read-only notice (no buttons) when no answer handler is wired", () => {
  render(<EventStream events={[APPROVAL]} />);
  expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
});

test("Approve calls onApprovalRespond with the request id and true", async () => {
  const onApprovalRespond = vi.fn();
  render(<EventStream events={[APPROVAL]} onApprovalRespond={onApprovalRespond} />);
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(onApprovalRespond).toHaveBeenCalledWith("req-1", true);
});

test("Deny calls onApprovalRespond with the request id and false", async () => {
  const onApprovalRespond = vi.fn();
  render(<EventStream events={[APPROVAL]} onApprovalRespond={onApprovalRespond} />);
  await userEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(onApprovalRespond).toHaveBeenCalledWith("req-1", false);
});

test("renders nothing for an unknown event kind (forward compatibility)", () => {
  // A newer backend may persist kinds this frontend build doesn't know yet.
  const unknown = { kind: "sparkles_v9", data: { text: "pondering" } } as unknown as AgentEvent;
  const { container } = render(<EventStream events={[unknown]} />);
  expect(container.textContent).not.toContain("pondering");
  // Must not throw "Objects are not valid as a React child".
});

test("coalesces consecutive thought chunks into one collapsed Thinking block", () => {
  const events = [
    { kind: "thought", data: { text: "step one " } },
    { kind: "thought", data: { text: "step two" } },
    { kind: "token", data: { text: "answer" } },
  ] as AgentEvent[];
  render(<EventStream events={events} />);
  // One collapsed disclosure, not two.
  expect(screen.getAllByText("Thinking…")).toHaveLength(1);
  // Collapsed by default: thought text hidden until expanded.
  const details = screen.getByText("Thinking…").closest("details");
  expect(details).not.toHaveAttribute("open");
  expect(screen.getByText(/step one step two/)).toBeInTheDocument(); // present in DOM (native details)
  expect(screen.getByText("answer")).toBeInTheDocument();
});

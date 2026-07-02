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
  // A newer backend may persist kinds this frontend build doesn't know (e.g. "plan").
  const unknown = { kind: "plan", data: { text: "pondering" } } as unknown as AgentEvent;
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

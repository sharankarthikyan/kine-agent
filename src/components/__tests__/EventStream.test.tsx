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

test("never renders status events in the transcript — RunningIndicator owns live progress", () => {
  const events: AgentEvent[] = [
    { kind: "status", data: { text: "Launching ACP adapter" } },
    { kind: "status", data: { text: "Connecting to ACP agent" } },
    { kind: "token", data: { text: "Hi there" } },
    { kind: "status", data: { text: "Compacted" } },
  ];
  render(<EventStream events={events} />);
  expect(screen.queryByText("Launching ACP adapter")).not.toBeInTheDocument();
  expect(screen.queryByText("Connecting to ACP agent")).not.toBeInTheDocument();
  expect(screen.queryByText("Compacted")).not.toBeInTheDocument();
  expect(screen.getByText("Hi there")).toBeInTheDocument();
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

test("opens compact details for non-file tool chips", async () => {
  const events = [
    {
      kind: "toolCall",
      data: {
        name: "Bash",
        input: '{"command":"npm test -- --run EventStream.test.tsx"}',
        toolCallId: "call-1",
      },
    },
    { kind: "toolStatus", data: { toolCallId: "call-1", status: "completed", detail: "" } },
  ] as AgentEvent[];
  render(<EventStream events={events} />);
  const chip = screen.getByRole("button", { name: /Bash/ });
  expect(chip).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(chip);
  expect(chip).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("done")).toBeInTheDocument();
  expect(screen.getByText(/"command": "npm test/)).toBeInTheDocument();
});

test("tool chip summaries hide internal call ids and normalize mcp names", () => {
  const events = [
    {
      kind: "toolCall",
      data: {
        name: "mcp__mem0__search_memory",
        input: '{"call_id":"call_9KNnG4","query":"kine-agent context"}',
      },
    },
  ] as AgentEvent[];
  render(<EventStream events={events} />);
  expect(screen.getByText(/mem0\/search_memory/)).toBeInTheDocument();
  expect(screen.getByText(/kine-agent context/)).toBeInTheDocument();
  expect(screen.queryByText(/call_9KNnG4/)).not.toBeInTheDocument();
});

test("file write chips display a compact filename but open the full path", async () => {
  const onOpenFile = vi.fn();
  const events = [
    {
      kind: "fileWrite",
      data: { path: "/Users/me/KineAgent/worktrees/abc/docs/M6-SMOKE.md" },
    },
  ] as AgentEvent[];
  render(<EventStream events={events} onOpenFile={onOpenFile} />);
  expect(screen.getByText("M6-SMOKE.md")).toBeInTheDocument();
  expect(screen.queryByText(/KineAgent\/worktrees/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /M6-SMOKE.md/ }));
  expect(onOpenFile).toHaveBeenCalledWith("/Users/me/KineAgent/worktrees/abc/docs/M6-SMOKE.md");
});

test("edit tool details render an inline diff instead of raw json when available", async () => {
  const onOpenFile = vi.fn();
  const path = "/Users/me/KineAgent/worktrees/48b590f9/docs/M6-SMOKE.md";
  const events = [
    {
      kind: "toolCall",
      data: {
        name: `Edit ${path}`,
        input: JSON.stringify({
          auto_approved: false,
          call_id: "call_J4VIOMzVo0yK0t92Ysw1pcVG",
          changes: {
            [path]: {
              move_path: null,
              type: "update",
              unified_diff: "@@ -1 +1,2 @@\n codex over acp\n+resume works\n",
            },
          },
        }),
        toolCallId: "edit-1",
      },
    },
    { kind: "toolStatus", data: { toolCallId: "edit-1", status: "completed", detail: "" } },
  ] as AgentEvent[];

  render(<EventStream events={events} onOpenFile={onOpenFile} />);
  await userEvent.click(screen.getByRole("button", { name: /Edit/ }));

  expect(onOpenFile).not.toHaveBeenCalled();
  expect(screen.getByText("Approval required")).toBeInTheDocument();
  expect(screen.getAllByText("docs/M6-SMOKE.md").length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText("resume works")).toBeInTheDocument();
  expect(screen.queryByText(/auto_approved/)).not.toBeInTheDocument();
  expect(screen.queryByText(/call_J4VIOMz/)).not.toBeInTheDocument();
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

test("commands events render nothing in the transcript", () => {
  const events = [
    { kind: "commands", data: { commandsJson: JSON.stringify([{ name: "web", description: "" }]) } },
  ] as AgentEvent[];
  const { container } = render(<EventStream events={events} />);
  expect(container.textContent).not.toContain("web");
});

test("renders an error event with alert role", () => {
  const events: AgentEvent[] = [{ kind: "error", data: { message: "boom" } }];
  render(<EventStream events={events} />);
  expect(screen.getByRole("alert")).toHaveTextContent("boom");
});

test("renders authRequired as a compact sign-in action", () => {
  const events: AgentEvent[] = [
    {
      kind: "authRequired",
      data: {
        agent: "codex",
        command: "codex login",
        message: "Sign in to Codex CLI in a terminal, then retry this message.",
      },
    },
  ];
  render(<EventStream events={events} />);
  expect(screen.getByText("Sign in required")).toBeInTheDocument();
  expect(screen.getByText("Run in terminal")).toBeInTheDocument();
  expect(screen.getByText("codex login")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy codex sign-in command" })).toBeInTheDocument();
});

test("copying an auth command gives visible feedback", async () => {
  const events: AgentEvent[] = [
    {
      kind: "authRequired",
      data: {
        agent: "codex",
        command: "codex login",
        message: "Sign in to Codex CLI in a terminal, then retry this message.",
      },
    },
  ];
  render(<EventStream events={events} />);
  await userEvent.click(screen.getByRole("button", { name: "Copy codex sign-in command" }));
  expect(screen.getByText("Copied")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copied codex sign-in command" })).toBeInTheDocument();
});

test("renders Antigravity auth as an access-code login flow", async () => {
  const onOpenAuthLogin = vi.fn();
  const events: AgentEvent[] = [
    {
      kind: "authRequired",
      data: {
        agent: "antigravity",
        command: "agy --prompt-interactive \"Sign in to Antigravity\"",
        message:
          "Antigravity is not signed in. Kine Agent can open the real CLI login prompt, but the browser access code must be pasted into Antigravity's terminal prompt.",
      },
    },
  ];
  render(<EventStream events={events} onOpenAuthLogin={onOpenAuthLogin} />);
  expect(screen.getByText("Antigravity login needed")).toBeInTheDocument();
  expect(screen.getByText("Manual terminal command")).toBeInTheDocument();
  expect(screen.getByText("agy --prompt-interactive \"Sign in to Antigravity\"")).toBeInTheDocument();
  expect(screen.getByText(/Choose a login method/)).toBeInTheDocument();
  expect(screen.getByText(/Kine Agent does not accept the code in chat/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Open login terminal" }));
  expect(onOpenAuthLogin).toHaveBeenCalledWith("antigravity");
  expect(screen.getByRole("button", { name: "Copy antigravity sign-in command" })).toBeInTheDocument();
});

test("renders a done event with its summary", () => {
  const events: AgentEvent[] = [{ kind: "done", data: { summary: "all set" } }];
  render(<EventStream events={events} />);
  expect(screen.getByText(/all set/)).toBeInTheDocument();
});

test("renders an approvalNeeded event with its prompt", () => {
  render(<EventStream events={[APPROVAL]} />);
  expect(screen.getByText(/Run rm -rf build\?/)).toBeInTheDocument();
  expect(screen.getByText("Approval needed")).toBeInTheDocument();
});

test("shows a read-only notice (no buttons) when no answer handler is wired", () => {
  render(<EventStream events={[APPROVAL]} />);
  expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
});

test("Allow calls onApprovalRespond with the request id and 'allow'", async () => {
  const onApprovalRespond = vi.fn();
  render(<EventStream events={[APPROVAL]} onApprovalRespond={onApprovalRespond} />);
  await userEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(onApprovalRespond).toHaveBeenCalledWith("req-1", "allow");
});

test("Deny calls onApprovalRespond with the request id and 'deny'", async () => {
  const onApprovalRespond = vi.fn();
  render(<EventStream events={[APPROVAL]} onApprovalRespond={onApprovalRespond} />);
  await userEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(onApprovalRespond).toHaveBeenCalledWith("req-1", "deny");
});

test("renders one button per agent-supplied option and passes the chosen id", async () => {
  const onApprovalRespond = vi.fn();
  const event = {
    kind: "approvalNeeded",
    data: {
      requestId: "req-9",
      tool: "Edit",
      input: "{}",
      prompt: "Edit main.rs?",
      options: [
        { id: "opt-once", label: "Allow once", kind: "allow_once" },
        { id: "opt-always", label: "Allow always", kind: "allow_always" },
        { id: "opt-no", label: "Reject", kind: "reject_once" },
      ],
    },
  } as AgentEvent;
  render(<EventStream events={[event]} onApprovalRespond={onApprovalRespond} />);
  await userEvent.click(screen.getByRole("button", { name: "Allow always" }));
  expect(onApprovalRespond).toHaveBeenCalledWith("req-9", "opt-always");
  expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
});

test("an answered approval renders the chosen option instead of buttons", () => {
  const events = [
    APPROVAL, // requestId "req-1", no options → legacy allow/deny pair
    { kind: "approvalResolved", data: { requestId: "req-1", selectedOptionId: "allow" } },
  ] as AgentEvent[];
  render(<EventStream events={events} onApprovalRespond={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
  expect(screen.getByText("Allow")).toBeInTheDocument(); // answered label, not a button
});

test("an unanswered approval keeps its buttons", () => {
  render(<EventStream events={[APPROVAL]} onApprovalRespond={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
});

test("an answered approval with agent-supplied options shows the matching option's label", () => {
  const event = {
    kind: "approvalNeeded",
    data: {
      requestId: "req-9",
      tool: "Edit",
      input: "{}",
      prompt: "Edit main.rs?",
      options: [
        { id: "opt-once", label: "Allow once", kind: "allow_once" },
        { id: "opt-always", label: "Allow always", kind: "allow_always" },
        { id: "opt-no", label: "Reject", kind: "reject_once" },
      ],
    },
  } as AgentEvent;
  const resolved = {
    kind: "approvalResolved",
    data: { requestId: "req-9", selectedOptionId: "opt-always" },
  } as AgentEvent;
  render(<EventStream events={[event, resolved]} onApprovalRespond={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Allow always" })).not.toBeInTheDocument();
  expect(screen.getByText("Allow always")).toBeInTheDocument();
});

test("approvalResolved events render nothing themselves", () => {
  const events = [
    { kind: "approvalResolved", data: { requestId: "req-1", selectedOptionId: "allow" } },
  ] as AgentEvent[];
  const { container } = render(<EventStream events={events} />);
  expect(container.textContent).not.toContain("allow");
});

test("renders nothing for an unknown event kind (forward compatibility)", () => {
  // A newer backend may persist kinds this frontend build doesn't know yet.
  const unknown = { kind: "sparkles_v9", data: { text: "pondering" } } as unknown as AgentEvent;
  const { container } = render(<EventStream events={[unknown]} />);
  expect(container.textContent).not.toContain("pondering");
  // Must not throw "Objects are not valid as a React child".
});

test("renders a notice event as a muted inline note", () => {
  const events: AgentEvent[] = [
    { kind: "notice", data: { message: "Native resume unavailable — context replayed." } },
  ];
  render(<EventStream events={events} />);
  expect(screen.getByText("Native resume unavailable — context replayed.")).toBeInTheDocument();
});

test("terminal events never render their own rows", () => {
  render(
    <EventStream
      events={[
        { kind: "token", data: { text: "before " } },
        { kind: "toolCall", data: { name: "Bash", input: "{\"command\":\"ls\"}", toolCallId: "t1" } },
        { kind: "token", data: { text: "af" } },
        { kind: "terminalOutput", data: { toolCallId: "t1", data: "<img src=x onerror=alert(1)>\n" } },
        { kind: "token", data: { text: "ter" } },
        { kind: "terminalExit", data: { toolCallId: "t1", exitCode: 0, signal: null } },
      ]}
    />,
  );
  // Chip renders; the raw terminal events do not appear as standalone rows.
  expect(screen.getByText("Bash")).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
  // Discriminating assertion: "af" and "ter" only coalesce into one prose block
  // if both terminal events are excluded from `visible` before grouping — if the
  // filter were absent, the terminal event between them would split the token
  // run into two separate prose groups ("af", "ter") and this text would never
  // appear as one node.
  expect(screen.getByText("after")).toBeInTheDocument();
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

test("running terminal chip shows a live tail beneath the chip row", () => {
  render(
    <EventStream
      events={[
        { kind: "toolCall", data: { name: "Bash", input: '{"command":"make build"}', toolCallId: "t1" } },
        { kind: "toolStatus", data: { toolCallId: "t1", status: "in_progress", detail: "" } },
        { kind: "terminalOutput", data: { toolCallId: "t1", data: "compiling...\n" } },
      ]}
    />,
  );
  expect(screen.getByText(/compiling/)).toBeInTheDocument();
});

test("completed terminal chip hides the live tail; ToolDetails shows full output on click", async () => {
  render(
    <EventStream
      events={[
        { kind: "toolCall", data: { name: "Bash", input: '{"command":"ls"}', toolCallId: "t1" } },
        { kind: "terminalOutput", data: { toolCallId: "t1", data: "file-a\nfile-b\n" } },
        { kind: "terminalExit", data: { toolCallId: "t1", exitCode: 0, signal: null } },
        { kind: "toolStatus", data: { toolCallId: "t1", status: "completed", detail: "" } },
      ]}
    />,
  );
  expect(screen.queryByText(/file-a/)).toBeNull();
  await userEvent.click(screen.getByText("Bash"));
  expect(screen.getByText(/file-a/)).toBeInTheDocument();
  expect(screen.getByText(/exit 0/)).toBeInTheDocument();
});

test("empty rawInput block is suppressed when the details panel shows a terminal", async () => {
  render(
    <EventStream
      events={[
        { kind: "toolCall", data: { name: "Bash", input: "{}", toolCallId: "t1" } },
        { kind: "terminalOutput", data: { toolCallId: "t1", data: "hello\n" } },
        { kind: "terminalExit", data: { toolCallId: "t1", exitCode: 0, signal: null } },
        { kind: "toolStatus", data: { toolCallId: "t1", status: "completed", detail: "" } },
      ]}
    />,
  );
  await userEvent.click(screen.getByText("Bash"));
  expect(screen.getByText(/hello/)).toBeInTheDocument();
  // The terminal IS the tool's output — an empty "{}" input block under it is noise.
  expect(screen.queryByText("{}")).toBeNull();
});

test("terminal chunks concatenate in arrival order", async () => {
  render(
    <EventStream
      events={[
        { kind: "toolCall", data: { name: "Bash", input: '{"command":"seq"}', toolCallId: "t1" } },
        { kind: "terminalOutput", data: { toolCallId: "t1", data: "one " } },
        { kind: "terminalOutput", data: { toolCallId: "t1", data: "two" } },
        { kind: "terminalExit", data: { toolCallId: "t1", exitCode: 0, signal: null } },
        { kind: "toolStatus", data: { toolCallId: "t1", status: "completed", detail: "" } },
      ]}
    />,
  );
  await userEvent.click(screen.getByText("Bash"));
  expect(screen.getByText(/one two/)).toBeInTheDocument();
});

import { render, screen, fireEvent } from "@testing-library/react";
import { SessionList } from "../SessionList";
import type { SessionSummary } from "../../lib/sessions";

const sessions: SessionSummary[] = [
  { id: "a", agent: "claude", repo: "/r", branch: "agent/a", title: "add auth", status: "idle", createdAt: 1, updatedAt: 3 },
  { id: "b", agent: "claude", repo: "/r", branch: "agent/b", title: "fix bug", status: "running", createdAt: 2, updatedAt: 4 },
];

test("renders each session's title", () => {
  render(<SessionList sessions={sessions} activeId={null} onSelect={() => {}} onNew={() => {}} />);
  expect(screen.getByText("add auth")).toBeInTheDocument();
  expect(screen.getByText("fix bug")).toBeInTheDocument();
});

test("calls onSelect with the session id when a row is clicked", () => {
  const onSelect = vi.fn();
  render(<SessionList sessions={sessions} activeId={null} onSelect={onSelect} onNew={() => {}} />);
  fireEvent.click(screen.getByText("add auth"));
  expect(onSelect).toHaveBeenCalledWith("a");
});

test("calls onNew when the New session control is clicked", () => {
  const onNew = vi.fn();
  render(<SessionList sessions={sessions} activeId={null} onSelect={() => {}} onNew={onNew} />);
  fireEvent.click(screen.getByRole("button", { name: /new session/i }));
  expect(onNew).toHaveBeenCalled();
});

test("marks the active session row", () => {
  render(<SessionList sessions={sessions} activeId="b" onSelect={() => {}} onNew={() => {}} />);
  const active = screen.getByText("fix bug").closest("[aria-current]");
  expect(active).toHaveAttribute("aria-current", "true");
});

test("shows an empty hint when there are no sessions", () => {
  render(<SessionList sessions={[]} activeId={null} onSelect={() => {}} onNew={() => {}} />);
  expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument();
});

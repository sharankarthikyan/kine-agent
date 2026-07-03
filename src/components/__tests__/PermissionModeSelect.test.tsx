import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { PermissionModeSelect } from "@/components/PermissionModeSelect";

async function openFullAccessConfirm() {
  render(<PermissionModeSelect value="default" onChange={vi.fn()} agent="codex" />);
  await userEvent.click(screen.getByRole("button"));           // open the mode dropdown
  await userEvent.click(await screen.findByText("Full access")); // advanced item → confirm dialog
}

test("full-access confirm carries the honest isolation disclosure", async () => {
  await openFullAccessConfirm();
  expect(
    await screen.findByText(/does not sandbox what the agent's own process can access/),
  ).toBeInTheDocument();
});

test("full-access confirm never claims worktree containment", async () => {
  await openFullAccessConfirm();
  expect(screen.queryByText(/runs only inside this session's isolated worktree/)).toBeNull();
});

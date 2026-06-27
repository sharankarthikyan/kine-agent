import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptBar } from "../PromptBar";

test("calls onStart with the typed prompt", async () => {
  const onStart = vi.fn();
  render(<PromptBar onStart={onStart} running={false} />);
  await userEvent.type(screen.getByPlaceholderText("Ask the agent to do something…"), "fix the bug");
  await userEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(onStart).toHaveBeenCalledWith("fix the bug");
});

test("disables the button while running", () => {
  render(<PromptBar onStart={vi.fn()} running={true} />);
  expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
});

test("does not call onStart when prompt is empty", async () => {
  const onStart = vi.fn();
  render(<PromptBar onStart={onStart} running={false} />);
  await userEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(onStart).not.toHaveBeenCalled();
});

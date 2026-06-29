import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptBar } from "../PromptBar";

const PLACEHOLDER = "Message the agent…";

test("calls onStart with the typed prompt", async () => {
  const onStart = vi.fn();
  render(<PromptBar onStart={onStart} running={false} />);
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "fix the bug");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onStart).toHaveBeenCalledWith("fix the bug");
});

test("disables the Send button while running", () => {
  render(<PromptBar onStart={vi.fn()} running={true} />);
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("does not call onStart when prompt is empty", async () => {
  const onStart = vi.fn();
  render(<PromptBar onStart={onStart} running={false} />);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onStart).not.toHaveBeenCalled();
});

test("submits on Enter key in the input", async () => {
  const onStart = vi.fn();
  render(<PromptBar onStart={onStart} running={false} />);
  await userEvent.type(screen.getByPlaceholderText(PLACEHOLDER), "ship it{enter}");
  expect(onStart).toHaveBeenCalledWith("ship it");
});

test("clears the composer after sending", async () => {
  render(<PromptBar onStart={vi.fn()} running={false} />);
  const input = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
  await userEvent.type(input, "do the thing{enter}");
  expect(input.value).toBe("");
});

test("disabled Send is visually inert (reduced opacity)", () => {
  render(<PromptBar onStart={vi.fn()} running={false} />);
  const btn = screen.getByRole("button", { name: "Send" });
  expect(btn).toBeDisabled();
  expect(btn.style.opacity).toBe("0.45");
});

import { render, screen } from "@testing-library/react";
import { Markdown } from "../Markdown";

test("renders GFM tables", () => {
  render(<Markdown>{`| A | B |\n| --- | --- |\n| 1 | 2 |`}</Markdown>);
  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "1" })).toBeInTheDocument();
});

test("wraps wide tables in a horizontal-scroll container so they don't clip", () => {
  const { container } = render(<Markdown>{`| A | B |\n| --- | --- |\n| 1 | 2 |`}</Markdown>);
  const table = container.querySelector("table");
  expect(table?.parentElement).toHaveClass("md-table-wrap");
});

test("still renders ordinary prose", () => {
  render(<Markdown>{`Hello **world**`}</Markdown>);
  expect(screen.getByText("world").tagName).toBe("STRONG");
});

test("strips ANSI escapes from agent prose (codex echoes raw \\x1b bytes)", () => {
  render(<Markdown>{"tick \x1b[31mred\x1b[0m done"}</Markdown>);
  expect(screen.getByText("tick red done")).toBeInTheDocument();
});

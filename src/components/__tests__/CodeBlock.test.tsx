import { render, screen } from "@testing-library/react";
import { CodeBlock } from "../CodeBlock";

test("detects language from file path", () => {
  render(<CodeBlock content="const answer = 42;" path="src/app.ts" />);

  expect(screen.getByText("const").closest("pre")).toHaveAttribute("data-language", "typescript");
});

test("renders line numbers and preserves code text", () => {
  render(<CodeBlock content={"const answer = 42;\nreturn answer;"} path="src/app.ts" />);

  expect(screen.getByText("1")).toBeInTheDocument();
  expect(screen.getByText("2")).toBeInTheDocument();
  expect(screen.getByText("const").closest("pre")?.textContent).toContain("const answer = 42;");
});

test("highlights json property tokens", () => {
  render(<CodeBlock content={'{"name": "kineloop"}'} path="package.json" />);

  expect(screen.getByText('"name":')).toBeInTheDocument();
  expect(screen.getByText('"kineloop"')).toBeInTheDocument();
});

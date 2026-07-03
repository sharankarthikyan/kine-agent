import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { TerminalView } from "@/components/TerminalView";

describe("TerminalView", () => {
  test("renders HTML-looking output as literal text, never markup", () => {
    render(<TerminalView text={'<img src=x onerror="alert(1)">'} running={false} exitCode={0} signal={null} />);
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  test("strips ANSI before rendering", () => {
    render(<TerminalView text={"\x1b[32mok\x1b[0m"} running={false} exitCode={0} signal={null} />);
    expect(screen.getByText("ok")).toBeInTheDocument();
  });

  test("shows exit footer for failures and signals", () => {
    const { rerender } = render(<TerminalView text="boom" running={false} exitCode={127} signal={null} />);
    expect(screen.getByText(/exit 127/)).toBeInTheDocument();
    rerender(<TerminalView text="boom" running={false} exitCode={null} signal="SIGKILL" />);
    expect(screen.getByText(/SIGKILL/)).toBeInTheDocument();
  });

  test("no exit footer while running", () => {
    render(<TerminalView text="tick" running />);
    expect(screen.queryByText(/exit/)).toBeNull();
  });

  test("shows truncation note when bytes were dropped upstream", () => {
    render(<TerminalView text="head" running={false} exitCode={0} signal={null} droppedBytes={2048} />);
    expect(screen.getByText(/2 KB dropped/)).toBeInTheDocument();
  });

  test("clamps to a tail and says so", () => {
    render(<TerminalView text={"x".repeat(200000)} running={false} exitCode={0} signal={null} />);
    expect(screen.getByText(/earlier output trimmed/)).toBeInTheDocument();
  });

  test("maxLines shows only the last N lines", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");
    render(<TerminalView text={lines} running maxLines={5} />);
    expect(screen.queryByText("line-0")).toBeNull();
    expect(screen.getByText(/line-29/)).toBeInTheDocument();
  });
});

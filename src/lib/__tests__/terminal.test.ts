import { describe, expect, test } from "vitest";
import { clampTail, sanitizeTerminalText } from "@/lib/terminal";

describe("sanitizeTerminalText", () => {
  test("strips CSI color/cursor sequences", () => {
    expect(sanitizeTerminalText("\x1b[31mred\x1b[0m and \x1b[2Kcleared")).toBe("red and cleared");
  });

  test("strips OSC sequences (title set, OSC 52 clipboard)", () => {
    expect(sanitizeTerminalText("\x1b]0;evil title\x07visible")).toBe("visible");
    expect(sanitizeTerminalText("\x1b]52;c;aGF4\x1b\\visible")).toBe("visible");
  });

  test("strips single-char escapes and stray controls, keeps \\n and \\t", () => {
    expect(sanitizeTerminalText("\x1bMa\x00b\x07c\td\ne")).toBe("abc\td\ne");
  });

  test("collapses carriage-return overwrites to the final segment per line", () => {
    expect(sanitizeTerminalText("progress 10%\rprogress 99%\rdone\nnext")).toBe("done\nnext");
  });

  test("leaves plain multiline output untouched", () => {
    expect(sanitizeTerminalText("a\nb\nc")).toBe("a\nb\nc");
  });

  test("treats CRLF as a line ending, not an overwrite", () => {
    expect(sanitizeTerminalText("line\r\n")).toBe("line\n");
    expect(sanitizeTerminalText("a\r\nb\r\nc")).toBe("a\nb\nc");
    expect(sanitizeTerminalText("progress 10%\rprogress 99%\rdone\r\nnext")).toBe("done\nnext");
  });
});

describe("clampTail", () => {
  test("returns short text unclamped", () => {
    expect(clampTail("short", 100)).toEqual({ text: "short", clamped: false });
  });

  test("keeps the tail when over budget", () => {
    const { text, clamped } = clampTail("x".repeat(50) + "TAIL", 10);
    expect(clamped).toBe(true);
    expect(text.endsWith("TAIL")).toBe(true);
    expect(text.length).toBe(10);
  });
});

import { describe, it, expect } from "vitest";
import { detectTuiOnlyCommand } from "../tuiCommands";

describe("detectTuiOnlyCommand", () => {
  it("detects a TUI-only built-in at the start of the prompt", () => {
    expect(detectTuiOnlyCommand("/status", [])).toBe("status");
    expect(detectTuiOnlyCommand("  /model opus", [])).toBe("model");
    expect(detectTuiOnlyCommand("/permissions\nplease", [])).toBe("permissions");
  });

  it("is case-insensitive on the command name", () => {
    expect(detectTuiOnlyCommand("/Status", [])).toBe("status");
  });

  it("returns null for commands that work headless", () => {
    expect(detectTuiOnlyCommand("/usage", [])).toBeNull();
    expect(detectTuiOnlyCommand("/cost", [])).toBeNull();
    expect(detectTuiOnlyCommand("/context", [])).toBeNull();
    expect(detectTuiOnlyCommand("/compact", [])).toBeNull();
    expect(detectTuiOnlyCommand("/init", [])).toBeNull();
  });

  it("returns null for plain prompts and paths", () => {
    expect(detectTuiOnlyCommand("fix the bug", [])).toBeNull();
    expect(detectTuiOnlyCommand("look at /status quo", [])).toBeNull();
    expect(detectTuiOnlyCommand("/usr/bin/env", [])).toBeNull();
    expect(detectTuiOnlyCommand("", [])).toBeNull();
  });

  it("lets a user-defined skill or command shadow a built-in name", () => {
    // `claude -p` expands custom /commands and skills; a project /status skill must send.
    expect(detectTuiOnlyCommand("/status", ["status"])).toBeNull();
    expect(detectTuiOnlyCommand("/model", ["status"])).toBe("model");
  });
});

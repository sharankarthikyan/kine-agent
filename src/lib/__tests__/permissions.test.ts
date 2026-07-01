import { describe, expect, test } from "vitest";
import {
  coercePermissionMode,
  DEFAULT_PERMISSION_MODE,
  isPermissionModeSupported,
  permissionModeLabel,
  permissionModesForAgent,
  permissionQualifier,
  type PermissionMode,
} from "../permissions";

describe("permissionModesForAgent", () => {
  test("Claude exposes the headless-safe set including the advanced Locked-down mode", () => {
    const modes = permissionModesForAgent("claude");
    // `auto` is intentionally excluded: its classifier aborts under headless -p.
    expect(modes).toEqual(["plan", "default", "acceptEdits", "full", "dontAsk"]);
  });

  test("Codex omits plan and the advanced modes", () => {
    expect(permissionModesForAgent("codex")).toEqual(["default", "acceptEdits", "full"]);
  });

  test("Antigravity offers only Ask before edits and Full access", () => {
    expect(permissionModesForAgent("antigravity")).toEqual(["default", "full"]);
  });

  test("an unknown agent falls back to the safe common tier", () => {
    expect(permissionModesForAgent("gemini")).toEqual(["default", "acceptEdits", "full"]);
  });
});

describe("isPermissionModeSupported", () => {
  test("plan is Claude-only", () => {
    expect(isPermissionModeSupported("plan", "claude")).toBe(true);
    expect(isPermissionModeSupported("plan", "codex")).toBe(false);
    expect(isPermissionModeSupported("plan", "antigravity")).toBe(false);
  });

  test("full is supported by every agent", () => {
    for (const agent of ["claude", "codex", "antigravity"]) {
      expect(isPermissionModeSupported("full", agent)).toBe(true);
    }
  });
});

describe("coercePermissionMode", () => {
  test("keeps a supported mode unchanged", () => {
    expect(coercePermissionMode("acceptEdits", "codex")).toEqual({
      mode: "acceptEdits",
      changed: false,
    });
  });

  test("coerces an unsupported mode DOWN to default (never escalates to full)", () => {
    // acceptEdits isn't a tier Antigravity can express — must resolve to the safe default,
    // NOT to full (an incidental agent switch must never widen blast radius).
    expect(coercePermissionMode("acceptEdits", "antigravity")).toEqual({
      mode: "default",
      changed: true,
    });
    // plan is Claude-only; on Codex it becomes default.
    expect(coercePermissionMode("plan", "codex")).toEqual({ mode: "default", changed: true });
    // Advanced Claude modes coerce to default elsewhere.
    expect(coercePermissionMode("dontAsk", "codex").mode).toBe("default");
  });

  test("full is never coerced (supported everywhere)", () => {
    expect(coercePermissionMode("full", "antigravity")).toEqual({
      mode: "full",
      changed: false,
    });
  });
});

describe("copy helpers", () => {
  test("labels are human-readable", () => {
    expect(permissionModeLabel("default")).toBe("Ask before edits");
    expect(permissionModeLabel("full")).toBe("Full access");
  });

  test("qualifier explains the same label's different blast radius per agent", () => {
    // Codex default is genuinely read-only; the qualifier says so.
    expect(permissionQualifier("default", "codex")).toMatch(/read-only/i);
    // Claude default needs no qualifier (its generic description suffices).
    expect(permissionQualifier("default", "claude")).toBeNull();
  });

  test("the default mode id is 'default'", () => {
    const d: PermissionMode = DEFAULT_PERMISSION_MODE;
    expect(d).toBe("default");
  });
});

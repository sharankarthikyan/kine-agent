import { describe, it, expect, vi } from "vitest";
import { startSession } from "../agent";

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> { onmessage: ((m: T) => void) | null = null; }
  return { invoke: vi.fn().mockResolvedValue(undefined), Channel };
});

describe("startSession", () => {
  it("invokes start_session with prompt, cwd, and a channel", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const events: unknown[] = [];
    await startSession({ prompt: "hi", cwd: "/tmp", onEvent: (e) => events.push(e) });
    expect(invoke).toHaveBeenCalledWith(
      "start_session",
      expect.objectContaining({ prompt: "hi", cwd: "/tmp", onEvent: expect.anything() }),
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { startSession, type AgentEvent } from "../agent";

// The factory is hoisted above imports, so the mock Channel must be defined inline.
vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: ((m: T) => void) | null = null;
  }
  return { invoke: vi.fn().mockResolvedValue(undefined), Channel };
});

/** A captured Channel-like object handed to `invoke`. */
type CapturedChannel = { onmessage: ((m: AgentEvent) => void) | null };

describe("startSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes start_session with prompt, cwd, and a Channel", async () => {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    await startSession({ prompt: "hi", cwd: "/tmp", onEvent: () => {} });
    expect(invoke).toHaveBeenCalledWith(
      "start_session",
      expect.objectContaining({
        prompt: "hi",
        cwd: "/tmp",
        onEvent: expect.any(Channel),
      }),
    );
  });

  it("wires onEvent to the channel's onmessage so streamed events are delivered", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const received: AgentEvent[] = [];
    await startSession({ prompt: "hi", cwd: "/tmp", onEvent: (e) => received.push(e) });

    // Grab the Channel handed to invoke and simulate the backend emitting an event.
    const args = vi.mocked(invoke).mock.calls[0][1] as unknown as { onEvent: CapturedChannel };
    const event: AgentEvent = { kind: "token", data: { text: "Hi." } };
    args.onEvent.onmessage?.(event);

    expect(received).toEqual([event]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startSession, cleanupSession, sendMessage, type AgentEvent } from "../agent";

describe("desktop guard", () => {
  const internals = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  afterEach(() => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
  });

  it("startSession throws an actionable error outside the desktop app", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(
      startSession({ prompt: "x", repo: ".", onEvent: () => {} }),
    ).rejects.toThrow(/desktop app/i);
  });
});

// The factory is hoisted above imports, so the mock Channel must be defined inline.
vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: ((m: T) => void) | null = null;
  }
  return { invoke: vi.fn().mockResolvedValue(undefined), Channel };
});

type CapturedChannel = { onmessage: ((m: AgentEvent) => void) | null };

describe("startSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes start_session with prompt, repo, a sessionId, and a Channel", async () => {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    await startSession({ prompt: "hi", repo: "/work/proj", onEvent: () => {} });
    expect(invoke).toHaveBeenCalledWith(
      "start_session",
      expect.objectContaining({
        prompt: "hi",
        repo: "/work/proj",
        sessionId: expect.any(String),
        onEvent: expect.any(Channel),
      }),
    );
    const sessionId = (vi.mocked(invoke).mock.calls[0][1] as Record<string, unknown>).sessionId as string;
    expect(sessionId.length).toBeGreaterThan(0);
  });

  it("wires onEvent to the channel's onmessage so streamed events are delivered", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const received: AgentEvent[] = [];
    await startSession({ prompt: "hi", repo: "/work/proj", onEvent: (e) => received.push(e) });
    const args = vi.mocked(invoke).mock.calls[0][1] as unknown as { onEvent: CapturedChannel };
    const event: AgentEvent = { kind: "token", data: { text: "Hi." } };
    args.onEvent.onmessage?.(event);
    expect(received).toEqual([event]);
  });

  it("returns the sessionId so the caller can clean it up later", async () => {
    const sessionId = await startSession({ prompt: "hi", repo: "/work/proj", onEvent: () => {} });
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);
  });
});

describe("cleanupSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes cleanup_session with repo and sessionId", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await cleanupSession({ repo: "/work/proj", sessionId: "sess-7" });
    expect(invoke).toHaveBeenCalledWith("cleanup_session", { repo: "/work/proj", sessionId: "sess-7" });
  });
});

describe("sendMessage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes send_message with the sessionId, prompt, and a Channel", async () => {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    await sendMessage({ sessionId: "s1", prompt: "and now add docs", onEvent: () => {} });
    expect(invoke).toHaveBeenCalledWith(
      "send_message",
      expect.objectContaining({ sessionId: "s1", prompt: "and now add docs", onEvent: expect.any(Channel) }),
    );
  });

  it("delivers streamed events to onEvent", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const got: AgentEvent[] = [];
    await sendMessage({ sessionId: "s1", prompt: "x", onEvent: (e) => got.push(e) });
    const args = vi.mocked(invoke).mock.calls[0][1] as unknown as { onEvent: CapturedChannel };
    const event: AgentEvent = { kind: "token", data: { text: "more" } };
    args.onEvent.onmessage?.(event);
    expect(got).toEqual([event]);
  });
});

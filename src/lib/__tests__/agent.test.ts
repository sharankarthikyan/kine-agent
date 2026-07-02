import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startSession,
  cleanupSession,
  continueExternalSession,
  defaultEngineFor,
  listTrustedRepos,
  pickRepository,
  sendMessage,
  type AgentEvent,
} from "../agent";

describe("defaultEngineFor", () => {
  it("defaults claude and codex to acp when Node is present", () => {
    expect(defaultEngineFor("claude", true)).toBe("acp");
    expect(defaultEngineFor("codex", true)).toBe("acp");
  });

  it("falls back to pipe without Node — ACP agents are npx-launched", () => {
    expect(defaultEngineFor("claude", false)).toBe("pipe");
    expect(defaultEngineFor("codex", false)).toBe("pipe");
  });

  it("is always pipe for agents without ACP support", () => {
    expect(defaultEngineFor("antigravity", true)).toBe("pipe");
    expect(defaultEngineFor("gemini", true)).toBe("pipe");
  });
});

describe("desktop guard", () => {
  const internals = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  afterEach(() => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
  });

  it("startSession throws an actionable error outside the desktop app", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(
      startSession({ prompt: "x", repo: ".", sessionId: "x", onEvent: () => {} }),
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

  it("invokes start_session with prompt, repo, the caller-supplied sessionId, and a Channel", async () => {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    await startSession({ prompt: "hi", repo: "/work/proj", sessionId: "sess-1", onEvent: () => {} });
    expect(invoke).toHaveBeenCalledWith(
      "start_session",
      expect.objectContaining({
        prompt: "hi",
        repo: "/work/proj",
        sessionId: "sess-1",
        onEvent: expect.any(Channel),
      }),
    );
  });

  it("forwards model when provided", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await startSession({ prompt: "hi", repo: "/work/proj", sessionId: "sess-1", model: "opus", onEvent: () => {} });
    expect(invoke).toHaveBeenCalledWith(
      "start_session",
      expect.objectContaining({ model: "opus" }),
    );
  });

  it("forwards allowed permissionMode when provided", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await startSession({ prompt: "hi", repo: "/work/proj", sessionId: "sess-1", permissionMode: "acceptEdits", onEvent: () => {} });
    expect(invoke).toHaveBeenCalledWith(
      "start_session",
      expect.objectContaining({ permissionMode: "acceptEdits" }),
    );
  });

  it("omitting permissionMode still invokes without error", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await startSession({ prompt: "hi", repo: "/work/proj", sessionId: "sess-1", onEvent: () => {} });
    expect(invoke).toHaveBeenCalledWith(
      "start_session",
      expect.objectContaining({ prompt: "hi", sessionId: "sess-1" }),
    );
  });

  it("wires onEvent to the channel's onmessage so streamed events are delivered", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const received: AgentEvent[] = [];
    await startSession({ prompt: "hi", repo: "/work/proj", sessionId: "sess-1", onEvent: (e) => received.push(e) });
    const args = vi.mocked(invoke).mock.calls[0][1] as unknown as { onEvent: CapturedChannel };
    const event: AgentEvent = { kind: "token", data: { text: "Hi." } };
    args.onEvent.onmessage?.(event);
    expect(received).toEqual([event]);
  });

  it("resolves to undefined (caller owns the session id)", async () => {
    const result = await startSession({ prompt: "hi", repo: "/work/proj", sessionId: "sess-1", onEvent: () => {} });
    expect(result).toBeUndefined();
  });
});

describe("cleanupSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes cleanup_session with sessionId only", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await cleanupSession("sess-7");
    expect(invoke).toHaveBeenCalledWith("cleanup_session", { sessionId: "sess-7" });
  });
});

describe("repositories", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes the backend-owned repository picker", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce("/work/proj");
    await expect(pickRepository()).resolves.toBe("/work/proj");
    expect(invoke).toHaveBeenCalledWith("pick_repository");
  });

  it("lists backend-trusted repositories", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce(["/work/proj"]);
    await expect(listTrustedRepos()).resolves.toEqual(["/work/proj"]);
    expect(invoke).toHaveBeenCalledWith("list_trusted_repos");
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

  it("forwards model when provided", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await sendMessage({ sessionId: "s1", prompt: "x", model: "sonnet", onEvent: () => {} });
    expect(invoke).toHaveBeenCalledWith(
      "send_message",
      expect.objectContaining({ model: "sonnet" }),
    );
  });

  it("forwards permissionMode when provided", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await sendMessage({ sessionId: "s1", prompt: "x", permissionMode: "acceptEdits", onEvent: () => {} });
    expect(invoke).toHaveBeenCalledWith(
      "send_message",
      expect.objectContaining({ permissionMode: "acceptEdits" }),
    );
  });

  it("omitting permissionMode still invokes without error", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await sendMessage({ sessionId: "s1", prompt: "x", onEvent: () => {} });
    expect(invoke).toHaveBeenCalledWith(
      "send_message",
      expect.objectContaining({ sessionId: "s1", prompt: "x" }),
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

describe("continueExternalSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes continue_external_session with the imported id, new sessionId, prompt, and a Channel", async () => {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    await continueExternalSession({
      externalSessionId: "external:codex:abc",
      sessionId: "s2",
      prompt: "continue this",
      agent: "codex",
      onEvent: () => {},
    });
    expect(invoke).toHaveBeenCalledWith(
      "continue_external_session",
      expect.objectContaining({
        externalSessionId: "external:codex:abc",
        sessionId: "s2",
        prompt: "continue this",
        agent: "codex",
        onEvent: expect.any(Channel),
      }),
    );
  });

  it("forwards model and permissionMode when provided", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await continueExternalSession({
      externalSessionId: "external:claude:abc",
      sessionId: "s2",
      prompt: "x",
      agent: "claude",
      model: "opus",
      permissionMode: "acceptEdits",
      onEvent: () => {},
    });
    expect(invoke).toHaveBeenCalledWith(
      "continue_external_session",
      expect.objectContaining({ agent: "claude", model: "opus", permissionMode: "acceptEdits" }),
    );
  });

  it("delivers streamed events to onEvent", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const got: AgentEvent[] = [];
    await continueExternalSession({
      externalSessionId: "external:claude:abc",
      sessionId: "s2",
      prompt: "x",
      onEvent: (e) => got.push(e),
    });
    const args = vi.mocked(invoke).mock.calls[0][1] as unknown as { onEvent: CapturedChannel };
    const event: AgentEvent = { kind: "token", data: { text: "continued" } };
    args.onEvent.onmessage?.(event);
    expect(got).toEqual([event]);
  });
});

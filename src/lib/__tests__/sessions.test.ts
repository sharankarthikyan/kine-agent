import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listSessions,
  sessionEvents,
  sessionEventsPage,
  type SessionSummary,
  type StoredEvent,
} from "../sessions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("sessions client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listSessions invokes list_sessions and returns the rows", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const rows: SessionSummary[] = [
      { id: "s1", agent: "claude", repo: "/r", branch: "agent/s1", title: "t", status: "idle", source: "kine-agent", turnCount: null, toolCallCount: null, fileActionCount: null, createdAt: 1, updatedAt: 2 },
    ];
    vi.mocked(invoke).mockResolvedValue(rows);
    expect(await listSessions()).toEqual(rows);
    expect(invoke).toHaveBeenCalledWith("list_sessions");
  });

  it("sessionEvents invokes session_events with the sessionId", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const events: StoredEvent[] = [{ seq: 0, kind: "prompt", payloadJson: '{"text":"hi"}', ts: 1 }];
    vi.mocked(invoke).mockResolvedValue(events);
    expect(await sessionEvents("s1")).toEqual(events);
    expect(invoke).toHaveBeenCalledWith("session_events", { sessionId: "s1" });
  });

  it("sessionEventsPage invokes session_events_page with sessionId, offset, and limit", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const page = {
      events: [{ seq: 10, kind: "prompt", payloadJson: '{"text":"hi"}', ts: 1 }],
      nextOffset: 11,
      hasMore: true,
    };
    vi.mocked(invoke).mockResolvedValue(page);
    expect(await sessionEventsPage("s1", 10, 50)).toEqual(page);
    expect(invoke).toHaveBeenCalledWith("session_events_page", {
      sessionId: "s1",
      offset: 10,
      limit: 50,
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { reviewSession, type SessionDiff } from "../review";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("reviewSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes review_session with the sessionId and returns the diff", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const diff: SessionDiff = {
      files: [{ path: "a.txt", status: "modified", additions: 2, deletions: 1 }],
      patch: "--- a/a.txt\n+++ b/a.txt\n",
    };
    vi.mocked(invoke).mockResolvedValue(diff);
    const result = await reviewSession({ sessionId: "s1" });
    expect(invoke).toHaveBeenCalledWith("review_session", { sessionId: "s1" });
    expect(result).toEqual(diff);
  });
});

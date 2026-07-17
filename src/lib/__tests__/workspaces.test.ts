import { describe, it, expect } from "vitest";
import { groupByWorkspace } from "../workspaces";
import type { SessionSummary } from "../sessions";

function makeSession(overrides: Partial<SessionSummary> & { id: string; repo: string; updatedAt: number }): SessionSummary {
  return {
    agent: "claude",
    branch: "agent/s",
    title: "Test session",
    status: "idle",
    source: "kine-agent",
    turnCount: null,
    toolCallCount: null,
    fileActionCount: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("groupByWorkspace", () => {
  it("returns an empty array for no sessions", () => {
    expect(groupByWorkspace([])).toEqual([]);
  });

  it("groups sessions by the basename of their repo path", () => {
    const sessions = [
      makeSession({ id: "s1", repo: "/Users/x/projects/foo", updatedAt: 100 }),
      makeSession({ id: "s2", repo: "/Users/x/projects/bar", updatedAt: 200 }),
      makeSession({ id: "s3", repo: "/Users/x/projects/foo", updatedAt: 50 }),
    ];
    const groups = groupByWorkspace(sessions);

    expect(groups).toHaveLength(2);
    const workspaceNames = groups.map((g) => g.workspace);
    expect(workspaceNames).toContain("foo");
    expect(workspaceNames).toContain("bar");

    const foo = groups.find((g) => g.workspace === "foo")!;
    expect(foo.sessions.map((s) => s.id)).toEqual(["s1", "s3"]); // s1 newer
  });

  it("orders sessions within each group by updatedAt descending", () => {
    const sessions = [
      makeSession({ id: "s1", repo: "/repo/alpha", updatedAt: 10 }),
      makeSession({ id: "s2", repo: "/repo/alpha", updatedAt: 30 }),
      makeSession({ id: "s3", repo: "/repo/alpha", updatedAt: 20 }),
    ];
    const [group] = groupByWorkspace(sessions);
    expect(group.sessions.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
  });

  it("orders groups by their most-recent session's updatedAt descending", () => {
    const sessions = [
      makeSession({ id: "s1", repo: "/a/older", updatedAt: 10 }),
      makeSession({ id: "s2", repo: "/b/newer", updatedAt: 50 }),
      makeSession({ id: "s3", repo: "/c/middle", updatedAt: 30 }),
    ];
    const groups = groupByWorkspace(sessions);
    expect(groups.map((g) => g.workspace)).toEqual(["newer", "middle", "older"]);
  });

  it("extracts the basename correctly from various path forms", () => {
    const cases: [string, string][] = [
      ["/Users/x/projects/foo", "foo"],
      ["/Users/x/projects/foo/", "foo"],     // trailing slash
      ["myrepo", "myrepo"],                   // no slashes
      [".", "."],                             // dot
      ["", "."],                              // empty → fallback label
      ["/a/b/c", "c"],
    ];

    for (const [repo, expectedWorkspace] of cases) {
      const sessions = [makeSession({ id: "s", repo, updatedAt: 1 })];
      const [group] = groupByWorkspace(sessions);
      expect(group.workspace, `repo="${repo}"`).toBe(expectedWorkspace);
    }
  });

  it("places the most-recently-updated group first when multiple groups tie on name", () => {
    // Two different repos that happen to share a basename
    const sessions = [
      makeSession({ id: "s1", repo: "/x/shared", updatedAt: 5 }),
      makeSession({ id: "s2", repo: "/y/shared", updatedAt: 50 }),
    ];
    // Both map to workspace "shared" — they end up in the same group
    const [group] = groupByWorkspace(sessions);
    expect(group.workspace).toBe("shared");
    expect(group.sessions[0].id).toBe("s2"); // s2 is newer
  });
});

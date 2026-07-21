import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  customizationsCounts,
  sessionDiffstat,
  worktreeTree,
  branchChanges,
  commitSession,
  openInEditor,
  openTerminal,
  type CustomizationCounts,
  type Diffstat,
  type TreeEntry,
  type BranchChanges,
  type CommitResult,
} from "../conductor";
import type { FileChange } from "../review";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// ── assertDesktop guards ──────────────────────────────────────────────────────

describe("desktop guard", () => {
  const internals = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  afterEach(() => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
  });

  it("customizationsCounts throws outside the desktop app", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(customizationsCounts("s1")).rejects.toThrow(/desktop app/i);
  });

  it("sessionDiffstat throws outside the desktop app", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(sessionDiffstat("s1")).rejects.toThrow(/desktop app/i);
  });

  it("worktreeTree throws outside the desktop app", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(worktreeTree("s1")).rejects.toThrow(/desktop app/i);
  });

  it("branchChanges throws outside the desktop app", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(branchChanges("s1")).rejects.toThrow(/desktop app/i);
  });

  it("commitSession throws outside the desktop app", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(commitSession("s1", "feat: add tests")).rejects.toThrow(/desktop app/i);
  });

  it("openInEditor throws outside the desktop app", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(openInEditor("s1")).rejects.toThrow(/desktop app/i);
  });

  it("openTerminal throws outside the desktop app", async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(openTerminal("s1")).rejects.toThrow(/desktop app/i);
  });
});

// ── IPC command + arg assertions ──────────────────────────────────────────────

describe("customizationsCounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes customizations_counts with sessionId and returns the counts", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const counts: CustomizationCounts = { agents: 2, skills: 5, instructions: 1, hooks: 0, mcpServers: 3 };
    vi.mocked(invoke).mockResolvedValue(counts);

    const result = await customizationsCounts("sess-abc", "codex");

    expect(invoke).toHaveBeenCalledWith("customizations_counts", {
      sessionId: "sess-abc",
      agent: "codex",
    });
    expect(result).toEqual(counts);
  });
});

describe("sessionDiffstat", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes session_diffstat with sessionId and returns the diffstat", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const stat: Diffstat = { additions: 42, deletions: 7, filesChanged: 3 };
    vi.mocked(invoke).mockResolvedValue(stat);

    const result = await sessionDiffstat("sess-abc");

    expect(invoke).toHaveBeenCalledWith("session_diffstat", { sessionId: "sess-abc" });
    expect(result).toEqual(stat);
  });
});

describe("worktreeTree", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes worktree_tree with sessionId and returns the entries", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const entries: TreeEntry[] = [
      { path: "src/main.rs", isDir: false, status: "M" },
      { path: "src/", isDir: true, status: null },
    ];
    vi.mocked(invoke).mockResolvedValue(entries);

    const result = await worktreeTree("sess-abc");

    expect(invoke).toHaveBeenCalledWith("worktree_tree", { sessionId: "sess-abc" });
    expect(result).toEqual(entries);
  });

  it("returns an empty array when the worktree is empty", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue([]);

    const result = await worktreeTree("sess-abc");

    expect(result).toEqual([]);
  });
});

describe("branchChanges", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes branch_changes with sessionId and returns the result", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const files: FileChange[] = [
      { path: "src/lib.rs", status: "modified", additions: 10, deletions: 2 },
    ];
    const changes: BranchChanges = { aheadCount: 3, files };
    vi.mocked(invoke).mockResolvedValue(changes);

    const result = await branchChanges("sess-abc");

    expect(invoke).toHaveBeenCalledWith("branch_changes", { sessionId: "sess-abc" });
    expect(result).toEqual(changes);
  });
});

describe("commitSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes commit_session with sessionId and message, returns sha", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const commitResult: CommitResult = { sha: "abc1234def5678" };
    vi.mocked(invoke).mockResolvedValue(commitResult);

    const result = await commitSession("sess-abc", "feat: implement conductor IPC");

    expect(invoke).toHaveBeenCalledWith("commit_session", {
      sessionId: "sess-abc",
      message: "feat: implement conductor IPC",
    });
    expect(result).toEqual(commitResult);
  });
});

describe("openInEditor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes open_in_editor with sessionId and resolves to undefined", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(undefined);

    const result = await openInEditor("sess-abc");

    expect(invoke).toHaveBeenCalledWith("open_in_editor", { sessionId: "sess-abc" });
    expect(result).toBeUndefined();
  });
});

describe("openTerminal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes open_terminal with sessionId and resolves to undefined", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(undefined);

    const result = await openTerminal("sess-abc");

    expect(invoke).toHaveBeenCalledWith("open_terminal", { sessionId: "sess-abc" });
    expect(result).toBeUndefined();
  });
});

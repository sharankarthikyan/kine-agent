import { describe, it, expect, beforeEach, vi } from "vitest";
import { getRecentRepos, addRecentRepo } from "../recents";

// Node 22+ exposes an experimental (non-functional) localStorage global that
// shadows jsdom's own implementation in some Vitest environments. We stub the
// global with a reliable in-memory implementation for all recents tests.
function createLocalStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createLocalStorageMock());
});

describe("getRecentRepos", () => {
  it("returns [] when localStorage has no entry", () => {
    expect(getRecentRepos()).toEqual([]);
  });

  it("returns [] on a parse error (corrupted value)", () => {
    localStorage.setItem("kineloop.recentRepos", "not-json{{{");
    expect(getRecentRepos()).toEqual([]);
  });

  it("returns [] when the parsed value is not an array", () => {
    localStorage.setItem("kineloop.recentRepos", JSON.stringify({ path: "/foo" }));
    expect(getRecentRepos()).toEqual([]);
  });

  it("returns the stored list when the value is valid", () => {
    const repos = ["/a/b", "/c/d"];
    localStorage.setItem("kineloop.recentRepos", JSON.stringify(repos));
    expect(getRecentRepos()).toEqual(repos);
  });
});

describe("addRecentRepo", () => {
  it("adds a path to an empty list", () => {
    addRecentRepo("/users/me/projects/foo");
    expect(getRecentRepos()).toEqual(["/users/me/projects/foo"]);
  });

  it("prepends to an existing list (most-recent-first)", () => {
    addRecentRepo("/projects/alpha");
    addRecentRepo("/projects/beta");
    expect(getRecentRepos()).toEqual(["/projects/beta", "/projects/alpha"]);
  });

  it("moves an already-present path to the front (dedupe)", () => {
    addRecentRepo("/a");
    addRecentRepo("/b");
    addRecentRepo("/c");
    addRecentRepo("/a"); // move /a back to front
    expect(getRecentRepos()).toEqual(["/a", "/c", "/b"]);
  });

  it("caps the list at 8 entries", () => {
    for (let i = 1; i <= 10; i++) addRecentRepo(`/repo/${i}`);
    const recents = getRecentRepos();
    expect(recents).toHaveLength(8);
    // Most-recent (/repo/10) at front; oldest entries trimmed.
    expect(recents[0]).toBe("/repo/10");
    expect(recents).not.toContain("/repo/1");
    expect(recents).not.toContain("/repo/2");
  });

  it("dedupes when the path is at the tail and the list is near cap", () => {
    // Fill with 8 entries, then re-add the oldest — should move to front, not grow.
    for (let i = 1; i <= 8; i++) addRecentRepo(`/repo/${i}`);
    addRecentRepo("/repo/1"); // /repo/1 was oldest (position 7)
    const recents = getRecentRepos();
    expect(recents).toHaveLength(8);
    expect(recents[0]).toBe("/repo/1");
  });
});

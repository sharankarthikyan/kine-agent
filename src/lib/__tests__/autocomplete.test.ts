import { describe, test, expect } from "vitest";
import {
  detectTrigger,
  applySuggestion,
  matchRange,
  filterSuggestions,
  commandsToSuggestions,
  agentsToSuggestions,
  treeToFileSuggestions,
  parsePathQuery,
  entriesToPathSuggestions,
  effectiveFilterQuery,
  type Suggestion,
  type TriggerContext,
} from "../autocomplete";
import type { Capabilities } from "../inspect";
import type { TreeEntry } from "../conductor";

// ── detectTrigger ──────────────────────────────────────────────────────────────

describe("detectTrigger", () => {
  test("opens on a bare @ at start", () => {
    expect(detectTrigger("@", 1)).toEqual({ trigger: "@", query: "", start: 0, end: 1 });
  });

  test("captures the query after @ mid-line", () => {
    const text = "look at @src";
    expect(detectTrigger(text, text.length)).toEqual({
      trigger: "@",
      query: "src",
      start: 8,
      end: 12,
    });
  });

  test("allows slashes inside an @path query", () => {
    const text = "@src/components/App";
    expect(detectTrigger(text, text.length)).toEqual({
      trigger: "@",
      query: "src/components/App",
      start: 0,
      end: 19,
    });
  });

  test("does not treat an email @ as a trigger", () => {
    // "a@b" — the word starts with 'a', not '@'
    expect(detectTrigger("a@b", 3)).toBeNull();
  });

  test("opens / only at line start", () => {
    expect(detectTrigger("/dep", 4)).toEqual({ trigger: "/", query: "dep", start: 0, end: 4 });
    expect(detectTrigger("\n/dep", 5)).toEqual({ trigger: "/", query: "dep", start: 1, end: 5 });
  });

  test("does not open / mid-line", () => {
    expect(detectTrigger("run /dep", 8)).toBeNull();
    expect(detectTrigger("a/b", 3)).toBeNull();
  });

  test("returns null when caret sits after whitespace", () => {
    expect(detectTrigger("@src ", 5)).toBeNull();
  });

  test("captures a mid-token caret", () => {
    // caret right after "App" in "@src/App more"
    expect(detectTrigger("@src/App more", 8)).toEqual({
      trigger: "@",
      query: "src/App",
      start: 0,
      end: 8,
    });
  });
});

// ── applySuggestion ────────────────────────────────────────────────────────────

describe("applySuggestion", () => {
  test("replaces the token and appends a trailing space", () => {
    const ctx = detectTrigger("hi @sr", 6)!;
    expect(applySuggestion("hi @sr", ctx, "@src/App.tsx")).toEqual({
      text: "hi @src/App.tsx ",
      caret: 16,
    });
  });

  test("does not double a space that already follows", () => {
    const ctx = detectTrigger("@sr rest", 3)!;
    const out = applySuggestion("@sr rest", ctx, "@src");
    expect(out.text).toBe("@src rest");
    expect(out.caret).toBe(4);
  });

  test("keeps surrounding text intact", () => {
    const ctx = detectTrigger("/de and more", 3)!;
    expect(applySuggestion("/de and more", ctx, "/deploy").text).toBe("/deploy and more");
  });

  test("omits the trailing space for directory descent", () => {
    const ctx = detectTrigger("@~/Do", 5)!;
    const out = applySuggestion("@~/Do", ctx, "@~/Documents/", { trailingSpace: false });
    expect(out.text).toBe("@~/Documents/");
    expect(out.caret).toBe("@~/Documents/".length);
  });
});

// ── parsePathQuery ─────────────────────────────────────────────────────────────

describe("parsePathQuery", () => {
  test("returns null for repo-relative queries", () => {
    expect(parsePathQuery("src/App")).toBeNull();
    expect(parsePathQuery("App")).toBeNull();
  });
  test("parses a bare ~ as the home root", () => {
    expect(parsePathQuery("~")).toEqual({ dirPath: "~/", filter: "", insertPrefix: "~/" });
  });
  test("splits home and absolute paths into dir + filter", () => {
    expect(parsePathQuery("~/Doc")).toEqual({ dirPath: "~/", filter: "Doc", insertPrefix: "~/" });
    expect(parsePathQuery("~/docs/re")).toEqual({
      dirPath: "~/docs/",
      filter: "re",
      insertPrefix: "~/docs/",
    });
    expect(parsePathQuery("/")).toEqual({ dirPath: "/", filter: "", insertPrefix: "/" });
    expect(parsePathQuery("/usr/lo")).toEqual({
      dirPath: "/usr/",
      filter: "lo",
      insertPrefix: "/usr/",
    });
  });
});

describe("effectiveFilterQuery", () => {
  const t = (trigger: "@" | "/", query: string): TriggerContext => ({
    trigger,
    query,
    start: 0,
    end: query.length + 1,
  });
  test("strips a leading ./ from repo @ queries so @./src == @src", () => {
    expect(effectiveFilterQuery(t("@", "./src"))).toBe("src");
    expect(effectiveFilterQuery(t("@", "src"))).toBe("src");
  });
  test("leaves dotfile queries intact", () => {
    expect(effectiveFilterQuery(t("@", ".claude"))).toBe(".claude");
  });
  test("uses the name part for filesystem path queries", () => {
    expect(effectiveFilterQuery(t("@", "~/docs/re"))).toBe("re");
    expect(effectiveFilterQuery(t("@", "/usr/lo"))).toBe("lo");
  });
  test("passes command queries through unchanged", () => {
    expect(effectiveFilterQuery(t("/", "dep"))).toBe("dep");
  });
});

describe("entriesToPathSuggestions", () => {
  test("prefixes children and marks directories with a trailing slash", () => {
    const out = entriesToPathSuggestions("~/", [
      { name: "docs", isDir: true },
      { name: "a.txt", isDir: false },
    ]);
    expect(out[0]).toMatchObject({ kind: "dir", label: "docs/", insertText: "@~/docs/" });
    expect(out[1]).toMatchObject({ kind: "file", label: "a.txt", insertText: "@~/a.txt" });
  });
});

// ── matchRange ─────────────────────────────────────────────────────────────────

describe("matchRange", () => {
  test("finds a case-insensitive substring span", () => {
    expect(matchRange("src/App.tsx", "app")).toEqual([4, 7]);
  });
  test("returns null for no match and for empty query", () => {
    expect(matchRange("src/App.tsx", "zz")).toBeNull();
    expect(matchRange("src/App.tsx", "")).toBeNull();
  });
});

// ── filterSuggestions ──────────────────────────────────────────────────────────

function sug(searchText: string): Suggestion {
  return {
    id: searchText,
    kind: "file",
    label: searchText,
    insertText: `@${searchText}`,
    searchText,
  };
}

describe("filterSuggestions", () => {
  test("ranks prefix above boundary above plain substring above subsequence", () => {
    const items = [
      sug("aXpXp"), // scattered subsequence a-p-p
      sug("my-app"), // boundary substring (after '-')
      sug("mapping"), // plain substring (after 'm')
      sug("app.ts"), // prefix
    ];
    const out = filterSuggestions(items, "app").map((s) => s.searchText);
    expect(out[0]).toBe("app.ts");
    expect(out.indexOf("my-app")).toBeLessThan(out.indexOf("mapping"));
  });

  test("respects the limit", () => {
    const items = Array.from({ length: 20 }, (_, i) => sug(`file${i}.ts`));
    expect(filterSuggestions(items, "file", 5)).toHaveLength(5);
  });

  test("empty query returns items up to the limit in order", () => {
    const items = [sug("b"), sug("a"), sug("c")];
    expect(filterSuggestions(items, "", 2).map((s) => s.searchText)).toEqual(["b", "a"]);
  });

  test("drops non-matches", () => {
    expect(filterSuggestions([sug("readme.md")], "xyz")).toHaveLength(0);
  });
});

// ── providers ──────────────────────────────────────────────────────────────────

describe("commandsToSuggestions", () => {
  const caps: Capabilities = {
    skills: [{ name: "deploy", description: "Ship it", source: "user", path: "" }],
    commands: [
      { name: "deploy", description: "old command", source: "project", path: "" },
      { name: "review", description: "Review diff", source: "project", path: "" },
    ],
    subagents: [{ name: "planner", description: "plans", source: "user", path: "" }],
  };

  test("merges skills + commands, dedupes by name (skill wins), excludes subagents", () => {
    const out = commandsToSuggestions(caps);
    expect(out.map((s) => s.label).sort()).toEqual(["/deploy", "/review"]);
    const deploy = out.find((s) => s.label === "/deploy")!;
    expect(deploy.description).toBe("Ship it"); // skill won over the same-named command
    expect(deploy.insertText).toBe("/deploy");
    expect(out.some((s) => s.searchText === "planner")).toBe(false);
  });
});

describe("agentsToSuggestions", () => {
  test("maps subagents to @agent- tokens searchable by name or agent-name", () => {
    const out = agentsToSuggestions({
      skills: [],
      commands: [],
      subagents: [
        { name: "code-reviewer", description: "Reviews code", source: "user", path: "" },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "agent",
      label: "code-reviewer",
      insertText: "@agent-code-reviewer",
      searchText: "agent-code-reviewer",
      detail: "user",
    });
    // matchable by the bare name too
    expect(filterSuggestions(out, "code")).toHaveLength(1);
  });
});

describe("treeToFileSuggestions", () => {
  test("maps files and dirs to @-tokens with status detail", () => {
    const entries: TreeEntry[] = [
      { path: "src", isDir: true, status: null },
      { path: "src/App.tsx", isDir: false, status: "modified" },
    ];
    const out = treeToFileSuggestions(entries);
    expect(out[0]).toMatchObject({ kind: "dir", insertText: "@src" });
    expect(out[1]).toMatchObject({ kind: "file", insertText: "@src/App.tsx", detail: "modified" });
  });
});

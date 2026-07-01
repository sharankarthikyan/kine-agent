import type { Capabilities } from "./inspect";
import type { TreeEntry, DirEntry } from "./conductor";

/** The two trigger characters the composer autocompletes. */
export type TriggerChar = "@" | "/";

/** A live trigger detected at the caret: the token being typed and its span in the text. */
export interface TriggerContext {
  trigger: TriggerChar;
  /** Text between the trigger char and the caret (the search query). */
  query: string;
  /** Index of the trigger char in the source text. */
  start: number;
  /** Caret index — exclusive end of the token region to replace on accept. */
  end: number;
}

/** A single autocomplete suggestion row. */
export interface Suggestion {
  /** Stable React key. */
  id: string;
  kind: "command" | "file" | "dir" | "agent";
  /** Primary display text. */
  label: string;
  /** Exact text inserted into the composer on accept (e.g. `/deploy`, `@src/App.tsx`). */
  insertText: string;
  /** Secondary line (skill/command summary). */
  description?: string | null;
  /** Trailing meta chip (source scope, git status). */
  detail?: string | null;
  /** Lowercased-comparison target for filtering. */
  searchText: string;
}

/**
 * Detect the active trigger token at `caret`.
 *
 * A token is the whitespace-delimited word ending at the caret. It's a trigger when that
 * word starts with `@` or `/`. `@` fires after start-of-text or any whitespace (so it can
 * appear mid-line, and its query may contain `/` for paths). `/` fires only at line start
 * (matching Claude Code's "commands recognized only at message start" rule). Returns null
 * when the caret isn't inside such a token.
 */
function isWhitespace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

export function detectTrigger(text: string, caret: number): TriggerContext | null {
  if (caret < 0 || caret > text.length) return null;

  // Walk back to the start of the whitespace-delimited word ending at the caret.
  let start = caret;
  while (start > 0 && !isWhitespace(text[start - 1])) start--;
  if (start >= caret) return null; // caret sits right after whitespace / at start — no word

  const ch = text[start];
  if (ch !== "@" && ch !== "/") return null;

  if (ch === "/") {
    const atLineStart = start === 0 || text[start - 1] === "\n";
    if (!atLineStart) return null; // mid-line slash is a path/literal, not a command
  }

  return { trigger: ch, query: text.slice(start + 1, caret), start, end: caret };
}

/**
 * Replace the trigger token with `insertText`. Adds a single trailing space by default;
 * pass `trailingSpace: false` for directory-descent (keep typing the path).
 */
export function applySuggestion(
  text: string,
  ctx: TriggerContext,
  insertText: string,
  opts: { trailingSpace?: boolean } = {},
): { text: string; caret: number } {
  const trailingSpace = opts.trailingSpace ?? true;
  const before = text.slice(0, ctx.start);
  const after = text.slice(ctx.end);
  const inserted = !trailingSpace
    ? insertText
    : after.startsWith(" ")
      ? insertText
      : `${insertText} `;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

/** A parsed filesystem path query (`@/…` or `@~/…`): the dir to list + the name filter. */
export interface PathQuery {
  /** Directory to list (may contain a leading `~`), e.g. `~/`, `~/docs/`, `/`, `/usr/`. */
  dirPath: string;
  /** The partial name after the last slash, used to filter the listing. */
  filter: string;
  /** The `@`-token prefix to prepend to a selected child, e.g. `~/docs/`. */
  insertPrefix: string;
}

/**
 * Parse an `@` query as a filesystem path when it starts with `/` (absolute) or `~` (home).
 * Repo-relative queries (no leading `/` or `~`) return null and use fuzzy file search instead.
 */
export function parsePathQuery(query: string): PathQuery | null {
  if (!query.startsWith("/") && !query.startsWith("~")) return null;
  const lastSlash = query.lastIndexOf("/");
  if (lastSlash === -1) {
    // "~" typed with no slash yet → list the home root.
    return { dirPath: "~/", filter: query.slice(1), insertPrefix: "~/" };
  }
  const insertPrefix = query.slice(0, lastSlash + 1);
  return { dirPath: insertPrefix, filter: query.slice(lastSlash + 1), insertPrefix };
}

/**
 * The string to actually filter suggestions by (and highlight). For filesystem path queries
 * it's the name after the last slash; for repo `@` queries a leading `./` is stripped so
 * `@./src` matches repo files exactly like `@src` (worktree paths have no `./` prefix).
 */
export function effectiveFilterQuery(t: TriggerContext): string {
  if (t.trigger === "@") {
    const path = parsePathQuery(t.query);
    if (path) return path.filter;
    if (t.query.startsWith("./")) return t.query.slice(2);
  }
  return t.query;
}

/** Build `@`-path suggestions from a directory listing, prefixed for the current location. */
export function entriesToPathSuggestions(insertPrefix: string, entries: DirEntry[]): Suggestion[] {
  return entries.map((e) => ({
    id: `fs:${insertPrefix}${e.name}`,
    kind: e.isDir ? "dir" : "file",
    label: e.isDir ? `${e.name}/` : e.name,
    insertText: `@${insertPrefix}${e.name}${e.isDir ? "/" : ""}`,
    detail: null,
    searchText: e.name,
  }));
}

/** Case-insensitive substring match span of `query` in `hay`, or null. Empty query → null. */
export function matchRange(hay: string, query: string): [number, number] | null {
  if (query === "") return null;
  const idx = hay.toLowerCase().indexOf(query.toLowerCase());
  return idx === -1 ? null : [idx, idx + query.length];
}

/** Ordered subsequence test: does every char of `n` appear in `h` in order? */
function isSubsequence(h: string, n: string): boolean {
  let i = 0;
  for (const c of h) {
    if (c === n[i]) i++;
    if (i === n.length) return true;
  }
  return n.length === 0;
}

/** Word-boundary characters common in paths and command names. */
function isBoundaryChar(c: string): boolean {
  return c === "/" || c === "-" || c === "_" || c === "." || c === ":";
}

/** Rank a candidate: higher is better; null means no match. */
function score(hay: string, query: string): number | null {
  if (query === "") return 0;
  const h = hay.toLowerCase();
  const n = query.toLowerCase();
  const idx = h.indexOf(n);
  if (idx === 0) return 3; // prefix
  if (idx > 0) return isBoundaryChar(h[idx - 1]) ? 2 : 1; // boundary vs plain substring
  return isSubsequence(h, n) ? 0.5 : null; // scattered subsequence
}

/**
 * Filter + rank suggestions against `query`, returning at most `limit` rows. Ranking:
 * prefix > boundary-substring > substring > subsequence, tie-broken by shorter target
 * then alphabetically. An empty query preserves input order (already-scoped list).
 */
export function filterSuggestions(items: Suggestion[], query: string, limit = 8): Suggestion[] {
  if (query === "") return items.slice(0, limit);
  const scored: { item: Suggestion; s: number }[] = [];
  for (const item of items) {
    const s = score(item.searchText, query);
    if (s !== null) scored.push({ item, s });
  }
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    if (a.item.searchText.length !== b.item.searchText.length) {
      return a.item.searchText.length - b.item.searchText.length;
    }
    return a.item.searchText.localeCompare(b.item.searchText);
  });
  return scored.slice(0, limit).map((x) => x.item);
}

/**
 * Build `/command` suggestions from a session's capabilities. Both custom commands
 * (`.claude/commands/*.md`) and skills (`.claude/skills/<n>/SKILL.md`) invoke as `/<name>`,
 * so they merge into one list, de-duplicated by name (skills win on clash, per Claude's
 * precedence). Subagents are excluded — they aren't slash-invocable.
 */
export function commandsToSuggestions(caps: Capabilities): Suggestion[] {
  const byName = new Map<string, Suggestion>();
  const add = (name: string, description: string | null, source: string, kindLabel: string) => {
    // Skills are added first so they take precedence over a same-named command.
    if (byName.has(name)) return;
    byName.set(name, {
      id: `cmd:${name}`,
      kind: "command",
      label: `/${name}`,
      insertText: `/${name}`,
      description,
      detail: kindLabel === "skill" ? source : `${source} command`,
      searchText: name,
    });
  };
  for (const s of caps.skills) add(s.name, s.description, s.source, "skill");
  for (const c of caps.commands) add(c.name, c.description, c.source, "command");
  return [...byName.values()];
}

/**
 * Build `@agent-<name>` suggestions from a session's subagents. Offered only for Claude (the
 * only agent whose subagents Kineloop can enumerate); on send the token is expanded to a
 * natural-language nudge, since the raw `@agent-` token is cosmetic in headless mode.
 */
export function agentsToSuggestions(caps: Capabilities): Suggestion[] {
  return caps.subagents.map((a) => ({
    id: `agent:${a.name}`,
    kind: "agent",
    label: a.name,
    insertText: `@agent-${a.name}`,
    description: a.description,
    detail: a.source,
    searchText: `agent-${a.name}`,
  }));
}

/** Build `@file`/`@dir` suggestions from a worktree file tree. */
export function treeToFileSuggestions(entries: TreeEntry[]): Suggestion[] {
  return entries.map((e) => ({
    id: `path:${e.path}`,
    kind: e.isDir ? "dir" : "file",
    label: e.path,
    insertText: `@${e.path}`,
    description: null,
    detail: e.status,
    searchText: e.path,
  }));
}

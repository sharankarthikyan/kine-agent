/**
 * `@` mentions are resolved differently per agent (all verified 2026-07-01):
 *
 * - `@file`: `claude -p` inlines file contents natively; `codex exec` and `agy --print`
 *   treat `@path` as literal text, so Kineloop inlines those files client-side before sending.
 * - `@agent-<name>`: the explicit token is cosmetic in every headless mode (Claude's `-p`
 *   ignores it — smoke-tested; codex/agy have no subagent selector at all). Agents are only
 *   offered for Claude, where on send we expand the token to the documented natural-language
 *   form (`the "<name>" subagent`), which Claude *may* honor via auto-delegation.
 */

/** A file or agent the user referenced via the `@` autocomplete, tracked for send-time resolution. */
export type Mention =
  | { kind: "file"; token: string; path: string }
  | { kind: "agent"; token: string; name: string };

/** Per-file cap on inlined content (characters); larger files are truncated with a marker. */
const MAX_INLINE_CHARS = 200_000;

function fence(path: string, contents: string): string {
  const capped =
    contents.length > MAX_INLINE_CHARS
      ? `${contents.slice(0, MAX_INLINE_CHARS)}\n… [truncated — file exceeds ${MAX_INLINE_CHARS} chars]`
      : contents;
  return `===== ${path} =====\n${capped}`;
}

/** Mentions whose token still appears in `text` (edited-away tokens are ignored). */
function activeMentions(text: string, mentions: Mention[]): Mention[] {
  return mentions.filter((m) => text.includes(m.token));
}

/**
 * Whether sending needs an async prompt transform (file read or agent expansion). Lets the
 * composer keep the common case (plain text, no mentions) synchronous.
 */
export function needsPromptTransform(text: string, mentions: Mention[], agent: string): boolean {
  const active = activeMentions(text, mentions);
  if (agent === "claude") return active.some((m) => m.kind === "agent");
  return active.some((m) => m.kind === "file");
}

/**
 * Produce the prompt text to send for `agent`, resolving mentions:
 *
 * - `claude`: expand `@agent-<name>` tokens to `the "<name>" subagent` (files pass through —
 *   the CLI inlines them itself).
 * - `codex` / `antigravity`: inline the contents of each referenced file (de-duplicated by
 *   path). Agent mentions never occur for these (the menu doesn't offer them) and are left as-is.
 *
 * `readFile` reads a repo-relative path from the session worktree.
 */
export async function buildPromptForAgent(
  text: string,
  mentions: Mention[],
  agent: string,
  readFile: (path: string) => Promise<string>,
): Promise<string> {
  const active = activeMentions(text, mentions);

  if (agent === "claude") {
    let out = text;
    const seen = new Set<string>();
    for (const m of active) {
      if (m.kind === "agent" && !seen.has(m.token)) {
        seen.add(m.token);
        out = out.split(m.token).join(`the "${m.name}" subagent`);
      }
    }
    return out;
  }

  // codex / antigravity: inline referenced files.
  const seen = new Set<string>();
  const files = active.filter((m): m is Extract<Mention, { kind: "file" }> => {
    if (m.kind !== "file" || seen.has(m.path)) return false;
    seen.add(m.path);
    return true;
  });
  if (files.length === 0) return text;

  const blocks: string[] = [];
  for (const m of files) {
    try {
      blocks.push(fence(m.path, await readFile(m.path)));
    } catch {
      // Unreadable (deleted, binary, too large) — leave the @token as a bare reference.
    }
  }
  if (blocks.length === 0) return text;

  return `Referenced files (contents inlined below):\n\n${blocks.join("\n\n")}\n\n---\n\n${text}`;
}

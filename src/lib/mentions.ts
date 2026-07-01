/**
 * `@file` mentions are resolved differently per agent (verified 2026-07-01):
 * `claude -p` expands `@path` tokens natively (inlines file contents), but `codex exec`
 * and `agy --print` treat `@path` as literal text. So for codex/antigravity Kineloop must
 * inline the referenced files client-side before spawning; for claude it passes through.
 */

/** A file the user tagged via the `@` autocomplete, tracked so we know what to inline. */
export interface Mention {
  /** The exact token inserted into the composer, e.g. `@src/App.tsx`. */
  token: string;
  /** Repo-relative path used to read the file. */
  path: string;
}

/** Agents whose headless mode resolves `@path` natively; others need client-side inlining. */
export function agentResolvesMentions(agent: string): boolean {
  return agent === "claude";
}

/** Per-file cap on inlined content (characters); larger files are truncated with a marker. */
const MAX_INLINE_CHARS = 200_000;

function fence(path: string, contents: string): string {
  const capped =
    contents.length > MAX_INLINE_CHARS
      ? `${contents.slice(0, MAX_INLINE_CHARS)}\n… [truncated — file exceeds ${MAX_INLINE_CHARS} chars]`
      : contents;
  return `===== ${path} =====\n${capped}`;
}

/**
 * Produce the prompt text to send for `agent`, given the composed `text` and the mentions
 * recorded during editing.
 *
 * - `claude`: returns `text` unchanged (the CLI inlines `@path` itself).
 * - `codex` / `antigravity`: reads each mentioned file whose token still appears in `text`
 *   (de-duplicated by path, order preserved) and prepends a labeled block, then the message.
 *   Files that fail to read are skipped (their `@token` stays as a plain reference).
 *
 * `readFile` reads a repo-relative path from the session worktree.
 */
export async function buildPromptForAgent(
  text: string,
  mentions: Mention[],
  agent: string,
  readFile: (path: string) => Promise<string>,
): Promise<string> {
  if (agentResolvesMentions(agent)) return text;

  const seen = new Set<string>();
  const active = mentions.filter((m) => {
    if (seen.has(m.path)) return false;
    if (!text.includes(m.token)) return false; // token was edited away — don't inline
    seen.add(m.path);
    return true;
  });
  if (active.length === 0) return text;

  const blocks: string[] = [];
  for (const m of active) {
    try {
      blocks.push(fence(m.path, await readFile(m.path)));
    } catch {
      // Unreadable (deleted, binary, too large) — leave the @token as a bare reference.
    }
  }
  if (blocks.length === 0) return text;

  return `Referenced files (contents inlined below):\n\n${blocks.join("\n\n")}\n\n---\n\n${text}`;
}

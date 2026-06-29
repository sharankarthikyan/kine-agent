const STORAGE_KEY = "agent-editor.recentRepos";
const MAX_RECENTS = 8;

/**
 * Read the persisted list of recent repo paths from localStorage.
 * Returns [] on missing key or any parse error.
 */
export function getRecentRepos(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/**
 * Prepend `path` to the recents list.
 * If `path` is already in the list it is moved to the front (deduped).
 * The list is capped at MAX_RECENTS entries (most-recent-first).
 * Persists the result to localStorage.
 */
export function addRecentRepo(path: string): void {
  const current = getRecentRepos().filter((p) => p !== path);
  const next = [path, ...current].slice(0, MAX_RECENTS);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

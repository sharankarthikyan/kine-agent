/**
 * Return a human-readable relative time string for a Unix-ms timestamp.
 * Both `ts` and `now` are Unix milliseconds.
 * PURE: no Date.now() inside — callers must pass the reference time.
 */
export function relativeTime(ts: number, now: number): string {
  const diffSeconds = Math.floor((now - ts) / 1000);

  if (diffSeconds < 60) return "just now";

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return diffMinutes === 1 ? "1 min ago" : `${diffMinutes} mins ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return diffHours === 1 ? "1 hr ago" : `${diffHours} hrs ago`;

  const diffDays = Math.floor(diffHours / 24);
  return diffDays === 1 ? "1 day ago" : `${diffDays} days ago`;
}

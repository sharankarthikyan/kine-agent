const KEY = "kineloop.acpAdapterNoticeShown";

/**
 * True exactly once per install: the first ACP run downloads the pinned
 * claude-agent-acp package via npx, which can delay the first tokens by a
 * minute — worth a heads-up, once. There is no reliable way to probe the npx
 * cache from the frontend, so "first ACP start on this install" is the proxy.
 */
export function shouldShowAcpDownloadNotice(
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): boolean {
  if (storage.getItem(KEY) !== null) return false;
  storage.setItem(KEY, "1");
  return true;
}

// Sessions whose adapter notice has already been toasted this app run. Notices
// re-arrive on every fallback turn (each ACP turn is a fresh subprocess), but
// nagging once per turn would be noise — once per session is enough; the muted
// transcript row keeps the full record.
const toastedNoticeSessions = new Set<string>();

/** True the first time a session surfaces an adapter notice this app run. */
export function shouldToastSessionNotice(sessionId: string): boolean {
  if (toastedNoticeSessions.has(sessionId)) return false;
  toastedNoticeSessions.add(sessionId);
  return true;
}

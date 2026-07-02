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

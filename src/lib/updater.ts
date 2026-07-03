import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * In-app self-update, backed by the Tauri updater plugin. The plugin fetches the
 * signed `latest.json` manifest from the endpoint configured in tauri.conf.json,
 * compares it to the running version, and (on install) verifies the artifact
 * signature against the compiled-in public key before applying it.
 *
 * Two entry points share this module: a silent check on launch (see App.tsx) and
 * a manual "Check for updates" button in the titlebar. Both call `checkForUpdate`.
 */

/** Only reachable inside the Tauri desktop window — the plugin IPC is absent in a browser preview. */
function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Ask the endpoint whether a newer version exists.
 * Returns the pending `Update` (call `installUpdate` next) or `null` if already current.
 * Throws on network/endpoint/signature-config errors — callers decide whether to surface.
 */
export async function checkForUpdate(): Promise<Update | null> {
  if (!isDesktop()) return null;
  const update = await check();
  if (!update) return null;
  return update;
}

export interface DownloadProgress {
  /** Bytes downloaded so far. */
  downloaded: number;
  /** Total bytes to download, if the server advertised a Content-Length. */
  total: number | null;
}

/**
 * Download + verify + install a pending update, reporting byte progress.
 * On success the old binary is replaced; the caller should relaunch via `restartApp`.
 */
export async function installUpdate(
  update: Update,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onProgress?.({ downloaded, total });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.({ downloaded, total });
        break;
      case "Finished":
        onProgress?.({ downloaded, total });
        break;
    }
  });
}

/** Relaunch the app so the freshly installed version takes over. */
export async function restartApp(): Promise<void> {
  await relaunch();
}

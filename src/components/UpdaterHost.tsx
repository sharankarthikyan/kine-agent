import { useCallback, useEffect, useRef } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { checkForUpdate, installUpdate, restartApp } from "@/lib/updater";

const PROGRESS_TOAST = "kineloop-update-progress";

/** Event the native "Check for Updates…" menu item emits from Rust (lib.rs). */
const MENU_CHECK_EVENT = "menu://check-for-updates";

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Headless self-update controller. Renders nothing — it owns the updater IPC and
 * toast lifecycle for BOTH triggers:
 *  - a silent check on launch (surfaces a toast only when an update exists)
 *  - the native macOS menu item "Kineloop ▸ Check for Updates…", which emits
 *    `menu://check-for-updates` from Rust; that path always gives feedback
 *    (up-to-date / error) since the user asked explicitly.
 *
 * Mount once near the app root.
 */
export function UpdaterHost() {
  // Serializes the mount check, a menu click, and an in-flight install.
  const busy = useRef(false);

  const runInstall = useCallback(async (update: Update) => {
    if (busy.current) return;
    busy.current = true;
    toast.loading(`Downloading ${update.version}…`, { id: PROGRESS_TOAST });
    try {
      await installUpdate(update, ({ downloaded, total }) => {
        const label = total
          ? `Downloading ${update.version} — ${formatMb(downloaded)} / ${formatMb(total)}`
          : `Downloading ${update.version} — ${formatMb(downloaded)}`;
        toast.loading(label, { id: PROGRESS_TOAST });
      });
      toast.success(`Kineloop ${update.version} installed`, {
        id: PROGRESS_TOAST,
        description: "Restart to finish updating.",
        duration: Infinity,
        action: { label: "Restart now", onClick: () => void restartApp() },
      });
    } catch (err) {
      toast.error("Update failed to install", {
        id: PROGRESS_TOAST,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      busy.current = false;
    }
  }, []);

  const promptInstall = useCallback(
    (update: Update) => {
      toast(`Update available — Kineloop ${update.version}`, {
        description: update.body?.trim() || "A newer version is ready to install.",
        duration: Infinity,
        action: { label: "Install", onClick: () => void runInstall(update) },
      });
    },
    [runInstall],
  );

  // Silent check on launch — quiet when up to date or on transient errors.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const update = await checkForUpdate();
        if (!cancelled && update) promptInstall(update);
      } catch {
        // Offline / endpoint hiccup on launch is non-fatal — stay quiet.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [promptInstall]);

  // Manual check driven by the native menu item — always gives feedback.
  useEffect(() => {
    const unlisten = listen(MENU_CHECK_EVENT, async () => {
      if (busy.current) return;
      const pending = toast.loading("Checking for updates…");
      try {
        const update = await checkForUpdate();
        toast.dismiss(pending);
        if (update) {
          promptInstall(update);
        } else {
          toast.success("You're on the latest version");
        }
      } catch (err) {
        toast.dismiss(pending);
        toast.error("Couldn't check for updates", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [promptInstall]);

  return null;
}

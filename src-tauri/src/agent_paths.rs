//! Cross-platform resolution of user directories and external CLI executables.
//!
//! Centralizes every "where does the user's home / agent config live" decision so the
//! rest of the codebase never reaches for `$HOME` directly — which is unset on Windows.
//! `dirs::home_dir()` resolves the real profile directory on every OS (Known Folder API
//! on Windows, `$HOME` on Unix). The agent-specific helpers additionally honor the
//! documented relocation env vars (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).

use std::ffi::OsString;
use std::path::PathBuf;

/// The current user's home directory, cross-platform. `None` only in the rare case the
/// OS cannot report one (e.g. a service account with no profile).
pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Root of the user's Claude configuration (`~/.claude` by default). Honors the
/// `CLAUDE_CONFIG_DIR` override that Claude Code itself respects.
pub fn claude_config_dir() -> Option<PathBuf> {
    if let Some(dir) = non_empty_env("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    home_dir().map(|h| h.join(".claude"))
}

/// Root of the user's Codex configuration (`~/.codex` by default). Honors the
/// `CODEX_HOME` override that the Codex CLI respects.
pub fn codex_home_dir() -> Option<PathBuf> {
    if let Some(dir) = non_empty_env("CODEX_HOME") {
        return Some(PathBuf::from(dir));
    }
    home_dir().map(|h| h.join(".codex"))
}

/// Root of the user's Gemini configuration (`~/.gemini`). No documented relocation var.
pub fn gemini_config_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".gemini"))
}

fn non_empty_env(key: &str) -> Option<OsString> {
    std::env::var_os(key).filter(|v| !v.is_empty())
}

/// Kineloop's own per-user data directory (`<home>/.kineloop`), holding the session DB.
/// Falls back to the temp dir if no home is available. Per-session git worktrees do NOT
/// live here: they need a non-hidden path (the Antigravity CLI refuses hidden-path
/// workspaces), so they sit under a visible `<home>/Kineloop/worktrees`
/// (`commands::worktrees_root`). Pre-relocation sessions still resolve to the legacy
/// `<home>/.kineloop/worktrees`.
pub fn data_dir() -> PathBuf {
    home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".kineloop")
}

/// One-time migration of the pre-rename data directory (`~/.agent-editor`) to
/// `~/.kineloop`, including the SQLite DB file (and its WAL/SHM sidecars). Idempotent
/// and best-effort: runs only when the legacy directory exists and the new one does not,
/// so existing sessions and worktrees survive the rename. Safe to call on every launch.
pub fn migrate_legacy_data_dir() {
    let Some(home) = home_dir() else {
        return;
    };
    let legacy = home.join(".agent-editor");
    let current = home.join(".kineloop");

    if legacy.is_dir() && !current.exists() {
        // Same parent (the home dir), so this is a cheap rename, not a cross-device move.
        if std::fs::rename(&legacy, &current).is_err() {
            return;
        }
    }

    // Rename the DB file (+ WAL/SHM) inside the now-current directory.
    for (from, to) in [
        ("agent-editor.db", "kineloop.db"),
        ("agent-editor.db-wal", "kineloop.db-wal"),
        ("agent-editor.db-shm", "kineloop.db-shm"),
    ] {
        let from_path = current.join(from);
        let to_path = current.join(to);
        if from_path.exists() && !to_path.exists() {
            let _ = std::fs::rename(&from_path, &to_path);
        }
    }
}

/// Resolve an external CLI program name to a concrete path to spawn.
///
/// On Windows, agent CLIs installed via npm are `.cmd`/`.ps1` shims (e.g. `claude.cmd`,
/// `code.cmd`) that `std::process::Command::new("claude")` will NOT find — it only
/// auto-appends `.exe`. `which` performs PATHEXT-aware lookup and returns the real path
/// (including the `.cmd`), which `Command` can then execute. On Unix this resolves the
/// absolute path too; either way, if lookup fails we fall back to the bare name so the
/// caller's existing "not found" error path still fires.
pub fn resolve_program(name: &str) -> OsString {
    which::which(name)
        .map(PathBuf::into_os_string)
        .unwrap_or_else(|_| OsString::from(name))
}

/// Marker isolating `$PATH` from any profile stdout noise (banners, nvm messages).
#[cfg(unix)]
const PATH_MARKER: &str = "__KINELOOP_PATH__";

/// Adopt the user's login-shell PATH into this process — once.
///
/// A Finder/desktop launch inherits launchd's minimal PATH (typically
/// `/usr/bin:/bin:/usr/sbin:/sbin`), NOT the user's shell PATH — so Homebrew, npm and
/// `~/.local/bin` CLIs (claude, codex, agy, npx) all look "not installed" in the packaged
/// app even though the terminal finds them, and `npm run tauri dev` masks the bug by
/// inheriting the dev shell. Windows needs none of this: GUI processes there receive the
/// registry user+system PATH.
///
/// Best-effort: on any failure (no shell, timeout, unparseable output) the current PATH
/// is left untouched and the existing "not installed" flows still apply.
#[cfg(unix)]
pub fn adopt_login_shell_path() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let Some(login) = login_shell_path() else {
            eprintln!(
                "kineloop: could not read the login-shell PATH — agent CLIs may look \
                 missing when launched from Finder/desktop"
            );
            return;
        };
        let current = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", merged_path(&login, &current));
    });
}

/// No-op off Unix (see [`adopt_login_shell_path`] docs).
#[cfg(not(unix))]
pub fn adopt_login_shell_path() {}

/// Run the user's login shell and capture its `$PATH`, marker-delimited. Interactive +
/// login (`-l -i`) so both profile (`~/.zprofile`, Homebrew shellenv) and rc (`~/.zshrc`,
/// nvm) PATH edits apply. Bounded by a 5s timeout so a hung dotfile can never wedge app
/// startup; the child is killed either way.
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::Duration;

    let shell = std::env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| OsString::from("/bin/sh"));
    let shell_name = PathBuf::from(&shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    // fish's $PATH is a list — quoting joins it with spaces, so join it explicitly.
    let script = if shell_name == "fish" {
        format!("printf '{PATH_MARKER}%s' (string join ':' $PATH)")
    } else {
        format!("printf '{PATH_MARKER}%s' \"$PATH\"")
    };

    let mut child = crate::proc::std_command(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    // Read on a worker thread so a shell that never exits cannot block us; recv_timeout
    // bounds the wait and the child is killed regardless (same pattern as probe_alias).
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    let output = rx.recv_timeout(Duration::from_secs(5)).ok();
    let _ = child.kill();
    let _ = child.wait();
    extract_marked_path(&output?)
}

/// Pull the marker-delimited PATH out of shell output that may carry profile noise
/// before the marker and logout noise (own line) after it.
#[cfg(unix)]
fn extract_marked_path(output: &str) -> Option<String> {
    let start = output.rfind(PATH_MARKER)? + PATH_MARKER.len();
    let path = output[start..].split('\n').next().unwrap_or("").trim();
    if path.is_empty() {
        return None;
    }
    Some(path.to_string())
}

/// Login-shell entries first (their order preserved), then any current-process entries
/// not already present — keeps system fallbacks without duplicating anything.
#[cfg(unix)]
fn merged_path(login: &str, current: &str) -> String {
    let mut seen = std::collections::BTreeSet::new();
    login
        .split(':')
        .chain(current.split(':'))
        .filter(|e| !e.is_empty())
        .filter(|e| seen.insert(e.to_string()))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn extract_marked_path_survives_profile_and_logout_noise() {
        let out = format!("welcome banner\nnvm loaded\n{PATH_MARKER}/a/bin:/b/bin\ngoodbye\n");
        assert_eq!(extract_marked_path(&out).as_deref(), Some("/a/bin:/b/bin"));
    }

    #[test]
    fn extract_marked_path_rejects_missing_or_empty_marker() {
        assert_eq!(extract_marked_path("no marker here"), None);
        assert_eq!(extract_marked_path(&format!("noise\n{PATH_MARKER}\n")), None);
    }

    #[test]
    fn merged_path_prefers_login_order_and_dedups() {
        assert_eq!(
            merged_path("/hb/bin:/usr/bin", "/usr/bin:/bin:"),
            "/hb/bin:/usr/bin:/bin"
        );
        // Empty login output must never erase the current PATH.
        assert_eq!(merged_path("", "/usr/bin:/bin"), "/usr/bin:/bin");
    }

    /// Live capture: every Unix CI runner has a real `$SHELL` (or the /bin/sh fallback),
    /// so the login-shell PATH must come back non-empty within the timeout.
    #[test]
    fn login_shell_path_captures_a_real_path() {
        let path = login_shell_path().expect("login shell PATH");
        assert!(path.contains('/'), "not a PATH: {path:?}");
    }
}

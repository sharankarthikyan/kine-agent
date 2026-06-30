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

/// Kineloop's own per-user data directory (`<home>/.kineloop`), holding the session DB
/// and per-session git worktrees. Falls back to the temp dir if no home is available.
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

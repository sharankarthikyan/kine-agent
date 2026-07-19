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

/// Kine Agent's own per-user data directory (`<home>/.kine-agent`), holding the session DB.
/// Falls back to the temp dir if no home is available. Per-session git worktrees do NOT
/// live here: they need a non-hidden path (the Antigravity CLI refuses hidden-path
/// workspaces), so they sit under a visible `<home>/KineAgent/worktrees`
/// (`commands::worktrees_root`). Pre-relocation sessions still resolve to the legacy
/// worktree roots (`commands::legacy_worktrees_roots`).
pub fn data_dir() -> PathBuf {
    home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".kine-agent")
}

/// One-time migration of an older data directory to the current `~/.kine-agent`, including
/// the SQLite DB file (and its WAL/SHM sidecars). The product was renamed twice — the app
/// dir went `~/.agent-editor` → `~/.kineloop` → `~/.kine-agent` — so this migrates from
/// either predecessor. Idempotent and best-effort: the directory move runs only when a
/// legacy dir exists and the new one does not, so existing sessions survive the rename.
/// Safe to call on every launch.
pub fn migrate_legacy_data_dir() {
    let Some(home) = home_dir() else {
        return;
    };
    let current = home.join(".kine-agent");

    // Adopt the newest predecessor dir that still exists (only if we don't already have
    // our own). Same parent (the home dir), so each is a cheap rename, not a cross-device
    // move. `.kineloop` is preferred over `.agent-editor` as the more recent name.
    if !current.exists() {
        for legacy_name in [".kineloop", ".agent-editor"] {
            let legacy = home.join(legacy_name);
            if legacy.is_dir() {
                if std::fs::rename(&legacy, &current).is_err() {
                    return;
                }
                break;
            }
        }
    }

    // Rename any predecessor DB file (+ WAL/SHM) inside the now-current directory to the
    // current name. Ordered newest-first so a partially-migrated dir converges.
    for old_stem in ["kineloop", "agent-editor"] {
        for suffix in ["db", "db-wal", "db-shm"] {
            let from_path = current.join(format!("{old_stem}.{suffix}"));
            let to_path = current.join(format!("kine-agent.{suffix}"));
            if from_path.exists() && !to_path.exists() {
                let _ = std::fs::rename(&from_path, &to_path);
            }
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
const PATH_MARKER: &str = "__KINE_AGENT_PATH__";

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
        // If the inherited PATH already resolves `node`, this process was launched from a
        // shell that already sourced the user's profile (a terminal or `tauri dev`), so
        // there is nothing to adopt. Skipping avoids spawning the user's shell — which, on
        // macOS, runs their profile and can trigger a burst of Desktop/Documents/Downloads
        // access prompts attributed to this app (see `login_shell_path`).
        let current = std::env::var("PATH").unwrap_or_default();
        if resolves_node(&current) {
            return;
        }
        let Some(login) = login_shell_path() else {
            eprintln!(
                "kine-agent: could not read the login-shell PATH — agent CLIs may look \
                 missing when launched from Finder/desktop"
            );
            return;
        };
        std::env::set_var("PATH", merged_path(&login, &current));
    });
}

/// No-op off Unix (see [`adopt_login_shell_path`] docs).
#[cfg(not(unix))]
pub fn adopt_login_shell_path() {}

/// Capture the user's login-shell `$PATH`, preferring the quietest shell that still finds
/// `node`.
///
/// A NON-interactive login shell (`-l`) sources the login profile (`~/.zprofile`,
/// `~/.bash_profile` — where Homebrew's `shellenv` and most PATH setup live) but NOT the
/// interactive rc file (`~/.zshrc`). That distinction matters on macOS: the rc file is
/// where prompt frameworks and shell helpers run, and those routinely read `~/Desktop`,
/// `~/Documents`, `~/Downloads`, … — accesses the OS attributes to THIS app (the shell's
/// parent), producing a cascade of TCC permission prompts on launch. So we try `-l` first
/// and fall back to an interactive login shell (`-l -i`) only when the quiet PATH can't
/// find `node` (e.g. nvm, which appends to `~/.zshrc`).
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    let login = capture_shell_path(&["-l"]);
    if login.as_deref().is_some_and(resolves_node) {
        return login;
    }
    capture_shell_path(&["-l", "-i"]).or(login)
}

/// Whether `node` resolves on the given colon-separated `$PATH`. Used both to short-circuit
/// PATH adoption when the inherited env is already rich and to decide whether the quiet
/// login shell was enough. An empty PATH never resolves.
#[cfg(unix)]
fn resolves_node(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    which::which_in("node", Some(path), cwd).is_ok()
}

/// Run the user's login shell with `login_flags` and capture its `$PATH`, marker-delimited.
/// Bounded by a 5s timeout so a hung dotfile can never wedge app startup; the child is
/// killed either way.
#[cfg(unix)]
fn capture_shell_path(login_flags: &[&str]) -> Option<String> {
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
        .args(login_flags)
        .arg("-c")
        .arg(&script)
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

    /// `resolves_node` gates whether we spawn the user's shell at all, so it must find an
    /// executable `node` on a given PATH and reject empty / missing dirs.
    #[test]
    fn resolves_node_detects_an_executable_on_the_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("kine-node-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let node = dir.join("node");
        std::fs::write(&node, "#!/bin/sh\ntrue\n").unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(resolves_node(dir.to_str().unwrap()));
        assert!(!resolves_node(""));
        assert!(!resolves_node("/no/such/kine-agent/dir"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}

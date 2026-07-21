//! Lockfile-verified local install of the ACP adapter packages.
//!
//! The ACP engine used to launch its wrapper with `npx --yes <pkg>@<version>`.
//! The top-level version was pinned, but npx resolves TRANSITIVE dependencies
//! by semver range at run time and executes npm install scripts — so a
//! hijacked publish of any dependency became arbitrary code execution on the
//! user's machine, in a child that carries the BYOK API key in its env.
//!
//! Instead, each profile's `package.json` + `package-lock.json` (generated
//! against the pinned version, sha512 integrity for every package in the
//! tree) is embedded in the binary and materialized under
//! `<data_dir>/acp/<agent>-<version>/`, then installed with
//! `npm ci --ignore-scripts`. npm verifies every tarball against the lockfile
//! hashes, no lifecycle script ever runs (both packages are pure-JS launchers
//! with prebuilt platform binaries as scriptless optionalDependencies), and
//! the spawn runs the installed bin via `node` directly. Re-runs are offline:
//! a marker file skips the install entirely once it has succeeded.
//!
//! Bumping a pin: change the version in [`AcpLock`] AND regenerate the lock
//! dir under `src-tauri/acp-locks/` (`npm install --package-lock-only`) — the
//! `lock_matches_pinned_version` test fails if they drift apart.

use std::path::{Path, PathBuf};

/// Everything needed to install + launch one profile's ACP wrapper.
#[derive(Clone, Copy)]
pub struct AcpLock {
    pub agent: &'static str,
    /// Package name without version, e.g. `@zed-industries/codex-acp`.
    pub name: &'static str,
    pub version: &'static str,
    /// The package's `bin` entry, relative to the package root.
    pub bin_rel: &'static str,
    package_json: &'static str,
    package_lock: &'static str,
}

pub const CLAUDE_LOCK: AcpLock = AcpLock {
    agent: "claude",
    name: "@agentclientprotocol/claude-agent-acp",
    version: "0.54.1",
    bin_rel: "dist/index.js",
    package_json: include_str!("../../acp-locks/claude/package.json"),
    package_lock: include_str!("../../acp-locks/claude/package-lock.json"),
};

pub const CODEX_LOCK: AcpLock = AcpLock {
    agent: "codex",
    name: "@zed-industries/codex-acp",
    version: "0.16.0",
    bin_rel: "bin/codex-acp.js",
    package_json: include_str!("../../acp-locks/codex/package.json"),
    package_lock: include_str!("../../acp-locks/codex/package-lock.json"),
};

impl AcpLock {
    fn install_dir(&self, base: &Path) -> PathBuf {
        base.join(format!("{}-{}", self.agent, self.version))
    }

    fn bin_path(&self, install_dir: &Path) -> PathBuf {
        install_dir
            .join("node_modules")
            .join(self.name)
            .join(self.bin_rel)
    }
}

/// Marker written after a successful `npm ci`; its presence (plus the bin
/// file) means the install is complete and future launches skip npm entirely.
const OK_MARKER: &str = ".install-ok";

/// Serializes installs within this process so two sessions starting at once
/// don't run `npm ci` into the same directory.
static INSTALL_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// True once a completed install for this pin exists — lets the caller show a
/// "downloading" status only when [`ensure_installed`] will actually hit npm.
pub fn is_installed(lock: AcpLock) -> bool {
    let dir = lock.install_dir(&crate::agent_paths::data_dir().join("acp"));
    dir.join(OK_MARKER).is_file() && lock.bin_path(&dir).is_file()
}

/// Ensure the profile's wrapper is installed and return the absolute path of
/// its JS bin. Fast path (already installed) touches only the filesystem.
pub async fn ensure_installed(lock: AcpLock) -> Result<PathBuf, String> {
    let base = crate::agent_paths::data_dir().join("acp");
    let dir = lock.install_dir(&base);
    let bin = lock.bin_path(&dir);
    if dir.join(OK_MARKER).is_file() && bin.is_file() {
        return Ok(bin);
    }

    let _gate = INSTALL_GATE.lock().await;
    // Re-check under the gate: a concurrent session may have just finished.
    if dir.join(OK_MARKER).is_file() && bin.is_file() {
        return Ok(bin);
    }

    if which::which("npm").is_err() {
        return Err(
            "npm is required to set up the ACP engine — install Node.js or switch the session back to the default engine"
                .to_string(),
        );
    }

    // Install into a temp sibling, then rename into place so a killed app
    // mid-install can never leave a half-populated dir that passes the marker
    // check, and a concurrent second app instance loses the race harmlessly.
    let tmp = base.join(format!(".tmp-{}-{}-{}", lock.agent, lock.version, std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
    std::fs::write(tmp.join("package.json"), lock.package_json)
        .map_err(|e| format!("write package.json: {e}"))?;
    std::fs::write(tmp.join("package-lock.json"), lock.package_lock)
        .map_err(|e| format!("write package-lock.json: {e}"))?;

    let npm = crate::agent_paths::resolve_program("npm");
    let output = crate::proc::tokio_command(&npm)
        .args([
            "ci",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
        ])
        .current_dir(&tmp)
        .output()
        .await
        .map_err(|e| format!("npm ci: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr
            .lines()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "downloading the {} ACP adapter failed (check your network and retry): {tail}",
            lock.name
        ));
    }
    if !lock.bin_path(&tmp).is_file() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "ACP adapter install for {} completed but its bin {} is missing — the package layout may have changed; report this",
            lock.name, lock.bin_rel
        ));
    }
    std::fs::write(tmp.join(OK_MARKER), b"").map_err(|e| format!("write marker: {e}"))?;

    match std::fs::rename(&tmp, &dir) {
        Ok(()) => {}
        Err(_) if dir.join(OK_MARKER).is_file() && bin.is_file() => {
            // Another app instance won the cross-process race; use theirs.
            let _ = std::fs::remove_dir_all(&tmp);
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("finalize ACP adapter install: {e}"));
        }
    }

    cleanup_stale_versions(&base, lock);
    Ok(bin)
}

/// Best-effort removal of older installed versions of this agent's wrapper
/// (left behind by pin bumps). Never fails the launch.
fn cleanup_stale_versions(base: &Path, lock: AcpLock) {
    let current = format!("{}-{}", lock.agent, lock.version);
    let prefix = format!("{}-", lock.agent);
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with(&prefix) && name != current {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The committed lockfiles must stay in sync with the pinned versions:
    /// bumping one without regenerating the other silently reverts the
    /// supply-chain protection this module exists for.
    #[test]
    fn lock_matches_pinned_version() {
        for lock in [CLAUDE_LOCK, CODEX_LOCK] {
            let parsed: serde_json::Value =
                serde_json::from_str(lock.package_lock).expect("lockfile is valid JSON");
            let pkg_key = format!("node_modules/{}", lock.name);
            let entry = parsed["packages"][&pkg_key]
                .as_object()
                .unwrap_or_else(|| panic!("{} missing from {} lockfile", pkg_key, lock.agent));
            assert_eq!(
                entry["version"].as_str(),
                Some(lock.version),
                "{}: lockfile version drifted from the pin — regenerate src-tauri/acp-locks/{}",
                lock.name,
                lock.agent
            );
            assert!(
                entry["integrity"]
                    .as_str()
                    .is_some_and(|i| i.starts_with("sha512-")),
                "{}: lockfile entry has no sha512 integrity",
                lock.name
            );
            // Every dependency in the tree must carry integrity (or be a
            // symlink/root entry) — otherwise npm ci can't verify it.
            for (key, pkg) in parsed["packages"].as_object().expect("packages map") {
                if key.is_empty() {
                    continue; // root project entry
                }
                assert!(
                    pkg["integrity"].as_str().is_some_and(|i| i.starts_with("sha")),
                    "{}: {key} lacks integrity hash",
                    lock.agent
                );
            }
        }
    }

    #[test]
    fn install_layout_is_stable() {
        let base = Path::new("/base");
        let dir = CODEX_LOCK.install_dir(base);
        assert_eq!(dir, Path::new("/base/codex-0.16.0"));
        assert_eq!(
            CODEX_LOCK.bin_path(&dir),
            Path::new("/base/codex-0.16.0/node_modules/@zed-industries/codex-acp/bin/codex-acp.js")
        );
    }

    #[test]
    fn cleanup_removes_only_stale_siblings_of_same_agent() {
        let base = std::env::temp_dir().join(format!("ae-acp-cleanup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        for name in ["codex-0.15.0", "codex-0.16.0", "claude-0.54.1", "unrelated"] {
            std::fs::create_dir(base.join(name)).unwrap();
        }
        cleanup_stale_versions(&base, CODEX_LOCK);
        assert!(!base.join("codex-0.15.0").exists());
        assert!(base.join("codex-0.16.0").exists());
        assert!(base.join("claude-0.54.1").exists());
        assert!(base.join("unrelated").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}

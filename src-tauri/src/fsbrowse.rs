//! Read-only filesystem browsing for `@/` and `@~/` mentions in the composer.
//!
//! This intentionally reaches OUTSIDE the session worktree, so it is deliberately narrow:
//! listing is non-recursive and capped; reads are regular-files-only and byte-capped; a
//! leading `~` expands to the user's home. It is user-initiated (the user types the path)
//! and read-only — it never writes, deletes, or executes. The UI surfaces a caution notice
//! when browsing here. As defense in depth, a fixed denylist blocks credential/secret
//! locations (SSH keys, cloud CLI configs, the OS keychain, Kine Agent's own data dir) even
//! though the rest of the filesystem stays reachable — see `reject_if_sensitive`.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Max directory entries returned in one listing (keeps huge dirs from flooding the UI).
const DIR_CAP: usize = 1000;
/// Max bytes read from a single file for inlining a global `@` mention.
const MAX_READ_BYTES: u64 = 512 * 1024;

/// Home-relative locations that stay off-limits regardless of the path the user typed:
/// SSH keys, cloud CLI credentials/config (`.docker/config.json` holds registry
/// credentials), and the macOS keychain. Matched by canonicalized-path prefix — see
/// `denylisted_roots` — so a symlink into one of these can't dodge the check.
const DENYLISTED_HOME_RELATIVE: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".config/gcloud",
    ".kube",
    ".azure",
    ".docker",
    ".netrc",
    "Library/Keychains", // macOS keychain files; no-ops elsewhere since the dir won't exist
];

/// One immediate child of a browsed directory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Expand a leading `~` (or `~/…`) to `home`; other paths pass through. `home` is injectable
/// so tests can exercise the denylist against a fabricated home instead of mutating the real
/// one; production callers pass `dirs::home_dir()`.
fn expand_home_with(path: &str, home: Option<&Path>) -> PathBuf {
    if path == "~" {
        return home
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

/// Denylisted roots for a given home and app-data directory, canonicalized where possible so
/// comparisons happen in fully-resolved space — the same space the target path is resolved
/// into in `reject_if_sensitive`, which is what lets this catch a symlink that points into a
/// denylisted directory from outside it. A root that doesn't exist yet on this machine is
/// kept un-canonicalized as a best-effort fallback (still an exact-prefix match).
fn denylisted_roots(home: &Path, data_dir: &Path) -> Vec<PathBuf> {
    DENYLISTED_HOME_RELATIVE
        .iter()
        .map(|rel| home.join(rel))
        .chain(std::iter::once(data_dir.to_path_buf()))
        .map(|root| root.canonicalize().unwrap_or(root))
        .collect()
}

/// Whether an already-canonicalized `path` falls under any of `roots` (also already
/// canonicalized). Pure and side-effect free, kept separate from path resolution so it is
/// directly unit-testable with fabricated paths.
fn is_denylisted(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

/// Canonicalize `resolved` and reject it if it falls under a sensitive location. Runs AFTER
/// canonicalization so a symlink pointing into a denylisted directory can't dodge the check.
/// `original` is only used to echo the user-typed path back in the error. No-ops (allows)
/// when there is no home directory to protect anything relative to.
fn reject_if_sensitive(
    resolved: &Path,
    home: Option<&Path>,
    data_dir: &Path,
    original: &str,
) -> Result<(), String> {
    let Some(home) = home else {
        return Ok(());
    };
    let canonical = resolved
        .canonicalize()
        .map_err(|e| format!("cannot open {original}: {e}"))?;
    let home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let roots = denylisted_roots(&home, data_dir);
    if is_denylisted(&canonical, &roots) {
        return Err(format!("path not allowed: {original}"));
    }
    Ok(())
}

/// List the immediate children of `path` (non-recursive, capped, dirs-first then
/// alphabetical). `~` expands to home. Errors if the path is missing, not a directory, or
/// denylisted (see the module docs).
pub fn list_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    list_dir_with(
        path,
        dirs::home_dir().as_deref(),
        &crate::agent_paths::data_dir(),
    )
}

fn list_dir_with(
    path: &str,
    home: Option<&Path>,
    data_dir: &Path,
) -> Result<Vec<DirEntry>, String> {
    let dir = expand_home_with(path, home);
    let meta = std::fs::metadata(&dir).map_err(|e| format!("cannot open {path}: {e}"))?;
    if !meta.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    reject_if_sensitive(&dir, home, data_dir, path)?;

    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir,
        });
        if out.len() >= DIR_CAP {
            break;
        }
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// Read a text file (UTF-8, lossy) at an absolute or `~`-expanded path, for inlining a global
/// `@` mention into codex/antigravity prompts. Regular files only; truncated at the byte
/// cap. Errors if the path is missing, not a file, or denylisted (see the module docs).
pub fn read_file(path: &str) -> Result<String, String> {
    read_file_with(
        path,
        dirs::home_dir().as_deref(),
        &crate::agent_paths::data_dir(),
    )
}

fn read_file_with(path: &str, home: Option<&Path>, data_dir: &Path) -> Result<String, String> {
    use std::io::Read;

    let file_path = expand_home_with(path, home);
    let meta = std::fs::metadata(&file_path).map_err(|e| format!("cannot open {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {path}"));
    }
    reject_if_sensitive(&file_path, home, data_dir, path)?;

    let mut buf = Vec::new();
    std::fs::File::open(&file_path)
        .map_err(|e| e.to_string())?
        .take(MAX_READ_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static CTR: AtomicU64 = AtomicU64::new(0);

    fn test_dir(tag: &str) -> PathBuf {
        let n = CTR.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("ae-fs-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A fabricated home directory for denylist tests — never the real `$HOME`, so tests
    /// stay hermetic and safe under a parallel test run (see `commands.rs`'s
    /// `CLAUDE_CONFIG_DIR` test for why mutating real env vars for this is avoided).
    fn test_home(tag: &str) -> PathBuf {
        test_dir(&format!("home-{tag}"))
    }

    #[test]
    fn list_dir_returns_children_dirs_first() {
        let dir = test_dir("list");
        fs::write(dir.join("z.txt"), "z").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), "a").unwrap();

        let entries = list_dir(dir.to_str().unwrap()).unwrap();
        assert_eq!(entries[0].name, "sub");
        assert!(entries[0].is_dir);
        let files: Vec<_> = entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| &e.name)
            .collect();
        assert_eq!(files, vec!["a.txt", "z.txt"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_dir_errors_on_a_file() {
        let dir = test_dir("list-file");
        let f = dir.join("f.txt");
        fs::write(&f, "x").unwrap();
        assert!(list_dir(f.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_reads_and_rejects_directories() {
        let dir = test_dir("read");
        fs::write(dir.join("hi.txt"), "hello\n").unwrap();
        assert_eq!(
            read_file(dir.join("hi.txt").to_str().unwrap()).unwrap(),
            "hello\n"
        );
        assert!(read_file(dir.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_truncates_at_the_cap() {
        let dir = test_dir("read-large");
        let big = "a".repeat((MAX_READ_BYTES as usize) + 4096);
        fs::write(dir.join("big.txt"), &big).unwrap();
        let out = read_file(dir.join("big.txt").to_str().unwrap()).unwrap();
        assert_eq!(out.len(), MAX_READ_BYTES as usize);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn expand_home_maps_tilde_to_home() {
        if let Some(home) = dirs::home_dir() {
            assert_eq!(expand_home_with("~", Some(&home)), home);
            assert_eq!(expand_home_with("~/docs", Some(&home)), home.join("docs"));
        }
        assert_eq!(
            expand_home_with("/etc/hosts", dirs::home_dir().as_deref()),
            PathBuf::from("/etc/hosts")
        );
    }

    #[test]
    fn denylist_blocks_reading_a_file_under_home_ssh() {
        let home = test_home("ssh-read");
        let ssh = home.join(".ssh");
        fs::create_dir_all(&ssh).unwrap();
        fs::write(ssh.join("id_rsa"), "secret").unwrap();
        let data_dir = home.join("does-not-exist-data-dir");

        let err = read_file_with(ssh.join("id_rsa").to_str().unwrap(), Some(&home), &data_dir)
            .unwrap_err();
        assert!(err.contains("not allowed"), "unexpected error: {err}");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn denylist_blocks_listing_home_ssh() {
        let home = test_home("ssh-list");
        fs::create_dir_all(home.join(".ssh")).unwrap();
        let data_dir = home.join("does-not-exist-data-dir");

        let err =
            list_dir_with(home.join(".ssh").to_str().unwrap(), Some(&home), &data_dir).unwrap_err();
        assert!(err.contains("not allowed"), "unexpected error: {err}");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    #[cfg(unix)]
    fn denylist_blocks_a_symlink_that_resolves_into_home_ssh() {
        use std::os::unix::fs::symlink;

        let home = test_home("ssh-symlink");
        let ssh = home.join(".ssh");
        fs::create_dir_all(&ssh).unwrap();
        fs::write(ssh.join("id_rsa"), "secret").unwrap();
        let data_dir = home.join("does-not-exist-data-dir");

        // A symlink OUTSIDE home, pointing into the denylisted directory — the literal
        // requested path carries no hint of `.ssh`, so only post-canonicalization matching
        // catches it.
        let outside = test_dir("symlink-outside");
        let sneaky = outside.join("sneaky");
        symlink(&ssh, &sneaky).unwrap();

        let err = list_dir_with(sneaky.to_str().unwrap(), Some(&home), &data_dir).unwrap_err();
        assert!(err.contains("not allowed"), "unexpected error: {err}");

        let err = read_file_with(
            sneaky.join("id_rsa").to_str().unwrap(),
            Some(&home),
            &data_dir,
        )
        .unwrap_err();
        assert!(err.contains("not allowed"), "unexpected error: {err}");

        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn denylist_blocks_the_apps_own_data_dir() {
        let home = test_home("appdata");
        let data_dir = test_dir("appdata-real");
        fs::write(data_dir.join("kine-agent.db"), "db").unwrap();

        let err = list_dir_with(data_dir.to_str().unwrap(), Some(&home), &data_dir).unwrap_err();
        assert!(err.contains("not allowed"), "unexpected error: {err}");

        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn denylist_leaves_a_normal_temp_dir_reachable() {
        let home = test_home("normal");
        let data_dir = home.join("does-not-exist-data-dir");
        let dir = test_dir("normal-allowed");
        fs::write(dir.join("f.txt"), "hi").unwrap();

        let entries = list_dir_with(dir.to_str().unwrap(), Some(&home), &data_dir).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            read_file_with(dir.join("f.txt").to_str().unwrap(), Some(&home), &data_dir).unwrap(),
            "hi"
        );

        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&dir);
    }
}

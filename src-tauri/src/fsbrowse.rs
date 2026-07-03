//! Read-only filesystem browsing for `@/` and `@~/` mentions in the composer.
//!
//! This intentionally reaches OUTSIDE the session worktree, so it is deliberately narrow:
//! listing is non-recursive and capped; reads are regular-files-only and byte-capped; a
//! leading `~` expands to the user's home. It is user-initiated (the user types the path)
//! and read-only — it never writes, deletes, or executes. The UI surfaces a caution notice
//! when browsing here.

use serde::Serialize;
use std::path::PathBuf;

/// Max directory entries returned in one listing (keeps huge dirs from flooding the UI).
const DIR_CAP: usize = 1000;
/// Max bytes read from a single file for inlining a global `@` mention.
const MAX_READ_BYTES: u64 = 512 * 1024;

/// One immediate child of a browsed directory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Expand a leading `~` (or `~/…`) to the user's home directory; other paths pass through.
fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

/// List the immediate children of `path` (non-recursive, capped, dirs-first then alphabetical).
/// `~` expands to home. Errors if the path is missing or not a directory.
pub fn list_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    let dir = expand_home(path);
    let meta = std::fs::metadata(&dir).map_err(|e| format!("cannot open {path}: {e}"))?;
    if !meta.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

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
/// `@` mention into codex/antigravity prompts. Regular files only; truncated at the byte cap.
pub fn read_file(path: &str) -> Result<String, String> {
    use std::io::Read;

    let file_path = expand_home(path);
    let meta = std::fs::metadata(&file_path).map_err(|e| format!("cannot open {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {path}"));
    }

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
            assert_eq!(expand_home("~"), home);
            assert_eq!(expand_home("~/docs"), home.join("docs"));
        }
        assert_eq!(expand_home("/etc/hosts"), PathBuf::from("/etc/hosts"));
    }
}

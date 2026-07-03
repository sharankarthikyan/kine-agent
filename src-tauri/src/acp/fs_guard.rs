//! Worktree containment for the ACP fs proxy (spec §Inbound request handling, M4).
//!
//! Whole-path `canonicalize` fails for files that don't exist yet — the common
//! agent case is writing a NEW file — so: canonicalize the nearest EXISTING
//! ancestor, require that under the canonicalized root, then lexically reject
//! `..` in the remaining (non-existing) suffix before joining. Both sides of
//! the containment check are canonicalized, which also normalizes Windows
//! `\\?\` verbatim prefixes. Check-to-use TOCTOU is accepted risk for a local
//! single-user app.

use std::path::{Component, Path, PathBuf};

/// Resolve `requested` to an absolute path guaranteed inside `canonical_root`,
/// or explain why it was rejected. `canonical_root` must already be
/// canonicalized by the caller (once per session, not per request).
pub fn resolve_within_root(canonical_root: &Path, requested: &str) -> Result<PathBuf, String> {
    if requested.trim().is_empty() {
        return Err("empty path".to_string());
    }
    let requested_path = Path::new(requested);
    let candidate: PathBuf = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        canonical_root.join(requested_path)
    };

    // Split into (deepest existing ancestor, non-existing suffix).
    let mut ancestor = candidate.clone();
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    loop {
        // `symlink_metadata` reports existence WITHOUT following the final
        // symlink component (unlike `exists()`, which follows links and
        // reports `false` for a dangling one). A dangling symlink must count
        // as "existing" here so it becomes the ancestor to canonicalize —
        // `std::fs::canonicalize` then fails on it (broken link) and the
        // request is rejected, instead of the dangling link being treated as
        // a non-existing path suffix that a later `tokio::fs::write` would
        // follow and use to CREATE the symlink's (possibly outside-root)
        // target.
        if ancestor.symlink_metadata().is_ok() {
            break;
        }
        match (ancestor.parent(), ancestor.file_name()) {
            (Some(parent), Some(name)) => {
                suffix.push(name.to_os_string());
                ancestor = parent.to_path_buf();
            }
            // Walked off the top without finding anything that exists.
            _ => return Err(format!("path has no existing ancestor: {requested}")),
        }
    }
    // NOTE: `parent()`/`file_name()` return None for `..` tails, but a `..`
    // BETWEEN components would be consumed silently — reject them lexically
    // over the whole candidate first, so no normalization ambiguity survives.
    if candidate
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("path may not contain '..': {requested}"));
    }

    let canonical_ancestor = std::fs::canonicalize(&ancestor)
        .map_err(|e| format!("cannot resolve {}: {e}", ancestor.display()))?;
    if !canonical_ancestor.starts_with(canonical_root) {
        return Err(format!("path escapes the session worktree: {requested}"));
    }

    let mut resolved = canonical_ancestor;
    for part in suffix.iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

/// Security review §3 defense-in-depth: the diff basis lives INSIDE the
/// proxy-writable surface — a write to the worktree's own `.git` path (the
/// linked worktree's gitdir-pointer FILE, or any `.git/...` control file)
/// could make `git diff` misleading. Reject writes whose root-relative FIRST
/// component is exactly `.git`. Reads stay allowed; `.gitignore`/`.github`
/// and non-root `.git` dirs (vendored repos) stay writable. Case: `resolved`
/// comes from `resolve_within_root`, whose ancestor canonicalization already
/// normalizes an existing `.GIT` to the on-disk `.git` on case-insensitive
/// filesystems — exact comparison suffices. Residual: that normalization only
/// fires once `.git` already exists — if the root has none yet, a case
/// variant (`.GIT/x`) resolves through the non-existing suffix un-normalized
/// and slips past the exact match. Unreachable in product: worktree creation
/// always writes the `.git` pointer before any fs/* traffic starts, this
/// proxy has no delete op, and an agent able to remove `.git` out-of-band
/// could already rewrite it out-of-band too — so the guard's real property,
/// that an EXISTING diff basis can't be corrupted via fs/write, still holds.
pub fn reject_git_control_write(
    canonical_root: &Path,
    resolved: &Path,
    requested: &str,
) -> Result<(), String> {
    let Ok(relative) = resolved.strip_prefix(canonical_root) else {
        // resolve_within_root guarantees containment; a non-prefix here is a
        // caller bug — fail closed.
        return Err(format!(
            "writes to the worktree's own .git path are not allowed: {requested}"
        ));
    };
    let first_is_git = matches!(
        relative.components().next(),
        Some(Component::Normal(name)) if name == ".git"
    );
    if first_is_git {
        return Err(format!(
            "writes to the worktree's own .git path are not allowed: {requested}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A canonicalized tempdir root with one file and one subdir:
    ///   <root>/existing.txt, <root>/sub/
    /// Canonicalized because macOS tempdirs live behind the /tmp → /private/tmp
    /// symlink — un-canonicalized expectations fail containment spuriously.
    ///
    /// No `tempfile` dev-dependency exists in this crate, so this mirrors the
    /// hand-rolled `std::env::temp_dir()` + pid-and-tag-tagged directory
    /// pattern already used by `inspect.rs`/`external_sessions.rs` tests,
    /// with a best-effort `remove_dir_all` cleanup at the end of each test.
    /// `tag` must be unique per test so parallel `cargo test` runs (same
    /// process, same pid) don't collide on the same directory.
    fn root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kl-fsguard-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        fs::write(root.join("existing.txt"), "hello").unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        root
    }

    #[test]
    fn accepts_existing_file_inside_root() {
        let root = root("accepts-existing-file");
        let p = resolve_within_root(&root, root.join("existing.txt").to_str().unwrap()).unwrap();
        assert_eq!(p, root.join("existing.txt"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_new_file_in_existing_dir() {
        let root = root("accepts-new-in-existing-dir");
        let p = resolve_within_root(&root, root.join("sub/new.txt").to_str().unwrap()).unwrap();
        assert_eq!(p, root.join("sub/new.txt"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_new_file_under_new_nested_dirs() {
        let root = root("accepts-new-nested-dirs");
        let p = resolve_within_root(&root, root.join("a/b/c.txt").to_str().unwrap()).unwrap();
        assert_eq!(p, root.join("a/b/c.txt"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_relative_paths_against_the_root() {
        let root = root("resolves-relative");
        let p = resolve_within_root(&root, "sub/new.txt").unwrap();
        assert_eq!(p, root.join("sub/new.txt"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_parent_dir_escape() {
        let root = root("rejects-parent-escape");
        assert!(resolve_within_root(&root, root.join("../outside.txt").to_str().unwrap()).is_err());
        assert!(resolve_within_root(&root, "sub/../../outside.txt").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_absolute_path_outside_root() {
        let root = root("rejects-absolute-outside");
        assert!(resolve_within_root(&root, "/etc/passwd").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_dotdot_in_nonexisting_suffix() {
        let root = root("rejects-dotdot-in-suffix");
        // Ancestor "<root>/ghost" doesn't exist; the suffix still may not climb.
        assert!(resolve_within_root(&root, root.join("ghost/../..").to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_ancestor_pointing_outside_root() {
        let root = root("rejects-symlink-outside-root");
        let outside_dir =
            std::env::temp_dir().join(format!("kl-fsguard-symlink-outside-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside_dir);
        fs::create_dir_all(&outside_dir).unwrap();
        std::os::unix::fs::symlink(&outside_dir, root.join("link")).unwrap();
        // <root>/link exists and is inside lexically, but canonicalizes outside.
        assert!(resolve_within_root(&root, root.join("link/new.txt").to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside_dir);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_dangling_symlink_final_component() {
        let root = root("rejects-dangling-symlink");
        // Dangling link: target does not exist, so exists() would say false and
        // (pre-fix) the link joins the "non-existing suffix" — a write through
        // the returned path would CREATE the outside target. Must reject.
        std::os::unix::fs::symlink("/nonexistent-outside-target", root.join("link")).unwrap();
        assert!(resolve_within_root(&root, root.join("link").to_str().unwrap()).is_err());
        assert!(
            resolve_within_root(&root, root.join("link/nested.txt").to_str().unwrap()).is_err()
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_lexical_prefix_confusion_sibling() {
        let root = root("rejects-lexical-prefix-sibling");
        // Sibling dir whose name string-prefixes the root must not pass containment.
        let sibling = root.parent().unwrap().join(format!(
            "{}-evil",
            root.file_name().unwrap().to_str().unwrap()
        ));
        fs::create_dir_all(&sibling).unwrap();
        let result = resolve_within_root(&root, sibling.join("x.txt").to_str().unwrap());
        let _ = fs::remove_dir_all(&sibling);
        assert!(result.is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn accepts_in_root_symlink_to_in_root_target() {
        let root = root("accepts-in-root-symlink");
        std::os::unix::fs::symlink(root.join("existing.txt"), root.join("alias.txt")).unwrap();
        let p = resolve_within_root(&root, root.join("alias.txt").to_str().unwrap()).unwrap();
        assert_eq!(p, root.join("existing.txt")); // canonicalized to the target
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_empty_path() {
        let root = root("rejects-empty-path");
        assert!(resolve_within_root(&root, "").is_err());
        assert!(resolve_within_root(&root, "   ").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_write_to_git_pointer_file_and_nested_git_paths() {
        let root = root("git-reject");
        let resolved_pointer = root.join(".git");
        assert!(reject_git_control_write(&root, &resolved_pointer, ".git").is_err());
        let resolved_nested = root.join(".git").join("hooks").join("pre-commit");
        assert!(reject_git_control_write(&root, &resolved_nested, ".git/hooks/pre-commit").is_err());
        let err = reject_git_control_write(&root, &resolved_pointer, ".git").unwrap_err();
        assert_eq!(err, "writes to the worktree's own .git path are not allowed: .git");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn allows_gitignore_github_and_non_root_git_dirs() {
        let root = root("git-allow");
        for (rel, req) in [
            (root.join(".gitignore"), ".gitignore"),
            (root.join(".gitattributes"), ".gitattributes"),
            (
                root.join(".github").join("workflows").join("ci.yml"),
                ".github/workflows/ci.yml",
            ),
            (
                root.join("src").join("vendor").join(".git").join("config"),
                "src/vendor/.git/config",
            ),
            (root.join("git").join("notes.md"), "git/notes.md"),
        ] {
            assert!(
                reject_git_control_write(&root, &rel, req).is_ok(),
                "must allow {req}"
            );
        }
        let _ = fs::remove_dir_all(&root);
    }
}

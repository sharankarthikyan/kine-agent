use std::path::{Path, PathBuf};

/// An isolated git worktree for one session.
#[derive(Debug, Clone, PartialEq)]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: String,
}

#[derive(Debug, thiserror::Error)]
pub enum WorktreeError {
    #[error("invalid session id {0:?}: expected non-empty [A-Za-z0-9_-]")]
    InvalidSessionId(String),
    #[error("git {op} failed: {stderr}")]
    Git { op: &'static str, stderr: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Branch name for a session. Kept deterministic so a session maps to one branch.
pub fn branch_name(session_id: &str) -> String {
    format!("agent/{session_id}")
}

/// Upper bound on a session id's length. Generated ids are UUIDs (36 chars); this
/// guards against a WebView-supplied id long enough to overflow a path component
/// (commonly 255 bytes) or produce an unwieldy git ref.
const MAX_SESSION_ID_LEN: usize = 128;

/// Reject session ids that aren't a safe, flat token. The id is interpolated into
/// a filesystem path and a git ref, so anything outside `[A-Za-z0-9_-]` (notably
/// `/`, `.`, `..`) is refused — defense-in-depth against path traversal / ref
/// injection from WebView-supplied input, even though ids are generated UUIDs. The
/// length is bounded too, so an over-long id fails fast with a clear error rather
/// than a cryptic filesystem/git failure deeper in `create`.
fn validate_session_id(session_id: &str) -> Result<(), WorktreeError> {
    let ok = !session_id.is_empty()
        && session_id.len() <= MAX_SESSION_ID_LEN
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(WorktreeError::InvalidSessionId(session_id.to_string()))
    }
}

/// Resolve (without creating) the Worktree a session id maps to under `worktrees_root`.
/// Validates the id. Used by both `create` and cleanup so the mapping lives in one place.
pub fn worktree_for(worktrees_root: &Path, session_id: &str) -> Result<Worktree, WorktreeError> {
    validate_session_id(session_id)?;
    Ok(Worktree {
        path: worktrees_root.join(session_id),
        branch: branch_name(session_id),
    })
}

/// Create a worktree for `session_id` at `<worktrees_root>/<session_id>`, on a new
/// branch `agent/<session_id>` based on the repo's current HEAD. Shares the repo's
/// `.git` (reuses the local checkout — never clones).
pub fn create(
    repo: &Path,
    worktrees_root: &Path,
    session_id: &str,
) -> Result<Worktree, WorktreeError> {
    let Worktree { path, branch } = worktree_for(worktrees_root, session_id)?;
    std::fs::create_dir_all(worktrees_root)?;

    // Self-heal stale worktree administrative entries left by a crash or a worktree
    // directory the user deleted by hand. Without this, `git worktree add` for a path
    // git still has registered (but whose directory is gone) fails with "already
    // registered". Prune is safe — it only removes entries whose working tree is
    // missing — and best-effort, so its own failure never blocks the add.
    let _ = crate::proc::std_command("git")
        .arg("-C")
        .arg(repo)
        .args(["worktree", "prune"])
        .output();

    let output = crate::proc::std_command("git")
        .arg("-C")
        .arg(repo)
        .args(["worktree", "add", "-b", &branch])
        .arg(&path)
        .arg("HEAD")
        .output()?;

    if !output.status.success() {
        return Err(WorktreeError::Git {
            op: "worktree add",
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(Worktree { path, branch })
}

/// Remove a worktree and delete its branch. Idempotent: when the worktree directory is
/// already gone (a prior partial cleanup or a manual `rm`), this prunes the stale git
/// admin entry instead of failing, so callers can always reach a clean state. A genuine
/// `git worktree remove` failure on an existing worktree (e.g. a Windows sharing
/// violation) is still surfaced so the caller can keep the session and retry.
pub fn remove(repo: &Path, wt: &Worktree) -> Result<(), WorktreeError> {
    if wt.path.exists() {
        let rm = crate::proc::std_command("git")
            .arg("-C")
            .arg(repo)
            .args(["worktree", "remove", "--force"])
            .arg(&wt.path)
            .output()?;
        if !rm.status.success() {
            return Err(WorktreeError::Git {
                op: "worktree remove",
                stderr: String::from_utf8_lossy(&rm.stderr).trim().to_string(),
            });
        }
    } else {
        // Directory already gone — reconcile the leftover `.git/worktrees/<id>` admin
        // entry so the slot is reusable. Best-effort: a prune failure isn't fatal here.
        let _ = crate::proc::std_command("git")
            .arg("-C")
            .arg(repo)
            .args(["worktree", "prune"])
            .output();
    }
    // Best-effort branch delete — ignore ALL failures (spawn error or non-zero exit):
    // the branch may be checked out elsewhere, and the worktree is already gone.
    let _ = crate::proc::std_command("git")
        .arg("-C")
        .arg(repo)
        .args(["branch", "-D", &wt.branch])
        .output();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_name_is_namespaced() {
        assert_eq!(branch_name("abc123"), "agent/abc123");
    }

    #[test]
    fn worktree_for_builds_path_and_branch() {
        let wt = worktree_for(Path::new("/tmp/roots"), "abc123").unwrap();
        assert_eq!(wt.path, PathBuf::from("/tmp/roots/abc123"));
        assert_eq!(wt.branch, "agent/abc123");
    }

    #[test]
    fn rejects_path_traversal_and_bad_chars_in_session_id() {
        for bad in ["../escape", "a/b", "", "has space", "..", "x/../y"] {
            assert!(
                worktree_for(Path::new("/tmp/roots"), bad).is_err(),
                "session id {bad:?} should be rejected"
            );
        }
        // Over-long ids are rejected before they reach the filesystem/git.
        let too_long = "a".repeat(MAX_SESSION_ID_LEN + 1);
        assert!(
            worktree_for(Path::new("/tmp/roots"), &too_long).is_err(),
            "an over-long session id should be rejected"
        );
        assert!(worktree_for(Path::new("/tmp/roots"), "Valid-9_id").is_ok());
    }
}

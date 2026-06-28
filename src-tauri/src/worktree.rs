use std::path::{Path, PathBuf};
use std::process::Command;

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

/// Reject session ids that aren't a safe, flat token. The id is interpolated into
/// a filesystem path and a git ref, so anything outside `[A-Za-z0-9_-]` (notably
/// `/`, `.`, `..`) is refused — defense-in-depth against path traversal / ref
/// injection from WebView-supplied input, even though ids are generated UUIDs.
fn validate_session_id(session_id: &str) -> Result<(), WorktreeError> {
    let ok = !session_id.is_empty()
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

    let output = Command::new("git")
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

/// Remove a worktree and delete its branch. Idempotent-ish: a missing worktree
/// surfaces as a Git error from `git worktree remove`.
pub fn remove(repo: &Path, wt: &Worktree) -> Result<(), WorktreeError> {
    let rm = Command::new("git")
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
    // Best-effort branch delete; ignore failure (branch may be checked out elsewhere).
    let _ = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["branch", "-D", &wt.branch])
        .output()?;
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
        assert!(worktree_for(Path::new("/tmp/roots"), "Valid-9_id").is_ok());
    }
}

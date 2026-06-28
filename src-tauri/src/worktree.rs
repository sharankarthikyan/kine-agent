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
    #[error("git {op} failed: {stderr}")]
    Git { op: &'static str, stderr: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Branch name for a session. Kept deterministic so a session maps to one branch.
pub fn branch_name(session_id: &str) -> String {
    format!("agent/{session_id}")
}

/// Create a worktree for `session_id` at `<worktrees_root>/<session_id>`, on a new
/// branch `agent/<session_id>` based on the repo's current HEAD. Shares the repo's
/// `.git` (reuses the local checkout — never clones).
pub fn create(
    repo: &Path,
    worktrees_root: &Path,
    session_id: &str,
) -> Result<Worktree, WorktreeError> {
    std::fs::create_dir_all(worktrees_root)?;
    let path = worktrees_root.join(session_id);
    let branch = branch_name(session_id);

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
}

use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

/// How a file changed in a session worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
}

/// One changed file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: ChangeStatus,
    pub additions: u32,
    pub deletions: u32,
}

/// The full diff for a session: per-file summary + the unified patch text (tracked changes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiff {
    pub files: Vec<FileChange>,
    pub patch: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ReviewError {
    #[error("worktree not found at {0}")]
    NotFound(String),
    #[error("git {op} failed: {stderr}")]
    Git { op: &'static str, stderr: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Worktree(#[from] crate::worktree::WorktreeError),
}

/// Paths changed by BOTH sessions — a merge-collision risk. Pure set intersection,
/// returned sorted for deterministic output.
pub fn overlapping_paths(a: &[String], b: &[String]) -> Vec<String> {
    let bset: BTreeSet<&String> = b.iter().collect();
    let mut out: Vec<String> = a.iter().filter(|p| bset.contains(p)).cloned().collect();
    out.sort();
    out.dedup();
    out
}

/// Compute the diff of `worktree` against its current HEAD: tracked working-tree
/// changes plus untracked new files. Assumes the agent edits without committing.
pub fn diff(worktree: &Path) -> Result<SessionDiff, ReviewError> {
    if !worktree.is_dir() {
        return Err(ReviewError::NotFound(worktree.display().to_string()));
    }

    // Status (A/M/D) per tracked path.
    let name_status = git(worktree, &["diff", "HEAD", "--name-status"], "diff --name-status")?;
    // Additions/deletions per tracked path.
    let numstat = git(worktree, &["diff", "HEAD", "--numstat"], "diff --numstat")?;
    // The unified patch for tracked changes.
    let patch = git(worktree, &["diff", "HEAD"], "diff")?;
    // Untracked (new, unadded) files.
    let untracked = git(worktree, &["ls-files", "--others", "--exclude-standard"], "ls-files")?;

    let mut files: Vec<FileChange> = Vec::new();

    // Parse name-status: "<X>\t<path>" (X in A/M/D/R.../C...). Treat R/C as Modified.
    let mut status_by_path = std::collections::BTreeMap::new();
    for line in name_status.lines() {
        let mut parts = line.split('\t');
        // next_back takes the LAST field = destination path, handling both "M\tpath"
        // and rename "R100\told\tnew" correctly.
        let (Some(code), Some(path)) = (parts.next(), parts.next_back()) else { continue };
        let status = match code.chars().next() {
            Some('A') => ChangeStatus::Added,
            Some('D') => ChangeStatus::Deleted,
            _ => ChangeStatus::Modified,
        };
        status_by_path.insert(path.to_string(), status);
    }

    // Parse numstat: "<adds>\t<dels>\t<path>" ("-" for binary).
    for line in numstat.lines() {
        let mut parts = line.split('\t');
        let (Some(adds), Some(dels), Some(path)) = (parts.next(), parts.next(), parts.next())
        else { continue };
        let path = path.to_string();
        let status = status_by_path.get(&path).copied().unwrap_or(ChangeStatus::Modified);
        files.push(FileChange {
            path,
            status,
            additions: adds.parse().unwrap_or(0),
            deletions: dels.parse().unwrap_or(0),
        });
    }

    // Untracked files: count their lines as additions. Binary/non-UTF8 files fail
    // read_to_string and report 0 additions (consistent with binary tracked files,
    // whose numstat shows "-").
    for path in untracked.lines() {
        let abs = worktree.join(path);
        let additions = std::fs::read_to_string(&abs)
            .map(|c| c.lines().count() as u32)
            .unwrap_or(0);
        files.push(FileChange {
            path: path.to_string(),
            status: ChangeStatus::Added,
            additions,
            deletions: 0,
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(SessionDiff { files, patch })
}

/// Run a git command in `dir`, returning stdout on success or a ReviewError::Git.
fn git(dir: &Path, args: &[&str], op: &'static str) -> Result<String, ReviewError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .arg("-c")
        .arg("core.quotepath=false")
        // Force color off: a user's color.ui=always would otherwise inject ANSI
        // escapes into the patch (garbling the <pre>) and the parsed --name-status/
        // --numstat lines.
        .arg("-c")
        .arg("color.ui=never")
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(ReviewError::Git {
            op,
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_returns_sorted_intersection() {
        let a = vec!["src/b.rs".to_string(), "src/a.rs".to_string(), "README.md".to_string()];
        let b = vec!["src/a.rs".to_string(), "src/b.rs".to_string(), "other.rs".to_string()];
        assert_eq!(overlapping_paths(&a, &b), vec!["src/a.rs".to_string(), "src/b.rs".to_string()]);
    }

    #[test]
    fn overlap_empty_when_disjoint() {
        let a = vec!["a".to_string()];
        let b = vec!["b".to_string()];
        assert!(overlapping_paths(&a, &b).is_empty());
    }

    #[test]
    fn change_status_serializes_camelcase() {
        assert_eq!(serde_json::to_string(&ChangeStatus::Modified).unwrap(), "\"modified\"");
    }
}

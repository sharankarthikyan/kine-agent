use serde::Serialize;
use std::collections::BTreeSet;

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

use serde::Serialize;
use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

const PATCH_CAP_BYTES: usize = 2 * 1024 * 1024;
const UNTRACKED_FILE_CAP_BYTES: u64 = 512 * 1024;
const PATCH_TRUNCATED_MARKER: &str =
    "\n\ndiff --git a/.kineloop-truncated b/.kineloop-truncated\n--- a/.kineloop-truncated\n+++ b/.kineloop-truncated\n@@ -0,0 +1 @@\n+Patch truncated by Kineloop because it exceeded 2 MiB.\n";

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
/// changes plus untracked new files.
pub fn diff(worktree: &Path) -> Result<SessionDiff, ReviewError> {
    diff_from_ref(worktree, "HEAD")
}

/// Compute all reviewable changes for a session branch relative to `base`: committed
/// branch changes, tracked working-tree changes, and untracked files.
pub fn diff_from_base(worktree: &Path, base: &str) -> Result<SessionDiff, ReviewError> {
    diff_from_ref(worktree, base)
}

fn diff_from_ref(worktree: &Path, base: &str) -> Result<SessionDiff, ReviewError> {
    if !worktree.is_dir() {
        return Err(ReviewError::NotFound(worktree.display().to_string()));
    }

    // Status (A/M/D) per tracked path.
    let name_status = git(
        worktree,
        &["diff", base, "--name-status"],
        "diff --name-status",
    )?;
    // Additions/deletions per tracked path.
    let numstat = git(worktree, &["diff", base, "--numstat"], "diff --numstat")?;
    // The unified patch for tracked changes, capped before crossing IPC.
    let mut patch = git_capped(worktree, &["diff", base], "diff")?;
    // Untracked (new, unadded) files.
    let untracked = git(
        worktree,
        &["ls-files", "--others", "--exclude-standard"],
        "ls-files",
    )?;

    let mut files: Vec<FileChange> = Vec::new();

    // Parse name-status: "<X>\t<path>" (X in A/M/D/R.../C...). Treat R/C as Modified.
    let mut status_by_path = std::collections::BTreeMap::new();
    for line in name_status.lines() {
        let mut parts = line.split('\t');
        // next_back takes the LAST field = destination path, handling both "M\tpath"
        // and rename "R100\told\tnew" correctly.
        let (Some(code), Some(path)) = (parts.next(), parts.next_back()) else {
            continue;
        };
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
        else {
            continue;
        };
        let path = path.to_string();
        let status = status_by_path
            .get(&path)
            .copied()
            .unwrap_or(ChangeStatus::Modified);
        files.push(FileChange {
            path,
            status,
            additions: adds.parse().unwrap_or(0),
            deletions: dels.parse().unwrap_or(0),
        });
    }

    // Untracked files: count their lines as additions and synthesize a readable
    // /dev/null -> file patch so review can show the new file contents.
    for path in untracked.lines() {
        let abs = worktree.join(path);
        let (additions, file_patch) = untracked_file_patch(path, &abs);
        files.push(FileChange {
            path: path.to_string(),
            status: ChangeStatus::Added,
            additions,
            deletions: 0,
        });
        if !file_patch.is_empty() && !patch_was_truncated(&patch) {
            if !patch.ends_with('\n') && !patch.is_empty() {
                patch.push('\n');
            }
            patch.push_str(&file_patch);
            patch = truncate_patch(patch);
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(SessionDiff { files, patch })
}

/// Aggregate line/file counts for a session's worktree diff. Best-effort:
/// errors in `diff()` (e.g. no git repo yet) yield all-zero counts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diffstat {
    pub additions: u32,
    pub deletions: u32,
    /// `filesChanged` on the wire.
    pub files_changed: u32,
}

/// Return additions, deletions, and changed-file count for a worktree by
/// reusing the existing `diff()` result. Returns all-zero on any error.
pub fn diffstat(worktree: &Path) -> Diffstat {
    match diff(worktree) {
        Ok(session_diff) => {
            let additions: u32 = session_diff.files.iter().map(|f| f.additions).sum();
            let deletions: u32 = session_diff.files.iter().map(|f| f.deletions).sum();
            let files_changed = session_diff.files.len() as u32;
            Diffstat {
                additions,
                deletions,
                files_changed,
            }
        }
        Err(_) => Diffstat {
            additions: 0,
            deletions: 0,
            files_changed: 0,
        },
    }
}

pub fn diffstat_from_base(worktree: &Path, base: &str) -> Diffstat {
    match diff_from_base(worktree, base) {
        Ok(session_diff) => {
            let additions: u32 = session_diff.files.iter().map(|f| f.additions).sum();
            let deletions: u32 = session_diff.files.iter().map(|f| f.deletions).sum();
            let files_changed = session_diff.files.len() as u32;
            Diffstat {
                additions,
                deletions,
                files_changed,
            }
        }
        Err(_) => Diffstat {
            additions: 0,
            deletions: 0,
            files_changed: 0,
        },
    }
}

/// Run a git command in `dir`, returning stdout on success or a ReviewError::Git.
fn git(dir: &Path, args: &[&str], op: &'static str) -> Result<String, ReviewError> {
    let output = git_command(dir, args).output()?;
    if !output.status.success() {
        return Err(ReviewError::Git {
            op,
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn git_capped(dir: &Path, args: &[&str], op: &'static str) -> Result<String, ReviewError> {
    let mut child = git_command(dir, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");

    let stdout_reader =
        std::thread::spawn(move || read_with_storage_cap(&mut stdout, PATCH_CAP_BYTES + 1));
    let stderr_reader = std::thread::spawn(move || read_with_storage_cap(&mut stderr, 64 * 1024));

    let status = child.wait()?;
    let stdout = stdout_reader.join().map_err(|_| {
        ReviewError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            "stdout reader panicked",
        ))
    })??;
    let stderr = stderr_reader.join().map_err(|_| {
        ReviewError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            "stderr reader panicked",
        ))
    })??;

    if !status.success() {
        return Err(ReviewError::Git {
            op,
            stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
        });
    }
    Ok(truncate_patch(String::from_utf8_lossy(&stdout).to_string()))
}

fn read_with_storage_cap<R: Read>(reader: &mut R, cap: usize) -> std::io::Result<Vec<u8>> {
    let mut stored = Vec::with_capacity(cap.min(64 * 1024));
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        let remaining = cap.saturating_sub(stored.len());
        if remaining > 0 {
            stored.extend_from_slice(&chunk[..read.min(remaining)]);
        }
    }
    Ok(stored)
}

fn git_command(dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .arg("-c")
        .arg("core.quotepath=false")
        // Force color off: a user's color.ui=always would otherwise inject ANSI
        // escapes into the patch (garbling the <pre>) and the parsed --name-status/
        // --numstat lines.
        .arg("-c")
        .arg("color.ui=never")
        .args(args);
    command
}

fn truncate_patch(mut patch: String) -> String {
    if patch.len() <= PATCH_CAP_BYTES {
        return patch;
    }
    let mut end = PATCH_CAP_BYTES;
    while !patch.is_char_boundary(end) {
        end -= 1;
    }
    patch.truncate(end);
    patch.push_str(PATCH_TRUNCATED_MARKER);
    patch
}

fn patch_was_truncated(patch: &str) -> bool {
    patch.contains("diff --git a/.kineloop-truncated b/.kineloop-truncated")
}

fn untracked_file_patch(path: &str, abs: &Path) -> (u32, String) {
    let Ok(meta) = std::fs::metadata(abs) else {
        return (0, String::new());
    };
    if meta.len() > UNTRACKED_FILE_CAP_BYTES {
        let patch = format!(
            "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1 @@\n+File omitted from inline diff because it exceeds 512 KiB.\n"
        );
        return (0, patch);
    }
    let Ok(content) = std::fs::read_to_string(abs) else {
        let patch = format!(
            "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1 @@\n+Binary or non-UTF-8 file omitted from inline diff.\n"
        );
        return (0, patch);
    };
    let additions = content.lines().count() as u32;
    let mut patch = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +{additions} @@\n"
    );
    for line in content.lines() {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    if content.ends_with('\n') && additions == 0 {
        patch.push_str("+\n");
    }
    (additions, patch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_returns_sorted_intersection() {
        let a = vec![
            "src/b.rs".to_string(),
            "src/a.rs".to_string(),
            "README.md".to_string(),
        ];
        let b = vec![
            "src/a.rs".to_string(),
            "src/b.rs".to_string(),
            "other.rs".to_string(),
        ];
        assert_eq!(
            overlapping_paths(&a, &b),
            vec!["src/a.rs".to_string(), "src/b.rs".to_string()]
        );
    }

    #[test]
    fn overlap_empty_when_disjoint() {
        let a = vec!["a".to_string()];
        let b = vec!["b".to_string()];
        assert!(overlapping_paths(&a, &b).is_empty());
    }

    #[test]
    fn change_status_serializes_camelcase() {
        assert_eq!(
            serde_json::to_string(&ChangeStatus::Modified).unwrap(),
            "\"modified\""
        );
    }

    #[test]
    fn diffstat_nonzero_for_modified_and_untracked() {
        let dir = std::env::temp_dir().join(format!("ae-diffstat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // Bootstrap a git repo with a committed file.
        let git_in = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .unwrap()
        };
        git_in(&["init"]);
        git_in(&["config", "user.email", "test@test.com"]);
        git_in(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("main.rs"), "fn main() {}\n").unwrap();
        git_in(&["add", "main.rs"]);
        git_in(&["commit", "-m", "init"]);

        // Modify the tracked file so HEAD diff shows additions.
        std::fs::write(
            dir.join("main.rs"),
            "fn main() {\n    println!(\"hello\");\n}\n",
        )
        .unwrap();
        // Untracked file — counted as additions by `diff()`.
        std::fs::write(dir.join("new.rs"), "// new\n").unwrap();

        let ds = diffstat(&dir);
        assert!(
            ds.additions > 0,
            "expected non-zero additions, got {}",
            ds.additions
        );
        assert!(
            ds.files_changed > 0,
            "expected non-zero files_changed, got {}",
            ds.files_changed
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}

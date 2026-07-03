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
///
/// Diffs against the *merge-base* of `base` and HEAD, not `base`'s tip. This counts
/// only what the session branch itself introduced — commits made since it forked plus
/// uncommitted working-tree edits — and never attributes the base branch's later
/// progress to this session. Diffing `base` directly (two-dot) would report a branch
/// that has fallen behind `main` as if it deleted everything `main` gained meanwhile.
/// Falls back to `base` when no common ancestor exists (unrelated histories).
pub fn diff_from_base(worktree: &Path, base: &str) -> Result<SessionDiff, ReviewError> {
    let base_commit = merge_base(worktree, base).unwrap_or_else(|| base.to_string());
    diff_from_ref(worktree, &base_commit)
}

/// Resolve the merge-base commit of `base` and HEAD. Returns `None` on any error
/// (no common ancestor, missing ref) so callers can fall back to `base`.
fn merge_base(worktree: &Path, base: &str) -> Option<String> {
    let out = git(worktree, &["merge-base", base, "HEAD"], "merge-base").ok()?;
    let sha = out.trim();
    if sha.is_empty() {
        return None;
    }
    Some(sha.to_string())
}

fn diff_from_ref(worktree: &Path, base: &str) -> Result<SessionDiff, ReviewError> {
    if !worktree.is_dir() {
        return Err(ReviewError::NotFound(worktree.display().to_string()));
    }

    // `--end-of-options` forces git to treat `base` as a revision, never an option,
    // even if a malicious repo's default branch name begins with `-`. Option flags
    // (`--name-status`, `--numstat`) must come BEFORE `--end-of-options`.
    // Status (A/M/D) per tracked path.
    let name_status = git(
        worktree,
        &["diff", "--name-status", "--end-of-options", base],
        "diff --name-status",
    )?;
    // Additions/deletions per tracked path.
    let numstat = git(
        worktree,
        &["diff", "--numstat", "--end-of-options", base],
        "diff --numstat",
    )?;
    // The unified patch for tracked changes, capped before crossing IPC.
    let mut patch = git_capped(worktree, &["diff", "--end-of-options", base], "diff")?;
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

    // Parse numstat: "<adds>\t<dels>\t<path>" ("-" for binary). For renames/copies the
    // path field is the `old => new` (or brace) notation, NOT a plain path, so we
    // reconstruct the new path to match the name-status map and display correctly.
    for line in numstat.lines() {
        let mut parts = line.split('\t');
        let (Some(adds), Some(dels), Some(raw_path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = numstat_new_path(raw_path);
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
    let stdout = stdout_reader
        .join()
        .map_err(|_| ReviewError::Io(std::io::Error::other("stdout reader panicked")))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| ReviewError::Io(std::io::Error::other("stderr reader panicked")))??;

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
    let mut command = crate::proc::std_command("git");
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

/// Reconstruct the destination path from a `git diff --numstat` path field.
///
/// For renames/copies git emits the path as `old => new` or, with a common prefix/suffix,
/// the brace form `pre{old => new}post`. Plain modifications/adds/deletes have no ` => `
/// and are returned unchanged.
fn numstat_new_path(raw: &str) -> String {
    if let (Some(open), Some(close)) = (raw.find('{'), raw.find('}')) {
        if let Some(arrow) = raw.find(" => ") {
            if open < arrow && arrow < close {
                let prefix = &raw[..open];
                let new_mid = &raw[arrow + 4..close];
                let suffix = &raw[close + 1..];
                return format!("{prefix}{new_mid}{suffix}");
            }
        }
    }
    if let Some(idx) = raw.find(" => ") {
        return raw[idx + 4..].to_string();
    }
    raw.to_string()
}

fn untracked_file_patch(path: &str, abs: &Path) -> (u32, String) {
    let Ok(meta) = std::fs::metadata(abs) else {
        return (0, String::new());
    };
    if meta.len() > UNTRACKED_FILE_CAP_BYTES {
        let patch = format!(
            "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,1 @@\n+File omitted from inline diff because it exceeds 512 KiB.\n"
        );
        return (0, patch);
    }
    let Ok(content) = std::fs::read_to_string(abs) else {
        let patch = format!(
            "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,1 @@\n+Binary or non-UTF-8 file omitted from inline diff.\n"
        );
        return (0, patch);
    };
    let additions = content.lines().count() as u32;
    // Standards-compliant unified-diff hunk header: `@@ -0,0 +1,N @@` for N>0 added
    // lines, `@@ -0,0 +0,0 @@` for a genuinely empty file.
    let hunk_header = if additions == 0 {
        "@@ -0,0 +0,0 @@".to_string()
    } else {
        format!("@@ -0,0 +1,{additions} @@")
    };
    let mut patch = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n{hunk_header}\n"
    );
    for line in content.lines() {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    (additions, patch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_new_path_handles_plain_brace_and_non_rename() {
        // Plain modification/add — returned unchanged.
        assert_eq!(numstat_new_path("src/main.rs"), "src/main.rs");
        // Simple rename `old => new`.
        assert_eq!(numstat_new_path("old.rs => new.rs"), "new.rs");
        // Brace form with common prefix + suffix.
        assert_eq!(
            numstat_new_path("dir/{foo => bar}/baz.rs"),
            "dir/bar/baz.rs"
        );
        // Brace form adding a directory level.
        assert_eq!(numstat_new_path("src/{ => sub}/file.rs"), "src/sub/file.rs");
    }

    #[test]
    fn untracked_patch_hunk_header_is_standards_compliant() {
        let dir = std::env::temp_dir().join(format!("ae-untracked-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let abs = dir.join("new.txt");
        std::fs::write(&abs, "line1\nline2\n").unwrap();

        let (additions, patch) = untracked_file_patch("new.txt", &abs);
        assert_eq!(additions, 2);
        assert!(
            patch.contains("@@ -0,0 +1,2 @@"),
            "expected a count in the hunk header, got: {patch}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    #[test]
    fn diffstat_from_base_ignores_base_progress_for_a_behind_branch() {
        // Reproduces the "GM session" bug: a session branch that made no changes of
        // its own but has fallen behind `main` must report +0/−0, not main's later
        // additions inverted as deletions.
        let dir = std::env::temp_dir().join(format!("ae-behind-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let git_in = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .unwrap()
        };
        git_in(&["init", "-b", "main"]);
        git_in(&["config", "user.email", "test@test.com"]);
        git_in(&["config", "user.name", "Test"]);

        // Shared fork point.
        std::fs::write(dir.join("main.rs"), "fn main() {}\n").unwrap();
        git_in(&["add", "main.rs"]);
        git_in(&["commit", "-m", "init"]);

        // Session branch forks here and makes NO commits of its own.
        git_in(&["checkout", "-b", "session"]);

        // main advances with substantial work the session never saw.
        git_in(&["checkout", "main"]);
        std::fs::write(dir.join("big.rs"), "a\nb\nc\nd\ne\nf\n").unwrap();
        git_in(&["add", "big.rs"]);
        git_in(&["commit", "-m", "main progresses"]);

        // Back on the (now behind) session branch with a clean tree.
        git_in(&["checkout", "session"]);

        let ds = diffstat_from_base(&dir, "main");
        assert_eq!(ds.additions, 0, "branch made no additions of its own");
        assert_eq!(
            ds.deletions, 0,
            "main's later work must not be counted as session deletions"
        );
        assert_eq!(ds.files_changed, 0, "no files changed by this session");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diffstat_from_base_counts_branch_commits_and_uncommitted_edits() {
        // A branch genuinely ahead of `main`: both its committed work and its
        // uncommitted working-tree edits count, while main's divergence does not.
        let dir = std::env::temp_dir().join(format!("ae-ahead-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let git_in = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .unwrap()
        };
        git_in(&["init", "-b", "main"]);
        git_in(&["config", "user.email", "test@test.com"]);
        git_in(&["config", "user.name", "Test"]);
        std::fs::write(dir.join("main.rs"), "fn main() {}\n").unwrap();
        git_in(&["add", "main.rs"]);
        git_in(&["commit", "-m", "init"]);

        // Branch forks and commits its own file.
        git_in(&["checkout", "-b", "session"]);
        std::fs::write(dir.join("feature.rs"), "// feature\nfn f() {}\n").unwrap();
        git_in(&["add", "feature.rs"]);
        git_in(&["commit", "-m", "add feature"]);
        // Plus an uncommitted untracked file.
        std::fs::write(dir.join("wip.rs"), "// wip\n").unwrap();

        // main advances independently — must not affect the session's stat.
        git_in(&["checkout", "main"]);
        std::fs::write(dir.join("unrelated.rs"), "x\ny\nz\n").unwrap();
        git_in(&["add", "unrelated.rs"]);
        git_in(&["commit", "-m", "unrelated main work"]);
        git_in(&["checkout", "session"]);

        let ds = diffstat_from_base(&dir, "main");
        // feature.rs (2) committed + wip.rs (1) untracked = 3 additions, 2 files.
        assert_eq!(ds.additions, 3, "branch's own additions only");
        assert_eq!(ds.deletions, 0);
        assert_eq!(ds.files_changed, 2);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

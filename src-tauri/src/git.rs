use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

const TREE_CAP: usize = 2000;

/// One entry in a worktree's file tree — either a file or a derived intermediate directory.
/// The frontend is responsible for nesting; this module returns a flat list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub path: String,
    pub is_dir: bool,
    /// One of "modified" | "added" | "untracked" | "deleted", or None for clean entries
    /// and all directories.
    pub status: Option<String>,
}

/// Summary of a session branch's divergence from a base branch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchChanges {
    /// Number of commits in this branch not reachable from `base`.
    pub ahead_count: u32,
    /// Files changed since `base`, including committed branch changes, tracked
    /// working-tree changes, and untracked files.
    pub files: Vec<crate::review::FileChange>,
}

/// Returned after a successful commit in a session's worktree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub sha: String,
}

/// Build a flat, sorted list of all tracked and untracked entries in `worktree`.
/// Intermediate directories are derived from file paths (each ancestor dir becomes a
/// `TreeEntry` with `is_dir=true` and `status=None`). Output is sorted dirs-first,
/// then alphabetically by path within each group. Capped at `TREE_CAP` total entries;
/// excess entries are logged via `eprintln!` and truncated.
pub fn worktree_tree(worktree: &Path) -> Vec<TreeEntry> {
    let tracked = git_stdout(worktree, &["ls-files"]);
    let untracked = git_stdout(worktree, &["ls-files", "--others", "--exclude-standard"]);
    let porcelain = git_stdout(worktree, &["status", "--porcelain"]);

    let status_by_path = parse_porcelain(&porcelain);

    // Collect file paths, deduplicating (tracked and untracked sets are disjoint in a
    // well-formed repo, but we guard against overlap defensively).
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut file_paths: Vec<(String, Option<String>)> = Vec::new();

    for line in tracked.lines().chain(untracked.lines()) {
        let path = line.trim();
        if path.is_empty() || !seen.insert(path.to_string()) {
            continue;
        }
        let status = status_by_path.get(path).cloned();
        file_paths.push((path.to_string(), status));
    }

    // Derive all intermediate directories from the file paths.
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    for (path, _) in &file_paths {
        let mut p = path.as_str();
        while let Some(slash) = p.rfind('/') {
            let dir = &p[..slash];
            if !dirs.insert(dir.to_string()) {
                break; // already present; its own ancestors are already covered
            }
            p = dir;
        }
    }

    let mut entries: Vec<TreeEntry> = Vec::with_capacity(dirs.len() + file_paths.len());

    for dir in dirs {
        entries.push(TreeEntry {
            path: dir,
            is_dir: true,
            status: None,
        });
    }
    for (path, status) in file_paths {
        entries.push(TreeEntry {
            path,
            is_dir: false,
            status,
        });
    }

    // Dirs-first, then alphabetical within each group.
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.path.cmp(&b.path)));

    if entries.len() > TREE_CAP {
        eprintln!(
            "worktree_tree: result capped at {TREE_CAP} entries ({} total); \
             some entries omitted",
            entries.len()
        );
        entries.truncate(TREE_CAP);
    }

    entries
}

/// Best-effort: derive the repo's default base branch for `worktree`.
///
/// Resolves `origin/HEAD` (e.g. `origin/main`) and strips the `origin/` prefix. Falls
/// back to `"main"` when there is no remote, no `origin/HEAD` symref, or the lookup
/// produces empty output. Never panics.
pub fn default_base(worktree: &Path) -> String {
    let head = git_stdout(worktree, &["rev-parse", "--abbrev-ref", "origin/HEAD"]);
    let head = head.trim();
    head.strip_prefix("origin/")
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "main".to_string())
}

/// Return the number of commits `worktree`'s HEAD is ahead of `base`, plus the set of
/// reviewable changes since `base`. Both are best-effort: errors fall back to 0 /
/// empty so the UI always gets a valid value.
pub fn branch_changes(worktree: &Path, base: &str) -> BranchChanges {
    let rev_range = format!("{base}..HEAD");
    let ahead_count = git_stdout(worktree, &["rev-list", "--count", &rev_range])
        .trim()
        .parse::<u32>()
        .unwrap_or(0);

    let files = crate::review::diff_from_base(worktree, base)
        .map(|d| d.files)
        .unwrap_or_default();

    BranchChanges { ahead_count, files }
}

/// Stage all working-tree changes (`git add -A`) and create a commit with `message`
/// inside `worktree`. Returns the new HEAD sha on success.
///
/// Returns `Err` when:
/// - `message` is blank (trimmed empty);
/// - the working tree is already clean (git reports "nothing to commit");
/// - any git invocation fails for any other reason.
///
/// This function is intentionally scoped to `git add -A && git commit` only. It never
/// pushes, merges, or switches branches.
pub fn commit_session(worktree: &Path, message: &str) -> Result<CommitResult, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("commit message must not be empty".to_string());
    }

    run_git(worktree, &["add", "-A"], "add -A")?;
    run_git(worktree, &["commit", "-m", message], "commit")?;

    let sha = git_stdout(worktree, &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    if sha.is_empty() {
        return Err("git rev-parse HEAD returned empty output after commit".to_string());
    }
    Ok(CommitResult { sha })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Parse `git status --porcelain` output into a path → status-string map.
/// Status strings: "untracked" | "modified" | "added" | "deleted".
/// Unknown or irrelevant codes are silently skipped.
///
/// Porcelain v1 format (without -z): "XY PATH" or "XY ORIG -> DEST" for renames.
/// With `core.quotepath=false`, paths are not C-quoted.
fn parse_porcelain(porcelain: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for line in porcelain.lines() {
        if line.len() < 3 {
            continue;
        }
        let code = &line[..2];
        // Column 3 onward is the path; for renames ("ORIG -> DEST") take the destination.
        let raw_path = &line[3..];
        let path = if let Some(pos) = raw_path.find(" -> ") {
            raw_path[pos + 4..].to_string()
        } else {
            raw_path.to_string()
        };

        let status = if code == "??" {
            "untracked"
        } else if code.starts_with('A') {
            "added"
        } else if code.contains('D') {
            "deleted"
        } else if code.contains('M') {
            "modified"
        } else {
            continue;
        };
        map.insert(path, status.to_string());
    }
    map
}

/// Run a git command in `dir`, returning stdout on success or an empty string on any
/// error (non-zero exit or spawn failure). Used for best-effort reads where partial or
/// missing output is acceptable.
fn git_stdout(dir: &Path, args: &[&str]) -> String {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("-c")
        .arg("color.ui=never")
        .args(args)
        .output()
        .map(|o| {
            if o.status.success() {
                String::from_utf8_lossy(&o.stdout).to_string()
            } else {
                String::new()
            }
        })
        .unwrap_or_default()
}

/// Run a git command that must succeed. Returns `Err(message)` on non-zero exit or
/// spawn failure, incorporating git's stderr in the message.
fn run_git(dir: &Path, args: &[&str], op: &str) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("-c")
        .arg("color.ui=never")
        .args(args)
        .output()
        .map_err(|e| format!("git {op}: failed to spawn: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "git {op} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command as Cmd;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIR_CTR: AtomicU64 = AtomicU64::new(0);

    /// Return a unique temp dir path for a test. Uses a static counter + PID so
    /// parallel test threads do not collide.
    fn test_dir(tag: &str) -> std::path::PathBuf {
        let n = TEST_DIR_CTR.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("ae-git-{tag}-{}-{n}", std::process::id()))
    }

    /// Bootstrap a minimal git repo with a single "init" commit on branch "main".
    /// Sets local user.name/email and disables commit signing so CI doesn't prompt.
    fn init_repo(tag: &str) -> std::path::PathBuf {
        let dir = test_dir(tag);
        fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            Cmd::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .unwrap()
        };
        git(&["init"]);
        git(&["config", "user.email", "test@test.com"]);
        git(&["config", "user.name", "Test"]);
        git(&["config", "commit.gpgsign", "false"]);
        // Name the initial branch "main" before the first commit so branch_changes
        // tests can reliably use it as the base ref.
        git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
        fs::write(dir.join("main.rs"), "fn main() {}\n").unwrap();
        git(&["add", "main.rs"]);
        git(&["commit", "-m", "init"]);
        dir
    }

    #[test]
    fn worktree_tree_lists_committed_and_flags_untracked() {
        let dir = init_repo("tree-basic");
        // Add an untracked file alongside the committed one.
        fs::write(dir.join("untracked.txt"), "hello\n").unwrap();

        let entries = worktree_tree(&dir);

        let main_rs = entries.iter().find(|e| e.path == "main.rs");
        assert!(main_rs.is_some(), "expected main.rs in tree");

        let untracked_entry = entries.iter().find(|e| e.path == "untracked.txt");
        assert!(untracked_entry.is_some(), "expected untracked.txt in tree");
        assert_eq!(
            untracked_entry.unwrap().status.as_deref(),
            Some("untracked"),
            "untracked.txt should have status=untracked"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn branch_changes_ahead_count_increments_after_commit() {
        let dir = init_repo("bc-ahead");
        let git = |args: &[&str]| {
            Cmd::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .unwrap()
        };

        // Branch off main and add a commit on top.
        git(&["checkout", "-b", "feature"]);
        fs::write(dir.join("feature.rs"), "// feature\n").unwrap();
        git(&["add", "feature.rs"]);
        git(&["commit", "-m", "add feature"]);

        let changes = branch_changes(&dir, "main");
        assert!(
            changes.ahead_count >= 1,
            "expected ahead_count >= 1 after committing on feature, got {}",
            changes.ahead_count
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn branch_changes_files_nonempty_for_uncommitted_changes() {
        let dir = init_repo("bc-files");
        // Modify a tracked file without committing — review::diff picks this up.
        fs::write(dir.join("main.rs"), "fn main() { println!(\"hi\"); }\n").unwrap();

        let changes = branch_changes(&dir, "main");
        assert!(
            !changes.files.is_empty(),
            "expected non-empty files list when there are uncommitted changes"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_base_falls_back_to_main_without_remote() {
        let dir = init_repo("default-base-no-remote");
        // No remote configured → origin/HEAD cannot resolve → fallback to "main".
        assert_eq!(default_base(&dir), "main");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_session_returns_nonempty_sha() {
        let dir = init_repo("commit-ok");
        // New untracked file — git add -A will stage it.
        fs::write(dir.join("work.rs"), "// work\n").unwrap();

        let result = commit_session(&dir, "add work.rs");
        assert!(result.is_ok(), "expected Ok, got {:?}", result);
        let commit = result.unwrap();
        assert!(!commit.sha.is_empty(), "sha must not be empty");
        assert_eq!(commit.sha.len(), 40, "sha should be a 40-char hex string");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_session_errors_on_clean_tree() {
        let dir = init_repo("commit-clean");
        // Tree is clean after init_repo — nothing to stage or commit.
        let result = commit_session(&dir, "nothing to commit");
        assert!(result.is_err(), "expected Err on clean tree, got Ok");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_session_errors_on_empty_message() {
        let dir = init_repo("commit-empty-msg");
        let result = commit_session(&dir, "   ");
        assert!(result.is_err(), "expected Err for blank commit message");

        let _ = fs::remove_dir_all(&dir);
    }
}

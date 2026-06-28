use agent_editor_lib::review::{diff, ChangeStatus};
use agent_editor_lib::worktree::create;
use std::path::{Path, PathBuf};
use std::process::Command;

fn run(dir: &Path, args: &[&str]) {
    let status = Command::new("git").arg("-C").arg(dir).args(args).status().unwrap();
    assert!(status.success(), "git {:?} failed", args);
}

fn init_repo(dir: &Path) {
    run(dir, &["init", "-q", "-b", "main"]);
    run(dir, &["config", "user.email", "t@example.com"]);
    run(dir, &["config", "user.name", "Test"]);
    std::fs::write(dir.join("keep.txt"), "line1\nline2\n").unwrap();
    std::fs::write(dir.join("gone.txt"), "bye\n").unwrap();
    run(dir, &["add", "."]);
    run(dir, &["commit", "-q", "-m", "init"]);
}

fn temp_dir(tag: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!("ae-rev-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    base
}

#[test]
fn diff_reports_modified_added_and_deleted() {
    let root = temp_dir("diff");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    let wt = create(&repo, &root.join("worktrees"), "rev1").unwrap();

    // Agent edits in the worktree (no commit): modify, add new, delete tracked.
    std::fs::write(wt.path.join("keep.txt"), "line1\nline2\nline3\n").unwrap();
    std::fs::write(wt.path.join("new.txt"), "a\nb\n").unwrap();
    std::fs::remove_file(wt.path.join("gone.txt")).unwrap();

    let d = diff(&wt.path).unwrap();
    let by = |p: &str| d.files.iter().find(|f| f.path == p).cloned();

    let keep = by("keep.txt").expect("keep.txt in diff");
    assert_eq!(keep.status, ChangeStatus::Modified);
    assert_eq!(keep.additions, 1);

    let new = by("new.txt").expect("new.txt in diff");
    assert_eq!(new.status, ChangeStatus::Added);
    assert_eq!(new.additions, 2);

    let gone = by("gone.txt").expect("gone.txt in diff");
    assert_eq!(gone.status, ChangeStatus::Deleted);

    assert!(d.patch.contains("keep.txt"), "patch should mention modified file");

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn diff_is_empty_for_untouched_worktree() {
    let root = temp_dir("clean");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    let wt = create(&repo, &root.join("worktrees"), "rev2").unwrap();

    let d = diff(&wt.path).unwrap();
    assert!(d.files.is_empty(), "no changes expected, got {:?}", d.files);
    assert!(d.patch.is_empty());

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn diff_errors_when_worktree_missing() {
    let root = temp_dir("missing");
    let result = diff(&root.join("nope"));
    assert!(result.is_err());
    std::fs::remove_dir_all(&root).ok();
}

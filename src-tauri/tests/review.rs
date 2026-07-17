use kine_agent_lib::review::{diff, diff_from_base, ChangeStatus};
use kine_agent_lib::worktree::create;
use std::path::{Path, PathBuf};
use std::process::Command;

fn run(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .status()
        .unwrap();
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

    assert!(
        d.patch.contains("keep.txt"),
        "patch should mention modified file"
    );

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

#[test]
fn diff_includes_untracked_file_patch() {
    let root = temp_dir("untracked-patch");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    let wt = create(&repo, &root.join("worktrees"), "rev3").unwrap();

    std::fs::write(wt.path.join("notes.txt"), "alpha\nbeta\n").unwrap();

    let d = diff(&wt.path).unwrap();
    let notes = d
        .files
        .iter()
        .find(|file| file.path == "notes.txt")
        .expect("notes.txt in diff");
    assert_eq!(notes.status, ChangeStatus::Added);
    assert_eq!(notes.additions, 2);
    assert!(d.patch.contains("diff --git a/notes.txt b/notes.txt"));
    assert!(d.patch.contains("+alpha"));
    assert!(d.patch.contains("+beta"));

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn diff_omits_large_untracked_file_body() {
    let root = temp_dir("large-untracked");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    let wt = create(&repo, &root.join("worktrees"), "rev4").unwrap();

    std::fs::write(wt.path.join("large.txt"), "x".repeat(513 * 1024)).unwrap();

    let d = diff(&wt.path).unwrap();
    assert!(d.patch.contains("diff --git a/large.txt b/large.txt"));
    assert!(d
        .patch
        .contains("File omitted from inline diff because it exceeds 512 KiB."));
    assert!(!d.patch.contains(&"x".repeat(1024)));

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn diff_from_base_includes_committed_branch_changes_and_truncates_patch() {
    let root = temp_dir("committed-truncated");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    let wt = create(&repo, &root.join("worktrees"), "rev5").unwrap();

    let base = String::from_utf8(
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let base = base.trim().to_string();

    let mut content = String::new();
    for index in 0..240_000 {
        content.push_str(&format!("line-{index:06}\n"));
    }
    std::fs::write(wt.path.join("huge.txt"), content).unwrap();
    run(&wt.path, &["add", "huge.txt"]);
    run(&wt.path, &["commit", "-q", "-m", "huge change"]);

    let d = diff_from_base(&wt.path, &base).unwrap();
    assert!(d.files.iter().any(|file| file.path == "huge.txt"));
    assert!(d
        .patch
        .contains("Patch truncated by Kine Agent because it exceeded 2 MiB."));
    assert!(d.patch.len() < 2 * 1024 * 1024 + 512);

    std::fs::remove_dir_all(&root).ok();
}

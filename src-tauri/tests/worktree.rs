use kine_agent_lib::worktree::{create, remove, WorktreeError};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Make a throwaway git repo with one commit, return its path. Caller cleans up.
fn init_repo(dir: &Path) {
    run(dir, &["init", "-q", "-b", "main"]);
    run(dir, &["config", "user.email", "t@example.com"]);
    run(dir, &["config", "user.name", "Test"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    run(dir, &["add", "."]);
    run(dir, &["commit", "-q", "-m", "init"]);
}

fn run(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {:?} failed", args);
}

/// Unique temp dir under the system temp folder (no external crates).
fn temp_dir(tag: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!("ae-wt-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    base
}

#[test]
fn create_makes_worktree_with_repo_content_and_branch() {
    let root = temp_dir("create");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    let wt_root = root.join("worktrees");

    let wt = create(&repo, &wt_root, "sess1").unwrap();

    assert!(wt.path.is_dir());
    assert!(wt.path.join("README.md").exists());
    assert_eq!(wt.branch, "agent/sess1");

    let out = Command::new("git")
        .arg("-C")
        .arg(&wt.path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "agent/sess1");

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn remove_deletes_worktree_and_unregisters_it() {
    let root = temp_dir("remove");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    let wt_root = root.join("worktrees");

    let wt = create(&repo, &wt_root, "sess2").unwrap();
    assert!(wt.path.is_dir());

    remove(&repo, &wt).unwrap();

    assert!(!wt.path.exists());
    let list = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["worktree", "list"])
        .output()
        .unwrap();
    let listed = String::from_utf8_lossy(&list.stdout);
    assert!(
        !listed.contains("sess2"),
        "worktree still registered: {listed}"
    );

    // The branch was deleted too (best-effort branch cleanup ran).
    let branches = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "--list", "agent/sess2"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&branches.stdout).trim().is_empty(),
        "branch agent/sess2 should be deleted after remove"
    );

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn remove_is_idempotent_when_worktree_dir_already_gone() {
    let root = temp_dir("remove-idempotent");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    let wt_root = root.join("worktrees");

    let wt = create(&repo, &wt_root, "sess3").unwrap();
    // Simulate a crash / manual deletion: the worktree directory vanishes but git's
    // admin entry and the branch remain.
    std::fs::remove_dir_all(&wt.path).unwrap();
    assert!(!wt.path.exists());

    // remove() must succeed (prune the stale entry + delete the branch), not error.
    remove(&repo, &wt).unwrap();

    let list = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["worktree", "list"])
        .output()
        .unwrap();
    assert!(
        !String::from_utf8_lossy(&list.stdout).contains("sess3"),
        "stale worktree admin entry should be pruned"
    );

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn create_errors_on_non_repo() {
    let root = temp_dir("nonrepo");
    let not_repo = root.join("plain");
    std::fs::create_dir_all(&not_repo).unwrap();

    let result = create(&not_repo, &root.join("worktrees"), "sessX");
    assert!(
        matches!(result, Err(WorktreeError::Git { .. })),
        "expected WorktreeError::Git creating a worktree in a non-git dir, got {result:?}"
    );

    std::fs::remove_dir_all(&root).ok();
}

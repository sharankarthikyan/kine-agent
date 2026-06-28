use crate::adapter::{AgentAdapter, EventSink, Prompt};
use crate::adapters::claude::ClaudeAdapter;
use crate::events::AgentEvent;
use crate::worktree;
use std::path::PathBuf;
use tauri::ipc::Channel;

/// Adapts a Tauri Channel into our EventSink trait.
struct ChannelSink(Channel<AgentEvent>);

impl EventSink for ChannelSink {
    fn emit(&self, event: AgentEvent) {
        let _ = self.0.send(event);
    }
}

/// Root under which per-session worktrees are created (outside any target repo).
///
/// Uses a stable per-user directory (`$HOME/.agent-editor/worktrees`), NOT the system
/// temp dir — worktrees hold unreviewed agent work that must survive across reboots
/// until the user reviews and `cleanup_session`s them. Falls back to temp only if HOME
/// is unset. (A later phase moves this to the Tauri app-data dir via AppHandle.)
fn worktrees_root() -> PathBuf {
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join(".agent-editor").join("worktrees")
}

/// Start a session: create an isolated worktree off `repo` for `session_id`, then
/// run the Claude agent inside it. The worktree is left in place for later review;
/// call `cleanup_session` to remove it.
#[tauri::command]
pub async fn start_session(
    prompt: String,
    repo: String,
    session_id: String,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    let repo_path = PathBuf::from(&repo);
    let root = worktrees_root();
    // git worktree add is blocking I/O — keep it off the async runtime's worker.
    let wt = tokio::task::spawn_blocking(move || worktree::create(&repo_path, &root, &session_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let sink = Box::new(ChannelSink(on_event));
    // On error the worktree is left in place: a normal "agent ran then errored" session
    // still has changes worth reviewing, and the frontend can always cleanup_session.
    // (Plan 3/5: persist the repo↔session mapping, auto-clean empty spawn-failure
    // worktrees, and reuse-or-error on a colliding session_id instead of a raw git error.)
    ClaudeAdapter
        .run(Prompt { text: prompt }, wt.path, sink)
        .await
        .map_err(|e| e.to_string())
}

/// Remove the worktree (and branch) for a finished session.
#[tauri::command]
pub async fn cleanup_session(repo: String, session_id: String) -> Result<(), String> {
    let repo_path = PathBuf::from(&repo);
    let root = worktrees_root();
    // Resolve+validate the session→worktree mapping, then remove off the async runtime.
    tokio::task::spawn_blocking(move || {
        let wt = worktree::worktree_for(&root, &session_id)?;
        worktree::remove(&repo_path, &wt)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

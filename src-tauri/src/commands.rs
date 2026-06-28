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
fn worktrees_root() -> PathBuf {
    std::env::temp_dir().join("agent-editor").join("worktrees")
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
    ClaudeAdapter
        .run(Prompt { text: prompt }, wt.path.clone(), sink)
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

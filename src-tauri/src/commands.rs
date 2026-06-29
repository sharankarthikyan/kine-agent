use crate::adapter::{AgentAdapter, EventSink, Prompt};
use crate::adapters::claude::ClaudeAdapter;
use crate::events::AgentEvent;
use crate::inspect::{self, Capabilities, RuleFile};
use crate::review::{self, SessionDiff};
use crate::store::{self, SessionStore, SessionSummary, StoredEvent};
use crate::worktree;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;

/// Sink that fans each event two ways: to the live UI Channel AND to an mpsc queue
/// that a drain task persists to the store. Keeps the IPC path non-blocking — DB
/// writes happen on the drain task, not in `emit`.
///
/// `saw_error` is set when any `AgentEvent::Error` flows through, so `run_persisting`
/// can stamp the session status correctly even when the adapter returns `Ok` (i.e.
/// the agent ran to completion but reported an in-band error).
struct StoreSink {
    channel: Channel<AgentEvent>,
    tx: mpsc::UnboundedSender<AgentEvent>,
    saw_error: Arc<AtomicBool>,
}

impl EventSink for StoreSink {
    fn emit(&self, event: AgentEvent) {
        if matches!(event, AgentEvent::Error { .. }) {
            self.saw_error.store(true, Ordering::Release);
        }
        let _ = self.channel.send(event.clone());
        let _ = self.tx.send(event);
    }
}

/// Run the adapter while persisting every streamed event, then stamp the session
/// status ("idle" on success, "error" on failure). The prompt row must already be
/// written by the caller so it gets seq 0 before any streamed event.
///
/// Status is "error" if EITHER the run returned `Err` OR any `AgentEvent::Error`
/// flowed through the sink — covering in-band agent failures that still return `Ok`.
async fn run_persisting(
    store: &SessionStore,
    session_id: String,
    prompt: Prompt,
    cwd: PathBuf,
    resume: bool,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    let (tx, mut rx) = mpsc::unbounded_channel::<AgentEvent>();
    let saw_error = Arc::new(AtomicBool::new(false));
    let sink = Box::new(StoreSink { channel: on_event, tx, saw_error: Arc::clone(&saw_error) });

    // Drain task: persist events as they arrive. Ends when the sink (and its tx)
    // is dropped at the end of `.run()`.
    let drain_store = store.clone();
    let drain_sid = session_id.clone();
    let drain = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let (kind, payload) = store::split_event(&event);
            if let Err(e) = drain_store.append_event(&drain_sid, &kind, &payload).await {
                eprintln!("failed to persist event for session {drain_sid}: {e}");
            }
        }
    });

    let result = ClaudeAdapter
        .run(prompt, cwd, session_id.clone(), resume, sink)
        .await;
    let _ = drain.await; // flush all persisted events before stamping status
    let status = if result.is_ok() && !saw_error.load(Ordering::Acquire) { "idle" } else { "error" };
    let _ = store.set_status(&session_id, status).await;
    result.map_err(|e| e.to_string())
}

/// A session's display title: first non-empty line of the prompt, trimmed to 60 chars.
fn title_from_prompt(prompt: &str) -> String {
    let line = prompt.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if line.chars().count() > 60 {
        let truncated: String = line.chars().take(59).collect(); // 59 chars + ellipsis = 60 displayed
        format!("{truncated}…")
    } else if line.is_empty() {
        "Untitled session".to_string()
    } else {
        line.to_string()
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

/// Start a session: create an isolated worktree off `repo` for `session_id`, persist
/// the session + prompt, then run the Claude agent inside it (streaming + persisting
/// events). The worktree is left in place for review; `cleanup_session` removes it.
///
/// `model` is optional: `Some("opus")` / `Some("claude-opus-4-5")` etc. pass `--model`
/// to the CLI; `None` (omitted from the IPC call) uses the CLI's own default.
#[tauri::command]
pub async fn start_session(
    prompt: String,
    repo: String,
    session_id: String,
    model: Option<String>,
    on_event: Channel<AgentEvent>,
    store: State<'_, SessionStore>,
) -> Result<(), String> {
    let repo_path = PathBuf::from(&repo);
    if !repo_path.is_dir() {
        return Err(format!("repo is not an existing directory: {repo}"));
    }
    let root = worktrees_root();
    let sid = session_id.clone();
    let wt = tokio::task::spawn_blocking(move || worktree::create(&repo_path, &root, &sid))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    // Persist the session row + the user's prompt (seq 0) before streaming.
    store
        .create_session(
            &session_id,
            "claude",
            &repo,
            &wt.path.display().to_string(),
            &wt.branch,
            &title_from_prompt(&prompt),
        )
        .await
        .map_err(|e| e.to_string())?;
    if let Err(e) = store
        .append_event(&session_id, "prompt", &serde_json::json!({ "text": prompt }).to_string())
        .await
    {
        eprintln!("failed to persist prompt for session {session_id}: {e}");
    }

    run_persisting(&store, session_id, Prompt { text: prompt, model }, wt.path, false, on_event).await
}

/// Continue an existing session with a follow-up message (resumes the agent in the
/// session's worktree, persisting the new prompt + streamed events).
///
/// `model` is optional: passes `--model` to the CLI when `Some`, omitted when `None`.
#[tauri::command]
pub async fn send_message(
    prompt: String,
    session_id: String,
    model: Option<String>,
    on_event: Channel<AgentEvent>,
    store: State<'_, SessionStore>,
) -> Result<(), String> {
    let root = worktrees_root();
    let sid = session_id.clone();
    let wt_path = tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        let wt = worktree::worktree_for(&root, &sid).map_err(|e| e.to_string())?;
        if !wt.path.is_dir() {
            return Err(format!("no active session worktree for {sid}"));
        }
        Ok(wt.path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let _ = store.set_status(&session_id, "running").await;
    if let Err(e) = store
        .append_event(&session_id, "prompt", &serde_json::json!({ "text": prompt }).to_string())
        .await
    {
        eprintln!("failed to persist prompt for session {session_id}: {e}");
    }

    run_persisting(&store, session_id, Prompt { text: prompt, model }, wt_path, true, on_event).await
}

/// Remove the worktree (and branch) for a finished session.
#[tauri::command]
pub async fn cleanup_session(repo: String, session_id: String) -> Result<(), String> {
    let repo_path = PathBuf::from(&repo);
    if !repo_path.is_dir() {
        return Err(format!("repo is not an existing directory: {repo}"));
    }
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

/// Compute the diff of a session's worktree for review.
#[tauri::command]
pub async fn review_session(session_id: String) -> Result<SessionDiff, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let wt = review::diff(&worktree_resolve(&root, &session_id)?)?;
        Ok::<SessionDiff, review::ReviewError>(wt)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// All sessions for the list pane, most-recently-updated first.
#[tauri::command]
pub async fn list_sessions(store: State<'_, SessionStore>) -> Result<Vec<SessionSummary>, String> {
    store.list_sessions().await.map_err(|e| e.to_string())
}

/// A session's persisted events, in order — the frontend rebuilds its turns from these.
#[tauri::command]
pub async fn session_events(
    session_id: String,
    store: State<'_, SessionStore>,
) -> Result<Vec<StoredEvent>, String> {
    store.session_events(&session_id).await.map_err(|e| e.to_string())
}

/// Resolve a session's worktree path (validated), erroring via ReviewError.
fn worktree_resolve(root: &std::path::Path, session_id: &str) -> Result<std::path::PathBuf, review::ReviewError> {
    Ok(crate::worktree::worktree_for(root, session_id)?.path)
}

/// Probe PATH for each supported agent CLI (claude, codex, gemini) and return
/// their `AgentInfo` records with `installed` set accordingly. Blocking work is
/// offloaded from the async runtime via `spawn_blocking`.
#[tauri::command]
pub async fn detect_agents() -> Result<Vec<crate::models::AgentInfo>, String> {
    tokio::task::spawn_blocking(crate::models::detect_agents)
        .await
        .map_err(|e| e.to_string())
}

/// Return the model list for `agent`. For "claude": tries the Anthropic REST
/// API when `ANTHROPIC_API_KEY` is set, falls back to hardcoded aliases on any
/// error. Other agents return an empty list. Blocking I/O is offloaded from the
/// async runtime via `spawn_blocking`.
#[tauri::command]
pub async fn list_models(agent: String) -> Result<Vec<crate::models::ModelInfo>, String> {
    tokio::task::spawn_blocking(move || crate::models::list_models(&agent))
        .await
        .map_err(|e| e.to_string())
}

/// List candidate rule/config files for a session's worktree + global config dirs.
#[tauri::command]
pub async fn inspect_rules(session_id: String) -> Result<Vec<RuleFile>, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let wt = crate::worktree::worktree_for(&root, &session_id).map_err(|e| e.to_string())?;
        Ok::<Vec<RuleFile>, String>(inspect::rule_candidates(&wt.path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a rule/config file (validated to the session's worktree or known config dirs).
#[tauri::command]
pub async fn read_text_file(session_id: String, path: String) -> Result<String, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let wt = crate::worktree::worktree_for(&root, &session_id).map_err(|e| e.to_string())?;
        inspect::read_text_file(&path, &wt.path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Discover an agent's available skills/subagents/commands for a session's worktree.
///
/// Returns the three capability categories (`skills`, `subagents`, `commands`) as
/// discovered from `.claude/` subdirectories inside the session worktree and the user's
/// `~/.claude/` home directory. Only `"claude"` is mapped today; all other agents return
/// empty lists. Missing directories are silently ignored (best-effort discovery).
#[tauri::command]
pub async fn list_capabilities(session_id: String, agent: String) -> Result<Capabilities, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let wt = crate::worktree::worktree_for(&root, &session_id).map_err(|e| e.to_string())?;
        Ok::<Capabilities, String>(inspect::list_capabilities(&agent, &wt.path))
    })
    .await
    .map_err(|e| e.to_string())?
}

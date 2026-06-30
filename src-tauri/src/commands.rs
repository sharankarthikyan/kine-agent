use crate::adapter::{AgentAdapter, EventSink, Prompt};
use crate::adapters::claude::ClaudeAdapter;
use crate::events::AgentEvent;
use crate::external_sessions;
use crate::git::{self, BranchChanges, CommitResult, TreeEntry};
use crate::inspect::{
    self, Capabilities, CustomizationCounts, HookEntry, McpServerEntry, PluginEntry, RuleFile,
};
use crate::review::{self, Diffstat, SessionDiff};
use crate::store::{self, SessionStore, SessionSummary, StoredEvent};
use crate::worktree;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::mpsc;

#[derive(Default)]
pub struct RunRegistry {
    active: Mutex<HashSet<String>>,
}

struct RunGuard<'a> {
    registry: &'a RunRegistry,
    session_id: String,
}

impl RunRegistry {
    fn acquire(&self, session_id: &str) -> Result<RunGuard<'_>, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "session lock registry is poisoned".to_string())?;
        if !active.insert(session_id.to_string()) {
            return Err("session is already running".to_string());
        }
        Ok(RunGuard {
            registry: self,
            session_id: session_id.to_string(),
        })
    }
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.registry.active.lock() {
            active.remove(&self.session_id);
        }
    }
}

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
    let sink = Box::new(StoreSink {
        channel: on_event,
        tx,
        saw_error: Arc::clone(&saw_error),
    });

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
    let status = if result.is_ok() && !saw_error.load(Ordering::Acquire) {
        "idle"
    } else {
        "error"
    };
    if let Err(e) = store.set_status(&session_id, status).await {
        // A failed status write leaves the row stuck on its previous value (e.g.
        // "running"). Log it so the stuck state is diagnosable rather than silent.
        eprintln!("failed to set status '{status}' for session {session_id}: {e}");
    }
    result.map_err(|e| e.to_string())
}

/// A session's display title: first non-empty line of the prompt, trimmed to 60 chars.
fn title_from_prompt(prompt: &str) -> String {
    let line = prompt
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
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
/// Uses a stable per-user directory (`<home>/.kineloop/worktrees`), NOT the system
/// temp dir — worktrees hold unreviewed agent work that must survive across reboots
/// until the user reviews and `cleanup_session`s them. Falls back to temp only if the
/// home dir is unavailable. (A later phase moves this to the Tauri app-data dir.)
fn worktrees_root() -> PathBuf {
    crate::agent_paths::data_dir().join("worktrees")
}

/// Resolve which directory to inspect for customizations.
///
/// With an active session, that session's worktree (project + user scope merge).
/// Without one (`None` / empty — e.g. the New Session screen), an app-owned empty
/// directory: it contains no `.claude` config, so only the user's `~/.claude/`
/// global-scope customizations surface.
///
/// This does NOT create the directory — list/count callers never need it to exist on
/// disk (missing dirs just yield no project entries). Only `read_text_file`, which must
/// `canonicalize` a worktree root for its allowlist check, materializes it first via
/// `ensure_scope_dir`.
fn inspect_scope(root: &Path, session_id: Option<String>) -> Result<PathBuf, String> {
    match session_id.filter(|s| !s.is_empty()) {
        Some(id) => Ok(worktree::worktree_for(root, &id)
            .map_err(|e| e.to_string())?
            .path),
        None => Ok(root.join(".global-scope")),
    }
}

/// Ensure the resolved scope directory exists (idempotent). For a real session worktree
/// this is a no-op; for the global `.global-scope` sentinel it creates the empty dir so
/// `read_text_file` can canonicalize it.
fn ensure_scope_dir(scope: &Path) -> Result<(), String> {
    std::fs::create_dir_all(scope).map_err(|e| e.to_string())
}

fn validate_permission_mode(mode: Option<String>) -> Result<Option<String>, String> {
    match mode.as_deref() {
        None | Some("default") | Some("acceptEdits") | Some("plan") => Ok(mode),
        Some("bypassPermissions") => {
            Err("bypassPermissions is not allowed from the app UI".to_string())
        }
        Some(other) => Err(format!("unsupported permission mode: {other}")),
    }
}

/// Validate a model identifier before it is forwarded to the agent CLI's `--model` flag.
///
/// Not shell injection (`Command` takes argv directly), but an unvalidated value can
/// carry a NUL byte (crashes `spawn`) or be arbitrarily long. Restrict to the shape of
/// real model ids/aliases: ASCII alphanumerics plus `- _ . :`, capped at 128 chars.
fn validate_model(model: Option<String>) -> Result<Option<String>, String> {
    if let Some(m) = model.as_deref() {
        if m.is_empty() || m.len() > 128 {
            return Err("model name must be between 1 and 128 characters".to_string());
        }
        if !m
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
        {
            return Err(format!("invalid model name: {m}"));
        }
    }
    Ok(model)
}

fn canonical_repo_path(repo: impl AsRef<Path>) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(repo.as_ref())
        .map_err(|_| "repository folder was not found".to_string())?;
    if !path.is_dir() {
        return Err("repository path is not a directory".to_string());
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("failed to inspect repository: {e}"))?;
    if !output.status.success() {
        return Err("selected folder is not a git repository".to_string());
    }
    let top = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if top.is_empty() {
        return Err("git returned an empty repository path".to_string());
    }
    std::fs::canonicalize(top).map_err(|_| "repository root could not be resolved".to_string())
}

async fn ensure_trusted_repo(store: &SessionStore, repo_path: &Path) -> Result<String, String> {
    let repo = repo_path.display().to_string();
    let trusted = store
        .is_trusted_repo(&repo)
        .await
        .map_err(|e| e.to_string())?;
    if !trusted {
        return Err(
            "repository must be selected with the native folder picker before starting a session"
                .to_string(),
        );
    }
    Ok(repo)
}

/// Open the native folder picker from the privileged backend, canonicalize the selected
/// git repository root, and persist it as trusted for future sessions.
#[tauri::command]
pub async fn pick_repository(
    app: AppHandle,
    store: State<'_, SessionStore>,
) -> Result<Option<String>, String> {
    let selected = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    let Some(folder) = selected else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| format!("selected folder path is not local: {e}"))?;
    let repo = canonical_repo_path(path)?;
    let repo_string = repo.display().to_string();
    store
        .trust_repo(&repo_string)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(repo_string))
}

#[tauri::command]
pub async fn list_trusted_repos(store: State<'_, SessionStore>) -> Result<Vec<String>, String> {
    store.trusted_repos().await.map_err(|e| e.to_string())
}

/// Start a session: create an isolated worktree off `repo` for `session_id`, persist
/// the session + prompt, then run the Claude agent inside it (streaming + persisting
/// events). The worktree is left in place for review; `cleanup_session` removes it.
///
/// `model` is optional: `Some("opus")` / `Some("claude-opus-4-5")` etc. pass `--model`
/// to the CLI; `None` (omitted from the IPC call) uses the CLI's own default.
///
/// `permission_mode` is optional: `Some("acceptEdits")` / `Some("default")` etc. pass
/// `--permission-mode` to the CLI; `None` omits the flag (CLI default applies).
// A Tauri command's parameters are its IPC contract; the count is inherent, not a
// code smell that a parameter struct would meaningfully improve.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn start_session(
    prompt: String,
    repo: String,
    session_id: String,
    model: Option<String>,
    permission_mode: Option<String>,
    on_event: Channel<AgentEvent>,
    store: State<'_, SessionStore>,
    runs: State<'_, RunRegistry>,
) -> Result<(), String> {
    let _guard = runs.acquire(&session_id)?;
    let permission_mode = validate_permission_mode(permission_mode)?;
    let model = validate_model(model)?;
    // `canonical_repo_path` does blocking FS + a git subprocess — keep it off the async
    // runtime thread.
    let repo_for_canon = repo.clone();
    let repo_path = tokio::task::spawn_blocking(move || canonical_repo_path(repo_for_canon))
        .await
        .map_err(|e| e.to_string())??;
    let repo = ensure_trusted_repo(&store, &repo_path).await?;
    let root = worktrees_root();
    let sid = session_id.clone();
    let create_repo_path = repo_path.clone();
    let wt = tokio::task::spawn_blocking(move || worktree::create(&create_repo_path, &root, &sid))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    // Persist the session row + the user's prompt (seq 0) before streaming.
    if let Err(e) = store
        .create_session(
            &session_id,
            "claude",
            &repo,
            &wt.path.display().to_string(),
            &wt.branch,
            &title_from_prompt(&prompt),
        )
        .await
    {
        // Roll back the just-created worktree off the async runtime (git subprocess).
        let cleanup_repo = repo_path.clone();
        let _ = tokio::task::spawn_blocking(move || worktree::remove(&cleanup_repo, &wt)).await;
        return Err(e.to_string());
    }
    if let Err(e) = store
        .append_event(
            &session_id,
            "prompt",
            &serde_json::json!({ "text": prompt }).to_string(),
        )
        .await
    {
        eprintln!("failed to persist prompt for session {session_id}: {e}");
    }

    run_persisting(
        &store,
        session_id,
        Prompt {
            text: prompt,
            model,
            permission_mode,
        },
        wt.path,
        false,
        on_event,
    )
    .await
}

/// Continue an existing session with a follow-up message (resumes the agent in the
/// session's worktree, persisting the new prompt + streamed events).
///
/// `model` is optional: passes `--model` to the CLI when `Some`, omitted when `None`.
/// `permission_mode` is optional: passes `--permission-mode` to the CLI when `Some`, omitted when `None`.
#[tauri::command]
pub async fn send_message(
    prompt: String,
    session_id: String,
    model: Option<String>,
    permission_mode: Option<String>,
    on_event: Channel<AgentEvent>,
    store: State<'_, SessionStore>,
    runs: State<'_, RunRegistry>,
) -> Result<(), String> {
    let _guard = runs.acquire(&session_id)?;
    let permission_mode = validate_permission_mode(permission_mode)?;
    let model = validate_model(model)?;
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

    if let Err(e) = store.set_status(&session_id, "running").await {
        eprintln!("failed to mark session {session_id} running: {e}");
    }
    if let Err(e) = store
        .append_event(
            &session_id,
            "prompt",
            &serde_json::json!({ "text": prompt }).to_string(),
        )
        .await
    {
        eprintln!("failed to persist prompt for session {session_id}: {e}");
    }

    run_persisting(
        &store,
        session_id,
        Prompt {
            text: prompt,
            model,
            permission_mode,
        },
        wt_path,
        true,
        on_event,
    )
    .await
}

/// Remove the worktree (and branch) for a finished session.
#[tauri::command]
pub async fn cleanup_session(
    session_id: String,
    store: State<'_, SessionStore>,
) -> Result<(), String> {
    let repo = store
        .session_repo(&session_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "session not found".to_string())?;
    let repo_path = canonical_repo_path(repo)?;
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
        let wt_path = worktree_resolve(&root, &session_id)?;
        let base = git::default_base(&wt_path);
        let wt = review::diff_from_base(&wt_path, &base)?;
        Ok::<SessionDiff, review::ReviewError>(wt)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// All sessions for the list pane, most-recently-updated first.
#[tauri::command]
pub async fn list_sessions(store: State<'_, SessionStore>) -> Result<Vec<SessionSummary>, String> {
    let mut sessions = store.list_sessions().await.map_err(|e| e.to_string())?;
    // Scanning ~/.claude and ~/.codex transcripts is blocking FS work — keep it off
    // the async runtime thread.
    let external = tokio::task::spawn_blocking(external_sessions::list_sessions)
        .await
        .map_err(|e| e.to_string())?;
    sessions.extend(external);
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(sessions)
}

/// A session's persisted events, in order — the frontend rebuilds its turns from these.
#[tauri::command]
pub async fn session_events(
    session_id: String,
    store: State<'_, SessionStore>,
) -> Result<Vec<StoredEvent>, String> {
    if session_id.starts_with("external:") {
        // Reading + parsing a transcript file is blocking FS work.
        let sid = session_id.clone();
        return tokio::task::spawn_blocking(move || external_sessions::events_for_session(&sid))
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "external session not found".to_string());
    }
    store
        .session_events(&session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Resolve a session's worktree path (validated), erroring via ReviewError.
fn worktree_resolve(
    root: &std::path::Path,
    session_id: &str,
) -> Result<std::path::PathBuf, review::ReviewError> {
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
pub async fn inspect_rules(session_id: Option<String>) -> Result<Vec<RuleFile>, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let path = inspect_scope(&root, session_id)?;
        Ok::<Vec<RuleFile>, String>(inspect::rule_candidates(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a rule/config file (validated to the session's worktree or known config dirs).
#[tauri::command]
pub async fn read_text_file(session_id: Option<String>, path: String) -> Result<String, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let scope = inspect_scope(&root, session_id)?;
        ensure_scope_dir(&scope)?;
        inspect::read_text_file(&path, &scope).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write `content` to a rule/config or capability file that is already within the
/// allowed set for this session's worktree. Uses the identical allowlist as
/// `read_text_file` — only files discovered by `rule_candidates` or
/// `list_capabilities` (filtered to the worktree / `~/.claude` roots) may be written.
/// Content larger than 1 MiB or a path not in the allowlist is rejected.
#[tauri::command]
pub async fn write_text_file(
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let wt = crate::worktree::worktree_for(&root, &session_id).map_err(|e| e.to_string())?;
        inspect::write_project_text_file(&path, &content, &wt.path).map_err(|e| e.to_string())
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
pub async fn list_capabilities(
    session_id: Option<String>,
    agent: String,
) -> Result<Capabilities, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let path = inspect_scope(&root, session_id)?;
        Ok::<Capabilities, String>(inspect::list_capabilities(&agent, &path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Count agents/skills/instructions/hooks/MCP servers for a session's worktree
/// and the user's ~/.claude home. Best-effort: missing files contribute 0.
#[tauri::command]
pub async fn customizations_counts(
    session_id: Option<String>,
) -> Result<CustomizationCounts, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let path = inspect_scope(&root, session_id)?;
        Ok::<CustomizationCounts, String>(inspect::customizations_counts(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return the aggregate diffstat (additions, deletions, filesChanged) for a
/// session's worktree. Best-effort: errors in the underlying diff return all zeros.
#[tauri::command]
pub async fn session_diffstat(session_id: String) -> Result<Diffstat, String> {
    if session_id.starts_with("external:") {
        return Ok(Diffstat {
            additions: 0,
            deletions: 0,
            files_changed: 0,
        });
    }
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let wt = crate::worktree::worktree_for(&root, &session_id).map_err(|e| e.to_string())?;
        let base = git::default_base(&wt.path);
        Ok::<Diffstat, String>(review::diffstat_from_base(&wt.path, &base))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return a flat, sorted file tree for a session's worktree. Directories are derived
/// from file paths and appear before files. Status ("modified" | "added" | "untracked" |
/// "deleted") is attached per file; directories always carry `status: null`.
/// Capped at 2000 entries; excess is logged server-side and truncated.
#[tauri::command]
pub async fn worktree_tree(session_id: String) -> Result<Vec<TreeEntry>, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let wt = crate::worktree::worktree_for(&root, &session_id).map_err(|e| e.to_string())?;
        Ok::<Vec<TreeEntry>, String>(git::worktree_tree(&wt.path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return how many commits the session branch is ahead of its default base branch
/// (derived via `git::default_base`, e.g. main/master) and the list of files with
/// uncommitted changes. Both are best-effort (0 / empty on error).
#[tauri::command]
pub async fn branch_changes(session_id: String) -> Result<BranchChanges, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let wt = crate::worktree::worktree_for(&root, &session_id).map_err(|e| e.to_string())?;
        let base = git::default_base(&wt.path);
        Ok::<BranchChanges, String>(git::branch_changes(&wt.path, &base))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open the session's worktree in VS Code by spawning `code <path>`. Returns a
/// friendly error if `code` is not on PATH; does not wait for VS Code to exit.
#[tauri::command]
pub async fn open_in_editor(session_id: String) -> Result<(), String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let wt = worktree::worktree_for(&root, &session_id).map_err(|e| e.to_string())?;
        // Resolve `code` via PATHEXT so the Windows `code.cmd` shim is found, not just
        // `code.exe`.
        std::process::Command::new(crate::agent_paths::resolve_program("code"))
            .arg(&wt.path)
            .spawn()
            .map_err(|_| "VS Code (code) not found on PATH".to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Spawn the platform's terminal at `dir`. Best-effort and per-OS:
/// - macOS: `open -a Terminal <dir>`
/// - Windows: Windows Terminal (`wt -d <dir>`), falling back to a classic console
/// - Linux/BSD: the first available common emulator, launched with `dir` as its cwd
fn open_terminal_at(dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("failed to open Terminal: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        // Prefer Windows Terminal when present.
        if std::process::Command::new(crate::agent_paths::resolve_program("wt"))
            .arg("-d")
            .arg(dir)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        // Fall back to a classic console window opened in the directory. `start ""`
        // supplies an empty window title so the path isn't misread as the title.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/K"])
            .arg(format!("cd /d \"{}\"", dir.display()))
            .spawn()
            .map_err(|e| format!("failed to open a terminal: {e}"))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Try common emulators in order; each inherits `dir` as its working directory.
        for term in [
            "x-terminal-emulator",
            "gnome-terminal",
            "konsole",
            "xfce4-terminal",
            "alacritty",
            "kitty",
            "xterm",
        ] {
            if std::process::Command::new(term)
                .current_dir(dir)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err("No terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, alacritty, kitty, xterm)".into())
    }
}

/// Open a terminal at the session's worktree. Supported on macOS, Windows, and Linux;
/// returns a friendly error if no terminal could be launched.
#[tauri::command]
pub async fn open_terminal(session_id: String) -> Result<(), String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let wt = worktree::worktree_for(&root, &session_id).map_err(|e| e.to_string())?;
        open_terminal_at(&wt.path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return all hook rules configured for a session's worktree (project) and
/// `~/.claude/settings.json` (user). Each leaf command in the hooks object becomes one
/// entry. Best-effort: missing or unparseable files contribute an empty list.
#[tauri::command]
pub async fn list_hooks(session_id: Option<String>) -> Result<Vec<HookEntry>, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let path = inspect_scope(&root, session_id)?;
        Ok::<Vec<HookEntry>, String>(inspect::list_hooks(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return all MCP servers declared for a session's worktree (`.mcp.json`) and
/// `~/.claude.json` (user). Best-effort: missing or unparseable files contribute nothing.
#[tauri::command]
pub async fn list_mcp_servers(session_id: Option<String>) -> Result<Vec<McpServerEntry>, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let path = inspect_scope(&root, session_id)?;
        Ok::<Vec<McpServerEntry>, String>(inspect::list_mcp_servers(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return installed Claude Code plugins from `~/.claude/plugins/installed_plugins.json`.
/// Best-effort: returns an empty list when the file is missing or unparseable.
#[tauri::command]
pub async fn list_plugins(session_id: Option<String>) -> Result<Vec<PluginEntry>, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let path = inspect_scope(&root, session_id)?;
        Ok::<Vec<PluginEntry>, String>(inspect::list_plugins(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stage all changes in the session's worktree (`git add -A`) and commit them with
/// `message`. Returns the new HEAD sha. Errors when the message is blank, the tree is
/// clean, or git fails for any reason. Never pushes, merges, or switches branches.
#[tauri::command]
pub async fn commit_session(session_id: String, message: String) -> Result<CommitResult, String> {
    let root = worktrees_root();
    tokio::task::spawn_blocking(move || {
        let wt = crate::worktree::worktree_for(&root, &session_id).map_err(|e| e.to_string())?;
        git::commit_session(&wt.path, &message)
    })
    .await
    .map_err(|e| e.to_string())?
}

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
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{mpsc, watch};

/// Tracks in-flight runs. A session id present in `active` means a run is in progress;
/// the mapped `watch::Sender` lets `stop_session` cancel it. The presence test also gates
/// destructive operations (e.g. `cleanup_session`) from racing a live run.
#[derive(Default)]
pub struct RunRegistry {
    active: Mutex<HashMap<String, watch::Sender<bool>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventsPage {
    pub events: Vec<StoredEvent>,
    pub next_offset: usize,
    pub has_more: bool,
}

struct RunGuard<'a> {
    registry: &'a RunRegistry,
    session_id: String,
}

impl RunRegistry {
    /// Reserve `session_id` for a run. Returns a guard that releases the reservation on
    /// drop, plus a cancel receiver the run races against; `Err` if a run is already in
    /// flight for this id.
    fn acquire(&self, session_id: &str) -> Result<(RunGuard<'_>, watch::Receiver<bool>), String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "session lock registry is poisoned".to_string())?;
        if active.contains_key(session_id) {
            return Err("session is already running".to_string());
        }
        let (cancel_tx, cancel_rx) = watch::channel(false);
        active.insert(session_id.to_string(), cancel_tx);
        Ok((
            RunGuard {
                registry: self,
                session_id: session_id.to_string(),
            },
            cancel_rx,
        ))
    }

    /// Signal an in-flight run to stop. Returns true if a run was signalled, false if
    /// nothing was running. A send error means the run already ended — an equally fine
    /// outcome for a stop request — so it's ignored.
    fn cancel(&self, session_id: &str) -> bool {
        if let Ok(active) = self.active.lock() {
            if let Some(cancel_tx) = active.get(session_id) {
                let _ = cancel_tx.send(true);
                return true;
            }
        }
        false
    }

    /// Whether a run is currently in flight for `session_id`.
    fn is_active(&self, session_id: &str) -> bool {
        self.active
            .lock()
            .map(|active| active.contains_key(session_id))
            .unwrap_or(false)
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
#[allow(clippy::too_many_arguments)]
async fn run_persisting(
    store: &SessionStore,
    session_id: String,
    agent: String,
    prompt: Prompt,
    cwd: PathBuf,
    resume: bool,
    external_thread_id: Option<String>,
    mut cancel_rx: watch::Receiver<bool>,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    // Persist the permission mode + sandbox flag actually used for this run so the UI can
    // seed each session's control from its last choice (single place, covering both new
    // sessions and follow-up turns). Best-effort: a persistence hiccup must not abort a run.
    // Skipped when no mode was supplied, to avoid clobbering a stored value with NULL.
    if let Some(mode) = prompt.permission_mode.as_deref() {
        if let Err(e) = store
            .set_permission_mode(&session_id, mode, prompt.sandbox_terminal)
            .await
        {
            eprintln!("failed to persist permission mode for {session_id}: {e}");
        }
    }

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

    // Dispatch to the agent's adapter. Codex and Antigravity mint their own
    // conversation id; `captured` collects it during the run so we can persist it for
    // resume. On resume those adapters take the previously-captured id (not the
    // Kineloop session id); Claude always uses the Kineloop session id directly.
    let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let run_future = async {
        match agent.as_str() {
            "codex" => {
                let (adapter_id, do_resume) =
                    resume_target(&session_id, resume, external_thread_id.as_deref());
                crate::adapters::codex::CodexAdapter::new(captured.clone())
                    .run(prompt, cwd, adapter_id, do_resume, sink)
                    .await
            }
            "antigravity" => {
                let (adapter_id, do_resume) =
                    resume_target(&session_id, resume, external_thread_id.as_deref());
                crate::adapters::antigravity::AntigravityAdapter::new(captured.clone())
                    .run(prompt, cwd, adapter_id, do_resume, sink)
                    .await
            }
            _ => {
                ClaudeAdapter
                    .run(prompt, cwd, session_id.clone(), resume, sink)
                    .await
            }
        }
    };

    // Race the run against a cancel signal from `stop_session`. On cancel, dropping
    // `run_future` drops the adapter future, killing its child process via `kill_on_drop`
    // and dropping the sink (whose tx end terminates the drain task below).
    let mut cancelled = false;
    let result = tokio::select! {
        r = run_future => r,
        _ = cancel_rx.changed() => {
            cancelled = true;
            Ok(())
        }
    };
    let _ = drain.await; // flush all persisted events before stamping status

    // Persist a freshly captured external conversation id so later turns can resume it.
    if let Some(id) = captured.lock().ok().and_then(|g| g.clone()) {
        if let Err(e) = store.set_external_thread_id(&session_id, &id).await {
            eprintln!("failed to persist external thread id for {session_id}: {e}");
        }
    }
    // A user-initiated stop is not a failure: mark the session idle (stopped, resumable).
    // Otherwise "error" iff the run returned Err OR an in-band Error event flowed through.
    let status = if !cancelled && (result.is_err() || saw_error.load(Ordering::Acquire)) {
        "error"
    } else {
        "idle"
    };
    if let Err(e) = store.set_status(&session_id, status).await {
        // A failed status write leaves the row stuck on its previous value (e.g.
        // "running"). Log it so the stuck state is diagnosable rather than silent; the
        // startup `reset_running_sessions` sweep is the backstop that un-sticks it.
        eprintln!("failed to set status '{status}' for session {session_id}: {e}");
    }
    result.map_err(|e| e.to_string())
}

/// Upper bound on a single user prompt forwarded to an agent CLI. The prompt is passed as
/// a process argument, so an unbounded value can exceed the OS argv limit (`E2BIG`) and
/// surface only as a cryptic spawn failure. 256 KiB dwarfs any hand-written prompt while
/// staying well under ARG_MAX.
const MAX_PROMPT_BYTES: usize = 256 * 1024;

/// Budget for the imported-transcript portion of a continuation prompt. The assembled
/// prompt is one process argument, so a multi-MB external session would otherwise blow
/// ARG_MAX. We keep the most recent tail (the most relevant context) within this budget.
const MAX_TRANSCRIPT_BYTES: usize = 192 * 1024;

/// Reject a user prompt that is too large to pass safely as a process argument.
fn validate_prompt(prompt: &str) -> Result<(), String> {
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(format!(
            "prompt is too long ({} bytes; limit is {} bytes)",
            prompt.len(),
            MAX_PROMPT_BYTES
        ));
    }
    Ok(())
}

/// Keep an imported transcript within [`MAX_TRANSCRIPT_BYTES`] when embedding it in a
/// continuation prompt. Retains the most recent tail and prepends a note when older
/// entries are dropped, so the assembled single-argument prompt can't exceed ARG_MAX for
/// very large external sessions. Cuts on a UTF-8 char boundary so no sequence is split.
fn truncate_transcript_tail(transcript: String) -> String {
    if transcript.len() <= MAX_TRANSCRIPT_BYTES {
        return transcript;
    }
    let cut = transcript.len() - MAX_TRANSCRIPT_BYTES;
    let cut = (cut..=transcript.len())
        .find(|i| transcript.is_char_boundary(*i))
        .unwrap_or(transcript.len());
    format!(
        "[Older transcript entries were truncated to fit the context budget.]\n\n{}",
        &transcript[cut..]
    )
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

fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
}

fn external_event_excerpt(event: &StoredEvent) -> Option<String> {
    let payload: serde_json::Value = serde_json::from_str(&event.payload_json).ok()?;
    match event.kind.as_str() {
        "prompt" => json_string(&payload, "text").map(|text| format!("User: {text}")),
        "token" => json_string(&payload, "text").map(|text| format!("Assistant: {text}")),
        "toolCall" => {
            let name = json_string(&payload, "name").unwrap_or_else(|| "tool".to_string());
            let input = json_string(&payload, "input").unwrap_or_default();
            Some(if input.is_empty() {
                format!("Tool call: {name}")
            } else {
                format!("Tool call: {name} {input}")
            })
        }
        "fileWrite" => json_string(&payload, "path").map(|path| format!("File changed: {path}")),
        "done" => {
            json_string(&payload, "summary").map(|summary| format!("Assistant summary: {summary}"))
        }
        "error" => json_string(&payload, "message").map(|message| format!("Error: {message}")),
        _ => None,
    }
}

fn build_external_continuation_prompt(
    external_session_id: &str,
    original_agent: &str,
    continuation_agent: &str,
    repo: &Path,
    prompt: &str,
    events: &[StoredEvent],
) -> String {
    let transcript = truncate_transcript_tail(
        events
            .iter()
            .filter_map(external_event_excerpt)
            .collect::<Vec<_>>()
            .join("\n\n"),
    );
    format!(
        "You are continuing an imported CLI history session inside Kineloop.\n\
         External session id: {external_session_id}\n\
         Original agent: {original_agent}\n\
         Continuation agent: {continuation_agent}\n\
         Repository: {}\n\n\
         Treat the transcript below as prior conversation context. Do not assume the old CLI process is still alive. \
         Continue from the user's new request using the current repository state.\n\n\
         --- Imported transcript ---\n\
         {transcript}\n\
         --- End imported transcript ---\n\n\
         New user request:\n\
         {prompt}",
        repo.display()
    )
}

fn original_agent_from_external_session_id(session_id: &str) -> Result<String, String> {
    let mut parts = session_id.split(':');
    match (parts.next(), parts.next()) {
        (Some("external"), Some(agent)) if !agent.is_empty() => Ok(agent.to_string()),
        _ => Err("session is not an imported CLI session".to_string()),
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
        // External (read-only CLI history) sessions have no Kineloop worktree — their
        // `external:` ids aren't valid worktree ids. Resolve to the session's real repo
        // so its `.claude` customizations surface; fall back to global scope when the
        // transcript recorded no usable repo path.
        Some(id) if id.starts_with("external:") => Ok(external_sessions::repo_for_session(&id)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| root.join(".global-scope"))),
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

/// Validate the unified permission-mode id from the (untrusted) IPC boundary. Accepts the
/// wire vocabulary the frontend emits (`default`, `acceptEdits`, `plan`, `full`, `dontAsk`)
/// or `None` (defer to the CLI default). Raw per-CLI spellings like `bypassPermissions` are
/// rejected so only the unified vocabulary crosses the boundary; adapters translate `full`
/// to each CLI's real bypass flag. `full` is intentionally allowed (the UI gates it behind
/// an explicit confirmation). Claude's `auto` classifier mode is not accepted: it aborts
/// under headless `-p`, so Kineloop never offers it.
fn validate_permission_mode(mode: Option<String>) -> Result<Option<String>, String> {
    match mode.as_deref() {
        None
        | Some("default")
        | Some("acceptEdits")
        | Some("plan")
        | Some("full")
        | Some("dontAsk") => Ok(mode),
        Some(other) => Err(format!("unsupported permission mode: {other}")),
    }
}

/// Agents Kineloop can spawn. The frontend gates the picker, but the backend
/// re-validates because the IPC boundary is untrusted.
const SPAWNABLE_AGENTS: [&str; 3] = ["claude", "codex", "antigravity"];

/// Validate the requested agent id, defaulting to `"claude"` when omitted.
fn validate_agent(agent: Option<String>) -> Result<String, String> {
    match agent {
        None => Ok("claude".to_string()),
        Some(a) if SPAWNABLE_AGENTS.contains(&a.as_str()) => Ok(a),
        Some(a) => Err(format!("unsupported agent: {a}")),
    }
}

/// Pick the id + resume flag to hand an adapter that resumes by a CLI-native id.
/// Resumes with the captured external id when available; otherwise starts fresh so a
/// missing/never-captured id degrades to a new turn rather than an error.
fn resume_target(session_id: &str, resume: bool, external: Option<&str>) -> (String, bool) {
    match (resume, external) {
        (true, Some(id)) => (id.to_string(), true),
        _ => (session_id.to_string(), false),
    }
}

/// Validate a model identifier before it is forwarded to the agent CLI's `--model` flag.
///
/// Not shell injection (`Command` takes argv directly), but an unvalidated value can
/// carry a NUL/control byte (crashes `spawn`) or be arbitrarily long. Allow the shape of
/// real model ids/aliases AND human-readable names like `"Gemini 3.5 Flash (Medium)"`
/// that `agy models` emits: ASCII alphanumerics plus `- _ . : space ( )`, ≤128 chars.
fn validate_model(model: Option<String>) -> Result<Option<String>, String> {
    if let Some(m) = model.as_deref() {
        if m.is_empty() || m.len() > 128 {
            return Err("model name must be between 1 and 128 characters".to_string());
        }
        if !m.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | ' ' | '(' | ')')
        }) {
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

#[allow(clippy::too_many_arguments)]
async fn create_session_and_run(
    store: &SessionStore,
    session_id: String,
    agent: String,
    repo_path: PathBuf,
    repo: String,
    display_prompt: String,
    agent_prompt: String,
    model: Option<String>,
    permission_mode: Option<String>,
    sandbox_terminal: bool,
    title_override: Option<String>,
    cancel_rx: watch::Receiver<bool>,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    let root = worktrees_root();
    let sid = session_id.clone();
    let create_repo_path = repo_path.clone();
    let wt = tokio::task::spawn_blocking(move || worktree::create(&create_repo_path, &root, &sid))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    // A title override (e.g. a renamed CLI-history session being continued) wins over the
    // prompt-derived title so the user's chosen name carries into the new session.
    let title = title_override.unwrap_or_else(|| title_from_prompt(&display_prompt));
    if let Err(e) = store
        .create_session(
            &session_id,
            &agent,
            &repo,
            &wt.path.display().to_string(),
            &wt.branch,
            &title,
        )
        .await
    {
        let cleanup_repo = repo_path.clone();
        let _ = tokio::task::spawn_blocking(move || worktree::remove(&cleanup_repo, &wt)).await;
        return Err(e.to_string());
    }
    if let Err(e) = store
        .append_event(
            &session_id,
            "prompt",
            &serde_json::json!({ "text": display_prompt }).to_string(),
        )
        .await
    {
        eprintln!("failed to persist prompt for session {session_id}: {e}");
    }

    run_persisting(
        store,
        session_id,
        agent,
        Prompt {
            text: agent_prompt,
            model,
            permission_mode,
            sandbox_terminal,
        },
        wt.path,
        false,
        None,
        cancel_rx,
        on_event,
    )
    .await
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
    agent: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    sandbox_terminal: Option<bool>,
    on_event: Channel<AgentEvent>,
    store: State<'_, SessionStore>,
    runs: State<'_, RunRegistry>,
) -> Result<(), String> {
    validate_prompt(&prompt)?;
    let (_guard, cancel_rx) = runs.acquire(&session_id)?;
    let agent = validate_agent(agent)?;
    let permission_mode = validate_permission_mode(permission_mode)?;
    let sandbox_terminal = sandbox_terminal.unwrap_or(false);
    let model = validate_model(model)?;
    // `canonical_repo_path` does blocking FS + a git subprocess — keep it off the async
    // runtime thread.
    let repo_for_canon = repo.clone();
    let repo_path = tokio::task::spawn_blocking(move || canonical_repo_path(repo_for_canon))
        .await
        .map_err(|e| e.to_string())??;
    let repo = ensure_trusted_repo(&store, &repo_path).await?;

    create_session_and_run(
        &store,
        session_id,
        agent,
        repo_path,
        repo,
        prompt.clone(),
        prompt,
        model,
        permission_mode,
        sandbox_terminal,
        None,
        cancel_rx,
        on_event,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn continue_external_session(
    external_session_id: String,
    prompt: String,
    session_id: String,
    agent: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    sandbox_terminal: Option<bool>,
    // The originating CLI-history session's display title (as shown in the list, already
    // reflecting any rename override). The writable continuation inherits it so it reads
    // as a continuation of that session instead of being titled by the first follow-up.
    title: Option<String>,
    on_event: Channel<AgentEvent>,
    store: State<'_, SessionStore>,
    runs: State<'_, RunRegistry>,
) -> Result<(), String> {
    validate_prompt(&prompt)?;
    let (_guard, cancel_rx) = runs.acquire(&session_id)?;
    let original_agent = original_agent_from_external_session_id(&external_session_id)?;
    let default_agent = SPAWNABLE_AGENTS
        .contains(&original_agent.as_str())
        .then(|| original_agent.clone());
    let agent = validate_agent(agent.or(default_agent))?;
    let permission_mode = validate_permission_mode(permission_mode)?;
    let sandbox_terminal = sandbox_terminal.unwrap_or(false);
    let model = validate_model(model)?;

    let repo_lookup_id = external_session_id.clone();
    let repo_path = tokio::task::spawn_blocking(move || {
        external_sessions::repo_for_session(&repo_lookup_id)
            .ok_or_else(|| "imported CLI session does not record a repository path".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let repo_path = tokio::task::spawn_blocking(move || canonical_repo_path(repo_path))
        .await
        .map_err(|e| e.to_string())??;
    // The repo here is NOT arbitrary WebView input: it's read from the user's own on-disk
    // CLI transcript and validated as a real git repository by `canonical_repo_path`.
    // Choosing to continue that session is itself the trust gesture, so persist the repo
    // as trusted rather than demanding a separate native-folder-picker step (which an
    // imported session can never have gone through). `start_session`, whose repo IS
    // WebView-supplied, keeps the stricter `ensure_trusted_repo` gate.
    let repo = repo_path.display().to_string();
    store.trust_repo(&repo).await.map_err(|e| e.to_string())?;

    let events_lookup_id = external_session_id.clone();
    let external_events = tokio::task::spawn_blocking(move || {
        external_sessions::events_for_session(&events_lookup_id)
            .ok_or_else(|| "imported CLI session not found".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let agent_prompt = build_external_continuation_prompt(
        &external_session_id,
        &original_agent,
        &agent,
        &repo_path,
        &prompt,
        &external_events,
    );

    // Inherit the originating session's title (trimmed + capped) so the continuation is
    // recognizable as such. The frontend-supplied title already reflects any rename
    // override; if none was passed, fall back to a stored override for this id, and
    // finally (in create_session_and_run) to a prompt-derived title.
    let passed_title = title.and_then(|t| normalize_title(&t).ok());
    let title_override = match passed_title {
        Some(t) => Some(t),
        None => store
            .title_overrides()
            .await
            .map_err(|e| e.to_string())?
            .remove(&external_session_id),
    };

    create_session_and_run(
        &store,
        session_id,
        agent,
        repo_path,
        repo,
        prompt,
        agent_prompt,
        model,
        permission_mode,
        sandbox_terminal,
        title_override,
        cancel_rx,
        on_event,
    )
    .await
}

/// Continue an existing session with a follow-up message (resumes the agent in the
/// session's worktree, persisting the new prompt + streamed events).
///
/// `model` is optional: passes `--model` to the CLI when `Some`, omitted when `None`.
/// `permission_mode` is optional: the unified mode id applied to the resumed run.
// A Tauri command's parameters are its IPC contract; the count is inherent.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn send_message(
    prompt: String,
    session_id: String,
    model: Option<String>,
    permission_mode: Option<String>,
    sandbox_terminal: Option<bool>,
    on_event: Channel<AgentEvent>,
    store: State<'_, SessionStore>,
    runs: State<'_, RunRegistry>,
) -> Result<(), String> {
    validate_prompt(&prompt)?;
    let (_guard, cancel_rx) = runs.acquire(&session_id)?;
    let permission_mode = validate_permission_mode(permission_mode)?;
    let sandbox_terminal = sandbox_terminal.unwrap_or(false);
    let model = validate_model(model)?;
    // Resume uses the session's own agent + its captured CLI-native conversation id.
    let agent = store
        .get_agent(&session_id)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "claude".to_string());
    let external_thread_id = store
        .get_external_thread_id(&session_id)
        .await
        .map_err(|e| e.to_string())?;
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
        agent,
        Prompt {
            text: prompt,
            model,
            permission_mode,
            sandbox_terminal,
        },
        wt_path,
        true,
        external_thread_id,
        cancel_rx,
        on_event,
    )
    .await
}

/// Request cancellation of an in-flight run for `session_id`. Returns true when a run was
/// signalled to stop, false when nothing was running. The run's child process is killed
/// and the session is marked idle (a user stop is not a failure).
#[tauri::command]
pub async fn stop_session(
    session_id: String,
    runs: State<'_, RunRegistry>,
) -> Result<bool, String> {
    Ok(runs.cancel(&session_id))
}

/// Remove the worktree (and branch) for a finished session, then delete its persisted
/// rows (session, events, title override) so it doesn't linger as a ghost pointing at a
/// path that no longer exists. Refuses to run while the session is still active — stop it
/// first — so cleanup can't yank the worktree out from under a live agent process.
#[tauri::command]
pub async fn cleanup_session(
    session_id: String,
    store: State<'_, SessionStore>,
    runs: State<'_, RunRegistry>,
) -> Result<(), String> {
    if runs.is_active(&session_id) {
        return Err("Stop the running session before cleaning up its worktree.".to_string());
    }
    let repo = store
        .session_repo(&session_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "session not found".to_string())?;
    let repo_path = canonical_repo_path(repo)?;
    let root = worktrees_root();
    let cleanup_id = session_id.clone();
    // Resolve+validate the session→worktree mapping, then remove off the async runtime.
    // `worktree::remove` is idempotent (a missing worktree is treated as already removed),
    // so a prior partial cleanup or a manual deletion still succeeds here.
    tokio::task::spawn_blocking(move || {
        let wt = worktree::worktree_for(&root, &cleanup_id)?;
        worktree::remove(&repo_path, &wt)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    // Worktree gone — drop the DB rows last, so a removal failure above leaves the session
    // intact for the user to retry rather than orphaning a half-cleaned session.
    store
        .delete_session(&session_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
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
    // Apply user-set title overrides (chiefly for external sessions, whose on-disk
    // transcripts we never rewrite). Kineloop sessions are renamed in place, so they
    // normally have no override; if one exists it still wins, which is harmless.
    let overrides = store.title_overrides().await.map_err(|e| e.to_string())?;
    if !overrides.is_empty() {
        for s in &mut sessions {
            if let Some(title) = overrides.get(&s.id) {
                s.title = title.clone();
            }
        }
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(sessions)
}

/// Trim a user-supplied title and cap it at 60 chars (mirroring `title_from_prompt`),
/// rejecting titles that are empty after trimming.
fn normalize_title(title: &str) -> Result<String, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("Title cannot be empty.".to_string());
    }
    if trimmed.chars().count() > 60 {
        Ok(trimmed.chars().take(60).collect())
    } else {
        Ok(trimmed.to_string())
    }
}

/// Rename a session. Trims and caps the title at 60 chars (mirroring `title_from_prompt`)
/// and rejects empty titles. Kineloop sessions are renamed in place; external CLI sessions
/// get a stored title override (their on-disk transcript is never modified). Returns the
/// stored title so the frontend can display the canonical form.
#[tauri::command]
pub async fn rename_session(
    session_id: String,
    title: String,
    store: State<'_, SessionStore>,
) -> Result<String, String> {
    let capped = normalize_title(&title)?;
    if session_id.starts_with("external:") {
        store
            .set_title_override(&session_id, &capped)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(capped);
    }
    let rows = store
        .set_title(&session_id, &capped)
        .await
        .map_err(|e| e.to_string())?;
    if rows == 0 {
        return Err("Session not found.".to_string());
    }
    Ok(capped)
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

#[tauri::command]
pub async fn session_events_page(
    session_id: String,
    offset: usize,
    limit: usize,
    store: State<'_, SessionStore>,
) -> Result<SessionEventsPage, String> {
    if limit == 0 {
        return Ok(SessionEventsPage {
            events: Vec::new(),
            next_offset: offset,
            has_more: false,
        });
    }

    if session_id.starts_with("external:") {
        let sid = session_id.clone();
        let fetch_limit = limit.saturating_add(1);
        let mut events = tokio::task::spawn_blocking(move || {
            external_sessions::events_page_for_session(&sid, offset, fetch_limit)
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "external session not found".to_string())?;
        let has_more = events.len() > limit;
        if has_more {
            events.truncate(limit);
        }
        return Ok(SessionEventsPage {
            next_offset: offset.saturating_add(events.len()),
            events,
            has_more,
        });
    }

    let fetch_limit = limit.saturating_add(1);
    let mut events = store
        .session_events_recent_page(&session_id, offset, fetch_limit)
        .await
        .map_err(|e| e.to_string())?;
    let has_more = events.len() > limit;
    if has_more {
        events.truncate(limit);
    }
    Ok(SessionEventsPage {
        next_offset: offset.saturating_add(events.len()),
        events,
        has_more,
    })
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

/// Return the model list for `agent`. For "claude" this is the CLI's family
/// aliases (`opus`/`sonnet`/`haiku`) with versioned labels filled in from the
/// on-disk cache when present — fast and non-blocking. Other agents return an
/// empty list. Call `refresh_models` to (re-)resolve the versioned labels.
#[tauri::command]
pub async fn list_models(agent: String) -> Result<Vec<crate::models::ModelInfo>, String> {
    tokio::task::spawn_blocking(move || crate::models::list_models(&agent))
        .await
        .map_err(|e| e.to_string())
}

/// Re-resolve a model list against the CLI under the user's subscription auth,
/// upgrading alias labels to versioned names (e.g. "Claude Opus 4.8"). For
/// "claude" this probes the CLI once per family (skipped when the cache is
/// fresh); "codex" reads the CLI's catalog via `codex debug models`; other
/// agents fall through to the plain list. These spawn subprocesses, so the work
/// is offloaded via `spawn_blocking`.
#[tauri::command]
pub async fn refresh_models(agent: String) -> Result<Vec<crate::models::ModelInfo>, String> {
    tokio::task::spawn_blocking(move || match agent.as_str() {
        "claude" => crate::models::refresh_claude_models(),
        "codex" => crate::models::refresh_codex_models(),
        "antigravity" => crate::models::refresh_antigravity_models(),
        other => crate::models::list_models(other),
    })
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

#[cfg(test)]
mod tests {
    use super::{
        normalize_title, truncate_transcript_tail, validate_permission_mode, validate_prompt,
        MAX_PROMPT_BYTES, MAX_TRANSCRIPT_BYTES,
    };

    // Guards the cancellation mechanism in `run_persisting`: a freshly-created watch
    // receiver must NOT report a change until `send` is called, otherwise the select would
    // take the cancel branch immediately and no agent would ever run.
    #[tokio::test]
    async fn watch_changed_only_fires_after_send() {
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        tokio::select! {
            biased;
            _ = rx.changed() => panic!("changed() fired before any send"),
            _ = std::future::ready(()) => {}
        }
        tx.send(true).unwrap();
        rx.changed().await.unwrap();
        assert!(*rx.borrow());
    }

    #[test]
    fn validate_prompt_accepts_normal_and_rejects_oversized() {
        assert!(validate_prompt("write a function").is_ok());
        assert!(validate_prompt(&"a".repeat(MAX_PROMPT_BYTES)).is_ok());
        assert!(validate_prompt(&"a".repeat(MAX_PROMPT_BYTES + 1)).is_err());
    }

    #[test]
    fn validate_permission_mode_accepts_unified_ids_and_rejects_raw_spellings() {
        for ok in ["default", "acceptEdits", "plan", "full", "dontAsk"] {
            assert!(
                validate_permission_mode(Some(ok.to_string())).is_ok(),
                "{ok} should be accepted"
            );
        }
        // None defers to the CLI default.
        assert!(validate_permission_mode(None).is_ok());
        // `full` is now allowed (UI gates it behind a confirm); raw per-CLI spellings and
        // anything unknown are rejected so only the unified vocabulary crosses the boundary.
        assert!(validate_permission_mode(Some("bypassPermissions".to_string())).is_err());
        assert!(validate_permission_mode(Some("workspace-write".to_string())).is_err());
        assert!(validate_permission_mode(Some("nonsense".to_string())).is_err());
        // `auto` is rejected: its classifier aborts under headless -p, so it's never offered.
        assert!(validate_permission_mode(Some("auto".to_string())).is_err());
    }

    #[test]
    fn truncate_transcript_tail_keeps_small_transcripts_verbatim() {
        let small = "User: hi\n\nAssistant: hello".to_string();
        assert_eq!(truncate_transcript_tail(small.clone()), small);
    }

    #[test]
    fn truncate_transcript_tail_caps_large_transcripts_to_the_tail() {
        // Build a transcript larger than the budget; the tail (with the newest marker)
        // must survive and the result must stay within budget + the prepended note.
        let mut transcript = "OLDEST_MARKER\n".to_string();
        transcript.push_str(&"x".repeat(MAX_TRANSCRIPT_BYTES));
        transcript.push_str("\nNEWEST_MARKER");
        let out = truncate_transcript_tail(transcript);
        assert!(out.contains("truncated"), "a truncation note is prepended");
        assert!(out.contains("NEWEST_MARKER"), "the newest tail is retained");
        assert!(!out.contains("OLDEST_MARKER"), "the oldest head is dropped");
    }

    #[test]
    fn truncate_transcript_tail_cuts_on_char_boundary() {
        // A transcript of multi-byte chars must not panic or split a UTF-8 sequence.
        let transcript = "é".repeat(MAX_TRANSCRIPT_BYTES); // 2 bytes each → over budget
        let out = truncate_transcript_tail(transcript);
        // Round-trips as valid UTF-8 (no split sequence) and stays bounded.
        assert!(out.len() <= MAX_TRANSCRIPT_BYTES + 128);
    }

    #[test]
    fn normalize_title_trims_surrounding_whitespace() {
        assert_eq!(normalize_title("  hello  ").unwrap(), "hello");
    }

    #[test]
    fn normalize_title_rejects_blank_input() {
        assert!(normalize_title("   ").is_err());
        assert!(normalize_title("").is_err());
    }

    #[test]
    fn normalize_title_caps_at_60_chars() {
        let long = "a".repeat(75);
        let out = normalize_title(&long).unwrap();
        assert_eq!(out.chars().count(), 60);
    }

    #[test]
    fn normalize_title_caps_by_chars_not_bytes() {
        // Multi-byte chars must be counted as one each, not by UTF-8 byte length.
        let long = "é".repeat(70);
        let out = normalize_title(&long).unwrap();
        assert_eq!(out.chars().count(), 60);
    }
}

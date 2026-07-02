//! ACP engine adapter: drives an ACP agent subprocess (claude-agent-acp in M1)
//! over ndjson JSON-RPC stdio. See docs/superpowers/specs/2026-07-01-acp-adapter-design.md.
//!
//! M1 scope: text + tool-call streaming, permissions auto-answered from the
//! session's permission mode, no usage event (ACP does not standardize usage),
//! immediate-kill cancel via `kill_on_drop`. M4 adds the fs proxy: reads/writes
//! the agent routes through fs/read_text_file / fs/write_text_file are served
//! here, contained to the session worktree (`acp::fs_guard`).

use crate::acp::client::{self, SessionUpdate};
use crate::acp::jsonrpc::{Inbound, RpcPeer};
use crate::adapter::{AgentAdapter, EventSink, Prompt, SessionError};
use crate::events::AgentEvent;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, BufReader};
use tokio::process::Command;

/// Per-agent ACP launch profile. Packages are VERSION-PINNED: unpinned npx
/// drifts to @latest, and a silent protocol bump must be a deliberate, tested
/// upgrade — not a runtime surprise. `login_hint` is appended to auth_required
/// failures so the toast tells the user exactly what to run.
#[derive(Clone, Copy)]
pub struct AcpProfile {
    pub package: &'static str,
    pub login_hint: &'static str,
    /// Under acceptEdits-grade session modes, permission requests that still
    /// arrive are by definition ESCALATIONS beyond the mode's grant (codex
    /// mode "auto": network / outside-workspace / sandbox-off) — surface them
    /// interactively instead of auto-approving. Claude keeps M1–M5 behavior
    /// (false) until revisited.
    pub interactive_escalations: bool,
}

pub const CLAUDE_ACP: AcpProfile = AcpProfile {
    package: "@agentclientprotocol/claude-agent-acp@0.54.1",
    login_hint: "log in with the Claude CLI first (`claude`, then /login)",
    interactive_escalations: false,
};

pub const CODEX_ACP: AcpProfile = AcpProfile {
    package: "@zed-industries/codex-acp@0.16.0",
    login_hint: "run `codex login` in a terminal, then retry",
    interactive_escalations: true,
};

/// SIGKILLs the child's process group when dropped. `spawn_and_drive` arms one
/// right after spawn so that EVERY exit path — normal return, the cancel-grace
/// expiry in run_persisting, a stop-button drop of the whole future, panic
/// unwind — tears down the full tree. tokio's `kill_on_drop` only reaches the
/// direct child (the npx wrapper); the descendants (node shim, codex-acp's
/// native binary) survive it and don't exit on stdin EOF (M6 smoke finding).
/// Double-kill against the inline killpg at normal teardown is harmless
/// (ESRCH on a dead group).
struct KillPgOnDrop(#[cfg(unix)] Option<i32>);

impl KillPgOnDrop {
    fn new(child_id: Option<u32>) -> Self {
        #[cfg(unix)]
        return Self(child_id.map(|pid| pid as i32));
        #[cfg(not(unix))]
        {
            let _ = child_id;
            Self()
        }
    }
}

impl Drop for KillPgOnDrop {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pgid) = self.0 {
            // process_group(0) at spawn made the child's pgid == its pid.
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        }
    }
}

/// Emitted when a resume request degrades to a fresh session WITH replayed context.
const RESUME_NOTICE_WITH_CONTEXT: &str = "This agent can't restore the previous session natively — Kineloop replayed recent conversation context into this turn.";
/// Emitted when a resume request degrades to a fresh session with NO context to replay.
const RESUME_NOTICE_NO_CONTEXT: &str = "This agent can't restore the previous session natively — this turn starts without prior context.";

/// Adapter that drives an ACP agent (Claude in M1) as a subprocess.
///
/// The agent mints its own ACP session id in `session/new`; we capture it into
/// [`AcpAdapter::captured_session`] so the command layer can persist it
/// (`external_thread_id`) and resume with `session/load` on later turns.
pub struct AcpAdapter {
    captured_session: Arc<Mutex<Option<String>>>,
    /// Shared handle to the app's approval registry: interactive permission
    /// requests register here and are resolved by respond_to_approval.
    approvals: crate::approval::ApprovalRegistry,
    /// The KINELOOP session id approvals belong to. Distinct from the `session_id`
    /// run() receives, which on resume is the ACP-minted thread id.
    app_session_id: String,
    /// Which agent's ACP package to launch, and its login hint on auth failure.
    profile: AcpProfile,
}

impl AcpAdapter {
    pub fn new(
        captured_session: Arc<Mutex<Option<String>>>,
        approvals: crate::approval::ApprovalRegistry,
        app_session_id: String,
        profile: AcpProfile,
    ) -> Self {
        Self { captured_session, approvals, app_session_id, profile }
    }
}

impl AgentAdapter for AcpAdapter {
    fn run(
        &self,
        prompt: Prompt,
        cwd: PathBuf,
        session_id: String,
        resume: bool,
        sink: Box<dyn EventSink>,
    ) -> impl std::future::Future<Output = Result<(), SessionError>> + Send {
        spawn_and_drive(
            prompt,
            cwd,
            session_id,
            resume,
            sink,
            self.captured_session.clone(),
            self.approvals.clone(),
            self.app_session_id.clone(),
            self.profile,
        )
    }
}

/// Spawn the ACP agent subprocess and run the protocol loop over its stdio.
#[allow(clippy::too_many_arguments)]
async fn spawn_and_drive(
    prompt: Prompt,
    cwd: PathBuf,
    session_id: String,
    resume: bool,
    sink: Box<dyn EventSink>,
    captured_session: Arc<Mutex<Option<String>>>,
    approvals: crate::approval::ApprovalRegistry,
    app_session_id: String,
    profile: AcpProfile,
) -> Result<(), SessionError> {
    // resolve_program falls back to the bare name on lookup failure, which would
    // yield a generic "No such file" from spawn — check explicitly so the user
    // gets an actionable message instead.
    if which::which("npx").is_err() {
        return Err(SessionError::Spawn(
            "Node.js (npx) is required for the ACP engine — install Node or switch the session back to the default engine".into(),
        ));
    }
    let npx = crate::agent_paths::resolve_program("npx");
    let mut cmd = Command::new(&npx);
    cmd.arg("--yes")
        .arg(profile.package)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // The child must lead its own process group: npx's descendants (the node
    // shim and codex-acp's native binary) don't die with npx — SIGKILL doesn't
    // propagate — and codex-acp doesn't exit on stdin EOF either (observed
    // live: one orphaned node+binary pair leaked per turn). Group-kill below
    // is the only reliable teardown for the whole tree.
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd
        .spawn()
        .map_err(|e| SessionError::Spawn(format!("npx {}: {e}", profile.package)))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| SessionError::Spawn("no stdin".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| SessionError::Spawn("no stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| SessionError::Spawn("no stderr".into()))?;
    // Armed before the first await: from here on, dropping this future kills
    // the whole process group (see KillPgOnDrop).
    let _pg_guard = KillPgOnDrop::new(child.id());

    // Drain stderr concurrently so a full pipe buffer can't deadlock stdout —
    // same tail-keeping pattern as the codex adapter.
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut buf).await;
        let lines: Vec<&str> = buf.lines().collect();
        let start = lines.len().saturating_sub(20);
        lines[start..].join("\n")
    });

    // On resume, `session_id` is the previously captured ACP session id
    // (external_thread_id), threaded in by the (agent, engine) dispatch — the
    // mirror of `resume_target` for codex/antigravity.
    let resume_id = if resume { Some(session_id) } else { None };
    let result = drive_session(
        stdout,
        stdin,
        prompt,
        cwd.to_string_lossy().to_string(),
        resume_id,
        sink,
        captured_session,
        approvals,
        app_session_id,
        profile,
    )
    .await;

    // Kill BEFORE awaiting the stderr tail: an ACP agent is a persistent server,
    // and the tail task only resolves at stderr EOF (child exit). Awaiting first
    // would hang whenever the agent ignores stdin EOF after the turn completes.
    // The await stays bounded regardless: any process that escapes the kill
    // (non-unix, or a descendant that left the group) keeps the stderr pipe
    // open — its lifetime must never wedge the session.
    //
    // Kill the entire process group first (unix): the direct kill below only
    // reaches the npx wrapper. On non-unix this degrades to the direct kill.
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // process_group(0) above made the child's pgid == its pid.
        unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
    }
    let _ = child.kill().await;
    let stderr_tail =
        match tokio::time::timeout(std::time::Duration::from_secs(2), stderr_task).await {
            Ok(joined) => joined.unwrap_or_default(),
            Err(_) => {
                // A surviving descendant (e.g. an orphaned npx grandchild) still
                // holds the stderr pipe. Don't let its lifetime wedge the session.
                eprintln!("acp: stderr tail unavailable — a child process outlived the kill");
                String::new()
            }
        };
    if result.is_err() && !stderr_tail.trim().is_empty() {
        eprintln!("acp agent stderr tail: {}", stderr_tail.trim());
    }
    result
}

/// Protocol loop, separated from process spawning so fixture tests can drive it
/// over an in-memory duplex instead of a real child process.
#[allow(clippy::too_many_arguments)]
pub async fn drive_session(
    read: impl AsyncRead + Unpin + Send + 'static,
    write: impl AsyncWrite + Unpin + Send + 'static,
    prompt: Prompt,
    cwd: String,
    resume_session: Option<String>,
    sink: Box<dyn EventSink>,
    captured_session: Arc<Mutex<Option<String>>>,
    approvals: crate::approval::ApprovalRegistry,
    app_session_id: String,
    profile: AcpProfile,
) -> Result<(), SessionError> {
    let peer = RpcPeer::start(read, write);
    let mut inbound = peer.inbound();

    // Canonicalized once: every fs/* request is contained against this root.
    // Canonicalization also survives macOS /tmp symlinks and Windows \\?\ paths.
    // A canonicalize failure leaves `None` — every fs request is then rejected
    // with -32603, never served unguarded.
    let fs_root = std::fs::canonicalize(&cwd).ok();

    let can_load = client::initialize(&peer).await.map_err(|e| {
        SessionError::Protocol(format!(
            "ACP initialize failed: {}",
            describe_rpc_failure(&e, profile.login_hint)
        ))
    })?;

    // Resume when the agent supports it; a failed/unsupported load degrades to a
    // fresh session. fallback=true ⇒ this turn was supposed to resume but
    // couldn't natively: compose the transcript-replay prompt and surface a
    // Notice (M5's transcript-replay fallback, so conversation context isn't
    // silently lost).
    let (acp_session_id, modes, fallback) = match resume_session {
        Some(id) if can_load => {
            match load_discarding_replay(&peer, &mut inbound, &id, &cwd, fs_root.as_deref()).await
            {
                Ok((modes, replay_events)) => {
                    for event in replay_events {
                        sink.emit(event); // sync emit — the load await already resolved
                    }
                    (id, modes, false)
                }
                Err(e) => {
                    eprintln!("acp: session/load failed ({e}); falling back to a fresh session");
                    let (id, modes) = new_session(&peer, &cwd, profile.login_hint).await?;
                    (id, modes, true)
                }
            }
        }
        Some(_) => {
            // Resume requested but the agent can't load sessions at all.
            let (id, modes) = new_session(&peer, &cwd, profile.login_hint).await?;
            (id, modes, true)
        }
        None => {
            let (id, modes) = new_session(&peer, &cwd, profile.login_hint).await?;
            // resume_transcript is only populated for follow-up turns
            // (send_message on an ACP session). Carrying one into a fresh
            // session means the prior thread id was never captured — without
            // the fallback, that context would silently vanish.
            (id, modes, prompt.resume_transcript.is_some())
        }
    };
    if let Ok(mut guard) = captured_session.lock() {
        *guard = Some(acp_session_id.clone());
    }

    let prompt_text = if fallback {
        match prompt.resume_transcript.as_deref() {
            Some(transcript) => {
                sink.emit(AgentEvent::Notice {
                    message: RESUME_NOTICE_WITH_CONTEXT.to_string(),
                });
                compose_resume_fallback_prompt(transcript, &prompt.text)
            }
            None => {
                sink.emit(AgentEvent::Notice {
                    message: RESUME_NOTICE_NO_CONTEXT.to_string(),
                });
                prompt.text.clone()
            }
        }
    } else {
        prompt.text.clone()
    };

    let permission_mode = prompt.permission_mode.clone();

    // The agent inherits the user's own settings default (often permissive).
    // Force the session into the mode Kineloop's permission mode demands —
    // otherwise "Ask before edits" never generates a permission request at all.
    let target_mode = client::acp_mode_for(permission_mode.as_deref(), &modes.available);
    if modes.current.as_deref() != Some(target_mode.as_str()) {
        if let Err(e) = client::session_set_mode(&peer, &acp_session_id, &target_mode).await {
            eprintln!(
                "acp: session/set_mode {target_mode} failed: {e} — the agent may not honor this session's permission mode"
            );
        }
    }

    let mut final_text = String::new();
    let prompt_fut = client::session_prompt(&peer, &acp_session_id, &prompt_text);
    tokio::pin!(prompt_fut);

    loop {
        tokio::select! {
            // Deterministic priority: a completed turn beats a closing connection.
            // The agent may exit right after answering session/prompt; without
            // `biased`, the racing inbound-channel EOF could win the select and
            // turn a successful run into a spurious "connection closed" error.
            biased;
            stop = &mut prompt_fut => {
                // The reader enqueues lines in order, so any update the agent sent
                // BEFORE its session/prompt response is already in the channel —
                // flush it into the transcript before closing the turn, or the
                // final streamed chunk(s) would be silently dropped.
                while let Ok(msg) = inbound.try_recv() {
                    match msg {
                        Inbound::Notification { method, params } => {
                            handle_notification(&method, &params, sink.as_ref(), &mut final_text);
                        }
                        Inbound::Request { id, method, params } => {
                            let answer = prepare_answer(&method, &params, permission_mode.as_deref(), profile.interactive_escalations, fs_root.as_deref(), sink.as_ref(), &approvals, &app_session_id);
                            if let Some(event) = answer_request(&peer, id, &method, answer).await {
                                sink.emit(event); // FileWrite — sync emit after the await
                            }
                        }
                    }
                }
                match stop {
                    Ok(reason) if reason == "cancelled" => {
                        sink.emit(AgentEvent::Error { message: "turn cancelled by agent".into() });
                    }
                    Ok(_) => sink.emit(AgentEvent::Done { summary: final_text.clone() }),
                    Err(e) => sink.emit(AgentEvent::Error { message: format!("ACP turn failed: {e}") }),
                }
                return Ok(());
            }
            msg = inbound.recv() => {
                match msg {
                    None => {
                        sink.emit(AgentEvent::Error { message: "ACP agent closed the connection".into() });
                        return Ok(());
                    }
                    // Notifications only emit (synchronous); requests only talk to the
                    // peer. Keeping the two apart means the `&dyn EventSink` borrow never
                    // lives across an await, so this future stays `Send` without
                    // requiring `EventSink: Sync`.
                    Some(Inbound::Notification { method, params }) => {
                        handle_notification(&method, &params, sink.as_ref(), &mut final_text);
                    }
                    Some(Inbound::Request { id, method, params }) => {
                        let answer = prepare_answer(&method, &params, permission_mode.as_deref(), profile.interactive_escalations, fs_root.as_deref(), sink.as_ref(), &approvals, &app_session_id);
                        if let Some(event) = answer_request(&peer, id, &method, answer).await {
                            sink.emit(event); // FileWrite — sync emit after the await
                        }
                    }
                }
            }
        }
    }
}

async fn new_session(
    peer: &RpcPeer,
    cwd: &str,
    login_hint: &str,
) -> Result<(String, client::SessionModes), SessionError> {
    client::session_new(peer, cwd).await.map_err(|e| {
        SessionError::Protocol(format!(
            "session/new failed: {}",
            describe_rpc_failure(&e, login_hint)
        ))
    })
}

/// Human-facing description of an initialize/session-setup RPC failure. ACP
/// auth_required (-32000) answers get the per-agent login hint appended so the
/// user sees what to run, not a bare protocol error.
fn describe_rpc_failure(e: &crate::acp::jsonrpc::RpcError, login_hint: &str) -> String {
    match e {
        crate::acp::jsonrpc::RpcError::Remote { code: -32000, .. } => {
            format!("{e} — {login_hint}")
        }
        _ => e.to_string(),
    }
}

/// Await session/load while DISCARDING the replayed history. The ACP spec
/// requires the agent to replay the entire prior conversation as session/update
/// notifications before answering session/load; Kineloop already persists that
/// history itself, so re-emitting it would duplicate the transcript on every
/// resume (and grow the events table multiplicatively). Returns the mode state
/// the load response advertised, plus any FileWrite events from fs writes the
/// agent made mid-replay — the caller (`drive_session`) emits them synchronously
/// once this await resolves, since no `&dyn EventSink` may cross an await here.
async fn load_discarding_replay(
    peer: &RpcPeer,
    inbound: &mut tokio::sync::mpsc::UnboundedReceiver<Inbound>,
    session_id: &str,
    cwd: &str,
    fs_root: Option<&Path>,
) -> Result<(client::SessionModes, Vec<AgentEvent>), crate::acp::jsonrpc::RpcError> {
    // The unbounded channel simply buffers the replay while we await the
    // response — but inbound REQUESTS still need answers (an agent blocking on
    // one mid-replay could never send the load response).
    let mut file_writes = Vec::new();
    let load_fut = client::session_load(peer, session_id, cwd);
    tokio::pin!(load_fut);
    let result = loop {
        tokio::select! {
            biased;
            result = &mut load_fut => break result,
            msg = inbound.recv() => match msg {
                Some(Inbound::Notification { .. }) => {} // historical replay: drop
                Some(Inbound::Request { id, method, params }) => {
                    answer_replay_request(peer, id, &method, &params, fs_root, &mut file_writes).await;
                }
                None => break Err(crate::acp::jsonrpc::RpcError::Closed),
            },
        }
    };
    // The reader task processes lines sequentially, so by the time the load
    // response resolved, every replayed notification is already queued. Flush
    // whatever the select didn't get to, so none of it leaks into the live turn.
    while let Ok(msg) = inbound.try_recv() {
        if let Inbound::Request { id, method, params } = msg {
            answer_replay_request(peer, id, &method, &params, fs_root, &mut file_writes).await;
        }
    }
    result.map(|modes| (modes, file_writes))
}

/// Answer one agent-initiated request arriving mid-replay. fs requests are
/// served (the capability is advertised); permission requests are answered
/// `cancelled` (no user context exists during replay); anything else is
/// method-not-found. A successful write's FileWrite is pushed for the
/// caller (drive_session) to emit after the load resolves.
async fn answer_replay_request(
    peer: &RpcPeer,
    id: serde_json::Value,
    method: &str,
    params: &serde_json::Value,
    fs_root: Option<&Path>,
    file_writes: &mut Vec<AgentEvent>,
) {
    if let Some(answer) = prepare_fs_answer(method, params, fs_root) {
        if let Some(event) = answer_request(peer, id, method, answer).await {
            file_writes.push(event);
        }
        return;
    }
    if method == "session/request_permission" {
        eprintln!("acp: permission request mid-replay — answering cancelled");
        if let Err(e) = client::respond_permission(peer, id, None).await {
            eprintln!("acp: failed to answer {method}: {e}");
        }
        return;
    }
    if let Err(e) = peer
        .respond_error(id, -32601, &format!("{method} not supported"))
        .await
    {
        eprintln!("acp: failed to answer {method}: {e}");
    }
}

/// Map a session/update notification onto AgentEvents. Synchronous by design —
/// see the comment at the call site about `Send` and the sink borrow.
fn handle_notification(
    method: &str,
    params: &serde_json::Value,
    sink: &dyn EventSink,
    final_text: &mut String,
) {
    if method != "session/update" {
        return;
    }
    match client::parse_session_update(params) {
        Some(SessionUpdate::AgentMessageChunk { text }) => {
            final_text.push_str(&text);
            sink.emit(AgentEvent::Token { text });
        }
        Some(SessionUpdate::Thought { text }) => {
            sink.emit(AgentEvent::Thought { text });
        }
        Some(SessionUpdate::ToolCall { title, raw_input, tool_call_id }) => {
            sink.emit(AgentEvent::ToolCall {
                name: title,
                input: raw_input,
                tool_call_id,
            });
        }
        Some(SessionUpdate::ToolCallUpdate { tool_call_id, status, detail }) => {
            sink.emit(AgentEvent::ToolStatus { tool_call_id, status, detail });
        }
        Some(SessionUpdate::Plan { entries_json }) => {
            sink.emit(AgentEvent::Plan { entries_json });
        }
        Some(SessionUpdate::AvailableCommands { commands_json }) => {
            sink.emit(AgentEvent::Commands { commands_json });
        }
        None => {} // unknown/future update kinds — ignored by design
    }
}

/// What the drive loop must do with an agent-initiated request. Produced by
/// the synchronous `prepare_answer` (which owns all sink emission and registry
/// access); consumed by the async `answer_request` (IO + RPC only). Splitting
/// "decide" from "answer" keeps the `&dyn EventSink` borrow (Send-not-Sync)
/// entirely inside the synchronous `prepare_answer` — it never crosses an
/// `.await`, so `answer_request`'s future stays `Send` without requiring
/// `EventSink: Sync`. A returned FileWrite is emitted by the CALLER,
/// synchronously, after the await — the sink must never cross an await point.
enum InboundAnswer {
    /// Not a permission or fs request: terminal/*, anything else Kineloop
    /// doesn't implement.
    NotSupported,
    /// Autonomous mode, or the agent offered no options: answer right away.
    Immediate(Option<String>),
    /// Interactive: ApprovalNeeded was already emitted; awaiting the user's
    /// decision (or a closed channel — see [`ApprovalRegistry::cancel_session`]).
    ///
    /// [`ApprovalRegistry::cancel_session`]: crate::approval::ApprovalRegistry::cancel_session
    Deferred {
        rx: tokio::sync::oneshot::Receiver<crate::approval::ApprovalDecision>,
        /// The option ids the agent actually offered. A resolution carrying any
        /// other id (e.g. a non-ACP-aware registry caller) is clamped to
        /// cancelled rather than forwarded — the agent's behavior on an
        /// unoffered optionId is unspecified.
        offered: Vec<String>,
    },
    /// fs/read_text_file, validated + resolved inside the session worktree.
    FsRead { path: PathBuf, line: Option<u64>, limit: Option<u64> },
    /// fs/write_text_file, validated + resolved inside the session worktree.
    FsWrite { path: PathBuf, content: String },
    /// Malformed params, an unresolved worktree, or a fs_guard rejection —
    /// answered with `code` (-32602 for the agent's mistake, -32603 for ours),
    /// never touches disk.
    FsRejected { code: i64, message: String },
}

/// Decide how an inbound request should be answered. Synchronous by design —
/// see [`InboundAnswer`]. Interactive permission requests surface
/// `ApprovalNeeded` here, before any RPC round-trip. fs/* requests are
/// validated and worktree-resolved here too, but their IO happens later in
/// `answer_request`.
#[allow(clippy::too_many_arguments)]
fn prepare_answer(
    method: &str,
    params: &serde_json::Value,
    permission_mode: Option<&str>,
    interactive_escalations: bool,
    fs_root: Option<&Path>,
    sink: &dyn EventSink,
    approvals: &crate::approval::ApprovalRegistry,
    app_session_id: &str,
) -> InboundAnswer {
    if let Some(answer) = prepare_fs_answer(method, params, fs_root) {
        return answer;
    }
    match method {
        "session/request_permission" => {
            let options = client::parse_permission_options(params);
            // Autonomous modes answer without asking (same policy as M1); everything
            // else — and only when the agent offered real options — goes interactive.
            // Under acceptEdits, a profile with interactive_escalations set treats
            // any request that still arrives as an escalation beyond the mode's
            // grant and surfaces it instead (see AcpProfile::interactive_escalations).
            let autonomous = match permission_mode {
                Some("full") | Some("dontAsk") | Some("auto") => true,
                Some("acceptEdits") => !interactive_escalations,
                _ => false,
            };
            if autonomous || options.is_empty() {
                return InboundAnswer::Immediate(client::auto_select_option(&options, permission_mode));
            }
            // Interactive: surface ApprovalNeeded now; the RPC is answered later (from a
            // spawned task) so a deliberating user can't head-of-line-block
            // session/update streaming. Run end drops the registry entry → cancelled.
            let request_id = approvals.next_request_id();
            let rx = approvals.register(&request_id, app_session_id);
            let (tool, input, prompt) = client::parse_permission_request(params);
            let offered: Vec<String> = options.iter().map(|o| o.option_id.clone()).collect();
            sink.emit(AgentEvent::ApprovalNeeded {
                request_id,
                tool,
                input,
                prompt,
                options: options
                    .iter()
                    .map(|o| crate::events::ApprovalOption {
                        id: o.option_id.clone(),
                        label: o.name.clone(),
                        kind: o.kind.clone(),
                    })
                    .collect(),
            });
            InboundAnswer::Deferred { rx, offered }
        }
        _ => InboundAnswer::NotSupported,
    }
}

/// The fs/read_text_file + fs/write_text_file arms, shared by the live drive
/// loop and the session/load replay drain. `None` ⇒ `method` is not an fs
/// method. Pure validation/classification — IO happens in `answer_request`.
fn prepare_fs_answer(
    method: &str,
    params: &serde_json::Value,
    fs_root: Option<&Path>,
) -> Option<InboundAnswer> {
    if method != "fs/read_text_file" && method != "fs/write_text_file" {
        return None;
    }
    let Some(root) = fs_root else {
        return Some(InboundAnswer::FsRejected {
            code: -32603,
            message: "session worktree could not be resolved".to_string(),
        });
    };
    let answer = if method == "fs/read_text_file" {
        match client::parse_fs_read(params) {
            Some((path, line, limit)) => {
                match crate::acp::fs_guard::resolve_within_root(root, &path) {
                    Ok(resolved) => InboundAnswer::FsRead { path: resolved, line, limit },
                    Err(e) => InboundAnswer::FsRejected { code: -32602, message: e },
                }
            }
            None => InboundAnswer::FsRejected {
                code: -32602,
                message: "malformed fs/read_text_file params".to_string(),
            },
        }
    } else {
        match client::parse_fs_write(params) {
            Some((path, content)) => {
                match crate::acp::fs_guard::resolve_within_root(root, &path) {
                    Ok(resolved) => InboundAnswer::FsWrite { path: resolved, content },
                    Err(e) => InboundAnswer::FsRejected { code: -32602, message: e },
                }
            }
            None => InboundAnswer::FsRejected {
                code: -32602,
                message: "malformed fs/write_text_file params".to_string(),
            },
        }
    };
    Some(answer)
}

/// The prompt sent when native resume is unavailable: the persisted transcript
/// tail as explicit prior context, then the user's actual request. Only the
/// fallback path composes this — native session/load sends the raw text.
fn compose_resume_fallback_prompt(transcript: &str, user_prompt: &str) -> String {
    format!(
        "You are continuing a previous Kineloop session with this agent. \
         Native session resume is unavailable, so the transcript below restores your context. \
         Treat it as prior conversation. Do not assume any earlier process is still alive. \
         Continue from the user's new request using the current repository state.\n\n\
         --- Prior transcript ---\n\
         {transcript}\n\
         --- End prior transcript ---\n\n\
         New user request:\n\
         {user_prompt}"
    )
}

/// 1-based `line` + `limit` slicing for fs/read_text_file. 0 and 1 both mean
/// "from the start"; absent limit means "to the end".
fn slice_lines(content: &str, line: Option<u64>, limit: Option<u64>) -> String {
    if line.is_none() && limit.is_none() {
        return content.to_string();
    }
    let start = line.unwrap_or(1).max(1) as usize - 1;
    let iter = content.lines().skip(start);
    match limit {
        Some(n) => iter.take(n as usize).collect::<Vec<_>>().join("\n"),
        None => iter.collect::<Vec<_>>().join("\n"),
    }
}

/// Answer an agent-initiated request over the wire. Never leaves the request
/// dangling — an unanswered inbound RPC would hang the child. Takes no
/// `EventSink`: any event was already decided synchronously by `prepare_answer`;
/// a `FileWrite` to emit is returned to the caller instead, which emits it
/// synchronously after this call returns (see [`InboundAnswer`]).
async fn answer_request(
    peer: &RpcPeer,
    id: serde_json::Value,
    method: &str,
    answer: InboundAnswer,
) -> Option<AgentEvent> {
    match answer {
        InboundAnswer::NotSupported => {
            if let Err(e) = peer
                .respond_error(id, -32601, &format!("{method} not supported"))
                .await
            {
                eprintln!("acp: failed to answer {method}: {e}");
            }
            None
        }
        InboundAnswer::Immediate(selected) => {
            if let Err(e) = client::respond_permission(peer, id, selected.as_deref()).await {
                eprintln!("acp: failed to answer {method}: {e}");
            }
            None
        }
        InboundAnswer::Deferred { rx, offered } => {
            let peer = peer.clone();
            tokio::spawn(async move {
                let selected = match rx.await {
                    Ok(decision) => decision.selected_option_id.filter(|id| {
                        let ok = offered.iter().any(|o| o == id);
                        if !ok {
                            eprintln!(
                                "acp: ignoring un-offered approval option id {id:?} — answering cancelled"
                            );
                        }
                        ok
                    }),
                    Err(_) => None, // registry dropped the entry (run ended) → cancelled
                };
                if let Err(e) = client::respond_permission(&peer, id, selected.as_deref()).await {
                    eprintln!("acp: failed to answer session/request_permission: {e}");
                }
            });
            None
        }
        InboundAnswer::FsRead { path, line, limit } => {
            match tokio::fs::read_to_string(&path).await {
                Ok(content) => {
                    let sliced = slice_lines(&content, line, limit);
                    if let Err(e) = peer
                        .respond(id, serde_json::json!({"content": sliced}))
                        .await
                    {
                        eprintln!("acp: failed to answer {method}: {e}");
                    }
                }
                Err(e) => {
                    if let Err(e) = peer
                        .respond_error(id, -32603, &format!("read failed: {e}"))
                        .await
                    {
                        eprintln!("acp: failed to answer {method}: {e}");
                    }
                }
            }
            None
        }
        InboundAnswer::FsWrite { path, content } => {
            let write_result = async {
                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(&path, &content).await
            }
            .await;
            match write_result {
                Ok(()) => {
                    if let Err(e) = peer.respond(id, serde_json::json!({})).await {
                        eprintln!("acp: failed to answer {method}: {e}");
                    }
                    Some(AgentEvent::FileWrite {
                        path: path.to_string_lossy().to_string(),
                    })
                }
                Err(e) => {
                    if let Err(e) = peer
                        .respond_error(id, -32603, &format!("write failed: {e}"))
                        .await
                    {
                        eprintln!("acp: failed to answer {method}: {e}");
                    }
                    None
                }
            }
        }
        InboundAnswer::FsRejected { code, message } => {
            if let Err(e) = peer.respond_error(id, code, &message).await {
                eprintln!("acp: failed to answer {method}: {e}");
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::{EventSink, Prompt};
    use crate::events::AgentEvent;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    struct Collect(Arc<Mutex<Vec<AgentEvent>>>);
    impl EventSink for Collect {
        fn emit(&self, event: AgentEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    struct Harness {
        events: Arc<Mutex<Vec<AgentEvent>>>,
        captured: Arc<Mutex<Option<String>>>,
        /// Kept for tests that want to resolve/cancel pending approvals after
        /// `drive_session` returns (not needed by the resolver-based tests,
        /// which resolve concurrently via the `resolver` closure instead).
        #[allow(dead_code)]
        approvals: crate::approval::ApprovalRegistry,
        /// Canonicalized per-test tempdir used as the session cwd/worktree — fs
        /// fixtures create/inspect files here (real fs_guard containment needs a
        /// real, canonicalized root; a literal "/wt" can't be canonicalized).
        worktree: PathBuf,
    }

    type AgentReader =
        tokio::io::Lines<tokio::io::BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>;
    type AgentWriter = tokio::io::WriteHalf<tokio::io::DuplexStream>;

    /// A fresh, canonicalized tempdir per test — mirrors the hand-rolled
    /// `std::env::temp_dir()` pattern in `acp/fs_guard.rs`'s tests, tagged
    /// uniquely (pid + a per-process counter) so parallel `cargo test` runs
    /// never collide on the same directory.
    fn unique_worktree() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "kl-acp-fixture-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    /// Read the fake agent's next inbound line and assert its JSON-RPC method.
    async fn next_request(lines: &mut AgentReader, method: &str) -> serde_json::Value {
        let req: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(req["method"], method);
        req
    }

    /// Read the fake agent's next inbound line without asserting its method —
    /// for fixtures that need to branch on whether a session/set_mode request
    /// shows up before session/prompt.
    async fn next_line_value(lines: &mut AgentReader) -> serde_json::Value {
        serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap()
    }

    /// Write one ndjson line from the fake agent.
    async fn send_line(w: &mut AgentWriter, msg: serde_json::Value) {
        w.write_all(format!("{msg}\n").as_bytes()).await.unwrap();
    }

    /// Spawned concurrently with `drive_session` by fixtures that need to resolve
    /// (or cancel) a pending approval mid-run — e.g. `spawn_resolver` above.
    type Resolver = Box<
        dyn FnOnce(Arc<Mutex<Vec<AgentEvent>>>, crate::approval::ApprovalRegistry) -> tokio::task::JoinHandle<()>
            + Send,
    >;

    /// Run drive_session against a fully scripted fake agent: `agent` owns the
    /// whole wire conversation from the initialize request onward. `resolver`,
    /// when present, is spawned before `drive_session` is awaited and joined
    /// after, so interactive-approval tests can resolve a pending request while
    /// the protocol loop is still running (see `spawn_resolver`).
    async fn run_agent_fixture<F, Fut>(
        prompt: Prompt,
        resume_session: Option<String>,
        resolver: Option<Resolver>,
        agent: F,
    ) -> Harness
    where
        F: FnOnce(AgentReader, AgentWriter, PathBuf) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let worktree = unique_worktree();
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        let (read, write) = tokio::io::split(ours);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink: Box<dyn EventSink> = Box::new(Collect(Arc::clone(&events)));
        let captured = Arc::new(Mutex::new(None));
        let approvals = crate::approval::ApprovalRegistry::new();

        let agent_task = tokio::spawn({
            let worktree = worktree.clone();
            async move {
                let (r, w) = tokio::io::split(theirs);
                let lines = tokio::io::BufReader::new(r).lines();
                agent(lines, w, worktree).await;
            }
        });

        let resolver_task = resolver.map(|make| make(Arc::clone(&events), approvals.clone()));

        drive_session(
            read,
            write,
            prompt,
            worktree.to_string_lossy().to_string(),
            resume_session,
            sink,
            Arc::clone(&captured),
            approvals.clone(),
            "app-session".to_string(),
            CLAUDE_ACP,
        )
        .await
        .unwrap();
        if let Some(handle) = resolver_task {
            handle.await.unwrap();
        }
        agent_task.await.unwrap();
        Harness { events, captured, approvals, worktree }
    }

    /// Concurrently: wait until an ApprovalNeeded lands in `events` — and, when
    /// `wait_for_token` is set, until that Token text has streamed in too — then
    /// resolve the request on the registry with `option_id`. Requiring the token
    /// BEFORE resolving is the no-head-of-line-blocking proof: an implementation
    /// that awaited the decision inline in the drive loop could never process
    /// the token while blocked, so this resolver would spin forever (deadlock →
    /// test failure) instead of the regression silently passing.
    fn spawn_resolver(
        events: Arc<Mutex<Vec<AgentEvent>>>,
        approvals: crate::approval::ApprovalRegistry,
        option_id: &'static str,
        wait_for_token: Option<&'static str>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                let pending = {
                    let events = events.lock().unwrap();
                    let token_seen = wait_for_token.is_none_or(|wanted| {
                        events
                            .iter()
                            .any(|e| matches!(e, AgentEvent::Token { text } if text == wanted))
                    });
                    if token_seen {
                        events.iter().find_map(|e| match e {
                            AgentEvent::ApprovalNeeded { request_id, .. } => {
                                Some(request_id.clone())
                            }
                            _ => None,
                        })
                    } else {
                        None
                    }
                };
                if let Some(request_id) = pending {
                    let decision = crate::approval::ApprovalDecision {
                        allow: true,
                        selected_option_id: Some(option_id.to_string()),
                        message: None,
                    };
                    approvals.resolve("app-session", &request_id, decision);
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
    }

    /// Concurrently: wait until an ApprovalNeeded lands in `events`, then cancel
    /// the whole session's pending approvals — mirrors `run_persisting` dropping
    /// the registry entries when a run ends before the user answers.
    fn spawn_canceller(events: Arc<Mutex<Vec<AgentEvent>>>, approvals: crate::approval::ApprovalRegistry) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                let pending = events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e, AgentEvent::ApprovalNeeded { .. }));
                if pending {
                    approvals.cancel_session("app-session");
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
    }

    /// Fresh-session shorthand: answers initialize (loadSession:false) and
    /// session/new (sessionId "acp-abc", modes default+acceptEdits available);
    /// the `script` closure takes over once the session/prompt request has
    /// arrived (its id is passed along). A Prompt whose permission_mode maps to
    /// something other than "default" (e.g. "acceptEdits") makes drive_session
    /// issue a session/set_mode first — answered here transparently with `{}` so
    /// existing fixtures don't all need to know about mode syncing.
    async fn run_fixture<F, Fut>(prompt: Prompt, resolver: Option<Resolver>, script: F) -> Harness
    where
        F: FnOnce(AgentReader, AgentWriter, serde_json::Value, PathBuf) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        run_agent_fixture(prompt, None, resolver, |mut lines, mut w, worktree| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}}),
            )
            .await;
            let req = next_request(&mut lines, "session/new").await;
            assert_eq!(req["params"]["cwd"], worktree.to_string_lossy().as_ref());
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"sessionId":"acp-abc","modes":{"currentModeId":"default",
                        "availableModes":[{"id":"default"},{"id":"acceptEdits"}]}}}),
            )
            .await;
            let next = next_line_value(&mut lines).await;
            let req = if next["method"] == "session/set_mode" {
                send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":next["id"],"result":{}}))
                    .await;
                next_request(&mut lines, "session/prompt").await
            } else {
                assert_eq!(next["method"], "session/prompt");
                next
            };
            script(lines, w, req["id"].clone(), worktree).await;
        })
        .await
    }

    #[tokio::test]
    async fn drive_session_maps_updates_and_auto_answers_permission() {
        let prompt = Prompt {
            text: "hello".into(),
            permission_mode: Some("acceptEdits".into()),
            ..Default::default()
        };
        let h = run_fixture(prompt, None, |mut lines, mut w, prompt_id, _wt| async move {
            for msg in [
                serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"acp-abc","update":{"sessionUpdate":"agent_message_chunk",
                    "content":{"type":"text","text":"Hi "}}}}),
                serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"acp-abc","update":{"sessionUpdate":"tool_call",
                    "toolCallId":"t1","title":"Read main.rs","rawInput":{"path":"main.rs"}}}}),
                serde_json::json!({"jsonrpc":"2.0","id":99,"method":"session/request_permission","params":{
                    "sessionId":"acp-abc","toolCall":{"toolCallId":"t1"},
                    "options":[{"optionId":"ok","name":"Allow","kind":"allow_once"},
                               {"optionId":"no","name":"Reject","kind":"reject_once"}]}}),
            ] {
                w.write_all(format!("{msg}\n").as_bytes()).await.unwrap();
            }
            // Our side must answer the permission request (acceptEdits ⇒ "ok").
            let ans: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(ans["id"], 99);
            assert_eq!(ans["result"]["outcome"]["outcome"], "selected");
            assert_eq!(ans["result"]["outcome"]["optionId"], "ok");
            let resp = serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                "result":{"stopReason":"completed"}});
            w.write_all(format!("{resp}\n").as_bytes()).await.unwrap();
        })
        .await;

        let events = h.events.lock().unwrap();
        assert!(matches!(&events[0], AgentEvent::Token { text } if text == "Hi "));
        assert!(matches!(&events[1], AgentEvent::ToolCall { name, .. } if name == "Read main.rs"));
        assert!(matches!(events.last().unwrap(), AgentEvent::Done { summary } if summary == "Hi "));
        assert_eq!(h.captured.lock().unwrap().as_deref(), Some("acp-abc"));
        assert!(
            !events.iter().any(|e| matches!(e, AgentEvent::ApprovalNeeded { .. })),
            "autonomous modes answer without surfacing an approval card"
        );
    }

    /// The agent's session/new default differs from what Kineloop's permission
    /// mode demands ("default" here, since permission_mode is None/"Ask before
    /// edits") — drive_session must sync via session/set_mode before the first
    /// session/prompt, or the agent silently runs under its own inherited
    /// default (the actual bug this test guards against).
    #[tokio::test]
    async fn mode_synced_before_prompt_when_agent_default_differs() {
        let prompt = Prompt {
            text: "hello".into(),
            permission_mode: None,
            ..Default::default()
        };
        let h = run_agent_fixture(prompt, None, None, |mut lines, mut w, _wt| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}}),
            )
            .await;
            let req = next_request(&mut lines, "session/new").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"sessionId":"acp-abc","modes":{"currentModeId":"auto",
                        "availableModes":[{"id":"auto"},{"id":"default"},{"id":"acceptEdits"},{"id":"plan"}]}}}),
            )
            .await;
            let req = next_request(&mut lines, "session/set_mode").await;
            assert_eq!(req["params"]["sessionId"], "acp-abc");
            assert_eq!(req["params"]["modeId"], "default");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],"result":{}})).await;
            let req = next_request(&mut lines, "session/prompt").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"stopReason":"completed"}}),
            )
            .await;
        })
        .await;
        assert!(matches!(
            h.events.lock().unwrap().last().unwrap(),
            AgentEvent::Done { .. }
        ));
    }

    /// Already matching ⇒ no session/set_mode is sent at all: the fixture's
    /// `next_request(lines, "session/prompt")` assertion fails the test if one
    /// sneaks in between session/new and session/prompt.
    #[tokio::test]
    async fn mode_sync_skipped_when_already_matching() {
        let prompt = Prompt {
            text: "hello".into(),
            permission_mode: Some("acceptEdits".into()),
            ..Default::default()
        };
        let h = run_agent_fixture(prompt, None, None, |mut lines, mut w, _wt| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}}),
            )
            .await;
            let req = next_request(&mut lines, "session/new").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"sessionId":"acp-abc","modes":{"currentModeId":"acceptEdits",
                        "availableModes":[{"id":"default"},{"id":"acceptEdits"}]}}}),
            )
            .await;
            let req = next_request(&mut lines, "session/prompt").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"stopReason":"completed"}}),
            )
            .await;
        })
        .await;
        assert!(matches!(
            h.events.lock().unwrap().last().unwrap(),
            AgentEvent::Done { .. }
        ));
    }

    /// session/set_mode failing must not kill the run: log and continue to
    /// session/prompt as if the mode weren't synced (best-effort by design).
    #[tokio::test]
    async fn mode_sync_failure_does_not_kill_the_run() {
        let prompt = Prompt {
            text: "hello".into(),
            permission_mode: None,
            ..Default::default()
        };
        let h = run_agent_fixture(prompt, None, None, |mut lines, mut w, _wt| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}}),
            )
            .await;
            let req = next_request(&mut lines, "session/new").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"sessionId":"acp-abc","modes":{"currentModeId":"auto",
                        "availableModes":[{"id":"auto"},{"id":"default"}]}}}),
            )
            .await;
            let req = next_request(&mut lines, "session/set_mode").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "error":{"code":-32603,"message":"set_mode unsupported"}}),
            )
            .await;
            let req = next_request(&mut lines, "session/prompt").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"stopReason":"completed"}}),
            )
            .await;
        })
        .await;
        assert!(matches!(
            h.events.lock().unwrap().last().unwrap(),
            AgentEvent::Done { .. }
        ));
    }

    #[tokio::test]
    async fn tool_call_update_emits_tool_status_event() {
        let prompt = Prompt { text: "hello".into(), ..Default::default() };
        let h = run_fixture(prompt, None, |_lines, mut w, prompt_id, _wt| async move {
            for msg in [
                serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"acp-abc","update":{"sessionUpdate":"tool_call",
                    "toolCallId":"t1","title":"Read main.rs","rawInput":{"path":"main.rs"}}}}),
                serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"acp-abc","update":{"sessionUpdate":"tool_call_update",
                    "toolCallId":"t1","status":"completed"}}}),
            ] {
                send_line(&mut w, msg).await;
            }
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        let events = h.events.lock().unwrap();
        assert!(matches!(&events[0],
            AgentEvent::ToolCall { tool_call_id: Some(id), .. } if id == "t1"));
        assert!(matches!(&events[1],
            AgentEvent::ToolStatus { tool_call_id, status, .. }
                if tool_call_id == "t1" && status == "completed"));
    }

    #[tokio::test]
    async fn plan_updates_emit_plan_events() {
        let prompt = Prompt { text: "hello".into(), ..Default::default() };
        let h = run_fixture(prompt, None, |_lines, mut w, prompt_id, _wt| async move {
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                "sessionId":"acp-abc","update":{"sessionUpdate":"plan","entries":[
                    {"content":"Step A","status":"pending","priority":"medium"}]}}})).await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        let events = h.events.lock().unwrap();
        assert!(matches!(&events[0],
            AgentEvent::Plan { entries_json } if entries_json.contains("Step A")));
    }

    #[tokio::test]
    async fn available_commands_update_emits_commands_event() {
        let prompt = Prompt { text: "hello".into(), ..Default::default() };
        let h = run_fixture(prompt, None, |_lines, mut w, prompt_id, _wt| async move {
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                "sessionId":"acp-abc","update":{"sessionUpdate":"available_commands_update",
                "availableCommands":[{"name":"web","description":"Search the web"}]}}})).await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        let events = h.events.lock().unwrap();
        assert!(matches!(&events[0],
            AgentEvent::Commands { commands_json } if commands_json.contains("web")));
    }

    #[tokio::test]
    async fn thought_chunks_emit_thought_events_not_summary_text() {
        let prompt = Prompt { text: "hello".into(), ..Default::default() };
        let h = run_fixture(prompt, None, |_lines, mut w, prompt_id, _wt| async move {
            for msg in [
                serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"acp-abc","update":{"sessionUpdate":"agent_thought_chunk",
                    "content":{"type":"text","text":"SECRET THOUGHT"}}}}),
                serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"acp-abc","update":{"sessionUpdate":"agent_message_chunk",
                    "content":{"type":"text","text":"visible answer"}}}}),
            ] {
                send_line(&mut w, msg).await;
            }
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        let events = h.events.lock().unwrap();
        assert!(matches!(&events[0], AgentEvent::Thought { text } if text == "SECRET THOUGHT"));
        assert!(matches!(&events[1], AgentEvent::Token { text } if text == "visible answer"));
        // Thought text must NOT leak into the turn summary.
        assert!(matches!(events.last().unwrap(),
            AgentEvent::Done { summary } if summary == "visible answer"));
    }

    /// Default mode is now interactive: the request surfaces as ApprovalNeeded
    /// (with the agent's own options), streaming continues while it is pending,
    /// and the user's registry resolution answers the RPC with the chosen option.
    #[tokio::test]
    async fn default_mode_surfaces_interactive_approval_and_answers_selected_option() {
        let prompt = Prompt {
            text: "hello".into(),
            permission_mode: None,
            ..Default::default()
        };
        let h = run_fixture(
            prompt,
            // Resolve only after the "still streaming" token has ALSO been
            // processed — an inline-await regression deadlocks here instead of
            // passing (see spawn_resolver).
            Some(Box::new(|events, approvals| {
                spawn_resolver(events, approvals, "ok-once", Some("still streaming"))
            })),
            |mut lines, mut w, prompt_id, _wt| async move {
                // Permission request, then MORE streaming — proving no head-of-line block.
                for msg in [
                    serde_json::json!({"jsonrpc":"2.0","id":41,"method":"session/request_permission","params":{
                        "sessionId":"acp-abc","toolCall":{"toolCallId":"t1","title":"Edit main.rs","rawInput":{"path":"main.rs"}},
                        "options":[{"optionId":"ok-once","name":"Allow once","kind":"allow_once"},
                                   {"optionId":"no","name":"Reject","kind":"reject_once"}]}}),
                    serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                        "sessionId":"acp-abc","update":{"sessionUpdate":"agent_message_chunk",
                        "content":{"type":"text","text":"still streaming"}}}}),
                ] {
                    send_line(&mut w, msg).await;
                }
                // The answer to id 41 arrives only after the test resolves the registry.
                let ans: serde_json::Value =
                    serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
                assert_eq!(ans["id"], 41);
                assert_eq!(ans["result"]["outcome"]["outcome"], "selected");
                assert_eq!(ans["result"]["outcome"]["optionId"], "ok-once");
                send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                    "result":{"stopReason":"completed"}})).await;
            },
        )
        .await;
        let events = h.events.lock().unwrap();
        let approval = events.iter().find_map(|e| match e {
            AgentEvent::ApprovalNeeded { request_id, tool, options, .. } => {
                Some((request_id.clone(), tool.clone(), options.clone()))
            }
            _ => None,
        });
        let (_, tool, options) = approval.expect("ApprovalNeeded surfaced");
        assert_eq!(tool, "Edit main.rs");
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].id, "ok-once");
        assert_eq!(options[0].label, "Allow once");
        assert!(
            events.iter().any(|e| matches!(e, AgentEvent::Token { text } if text == "still streaming")),
            "streaming continued while the approval was pending"
        );
        assert!(matches!(events.last().unwrap(), AgentEvent::Done { .. }));
    }

    /// Codex under Auto-edit (acceptEdits → codex mode "auto"): a permission
    /// request that STILL arrives is by definition an escalation beyond the
    /// mode's grant (network / outside-workspace / sandbox-off) — it must
    /// surface interactively (ApprovalNeeded), never be auto-approved.
    /// CODEX_ACP.interactive_escalations pins this; claude keeps M1–M5
    /// auto-answer behavior (see drive_session_maps_updates_and_auto_answers_permission).
    #[tokio::test]
    async fn codex_accept_edits_surfaces_escalations_interactively() {
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        let (read, write) = tokio::io::split(ours);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink: Box<dyn EventSink> = Box::new(Collect(Arc::clone(&events)));
        let approvals = crate::approval::ApprovalRegistry::new();
        let agent = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(theirs);
            let mut lines = tokio::io::BufReader::new(r).lines();
            let req = next_request(&mut lines, "initialize").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}})).await;
            // Codex-shaped mode list; currentModeId already "auto" (what
            // acceptEdits maps to) so no session/set_mode fires.
            let req = next_request(&mut lines, "session/new").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"sessionId":"acp-abc","modes":{"currentModeId":"auto",
                    "availableModes":[{"id":"read-only"},{"id":"auto"},{"id":"full-access"}]}}})).await;
            let prompt_req = next_request(&mut lines, "session/prompt").await;
            // The escalation request, then MORE streaming — no head-of-line block.
            for msg in [
                serde_json::json!({"jsonrpc":"2.0","id":41,"method":"session/request_permission","params":{
                    "sessionId":"acp-abc","toolCall":{"toolCallId":"t1","title":"Run curl (requires network)","rawInput":{"cmd":"curl"}},
                    "options":[{"optionId":"ok-once","name":"Allow once","kind":"allow_once"},
                               {"optionId":"no","name":"Reject","kind":"reject_once"}]}}),
                serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"acp-abc","update":{"sessionUpdate":"agent_message_chunk",
                    "content":{"type":"text","text":"still streaming"}}}}),
            ] {
                send_line(&mut w, msg).await;
            }
            // The answer to id 41 arrives only after the user's registry resolve.
            let ans: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(ans["id"], 41);
            assert_eq!(ans["result"]["outcome"]["outcome"], "selected");
            assert_eq!(ans["result"]["outcome"]["optionId"], "ok-once");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":prompt_req["id"],
                "result":{"stopReason":"completed"}})).await;
        });
        let resolver = spawn_resolver(
            Arc::clone(&events),
            approvals.clone(),
            "ok-once",
            Some("still streaming"),
        );
        drive_session(
            read,
            write,
            Prompt {
                text: "hi".into(),
                permission_mode: Some("acceptEdits".into()),
                ..Default::default()
            },
            "/wt".into(),
            None,
            sink,
            Arc::new(Mutex::new(None)),
            approvals.clone(),
            "app-session".to_string(),
            CODEX_ACP,
        )
        .await
        .unwrap();
        resolver.await.unwrap();
        agent.await.unwrap();
        let events = events.lock().unwrap();
        assert!(
            events.iter().any(|e| matches!(e, AgentEvent::ApprovalNeeded { tool, .. }
                if tool == "Run curl (requires network)")),
            "escalation must surface an approval card under codex Auto-edit, got {events:?}"
        );
        assert!(
            events.iter().any(|e| matches!(e, AgentEvent::Token { text } if text == "still streaming")),
            "streaming continued while the escalation was pending"
        );
        assert!(matches!(events.last().unwrap(), AgentEvent::Done { .. }));
    }

    /// A resolve carrying an option id the agent never offered (possible via a
    /// non-ACP-aware caller of the registry) must NOT be forwarded — the agent's
    /// behavior on unknown optionIds is unspecified. It degrades to cancelled.
    #[tokio::test]
    async fn unoffered_option_id_degrades_to_cancelled() {
        let prompt = Prompt {
            text: "hello".into(),
            permission_mode: None,
            ..Default::default()
        };
        let h = run_fixture(
            prompt,
            // Resolve only after the "still streaming" token has ALSO been
            // processed — an inline-await regression deadlocks here instead of
            // passing (see spawn_resolver).
            Some(Box::new(|events, approvals| {
                spawn_resolver(events, approvals, "not-a-real-option", Some("still streaming"))
            })),
            |mut lines, mut w, prompt_id, _wt| async move {
                // Permission request, then MORE streaming — proving no head-of-line block.
                for msg in [
                    serde_json::json!({"jsonrpc":"2.0","id":41,"method":"session/request_permission","params":{
                        "sessionId":"acp-abc","toolCall":{"toolCallId":"t1","title":"Edit main.rs","rawInput":{"path":"main.rs"}},
                        "options":[{"optionId":"ok-once","name":"Allow once","kind":"allow_once"},
                                   {"optionId":"no","name":"Reject","kind":"reject_once"}]}}),
                    serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                        "sessionId":"acp-abc","update":{"sessionUpdate":"agent_message_chunk",
                        "content":{"type":"text","text":"still streaming"}}}}),
                ] {
                    send_line(&mut w, msg).await;
                }
                // The answer to id 41 arrives only after the test resolves the registry.
                let ans: serde_json::Value =
                    serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
                assert_eq!(ans["id"], 41);
                assert_eq!(ans["result"]["outcome"]["outcome"], "cancelled");
                send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                    "result":{"stopReason":"completed"}})).await;
            },
        )
        .await;
        let events = h.events.lock().unwrap();
        let approval = events.iter().find_map(|e| match e {
            AgentEvent::ApprovalNeeded { request_id, tool, options, .. } => {
                Some((request_id.clone(), tool.clone(), options.clone()))
            }
            _ => None,
        });
        let (_, tool, options) = approval.expect("ApprovalNeeded surfaced");
        assert_eq!(tool, "Edit main.rs");
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].id, "ok-once");
        assert_eq!(options[0].label, "Allow once");
        assert!(
            events.iter().any(|e| matches!(e, AgentEvent::Token { text } if text == "still streaming")),
            "streaming continued while the approval was pending"
        );
        assert!(matches!(events.last().unwrap(), AgentEvent::Done { .. }));
    }

    /// Run ending before the user answers ⇒ the RPC gets a cancelled outcome,
    /// never a dangling request (the child would hang forever).
    #[tokio::test]
    async fn pending_approval_resolves_cancelled_when_registry_drops_it() {
        let prompt = Prompt {
            text: "hello".into(),
            permission_mode: None,
            ..Default::default()
        };
        let h = run_fixture(
            prompt,
            Some(Box::new(spawn_canceller)),
            |mut lines, mut w, prompt_id, _wt| async move {
                let msg = serde_json::json!({"jsonrpc":"2.0","id":41,"method":"session/request_permission","params":{
                    "sessionId":"acp-abc","toolCall":{"toolCallId":"t1","title":"Edit main.rs","rawInput":{"path":"main.rs"}},
                    "options":[{"optionId":"ok-once","name":"Allow once","kind":"allow_once"},
                               {"optionId":"no","name":"Reject","kind":"reject_once"}]}});
                send_line(&mut w, msg).await;
                // The answer to id 41 arrives only after the run-end cancellation.
                let ans: serde_json::Value =
                    serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
                assert_eq!(ans["id"], 41);
                assert_eq!(ans["result"]["outcome"]["outcome"], "cancelled");
                send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                    "result":{"stopReason":"completed"}})).await;
            },
        )
        .await;
        assert!(matches!(
            h.events.lock().unwrap().last().unwrap(),
            AgentEvent::Done { .. }
        ));
    }

    #[tokio::test]
    async fn unknown_inbound_request_gets_method_not_found() {
        let prompt = Prompt {
            text: "hello".into(),
            ..Default::default()
        };
        let h = run_fixture(prompt, None, |mut lines, mut w, prompt_id, _wt| async move {
            // A real ACP method Kineloop doesn't implement (fs/* IS handled now
            // that M4 wires the proxy — see the fs_* fixtures below).
            let msg = serde_json::json!({"jsonrpc":"2.0","id":7,"method":"terminal/create",
                "params":{"sessionId":"acp-abc"}});
            w.write_all(format!("{msg}\n").as_bytes()).await.unwrap();
            let ans: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(ans["id"], 7);
            assert_eq!(ans["error"]["code"], -32601);
            let resp = serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                "result":{"stopReason":"completed"}});
            w.write_all(format!("{resp}\n").as_bytes()).await.unwrap();
        })
        .await;
        assert!(matches!(
            h.events.lock().unwrap().last().unwrap(),
            AgentEvent::Done { .. }
        ));
    }

    #[test]
    fn slice_lines_handles_one_based_start_and_limit() {
        let content = "l1\nl2\nl3\nl4\n";
        assert_eq!(slice_lines(content, Some(2), Some(2)), "l2\nl3");
        assert_eq!(slice_lines(content, None, None), content);
        // 0 and 1 both mean "from the start".
        assert_eq!(slice_lines(content, Some(0), None), "l1\nl2\nl3\nl4");
        assert_eq!(slice_lines(content, Some(1), None), "l1\nl2\nl3\nl4");
        // Out-of-range start line ⇒ nothing left to slice.
        assert_eq!(slice_lines(content, Some(99), None), "");
    }

    #[tokio::test]
    async fn fs_read_returns_file_content_with_line_slicing() {
        let prompt = Prompt { text: "hello".into(), ..Default::default() };
        let h = run_fixture(prompt, None, |mut lines, mut w, prompt_id, wt| async move {
            std::fs::write(wt.join("notes.txt"), "l1\nl2\nl3\nl4\n").unwrap();
            let msg = serde_json::json!({"jsonrpc":"2.0","id":7,"method":"fs/read_text_file",
                "params":{"sessionId":"acp-abc",
                    "path":wt.join("notes.txt").to_string_lossy().to_string(),
                    "line":2,"limit":2}});
            send_line(&mut w, msg).await;
            let ans: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(ans["id"], 7);
            assert_eq!(ans["result"]["content"], "l2\nl3");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                "result":{"stopReason":"completed"}}))
            .await;
        })
        .await;
        assert!(matches!(
            h.events.lock().unwrap().last().unwrap(),
            AgentEvent::Done { .. }
        ));
    }

    #[tokio::test]
    async fn fs_write_creates_file_emits_file_write_and_answers_empty_object() {
        let prompt = Prompt { text: "hello".into(), ..Default::default() };
        let h = run_fixture(prompt, None, |mut lines, mut w, prompt_id, wt| async move {
            // sub/ does not exist yet — parent dirs must be created by the write.
            let target = wt.join("sub").join("new.txt");
            let msg = serde_json::json!({"jsonrpc":"2.0","id":7,"method":"fs/write_text_file",
                "params":{"sessionId":"acp-abc",
                    "path":target.to_string_lossy().to_string(),"content":"hi"}});
            send_line(&mut w, msg).await;
            let ans: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(ans["id"], 7);
            assert_eq!(ans["result"], serde_json::json!({}));
            assert!(ans.get("error").is_none());
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                "result":{"stopReason":"completed"}}))
            .await;
        })
        .await;
        assert_eq!(
            std::fs::read_to_string(h.worktree.join("sub").join("new.txt")).unwrap(),
            "hi"
        );
        let events = h.events.lock().unwrap();
        assert!(
            events
                .iter()
                .any(|e| matches!(e, AgentEvent::FileWrite { path } if path.ends_with("sub/new.txt")
                    || path.ends_with("sub\\new.txt"))),
            "expected a FileWrite event for sub/new.txt, got {events:?}"
        );
        assert!(matches!(events.last().unwrap(), AgentEvent::Done { .. }));
    }

    #[tokio::test]
    async fn fs_escape_attempt_is_rejected_and_run_survives() {
        let prompt = Prompt { text: "hello".into(), ..Default::default() };
        let h = run_fixture(prompt, None, |mut lines, mut w, prompt_id, _wt| async move {
            let msg = serde_json::json!({"jsonrpc":"2.0","id":7,"method":"fs/write_text_file",
                "params":{"sessionId":"acp-abc","path":"../outside.txt","content":"x"}});
            send_line(&mut w, msg).await;
            let ans: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(ans["id"], 7);
            assert_eq!(ans["error"]["code"], -32602);
            // The escape rejection must not kill the run: streaming continues.
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                "sessionId":"acp-abc","update":{"sessionUpdate":"agent_message_chunk",
                "content":{"type":"text","text":"still ok"}}}}))
            .await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                "result":{"stopReason":"completed"}}))
            .await;
        })
        .await;
        let outside = h.worktree.parent().unwrap().join("outside.txt");
        assert!(!outside.exists(), "escape write must never land on disk");
        let events = h.events.lock().unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::Token { text } if text == "still ok")));
        assert!(matches!(events.last().unwrap(), AgentEvent::Done { .. }));
        assert!(
            !events.iter().any(|e| matches!(e, AgentEvent::FileWrite { .. })),
            "a rejected write must never emit FileWrite"
        );
    }

    #[tokio::test]
    async fn drive_session_resumes_via_session_load_when_supported() {
        let prompt = Prompt {
            text: "continue".into(),
            ..Default::default()
        };
        let h = run_agent_fixture(prompt, Some("acp-abc".into()), None, |mut lines, mut w, worktree| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}),
            )
            .await;
            // loadSession:true + a resume id ⇒ session/load, NOT session/new.
            let req = next_request(&mut lines, "session/load").await;
            assert_eq!(req["params"]["sessionId"], "acp-abc");
            assert_eq!(req["params"]["cwd"], worktree.to_string_lossy().as_ref());
            // The spec REQUIRES the agent to replay the entire prior conversation
            // as session/update notifications before answering session/load.
            // None of it may resurface as live events.
            for replay in [
                serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"acp-abc","update":{"sessionUpdate":"agent_message_chunk",
                    "content":{"type":"text","text":"OLD TURN TEXT"}}}}),
                serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"acp-abc","update":{"sessionUpdate":"tool_call",
                    "toolCallId":"old","title":"Old tool call","rawInput":{}}}}),
            ] {
                send_line(&mut w, replay).await;
            }
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"modes":{"currentModeId":"default","availableModes":[{"id":"default"}]}}}),
            )
            .await;
            // Prompt permission_mode is None ("default") and the load response's
            // currentModeId already matches — no session/set_mode should fire.
            let req = next_request(&mut lines, "session/prompt").await;
            assert_eq!(req["params"]["sessionId"], "acp-abc");
            // Live turn: one real chunk, then completion.
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"acp-abc","update":{"sessionUpdate":"agent_message_chunk",
                    "content":{"type":"text","text":"fresh reply"}}}}),
            )
            .await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"stopReason":"completed"}}),
            )
            .await;
        })
        .await;
        assert_eq!(h.captured.lock().unwrap().as_deref(), Some("acp-abc"));
        let events = h.events.lock().unwrap();
        // Replayed history must be discarded: no event mentions the old turn.
        assert!(
            !events.iter().any(|e| format!("{e:?}").contains("OLD TURN")
                || format!("{e:?}").contains("Old tool call")),
            "replayed history leaked into live events: {events:?}"
        );
        assert!(matches!(&events[0], AgentEvent::Token { text } if text == "fresh reply"));
        assert!(
            matches!(events.last().unwrap(), AgentEvent::Done { summary } if summary == "fresh reply")
        );
    }

    /// A load error must degrade to a fresh session instead of failing the run.
    /// With no `resume_transcript` on the prompt, the fallback also surfaces
    /// the no-context Notice (see `fallback_without_transcript_notices_no_context`
    /// for the transcript-present variant).
    #[tokio::test]
    async fn drive_session_falls_back_to_new_session_when_load_fails() {
        let prompt = Prompt {
            text: "continue".into(),
            ..Default::default()
        };
        let h = run_agent_fixture(prompt, Some("acp-gone".into()), None, |mut lines, mut w, _wt| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}),
            )
            .await;
            // The agent no longer knows the session — a load error must degrade
            // to a fresh session instead of failing the run.
            let req = next_request(&mut lines, "session/load").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "error":{"code":-32603,"message":"session not found"}}),
            )
            .await;
            let req = next_request(&mut lines, "session/new").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"sessionId":"acp-fresh","modes":{"currentModeId":"default",
                        "availableModes":[{"id":"default"}]}}}),
            )
            .await;
            // Prompt permission_mode is None ("default") and matches — no
            // session/set_mode should fire.
            let req = next_request(&mut lines, "session/prompt").await;
            assert_eq!(req["params"]["sessionId"], "acp-fresh");
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"stopReason":"completed"}}),
            )
            .await;
        })
        .await;
        assert_eq!(h.captured.lock().unwrap().as_deref(), Some("acp-fresh"));
        let events = h.events.lock().unwrap();
        assert!(
            events
                .iter()
                .any(|e| matches!(e, AgentEvent::Notice { message } if message == RESUME_NOTICE_NO_CONTEXT)),
            "no-transcript fallback still notices, got {events:?}"
        );
        assert!(matches!(events.last().unwrap(), AgentEvent::Done { .. }));
    }

    /// Agent lacks loadSession + resume requested ⇒ session/new, transcript
    /// replayed into the prompt, Notice emitted. THE M5 headline behavior.
    #[tokio::test]
    async fn resume_without_load_support_replays_transcript_and_notices() {
        let prompt = Prompt {
            text: "and now add tests".into(),
            resume_transcript: Some("User: add a helper\n\nAssistant: added helper()".into()),
            ..Default::default()
        };
        let h = run_agent_fixture(prompt, Some("acp-old".into()), None, |mut lines, mut w, _wt| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}})).await;
            // No session/load may be attempted — the next request is session/new.
            let req = next_request(&mut lines, "session/new").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"sessionId":"acp-fresh","modes":{"currentModeId":"default",
                    "availableModes":[{"id":"default"}]}}})).await;
            let req = next_request(&mut lines, "session/prompt").await;
            let text = req["params"]["prompt"][0]["text"].as_str().unwrap().to_string();
            assert!(text.contains("Assistant: added helper()"), "transcript replayed: {text}");
            assert!(text.contains("and now add tests"), "user request present: {text}");
            assert!(
                text.contains("Native session resume is unavailable"),
                "framing present: {text}"
            );
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        assert_eq!(h.captured.lock().unwrap().as_deref(), Some("acp-fresh"));
        let events = h.events.lock().unwrap();
        assert!(
            events.iter().any(|e| matches!(e, AgentEvent::Notice { message } if message == RESUME_NOTICE_WITH_CONTEXT)),
            "notice emitted, got {events:?}"
        );
    }

    /// session/load fails ⇒ same fallback: fresh session + replay + notice.
    #[tokio::test]
    async fn failed_load_replays_transcript_and_notices() {
        let prompt = Prompt {
            text: "continue".into(),
            resume_transcript: Some("User: earlier work".into()),
            ..Default::default()
        };
        let h = run_agent_fixture(prompt, Some("acp-gone".into()), None, |mut lines, mut w, _wt| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}})).await;
            let req = next_request(&mut lines, "session/load").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "error":{"code":-32603,"message":"session not found"}})).await;
            let req = next_request(&mut lines, "session/new").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"sessionId":"acp-fresh","modes":{"currentModeId":"default",
                    "availableModes":[{"id":"default"}]}}})).await;
            let req = next_request(&mut lines, "session/prompt").await;
            let text = req["params"]["prompt"][0]["text"].as_str().unwrap().to_string();
            assert!(text.contains("User: earlier work"), "transcript replayed: {text}");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        let events = h.events.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Notice { message } if message == RESUME_NOTICE_WITH_CONTEXT)));
        assert!(matches!(events.last().unwrap(), AgentEvent::Done { .. }));
    }

    /// Fallback without a transcript still surfaces the (no-context) notice.
    #[tokio::test]
    async fn fallback_without_transcript_notices_no_context() {
        let prompt = Prompt { text: "continue".into(), ..Default::default() };
        let h = run_agent_fixture(prompt, Some("acp-old".into()), None, |mut lines, mut w, _wt| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}})).await;
            let req = next_request(&mut lines, "session/new").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"sessionId":"acp-fresh","modes":{"currentModeId":"default",
                    "availableModes":[{"id":"default"}]}}})).await;
            let req = next_request(&mut lines, "session/prompt").await;
            assert_eq!(req["params"]["prompt"][0]["text"], "continue", "no replay block");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        let events = h.events.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Notice { message } if message == RESUME_NOTICE_NO_CONTEXT)));
    }

    /// Native load succeeding must NOT engage the fallback: prompt text stays
    /// verbatim, no Notice.
    #[tokio::test]
    async fn native_load_ignores_the_resume_transcript() {
        let prompt = Prompt {
            text: "continue".into(),
            resume_transcript: Some("User: earlier work".into()),
            ..Default::default()
        };
        let h = run_agent_fixture(prompt, Some("acp-abc".into()), None, |mut lines, mut w, _wt| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}})).await;
            let req = next_request(&mut lines, "session/load").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"modes":{"currentModeId":"default","availableModes":[{"id":"default"}]}}})).await;
            let req = next_request(&mut lines, "session/prompt").await;
            assert_eq!(req["params"]["prompt"][0]["text"], "continue", "verbatim prompt");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        let events = h.events.lock().unwrap();
        assert!(
            !events.iter().any(|e| matches!(e, AgentEvent::Notice { .. })),
            "native resume must be silent, got {events:?}"
        );
    }

    /// The thread id was never captured (e.g. the first ACP spawn died before
    /// session/new answered), so the command layer passes resume_session: None
    /// but a populated resume_transcript. The fallback must still engage:
    /// transcript replayed + Notice, regardless of loadSession support.
    #[tokio::test]
    async fn never_captured_thread_id_still_replays_transcript_and_notices() {
        let prompt = Prompt {
            text: "continue".into(),
            resume_transcript: Some("User: earlier work".into()),
            ..Default::default()
        };
        let h = run_agent_fixture(prompt, None, None, |mut lines, mut w, _wt| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}})).await;
            // No thread id ⇒ no session/load may be attempted — straight to session/new.
            let req = next_request(&mut lines, "session/new").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"sessionId":"acp-fresh","modes":{"currentModeId":"default",
                    "availableModes":[{"id":"default"}]}}})).await;
            let req = next_request(&mut lines, "session/prompt").await;
            let text = req["params"]["prompt"][0]["text"].as_str().unwrap().to_string();
            assert!(text.contains("User: earlier work"), "transcript replayed: {text}");
            assert!(
                text.contains("Native session resume is unavailable"),
                "framing present: {text}"
            );
            assert!(text.contains("continue"), "user request present: {text}");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        assert_eq!(h.captured.lock().unwrap().as_deref(), Some("acp-fresh"));
        let events = h.events.lock().unwrap();
        assert!(
            events.iter().any(|e| matches!(e, AgentEvent::Notice { message } if message == RESUME_NOTICE_WITH_CONTEXT)),
            "notice emitted, got {events:?}"
        );
    }

    /// A true first turn (no resume id, no transcript) must stay silent: prompt
    /// text verbatim, no Notice.
    #[tokio::test]
    async fn true_first_turn_stays_silent() {
        let prompt = Prompt { text: "hello".into(), ..Default::default() };
        let h = run_agent_fixture(prompt, None, None, |mut lines, mut w, _wt| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}})).await;
            let req = next_request(&mut lines, "session/new").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"sessionId":"acp-fresh","modes":{"currentModeId":"default",
                    "availableModes":[{"id":"default"}]}}})).await;
            let req = next_request(&mut lines, "session/prompt").await;
            assert_eq!(req["params"]["prompt"][0]["text"], "hello", "verbatim prompt");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        let events = h.events.lock().unwrap();
        assert!(
            !events.iter().any(|e| matches!(e, AgentEvent::Notice { .. })),
            "a genuine first turn must be silent, got {events:?}"
        );
    }

    #[tokio::test]
    async fn cancelled_stop_reason_emits_error_not_done() {
        let prompt = Prompt {
            text: "hello".into(),
            ..Default::default()
        };
        let h = run_fixture(prompt, None, |_lines, mut w, prompt_id, _wt| async move {
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":prompt_id,
                    "result":{"stopReason":"cancelled"}}),
            )
            .await;
        })
        .await;
        assert!(matches!(
            h.events.lock().unwrap().last().unwrap(),
            AgentEvent::Error { message } if message.contains("cancelled")
        ));
    }

    #[test]
    fn describe_rpc_failure_appends_login_hint_only_for_auth_errors() {
        let auth = crate::acp::jsonrpc::RpcError::Remote {
            code: -32000,
            message: "Authentication required".into(),
        };
        let described = describe_rpc_failure(&auth, "run `codex login` in a terminal");
        assert!(described.contains("run `codex login`"), "got: {described}");

        let other = crate::acp::jsonrpc::RpcError::Remote {
            code: -32603,
            message: "boom".into(),
        };
        let described = describe_rpc_failure(&other, "run `codex login` in a terminal");
        assert!(!described.contains("codex login"), "got: {described}");
        assert!(described.contains("boom"));
    }

    /// An unauthenticated agent answers session/new with auth_required (-32000).
    /// The run must fail with a Protocol error carrying the login hint — an
    /// actionable toast, not a bare "agent returned error -32000".
    #[tokio::test]
    async fn auth_required_on_session_new_surfaces_the_login_hint() {
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        let (read, write) = tokio::io::split(ours);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink: Box<dyn EventSink> = Box::new(Collect(Arc::clone(&events)));
        let agent = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(theirs);
            let mut lines = tokio::io::BufReader::new(r).lines();
            let req: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(req["method"], "initialize");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}})).await;
            let req: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(req["method"], "session/new");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "error":{"code":-32000,"message":"Authentication required"}})).await;
        });
        let err = drive_session(
            read,
            write,
            Prompt { text: "hi".into(), ..Default::default() },
            "/wt".into(),
            None,
            sink,
            Arc::new(Mutex::new(None)),
            crate::approval::ApprovalRegistry::new(),
            "app-session".to_string(),
            CODEX_ACP,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, crate::adapter::SessionError::Protocol(m) if m.contains("codex login")),
            "expected the login hint in the failure, got {err:?}"
        );
        agent.await.unwrap();
    }

    #[tokio::test]
    async fn initialize_error_maps_to_protocol_session_error() {
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        let (read, write) = tokio::io::split(ours);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink: Box<dyn EventSink> = Box::new(Collect(Arc::clone(&events)));
        let agent = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(theirs);
            let mut lines = tokio::io::BufReader::new(r).lines();
            let req: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(req["method"], "initialize");
            let resp = serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "error":{"code":-32600,"message":"unsupported protocol version"}});
            w.write_all(format!("{resp}\n").as_bytes()).await.unwrap();
        });
        let err = drive_session(
            read,
            write,
            Prompt { text: "hi".into(), ..Default::default() },
            "/wt".into(),
            None,
            sink,
            Arc::new(Mutex::new(None)),
            crate::approval::ApprovalRegistry::new(),
            "app-session".to_string(),
            CLAUDE_ACP,
        )
        .await
        .unwrap_err();
        // Handshake failures are Protocol, not Spawn: the process launched fine.
        assert!(
            matches!(&err, crate::adapter::SessionError::Protocol(m) if m.contains("initialize")),
            "expected SessionError::Protocol mentioning initialize, got {err:?}"
        );
        agent.await.unwrap();
    }

    /// fs requests arriving DURING session/load replay must be served — the fs
    /// capability is advertised at initialize, before any load. (M4 shipped them
    /// as -32601, which contradicts the advertisement.)
    #[tokio::test]
    async fn fs_read_is_served_during_load_replay() {
        let prompt = Prompt { text: "continue".into(), ..Default::default() };
        let h = run_agent_fixture(prompt, Some("acp-abc".into()), None, |mut lines, mut w, worktree| async move {
            std::fs::write(worktree.join("notes.txt"), "l1\nl2\n").unwrap();
            let req = next_request(&mut lines, "initialize").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}})).await;
            let req = next_request(&mut lines, "session/load").await;
            // Mid-replay: an fs read (agents rebuild context this way) …
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":77,"method":"fs/read_text_file",
                "params":{"sessionId":"acp-abc",
                    "path":worktree.join("notes.txt").to_string_lossy().to_string()}})).await;
            let ans: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(ans["id"], 77);
            assert_eq!(ans["result"]["content"], "l1\nl2\n");
            // … and a non-fs, non-permission request still gets -32601.
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":78,"method":"terminal/create",
                "params":{"sessionId":"acp-abc"}})).await;
            let ans: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(ans["id"], 78);
            assert_eq!(ans["error"]["code"], -32601);
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"modes":{"currentModeId":"default","availableModes":[{"id":"default"}]}}})).await;
            let req = next_request(&mut lines, "session/prompt").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        assert!(matches!(h.events.lock().unwrap().last().unwrap(), AgentEvent::Done { .. }));
    }

    /// A write mid-replay is a real write — it lands on disk and its FileWrite
    /// chip is emitted (after the load resolves, never across the await).
    #[tokio::test]
    async fn fs_write_during_load_replay_lands_and_emits_file_write() {
        let prompt = Prompt { text: "continue".into(), ..Default::default() };
        let h = run_agent_fixture(prompt, Some("acp-abc".into()), None, |mut lines, mut w, worktree| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}})).await;
            let req = next_request(&mut lines, "session/load").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":9,"method":"fs/write_text_file",
                "params":{"sessionId":"acp-abc",
                    "path":worktree.join("replayed.txt").to_string_lossy().to_string(),
                    "content":"mid-replay"}})).await;
            let ans: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(ans["id"], 9);
            assert_eq!(ans["result"], serde_json::json!({}));
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"modes":{"currentModeId":"default","availableModes":[{"id":"default"}]}}})).await;
            let req = next_request(&mut lines, "session/prompt").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        assert_eq!(
            std::fs::read_to_string(h.worktree.join("replayed.txt")).unwrap(),
            "mid-replay"
        );
        let events = h.events.lock().unwrap();
        assert!(
            events.iter().any(|e| matches!(e, AgentEvent::FileWrite { path } if path.ends_with("replayed.txt"))),
            "replay-time write must still surface a FileWrite chip, got {events:?}"
        );
    }

    /// Permission requests mid-replay are answered `cancelled` (we support the
    /// method — -32601 would be a lie — but there is no user context to ask in).
    #[tokio::test]
    async fn permission_request_during_load_replay_is_cancelled() {
        let prompt = Prompt { text: "continue".into(), ..Default::default() };
        let h = run_agent_fixture(prompt, Some("acp-abc".into()), None, |mut lines, mut w, _wt| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}})).await;
            let req = next_request(&mut lines, "session/load").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":13,"method":"session/request_permission",
                "params":{"sessionId":"acp-abc","toolCall":{"toolCallId":"t1"},
                    "options":[{"optionId":"ok","name":"Allow","kind":"allow_once"}]}})).await;
            let ans: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(ans["id"], 13);
            assert_eq!(ans["result"]["outcome"]["outcome"], "cancelled");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"modes":{"currentModeId":"default","availableModes":[{"id":"default"}]}}})).await;
            let req = next_request(&mut lines, "session/prompt").await;
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"stopReason":"completed"}})).await;
        })
        .await;
        let events = h.events.lock().unwrap();
        assert!(
            !events.iter().any(|e| matches!(e, AgentEvent::ApprovalNeeded { .. })),
            "no approval card may surface for a replay-time permission request"
        );
        assert!(matches!(events.last().unwrap(), AgentEvent::Done { .. }));
    }

    /// An unresolvable worktree root is OUR failure (-32603 internal), not the
    /// agent's params (-32602). Drives drive_session directly with a cwd that
    /// cannot canonicalize.
    #[tokio::test]
    async fn unresolvable_root_rejects_fs_with_internal_error_code() {
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        let (read, write) = tokio::io::split(ours);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink: Box<dyn EventSink> = Box::new(Collect(Arc::clone(&events)));
        let agent = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(theirs);
            let mut lines = tokio::io::BufReader::new(r).lines();
            let req: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(req["method"], "initialize");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}})).await;
            let req: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(req["method"], "session/new");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                "result":{"sessionId":"acp-abc","modes":{"currentModeId":"default",
                    "availableModes":[{"id":"default"}]}}})).await;
            let prompt_req: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(prompt_req["method"], "session/prompt");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":7,"method":"fs/read_text_file",
                "params":{"sessionId":"acp-abc","path":"x.txt"}})).await;
            let ans: serde_json::Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(ans["id"], 7);
            assert_eq!(ans["error"]["code"], -32603, "our failure, not the agent's params");
            send_line(&mut w, serde_json::json!({"jsonrpc":"2.0","id":prompt_req["id"],
                "result":{"stopReason":"completed"}})).await;
        });
        drive_session(
            read,
            write,
            Prompt { text: "hi".into(), ..Default::default() },
            "/kineloop-does-not-exist-m5".into(), // canonicalize fails ⇒ fs_root None
            None,
            sink,
            Arc::new(Mutex::new(None)),
            crate::approval::ApprovalRegistry::new(),
            "app-session".to_string(),
            CLAUDE_ACP,
        )
        .await
        .unwrap();
        agent.await.unwrap();
    }

    /// Pins the teardown mechanism spawn_and_drive relies on: SIGKILL to the
    /// process GROUP reaches descendants the direct kill can't. npx's node
    /// shim + codex-acp's native binary survive their parent's SIGKILL and
    /// ignore stdin EOF (observed live in the M6 smoke — one orphaned pair
    /// leaked per turn). A shell with a background `sleep` stands in for the
    /// npx tree; a real npx tree is out of scope for a unit test.
    #[cfg(unix)]
    #[tokio::test]
    async fn group_kill_reaches_grandchildren_the_direct_kill_cannot() {
        use tokio::io::AsyncReadExt;
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c")
            .arg("echo $$; sleep 30 & echo $!; wait")
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true);
        // Mirrors spawn_and_drive: the child leads its own process group, so
        // its pgid == its pid and killpg(pid) covers the whole tree.
        cmd.process_group(0);
        let mut child = cmd.spawn().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut out = String::new();
        let mut buf = [0u8; 256];
        while out.lines().count() < 2 {
            let n = stdout.read(&mut buf).await.unwrap();
            assert!(n > 0, "shell exited before printing both pids: {out:?}");
            out.push_str(std::str::from_utf8(&buf[..n]).unwrap());
        }
        let mut lines = out.lines();
        let shell_pid: i32 = lines.next().unwrap().trim().parse().unwrap();
        let sleep_pid: i32 = lines.next().unwrap().trim().parse().unwrap();
        // Sanity: the descendant is alive before the kill.
        assert_eq!(unsafe { libc::kill(sleep_pid, 0) }, 0);

        // The mechanism under test. A direct kill(shell_pid) here — what
        // child.kill() amounts to — leaves the sleep orphaned and alive
        // (verified: this test FAILS with kill in place of killpg).
        unsafe { libc::killpg(shell_pid, libc::SIGKILL) };
        let _ = child.wait().await; // reap the direct child

        // Bounded poll: SIGKILL delivery + init reaping the orphan aren't
        // instantaneous. ESRCH ⇒ the descendant is truly gone.
        let mut gone = false;
        for _ in 0..100 {
            let alive = unsafe { libc::kill(sleep_pid, 0) } == 0;
            if !alive
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                gone = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(gone, "grandchild (sleep) survived the group kill");
    }

    /// Dropping the guard must kill the whole process group — this is the only
    /// teardown that runs when run_persisting DROPS the run future (stop
    /// button, cancel-grace expiry): kill_on_drop reaches only the npx
    /// wrapper, and spawn_and_drive's inline killpg never executes on drop.
    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_the_pgid_guard_kills_the_grandchild() {
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c")
            .arg("echo $$; sleep 30 & echo $!; wait")
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true);
        cmd.process_group(0);
        let mut child = cmd.spawn().unwrap();
        let guard = KillPgOnDrop::new(child.id());
        let mut stdout = child.stdout.take().unwrap();
        let mut out = String::new();
        while out.lines().count() < 2 {
            let mut buf = [0u8; 256];
            let n = tokio::io::AsyncReadExt::read(&mut stdout, &mut buf).await.unwrap();
            assert!(n > 0, "sh exited before printing both pids");
            out.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        let mut lines = out.lines();
        let _shell_pid: i32 = lines.next().unwrap().trim().parse().unwrap();
        let sleep_pid: i32 = lines.next().unwrap().trim().parse().unwrap();
        assert_eq!(unsafe { libc::kill(sleep_pid, 0) }, 0, "grandchild must be alive pre-drop");

        drop(guard); // <- the mechanism under test

        let mut dead = false;
        for _ in 0..100 {
            if unsafe { libc::kill(sleep_pid, 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                dead = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(dead, "grandchild (sleep) survived the guard drop");
        let _ = child.kill().await;
    }
}

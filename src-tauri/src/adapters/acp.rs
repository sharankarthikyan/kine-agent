//! ACP engine adapter: drives an ACP agent subprocess (claude-agent-acp in M1)
//! over ndjson JSON-RPC stdio. See docs/superpowers/specs/2026-07-01-acp-adapter-design.md.
//!
//! M1 scope: text + tool-call streaming, permissions auto-answered from the
//! session's permission mode, no fs proxy (capability not advertised, so the
//! agent uses its own file access exactly like the pipe engine), no usage event
//! (ACP does not standardize usage), immediate-kill cancel via `kill_on_drop`.

use crate::acp::client::{self, SessionUpdate};
use crate::acp::jsonrpc::{Inbound, RpcPeer};
use crate::adapter::{AgentAdapter, EventSink, Prompt, SessionError};
use crate::events::AgentEvent;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, BufReader};
use tokio::process::Command;

/// Version-pinned launcher. Unpinned npx drifts to @latest; a silent protocol
/// bump must be a deliberate, tested upgrade — not a runtime surprise.
pub const CLAUDE_ACP_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp@0.54.1";

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
}

impl AcpAdapter {
    pub fn new(
        captured_session: Arc<Mutex<Option<String>>>,
        approvals: crate::approval::ApprovalRegistry,
        app_session_id: String,
    ) -> Self {
        Self { captured_session, approvals, app_session_id }
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
    let mut child = Command::new(&npx)
        .arg("--yes")
        .arg(CLAUDE_ACP_PACKAGE)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| SessionError::Spawn(format!("npx {CLAUDE_ACP_PACKAGE}: {e}")))?;
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
    )
    .await;

    // Kill BEFORE awaiting the stderr tail: an ACP agent is a persistent server,
    // and the tail task only resolves at stderr EOF (child exit). Awaiting first
    // would hang whenever the agent ignores stdin EOF after the turn completes.
    let _ = child.kill().await;
    let stderr_tail = stderr_task.await.unwrap_or_default();
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
) -> Result<(), SessionError> {
    let peer = RpcPeer::start(read, write);
    let mut inbound = peer.inbound();

    let can_load = client::initialize(&peer)
        .await
        .map_err(|e| SessionError::Protocol(format!("ACP initialize failed: {e}")))?;

    // Resume when the agent supports it; a failed/unsupported load degrades to a
    // fresh session (M5 adds the transcript-replay fallback so conversation
    // context isn't silently lost).
    let acp_session_id = match resume_session {
        Some(id) if can_load => match load_discarding_replay(&peer, &mut inbound, &id, &cwd).await
        {
            Ok(()) => id,
            Err(e) => {
                eprintln!("acp: session/load failed ({e}); starting a fresh session");
                new_session(&peer, &cwd).await?
            }
        },
        _ => new_session(&peer, &cwd).await?,
    };
    if let Ok(mut guard) = captured_session.lock() {
        *guard = Some(acp_session_id.clone());
    }

    let permission_mode = prompt.permission_mode.clone();
    let mut final_text = String::new();
    let prompt_fut = client::session_prompt(&peer, &acp_session_id, &prompt.text);
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
                            let answer = prepare_answer(&method, &params, permission_mode.as_deref(), sink.as_ref(), &approvals, &app_session_id);
                            answer_request(&peer, id, &method, answer).await;
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
                        let answer = prepare_answer(&method, &params, permission_mode.as_deref(), sink.as_ref(), &approvals, &app_session_id);
                        answer_request(&peer, id, &method, answer).await;
                    }
                }
            }
        }
    }
}

async fn new_session(peer: &RpcPeer, cwd: &str) -> Result<String, SessionError> {
    client::session_new(peer, cwd)
        .await
        .map_err(|e| SessionError::Protocol(format!("session/new failed: {e}")))
}

/// Await session/load while DISCARDING the replayed history. The ACP spec
/// requires the agent to replay the entire prior conversation as session/update
/// notifications before answering session/load; Kineloop already persists that
/// history itself, so re-emitting it would duplicate the transcript on every
/// resume (and grow the events table multiplicatively).
async fn load_discarding_replay(
    peer: &RpcPeer,
    inbound: &mut tokio::sync::mpsc::UnboundedReceiver<Inbound>,
    session_id: &str,
    cwd: &str,
) -> Result<(), crate::acp::jsonrpc::RpcError> {
    // The unbounded channel simply buffers the replay while we await the
    // response — but inbound REQUESTS still need answers (an agent blocking on
    // one mid-replay could never send the load response).
    let load_fut = client::session_load(peer, session_id, cwd);
    tokio::pin!(load_fut);
    let result = loop {
        tokio::select! {
            biased;
            result = &mut load_fut => break result,
            msg = inbound.recv() => match msg {
                Some(Inbound::Notification { .. }) => {} // historical replay: drop
                Some(Inbound::Request { id, method, .. }) => {
                    let _ = peer
                        .respond_error(id, -32601, &format!("{method} not supported"))
                        .await;
                }
                None => break Err(crate::acp::jsonrpc::RpcError::Closed),
            },
        }
    };
    // The reader task processes lines sequentially, so by the time the load
    // response resolved, every replayed notification is already queued. Flush
    // whatever the select didn't get to, so none of it leaks into the live turn.
    while let Ok(msg) = inbound.try_recv() {
        if let Inbound::Request { id, method, .. } = msg {
            let _ = peer
                .respond_error(id, -32601, &format!("{method} not supported"))
                .await;
        }
    }
    result
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

/// What `prepare_answer` decided to do about an inbound request. Splitting
/// "decide" from "answer" keeps the `&dyn EventSink` borrow (Send-not-Sync)
/// entirely inside the synchronous `prepare_answer` — it never crosses an
/// `.await`, so `answer_request`'s future stays `Send` without requiring
/// `EventSink: Sync`.
enum PermissionAnswer {
    /// Not a permission request at all: fs/*, terminal/*, anything else.
    NotSupported,
    /// Autonomous mode, or the agent offered no options: answer right away.
    Immediate(Option<String>),
    /// Interactive: ApprovalNeeded was already emitted; awaiting the user's
    /// decision (or a closed channel — see [`ApprovalRegistry::cancel_session`]).
    ///
    /// [`ApprovalRegistry::cancel_session`]: crate::approval::ApprovalRegistry::cancel_session
    Deferred(tokio::sync::oneshot::Receiver<crate::approval::ApprovalDecision>),
}

/// Decide how an inbound request should be answered. Synchronous by design —
/// see [`PermissionAnswer`]. Interactive permission requests surface
/// `ApprovalNeeded` here, before any RPC round-trip.
fn prepare_answer(
    method: &str,
    params: &serde_json::Value,
    permission_mode: Option<&str>,
    sink: &dyn EventSink,
    approvals: &crate::approval::ApprovalRegistry,
    app_session_id: &str,
) -> PermissionAnswer {
    if method != "session/request_permission" {
        return PermissionAnswer::NotSupported;
    }
    let options = client::parse_permission_options(params);
    // Autonomous modes answer without asking (same policy as M1); everything
    // else — and only when the agent offered real options — goes interactive.
    let autonomous = matches!(
        permission_mode,
        Some("acceptEdits") | Some("full") | Some("dontAsk") | Some("auto")
    );
    if autonomous || options.is_empty() {
        return PermissionAnswer::Immediate(client::auto_select_option(&options, permission_mode));
    }
    // Interactive: surface ApprovalNeeded now; the RPC is answered later (from a
    // spawned task) so a deliberating user can't head-of-line-block
    // session/update streaming. Run end drops the registry entry → cancelled.
    let request_id = approvals.next_request_id();
    let rx = approvals.register(&request_id, app_session_id);
    let (tool, input, prompt) = client::parse_permission_request(params);
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
    PermissionAnswer::Deferred(rx)
}

/// Answer an agent-initiated request over the wire. Never leaves the request
/// dangling — an unanswered inbound RPC would hang the child. Takes no
/// `EventSink`: any event was already emitted synchronously by `prepare_answer`.
async fn answer_request(peer: &RpcPeer, id: serde_json::Value, method: &str, answer: PermissionAnswer) {
    match answer {
        PermissionAnswer::NotSupported => {
            if let Err(e) = peer
                .respond_error(id, -32601, &format!("{method} not supported"))
                .await
            {
                eprintln!("acp: failed to answer {method}: {e}");
            }
        }
        PermissionAnswer::Immediate(selected) => {
            if let Err(e) = client::respond_permission(peer, id, selected.as_deref()).await {
                eprintln!("acp: failed to answer {method}: {e}");
            }
        }
        PermissionAnswer::Deferred(rx) => {
            let peer = peer.clone();
            tokio::spawn(async move {
                let selected = match rx.await {
                    Ok(decision) => decision.selected_option_id,
                    Err(_) => None, // registry dropped the entry (run ended) → cancelled
                };
                if let Err(e) = client::respond_permission(&peer, id, selected.as_deref()).await {
                    eprintln!("acp: failed to answer session/request_permission: {e}");
                }
            });
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
    }

    type AgentReader =
        tokio::io::Lines<tokio::io::BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>;
    type AgentWriter = tokio::io::WriteHalf<tokio::io::DuplexStream>;

    /// Read the fake agent's next inbound line and assert its JSON-RPC method.
    async fn next_request(lines: &mut AgentReader, method: &str) -> serde_json::Value {
        let req: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(req["method"], method);
        req
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
        F: FnOnce(AgentReader, AgentWriter) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        let (read, write) = tokio::io::split(ours);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink: Box<dyn EventSink> = Box::new(Collect(Arc::clone(&events)));
        let captured = Arc::new(Mutex::new(None));
        let approvals = crate::approval::ApprovalRegistry::new();

        let agent_task = tokio::spawn(async move {
            let (r, w) = tokio::io::split(theirs);
            let lines = tokio::io::BufReader::new(r).lines();
            agent(lines, w).await;
        });

        let resolver_task = resolver.map(|make| make(Arc::clone(&events), approvals.clone()));

        drive_session(
            read,
            write,
            prompt,
            "/wt".into(),
            resume_session,
            sink,
            Arc::clone(&captured),
            approvals.clone(),
            "app-session".to_string(),
        )
        .await
        .unwrap();
        if let Some(handle) = resolver_task {
            handle.await.unwrap();
        }
        agent_task.await.unwrap();
        Harness { events, captured, approvals }
    }

    /// Concurrently: wait until an ApprovalNeeded lands in `events`, then resolve
    /// it on the registry with `option_id`. Used by interactive-approval tests.
    fn spawn_resolver(
        events: Arc<Mutex<Vec<AgentEvent>>>,
        approvals: crate::approval::ApprovalRegistry,
        option_id: &'static str,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                let pending = events.lock().unwrap().iter().find_map(|e| match e {
                    AgentEvent::ApprovalNeeded { request_id, .. } => Some(request_id.clone()),
                    _ => None,
                });
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
    /// session/new (sessionId "acp-abc"); the `script` closure takes over once
    /// the session/prompt request has arrived (its id is passed along).
    async fn run_fixture<F, Fut>(prompt: Prompt, resolver: Option<Resolver>, script: F) -> Harness
    where
        F: FnOnce(AgentReader, AgentWriter, serde_json::Value) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        run_agent_fixture(prompt, None, resolver, |mut lines, mut w| async move {
            let req = next_request(&mut lines, "initialize").await;
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}}),
            )
            .await;
            let req = next_request(&mut lines, "session/new").await;
            assert_eq!(req["params"]["cwd"], "/wt");
            send_line(
                &mut w,
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],
                    "result":{"sessionId":"acp-abc"}}),
            )
            .await;
            let req = next_request(&mut lines, "session/prompt").await;
            script(lines, w, req["id"].clone()).await;
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
        let h = run_fixture(prompt, None, |mut lines, mut w, prompt_id| async move {
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

    #[tokio::test]
    async fn tool_call_update_emits_tool_status_event() {
        let prompt = Prompt { text: "hello".into(), ..Default::default() };
        let h = run_fixture(prompt, None, |_lines, mut w, prompt_id| async move {
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
        let h = run_fixture(prompt, None, |_lines, mut w, prompt_id| async move {
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
        let h = run_fixture(prompt, None, |_lines, mut w, prompt_id| async move {
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
        let h = run_fixture(prompt, None, |_lines, mut w, prompt_id| async move {
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
            Some(Box::new(|events, approvals| spawn_resolver(events, approvals, "ok-once"))),
            |mut lines, mut w, prompt_id| async move {
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
            |mut lines, mut w, prompt_id| async move {
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
        let h = run_fixture(prompt, None, |mut lines, mut w, prompt_id| async move {
            let msg = serde_json::json!({"jsonrpc":"2.0","id":7,"method":"fs/read_text_file",
                "params":{"sessionId":"acp-abc","path":"/etc/passwd"}});
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

    #[tokio::test]
    async fn drive_session_resumes_via_session_load_when_supported() {
        let prompt = Prompt {
            text: "continue".into(),
            ..Default::default()
        };
        let h = run_agent_fixture(prompt, Some("acp-abc".into()), None, |mut lines, mut w| async move {
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
            assert_eq!(req["params"]["cwd"], "/wt");
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
                serde_json::json!({"jsonrpc":"2.0","id":req["id"],"result":{}}),
            )
            .await;
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

    #[tokio::test]
    async fn drive_session_falls_back_to_new_session_when_load_fails() {
        let prompt = Prompt {
            text: "continue".into(),
            ..Default::default()
        };
        let h = run_agent_fixture(prompt, Some("acp-gone".into()), None, |mut lines, mut w| async move {
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
                    "result":{"sessionId":"acp-fresh"}}),
            )
            .await;
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
        assert!(matches!(
            h.events.lock().unwrap().last().unwrap(),
            AgentEvent::Done { .. }
        ));
    }

    #[tokio::test]
    async fn cancelled_stop_reason_emits_error_not_done() {
        let prompt = Prompt {
            text: "hello".into(),
            ..Default::default()
        };
        let h = run_fixture(prompt, None, |_lines, mut w, prompt_id| async move {
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
}

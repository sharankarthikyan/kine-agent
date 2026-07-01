//! Unified, agent-agnostic tool-approval core.
//!
//! When an agent wants to run a gated tool, the agent's approval bridge registers a
//! pending request here and awaits the decision. Kineloop emits an
//! `AgentEvent::ApprovalNeeded` so the UI shows Approve/Deny; the user's answer arrives via
//! the `respond_to_approval` IPC command, which resolves the pending request and unblocks
//! the awaiting bridge.
//!
//! This layer is deliberately agent-neutral: every agent reaches it the same way, so the
//! moment Codex or Antigravity expose an answerable gate they slot into the identical flow
//! with no UI or IPC changes. Only the "how the CLI asks" piece differs per agent. Today
//! only Claude can be wired (via the permission-prompt-tool MCP bridge in [`mcp`]); Codex
//! `exec` and Antigravity `--print` have no answerable approval channel, verified against
//! their CLIs, so their runs stay governed by the pre-decided permission mode.

pub mod mcp;
#[cfg(unix)]
pub mod socket;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use crate::events::AgentEvent;

/// What the Claude adapter adds to its launch when approvals are enabled for a run: the
/// `--permission-prompt-tool` name and the inline `--mcp-config` JSON that registers the
/// Kineloop permission MCP server. `None` on a `Prompt` leaves the launch unchanged (the
/// default), so this is inert unless a run explicitly turns approvals on.
#[derive(Debug, Clone)]
pub struct ApprovalLaunch {
    pub tool: String,
    pub mcp_config: String,
}

/// The user's answer to an approval request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalDecision {
    /// True to allow the tool call, false to deny it.
    pub allow: bool,
    /// Optional message surfaced to the agent (a deny reason, or a note on allow).
    pub message: Option<String>,
}

impl ApprovalDecision {
    pub fn allow() -> Self {
        Self {
            allow: true,
            message: None,
        }
    }

    pub fn deny(reason: impl Into<String>) -> Self {
        Self {
            allow: false,
            message: Some(reason.into()),
        }
    }
}

struct Pending {
    session_id: String,
    responder: oneshot::Sender<ApprovalDecision>,
}

/// In-flight approval requests, keyed by a unique request id. Managed as Tauri state so
/// the `respond_to_approval` IPC command can resolve a request an agent bridge is awaiting.
#[derive(Default)]
pub struct ApprovalRegistry {
    pending: Mutex<HashMap<String, Pending>>,
    counter: AtomicU64,
}

impl ApprovalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a process-unique request id. Cheap and dependency-free (an atomic counter),
    /// which is enough because the registry only needs uniqueness within one process.
    pub fn next_request_id(&self) -> String {
        format!("ar-{}", self.counter.fetch_add(1, Ordering::Relaxed))
    }

    /// Drop a pending request without resolving it (e.g. when its surfacing failed). The
    /// awaiter observes a closed channel, which the bridge treats as a deny.
    pub fn forget(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(request_id);
        }
    }

    /// Register a pending request and return the receiver to await the user's decision.
    /// The caller emits the `ApprovalNeeded` event separately, carrying this `request_id`.
    /// Awaiting the receiver yields the decision; a closed channel (see [`cancel_session`])
    /// means the run ended before the user answered and should be treated as a deny.
    ///
    /// [`cancel_session`]: ApprovalRegistry::cancel_session
    pub fn register(
        &self,
        request_id: &str,
        session_id: &str,
    ) -> oneshot::Receiver<ApprovalDecision> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(
                request_id.to_string(),
                Pending {
                    session_id: session_id.to_string(),
                    responder: tx,
                },
            );
        }
        rx
    }

    /// Resolve a pending request with the user's decision. Returns true only when a request
    /// with that id was waiting AND belongs to `session_id` (the session check hardens the
    /// untrusted IPC boundary: a stray/unknown/foreign id is ignored, not acted on).
    pub fn resolve(&self, session_id: &str, request_id: &str, decision: ApprovalDecision) -> bool {
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        match pending.get(request_id) {
            Some(p) if p.session_id == session_id => {
                let p = pending.remove(request_id).expect("checked present above");
                // A send error means the awaiter is already gone (run ended); harmless.
                p.responder.send(decision).is_ok()
            }
            _ => false,
        }
    }

    /// Drop every pending request for a session (called when its run ends or is cancelled).
    /// Dropping the responder makes the awaiting bridge observe a closed channel, which it
    /// treats as a deny, so a gated tool never hangs a finished run.
    pub fn cancel_session(&self, session_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|_, p| p.session_id != session_id);
        }
    }

    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.lock().map(|p| p.len()).unwrap_or(0)
    }
}

/// Surfaces one event into a running session's live stream + persisted history. `run_persisting`
/// registers one per active session so out-of-band code (the MCP approval bridge, running on a
/// socket task) can raise `ApprovalNeeded` for the right session.
pub type SessionEmit = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// The live event emitters for currently-running sessions, keyed by session id. Managed as
/// Tauri state; entries live only for the duration of a run.
#[derive(Default)]
pub struct SessionEmitters {
    map: Mutex<HashMap<String, SessionEmit>>,
}

impl SessionEmitters {
    pub fn new() -> Self {
        Self::default()
    }

    /// Attach a session's emitter for the lifetime of its run.
    pub fn register(&self, session_id: &str, emit: SessionEmit) {
        if let Ok(mut map) = self.map.lock() {
            map.insert(session_id.to_string(), emit);
        }
    }

    /// Detach a session's emitter when its run ends.
    pub fn deregister(&self, session_id: &str) {
        if let Ok(mut map) = self.map.lock() {
            map.remove(session_id);
        }
    }

    /// Emit into a session's stream. Returns false when no live emitter is registered (no UI
    /// attached), so the caller can fail closed rather than surface an unanswerable request.
    pub fn emit(&self, session_id: &str, event: AgentEvent) -> bool {
        let emit = self.map.lock().ok().and_then(|m| m.get(session_id).cloned());
        match emit {
            Some(emit) => {
                emit(event);
                true
            }
            None => false,
        }
    }
}

/// Register a gated tool call, surface it to the session's UI as `ApprovalNeeded`, and await
/// the user's decision. This is the agent-agnostic entry point the MCP approval bridge calls.
///
/// Fails closed (deny) when the session has no live emitter (no UI to answer) or the run ends
/// before the user responds, so a gated tool never hangs and never runs unapproved.
pub async fn request_approval(
    registry: &ApprovalRegistry,
    emitters: &SessionEmitters,
    session_id: &str,
    tool: &str,
    input: &serde_json::Value,
) -> ApprovalDecision {
    let request_id = registry.next_request_id();
    let event = AgentEvent::ApprovalNeeded {
        request_id: request_id.clone(),
        tool: tool.to_string(),
        input: input.to_string(),
        prompt: mcp::describe(tool, input),
    };
    let rx = registry.register(&request_id, session_id);
    if !emitters.emit(session_id, event) {
        registry.forget(&request_id);
        return ApprovalDecision::deny("no interactive approver attached");
    }
    match rx.await {
        Ok(decision) => decision,
        Err(_) => ApprovalDecision::deny("run ended before approval"),
    }
}

/// Entry point for the MCP approval-server subprocess (spawned by Claude via `--mcp-config`).
/// Speaks MCP over stdio (with Claude), forwarding each gated tool call to the running app
/// over the Unix socket at `socket_path` and returning the user's decision. Blocks until
/// Claude closes stdin. Unix only; the app enables it only when approvals are turned on.
#[cfg(unix)]
pub fn run_approval_server(
    session_id: String,
    socket_path: std::path::PathBuf,
) -> std::io::Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        mcp::transport::run_stdio_server(
            tokio::io::stdin(),
            tokio::io::stdout(),
            move |call| {
                let path = socket_path.clone();
                let sid = session_id.clone();
                async move { socket::request_decision(&path, &sid, &call).await }
            },
        )
        .await
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolve_delivers_the_decision_and_clears_the_request() {
        let reg = ApprovalRegistry::new();
        let rx = reg.register("req-1", "sess-1");
        assert_eq!(reg.pending_count(), 1);

        assert!(reg.resolve("sess-1", "req-1", ApprovalDecision::deny("nope")));
        let decision = rx.await.expect("awaiter receives the decision");
        assert!(!decision.allow);
        assert_eq!(decision.message.as_deref(), Some("nope"));
        assert_eq!(reg.pending_count(), 0, "resolved request is removed");
    }

    #[tokio::test]
    async fn resolve_allows_and_carries_no_message_by_default() {
        let reg = ApprovalRegistry::new();
        let rx = reg.register("req-1", "sess-1");
        assert!(reg.resolve("sess-1", "req-1", ApprovalDecision::allow()));
        let decision = rx.await.unwrap();
        assert!(decision.allow);
        assert!(decision.message.is_none());
    }

    #[test]
    fn resolve_rejects_unknown_id_and_session_mismatch() {
        let reg = ApprovalRegistry::new();
        let _rx = reg.register("req-1", "sess-1");
        // Unknown request id.
        assert!(!reg.resolve("sess-1", "does-not-exist", ApprovalDecision::allow()));
        // Right id, wrong session: rejected and left pending (IPC boundary hardening).
        assert!(!reg.resolve("other-session", "req-1", ApprovalDecision::allow()));
        assert_eq!(reg.pending_count(), 1, "a mismatched resolve doesn't consume it");
    }

    #[tokio::test]
    async fn cancel_session_closes_awaiters_so_a_gated_tool_never_hangs() {
        let reg = ApprovalRegistry::new();
        let rx_a = reg.register("req-a", "sess-1");
        let rx_b = reg.register("req-b", "sess-2");

        reg.cancel_session("sess-1");
        // sess-1's awaiter observes a closed channel (treated as deny by the bridge).
        assert!(rx_a.await.is_err());
        // sess-2 is untouched and still resolvable.
        assert_eq!(reg.pending_count(), 1);
        assert!(reg.resolve("sess-2", "req-b", ApprovalDecision::allow()));
        assert!(rx_b.await.is_ok());
    }

    #[test]
    fn next_request_id_is_process_unique() {
        let reg = ApprovalRegistry::new();
        assert_ne!(reg.next_request_id(), reg.next_request_id());
    }

    #[test]
    fn emitters_register_emit_and_deregister() {
        let emitters = SessionEmitters::new();
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c = count.clone();
        emitters.register(
            "s1",
            Arc::new(move |_ev| {
                c.fetch_add(1, Ordering::Relaxed);
            }),
        );
        assert!(emitters.emit("s1", AgentEvent::Done { summary: String::new() }));
        // Unknown session: no emitter, returns false so the caller can fail closed.
        assert!(!emitters.emit("unknown", AgentEvent::Done { summary: String::new() }));
        assert_eq!(count.load(Ordering::Relaxed), 1);

        emitters.deregister("s1");
        assert!(!emitters.emit("s1", AgentEvent::Done { summary: String::new() }));
    }

    #[tokio::test]
    async fn request_approval_surfaces_the_event_then_returns_the_decision() {
        let registry = Arc::new(ApprovalRegistry::new());
        let emitters = Arc::new(SessionEmitters::new());
        let captured: Arc<Mutex<Option<AgentEvent>>> = Arc::new(Mutex::new(None));
        let cap = captured.clone();
        emitters.register(
            "s1",
            Arc::new(move |ev| {
                *cap.lock().unwrap() = Some(ev);
            }),
        );

        let reg = registry.clone();
        let emit = emitters.clone();
        let handle = tokio::spawn(async move {
            request_approval(&reg, &emit, "s1", "Bash", &serde_json::json!({ "command": "ls" }))
                .await
        });

        // Wait for the request to be surfaced, then answer it by its minted request id.
        let request_id = loop {
            if let Some(AgentEvent::ApprovalNeeded {
                request_id, tool, ..
            }) = captured.lock().unwrap().clone()
            {
                assert_eq!(tool, "Bash");
                break request_id;
            }
            tokio::task::yield_now().await;
        };
        assert!(registry.resolve("s1", &request_id, ApprovalDecision::allow()));
        assert!(handle.await.unwrap().allow);
    }

    #[tokio::test]
    async fn request_approval_denies_and_forgets_when_no_emitter_is_attached() {
        let registry = ApprovalRegistry::new();
        let emitters = SessionEmitters::new();
        let decision =
            request_approval(&registry, &emitters, "s1", "Bash", &serde_json::json!({})).await;
        assert!(!decision.allow, "fails closed with no UI to answer");
        assert_eq!(registry.pending_count(), 0, "the unanswerable request is forgotten");
    }
}

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

use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;

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
}

impl ApprovalRegistry {
    pub fn new() -> Self {
        Self::default()
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
}

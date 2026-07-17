use std::path::PathBuf;

/// What the user asks an agent to do.
///
/// `model` is forwarded verbatim to `--model` on the CLI (short alias: `opus`, `sonnet`,
/// `haiku`, `fable`; or a full model id like `claude-opus-4-5`). `None` leaves the flag
/// absent, deferring to the CLI's own default — today's behaviour is preserved.
///
/// `permission_mode` carries the unified permission mode id after command-layer
/// validation — one of `"default"`, `"acceptEdits"`, `"plan"`, `"full"`, `"dontAsk"`,
/// or `"auto"` (see [`crate::permission::PermissionMode`]). Each adapter maps it onto
/// that CLI's real flags; `None` leaves the CLI's own default in place.
///
/// `sandbox_terminal` is an Antigravity-only orthogonal control: when true it passes
/// `agy --sandbox` to restrict terminal commands' network/disk access. Other adapters
/// ignore it. Defaults to false.
///
/// `approval` (Claude-only) attaches the `--permission-prompt-tool` MCP bridge for
/// interactive tool approval. `None` (the default) leaves the launch unchanged; other
/// adapters ignore it.
#[derive(Debug, Clone, Default)]
pub struct Prompt {
    pub text: String,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub sandbox_terminal: bool,
    pub approval: Option<crate::approval::ApprovalLaunch>,
    /// Budgeted tail of the session's own persisted transcript (pre-rendered
    /// text block, not a full prompt). ACP-only: consumed when the adapter
    /// cannot natively resume (`session/load` unsupported/failed) so a fresh
    /// agent session still starts with conversation context. Other adapters
    /// ignore it. `None` for new sessions and pipe engines.
    pub resume_transcript: Option<String>,
    /// Resolved API-key-vs-subscription auth to apply to the spawned child (see
    /// [`crate::auth`]). The command layer fills this from the agent's persisted
    /// choice; each adapter applies it to its command right after construction.
    /// `Default` is a no-op that inherits the parent env unchanged — the pre-BYOK
    /// behavior — so tests building `Prompt::default()` are unaffected.
    pub auth: crate::auth::AgentAuth,
}

/// Fatal session-level failure (the agent never ran or died). In-band errors the
/// agent itself reports are delivered as `AgentEvent::Error` via the sink instead.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("failed to spawn agent: {0}")]
    Spawn(String),
    /// The agent process launched but its handshake/protocol failed (e.g. an ACP
    /// initialize or session/new error) — distinct from `Spawn` so the UI can one
    /// day say "install Node" vs "the agent misbehaved".
    #[error("agent protocol error: {0}")]
    Protocol(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// One sink for normalized events. The IPC command supplies a real impl;
/// tests supply a collecting impl.
///
/// NOTE: the trait is `Send` but NOT `Sync`. Adapters whose `run` future must be
/// `Send` therefore may not hold a `&dyn EventSink` across an `.await` — emit
/// synchronously, then await (see `adapters::acp::handle_notification`). If an
/// adapter ever genuinely needs to emit-await-emit while borrowing the sink
/// (e.g. M3's interactive ACP approvals), add `Sync` here instead of fighting
/// the borrow — both current impls are already `Sync` in practice.
pub trait EventSink: Send {
    fn emit(&self, event: crate::events::AgentEvent);
}

/// Every agent integration implements this. MVP: Claude only.
///
/// NOTE: the RPITIT `run` return makes this trait non-dyn-compatible (no
/// `Box<dyn AgentAdapter>`). Fine while there is a single adapter. When runtime
/// selection across Codex/Gemini is added, switch to enum dispatch or
/// `async-trait`/`Pin<Box<dyn Future>>`.
pub trait AgentAdapter {
    /// Run the agent in `cwd` for session `session_id`. `resume=false` starts a new
    /// session pinned to that id; `resume=true` continues it. Streams events to `sink`.
    fn run(
        &self,
        prompt: Prompt,
        cwd: PathBuf,
        session_id: String,
        resume: bool,
        sink: Box<dyn EventSink>,
    ) -> impl std::future::Future<Output = Result<(), SessionError>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_holds_text() {
        let p = Prompt {
            text: "do it".into(),
            ..Default::default()
        };
        assert_eq!(p.text, "do it");
        assert!(p.model.is_none());
        assert!(!p.sandbox_terminal);
    }

    #[test]
    fn prompt_holds_model() {
        let p = Prompt {
            text: "do it".into(),
            model: Some("opus".into()),
            ..Default::default()
        };
        assert_eq!(p.model.as_deref(), Some("opus"));
    }
}

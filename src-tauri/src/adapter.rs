use std::path::PathBuf;

/// What the user asks an agent to do.
#[derive(Debug, Clone)]
pub struct Prompt {
    pub text: String,
}

/// Fatal session-level failure (the agent never ran or died). In-band errors the
/// agent itself reports are delivered as `AgentEvent::Error` via the sink instead.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("failed to spawn agent: {0}")]
    Spawn(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// One sink for normalized events. The IPC command supplies a real impl;
/// tests supply a collecting impl.
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
        let p = Prompt { text: "do it".into() };
        assert_eq!(p.text, "do it");
    }
}

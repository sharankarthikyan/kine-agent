use std::path::PathBuf;

/// What the user asks an agent to do.
#[derive(Debug, Clone)]
pub struct Prompt {
    pub text: String,
}

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
pub trait AgentAdapter {
    /// Spawn the agent in `cwd`, stream normalized events into `sink`, return when done.
    fn run(
        &self,
        prompt: Prompt,
        cwd: PathBuf,
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

use serde::Serialize;

/// Normalized agent event — every adapter maps its CLI output to this.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "data")]
pub enum AgentEvent {
    Token { text: String },
    ToolCall { name: String, input: String },
    FileWrite { path: String },
    ApprovalNeeded { prompt: String },
    Done { summary: String },
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_token_as_tagged_camelcase() {
        let ev = AgentEvent::Token { text: "hi".into() };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(json, r#"{"kind":"token","data":{"text":"hi"}}"#);
    }

    #[test]
    fn serializes_done_with_summary() {
        let ev = AgentEvent::Done { summary: "ok".into() };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(json, r#"{"kind":"done","data":{"summary":"ok"}}"#);
    }
}

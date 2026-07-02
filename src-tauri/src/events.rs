use serde::Serialize;

/// Normalized agent event — every adapter maps its CLI output to this.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "data")]
pub enum AgentEvent {
    Token {
        text: String,
    },
    /// The agent's internal reasoning stream (ACP `agent_thought_chunk`). Rendered
    /// collapsed; never part of the Done summary.
    Thought {
        text: String,
    },
    ToolCall {
        name: String,
        input: String,
    },
    FileWrite {
        path: String,
    },
    /// A gated tool call awaiting the user's decision. `request_id` correlates the UI's
    /// answer (via `respond_to_approval`) back to the agent bridge that is blocking on it;
    /// `tool` + `input` describe the action, and `prompt` is a human-readable summary.
    #[serde(rename_all = "camelCase")]
    ApprovalNeeded {
        request_id: String,
        tool: String,
        input: String,
        prompt: String,
    },
    Done {
        summary: String,
    },
    Error {
        message: String,
    },
    /// Token usage + cost for a completed run (normalized across agents).
    #[serde(rename_all = "camelCase")]
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_creation_tokens: u64,
        cost_usd: Option<f64>,
        model: Option<String>,
    },
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
    fn serializes_thought_as_tagged_camelcase() {
        let ev = AgentEvent::Thought { text: "hmm".into() };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(json, r#"{"kind":"thought","data":{"text":"hmm"}}"#);
    }

    #[test]
    fn serializes_done_with_summary() {
        let ev = AgentEvent::Done {
            summary: "ok".into(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(json, r#"{"kind":"done","data":{"summary":"ok"}}"#);
    }

    #[test]
    fn serializes_tool_call_with_camelcase_tag_and_multiple_fields() {
        let ev = AgentEvent::ToolCall {
            name: "Write".into(),
            input: "{}".into(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"toolCall","data":{"name":"Write","input":"{}"}}"#
        );
    }

    #[test]
    fn serializes_usage_with_camelcase_fields() {
        let ev = AgentEvent::Usage {
            input_tokens: 100,
            output_tokens: 200,
            cache_read_tokens: 50,
            cache_creation_tokens: 25,
            cost_usd: Some(0.003),
            model: Some("claude-opus-4-5".into()),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"usage","data":{"inputTokens":100,"outputTokens":200,"cacheReadTokens":50,"cacheCreationTokens":25,"costUsd":0.003,"model":"claude-opus-4-5"}}"#
        );
    }

    #[test]
    fn serializes_usage_with_null_optional_fields() {
        let ev = AgentEvent::Usage {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost_usd: None,
            model: None,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"usage","data":{"inputTokens":10,"outputTokens":20,"cacheReadTokens":0,"cacheCreationTokens":0,"costUsd":null,"model":null}}"#
        );
    }
}

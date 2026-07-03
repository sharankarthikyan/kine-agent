use serde::Serialize;

/// One selectable answer to an approval request. The pipe path emits a fixed
/// allow/deny pair; ACP forwards the agent-supplied options verbatim.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ApprovalOption {
    pub id: String,
    pub label: String,
    pub kind: String,
}

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
    /// `tool_call_id` is set by adapters whose protocol assigns stable ids (ACP),
    /// so later `ToolStatus` events can upgrade the matching chip. Pipe adapters
    /// leave it `None` and the serialized shape is unchanged.
    #[serde(rename_all = "camelCase")]
    ToolCall {
        name: String,
        input: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
    },
    /// Status transition for an earlier ToolCall (ACP `tool_call_update`):
    /// pending | in_progress | completed | failed. `detail` is the update's
    /// human-readable title ("" when the update carried none).
    #[serde(rename_all = "camelCase")]
    ToolStatus {
        tool_call_id: String,
        status: String,
        detail: String,
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
        #[serde(skip_serializing_if = "Vec::is_empty")]
        options: Vec<ApprovalOption>,
    },
    /// The user's answer to an earlier ApprovalNeeded (same request_id). Lets the
    /// transcript render the card as answered — including across reloads.
    #[serde(rename_all = "camelCase")]
    ApprovalResolved {
        request_id: String,
        selected_option_id: String,
    },
    Done {
        summary: String,
    },
    Error {
        message: String,
    },
    /// The selected local CLI is installed but not authenticated. This is a
    /// first-class event instead of a generic stderr blob so the UI can show a
    /// calm, actionable sign-in state and keep the failed prompt in the transcript.
    #[serde(rename_all = "camelCase")]
    AuthRequired {
        agent: String,
        command: String,
        message: String,
    },
    /// A user-facing, non-error notice from an adapter (e.g. "native resume
    /// unsupported — transcript context replayed"). Rendered as a muted
    /// transcript row and toasted once per session; never flips run status.
    Notice {
        message: String,
    },
    /// The agent's live task plan (ACP `plan`). `entries_json` is the raw JSON
    /// array of `{content, status, priority}` entries; agents resend the full
    /// list on every change, so the UI renders only the latest event.
    #[serde(rename_all = "camelCase")]
    Plan {
        entries_json: String,
    },
    /// Slash commands the agent currently accepts (ACP `available_commands_update`).
    /// `commands_json` is a JSON array of `{name, description}`; feeds the composer's
    /// `/` autocomplete. Hidden in the transcript.
    #[serde(rename_all = "camelCase")]
    Commands {
        commands_json: String,
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
            tool_call_id: None,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"toolCall","data":{"name":"Write","input":"{}"}}"#
        );
    }

    #[test]
    fn tool_call_without_id_serializes_exactly_as_before() {
        // Pipe adapters set no id — the wire/persisted shape must stay byte-identical.
        let ev = AgentEvent::ToolCall {
            name: "Write".into(),
            input: "{}".into(),
            tool_call_id: None,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"toolCall","data":{"name":"Write","input":"{}"}}"#
        );
    }

    #[test]
    fn serializes_tool_call_with_id_and_tool_status() {
        let ev = AgentEvent::ToolCall {
            name: "Read".into(),
            input: "{}".into(),
            tool_call_id: Some("t1".into()),
        };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"kind":"toolCall","data":{"name":"Read","input":"{}","toolCallId":"t1"}}"#
        );
        let ev = AgentEvent::ToolStatus {
            tool_call_id: "t1".into(),
            status: "completed".into(),
            detail: "Read main.rs".into(),
        };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"kind":"toolStatus","data":{"toolCallId":"t1","status":"completed","detail":"Read main.rs"}}"#
        );
    }

    #[test]
    fn serializes_plan_with_entries_json() {
        let ev = AgentEvent::Plan {
            entries_json: "[]".into(),
        };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"kind":"plan","data":{"entriesJson":"[]"}}"#
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
    fn serializes_commands_with_commands_json() {
        let ev = AgentEvent::Commands {
            commands_json: "[]".into(),
        };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"kind":"commands","data":{"commandsJson":"[]"}}"#
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

    #[test]
    fn approval_needed_without_options_serializes_as_before() {
        // Legacy shape must stay byte-identical (old persisted rows re-serialize
        // through split_event; pipe pre-M3 events had no options key).
        let ev = AgentEvent::ApprovalNeeded {
            request_id: "ar-1".into(),
            tool: "Bash".into(),
            input: "{}".into(),
            prompt: "Run ls?".into(),
            options: vec![],
        };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"kind":"approvalNeeded","data":{"requestId":"ar-1","tool":"Bash","input":"{}","prompt":"Run ls?"}}"#
        );
    }

    #[test]
    fn serializes_approval_resolved_as_tagged_camelcase() {
        let ev = AgentEvent::ApprovalResolved {
            request_id: "ar-1".into(),
            selected_option_id: "allow".into(),
        };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"kind":"approvalResolved","data":{"requestId":"ar-1","selectedOptionId":"allow"}}"#
        );
    }

    #[test]
    fn serializes_notice_as_tagged_camelcase() {
        let ev = AgentEvent::Notice {
            message: "heads up".into(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(json, r#"{"kind":"notice","data":{"message":"heads up"}}"#);
    }

    #[test]
    fn serializes_auth_required_as_tagged_camelcase() {
        let ev = AgentEvent::AuthRequired {
            agent: "codex".into(),
            command: "codex login".into(),
            message: "Sign in to Codex CLI.".into(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"authRequired","data":{"agent":"codex","command":"codex login","message":"Sign in to Codex CLI."}}"#
        );
    }

    #[test]
    fn approval_needed_serializes_options_array() {
        let ev = AgentEvent::ApprovalNeeded {
            request_id: "ar-1".into(),
            tool: "Edit".into(),
            input: "{}".into(),
            prompt: "Edit main.rs?".into(),
            options: vec![ApprovalOption {
                id: "ok".into(),
                label: "Allow".into(),
                kind: "allow_once".into(),
            }],
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""options":[{"id":"ok","label":"Allow","kind":"allow_once"}]"#));
    }
}

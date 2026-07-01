//! Typed ACP layer over the ndjson JSON-RPC peer — only the M1 subset.
//! Unknown fields/update kinds are ignored, never fatal (agents evolve).

use super::jsonrpc::{RpcError, RpcPeer};
use serde_json::Value;

pub const PROTOCOL_VERSION: u64 = 1;

/// The session/update variants M1 consumes. Thought/plan/commands arrive on the
/// wire but map to `None` until M2/M5.
#[derive(Debug, PartialEq)]
pub enum SessionUpdate {
    AgentMessageChunk { text: String },
    ToolCall { title: String, raw_input: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

/// initialize → does the agent support session/load?
pub async fn initialize(peer: &RpcPeer) -> Result<bool, RpcError> {
    let result = peer
        .request(
            "initialize",
            serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                // M1: no fs capability — the agent uses its own file access,
                // exactly like the pipe engine. M4 flips these and adds the proxy.
                "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}},
                "clientInfo": {"name": "kineloop", "version": env!("CARGO_PKG_VERSION")}
            }),
        )
        .await?;
    Ok(result
        .pointer("/agentCapabilities/loadSession")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

/// session/new → the agent-minted session id (persisted as external_thread_id).
pub async fn session_new(peer: &RpcPeer, cwd: &str) -> Result<String, RpcError> {
    let result = peer
        .request("session/new", serde_json::json!({"cwd": cwd, "mcpServers": []}))
        .await?;
    Ok(result
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

/// session/load for resume. Errors surface to the caller (falls back to session/new).
pub async fn session_load(peer: &RpcPeer, session_id: &str, cwd: &str) -> Result<(), RpcError> {
    peer.request(
        "session/load",
        serde_json::json!({"sessionId": session_id, "cwd": cwd, "mcpServers": []}),
    )
    .await?;
    Ok(())
}

/// session/prompt → stopReason ("completed" | "cancelled" | "resource_not_found").
pub async fn session_prompt(
    peer: &RpcPeer,
    session_id: &str,
    text: &str,
) -> Result<String, RpcError> {
    let result = peer
        .request(
            "session/prompt",
            serde_json::json!({
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": text}]
            }),
        )
        .await?;
    Ok(result
        .get("stopReason")
        .and_then(Value::as_str)
        .unwrap_or("completed")
        .to_string())
}

/// Parse a session/update notification's params into the M1 subset.
pub fn parse_session_update(params: &Value) -> Option<SessionUpdate> {
    let update = params.get("update")?;
    match update.get("sessionUpdate").and_then(Value::as_str)? {
        "agent_message_chunk" => {
            let text = update
                .pointer("/content/text")
                .and_then(Value::as_str)?
                .to_string();
            Some(SessionUpdate::AgentMessageChunk { text })
        }
        "tool_call" => Some(SessionUpdate::ToolCall {
            title: update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string(),
            raw_input: update
                .get("rawInput")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string()),
        }),
        // thought/plan/tool_call_update/available_commands_update: M2+/M5.
        _ => None,
    }
}

/// Parse the options array of a session/request_permission request.
pub fn parse_permission_options(params: &Value) -> Vec<PermissionOption> {
    params
        .get("options")
        .and_then(Value::as_array)
        .map(|opts| {
            opts.iter()
                .filter_map(|o| {
                    Some(PermissionOption {
                        option_id: o.get("optionId").and_then(Value::as_str)?.to_string(),
                        name: o
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        kind: o
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// M1 auto-answer: autonomous permission modes allow, everything else rejects.
/// Prefers `*_once` over `*_always` so an M1 auto-answer never persists a policy.
/// Returns the optionId to select, or None when no matching option exists.
pub fn auto_select_option(options: &[PermissionOption], mode: Option<&str>) -> Option<String> {
    let allow = matches!(
        mode,
        Some("acceptEdits") | Some("full") | Some("dontAsk") | Some("auto")
    );
    let want = if allow { "allow" } else { "reject" };
    let once = format!("{want}_once");
    options
        .iter()
        .find(|o| o.kind == once)
        .or_else(|| options.iter().find(|o| o.kind.starts_with(want)))
        .map(|o| o.option_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_message_chunk_update() {
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "hello"}
            }
        });
        assert_eq!(
            parse_session_update(&params),
            Some(SessionUpdate::AgentMessageChunk {
                text: "hello".into()
            })
        );
    }

    #[test]
    fn parses_tool_call_update() {
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "t1",
                "title": "Read file",
                "rawInput": {"path": "/x"}
            }
        });
        match parse_session_update(&params) {
            Some(SessionUpdate::ToolCall { title, raw_input }) => {
                assert_eq!(title, "Read file");
                assert!(raw_input.contains("/x"));
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }
    }

    #[test]
    fn unknown_update_kind_is_none_not_panic() {
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "plan", "entries": []}
        });
        // M1 ignores plan/thought/commands updates.
        assert_eq!(parse_session_update(&params), None);
    }

    #[test]
    fn permission_options_pick_allow_when_mode_is_autonomous() {
        let options = vec![
            PermissionOption {
                option_id: "a".into(),
                name: "Allow".into(),
                kind: "allow_once".into(),
            },
            PermissionOption {
                option_id: "r".into(),
                name: "Reject".into(),
                kind: "reject_once".into(),
            },
        ];
        assert_eq!(
            auto_select_option(&options, Some("acceptEdits")),
            Some("a".to_string())
        );
        assert_eq!(
            auto_select_option(&options, Some("full")),
            Some("a".to_string())
        );
        assert_eq!(
            auto_select_option(&options, Some("default")),
            Some("r".to_string())
        );
        assert_eq!(auto_select_option(&options, None), Some("r".to_string()));
        assert_eq!(auto_select_option(&[], Some("full")), None);
    }

    #[test]
    fn auto_select_prefers_once_over_always() {
        let options = vec![
            PermissionOption {
                option_id: "aa".into(),
                name: "Always".into(),
                kind: "allow_always".into(),
            },
            PermissionOption {
                option_id: "ao".into(),
                name: "Once".into(),
                kind: "allow_once".into(),
            },
        ];
        // An M1 auto-answer must never persist a policy on the agent side.
        assert_eq!(
            auto_select_option(&options, Some("full")),
            Some("ao".to_string())
        );
    }

    #[test]
    fn parses_permission_options_ignoring_malformed_entries() {
        let params = serde_json::json!({
            "options": [
                {"optionId": "y", "name": "Yes", "kind": "allow_once"},
                {"name": "missing id"},
                {"optionId": "n", "name": "No", "kind": "reject_once"}
            ]
        });
        let opts = parse_permission_options(&params);
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0].option_id, "y");
        assert_eq!(opts[1].option_id, "n");
    }
}

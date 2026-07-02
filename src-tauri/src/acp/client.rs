//! Typed ACP layer over the ndjson JSON-RPC peer — the M1/M2 subset.
//! Unknown fields/update kinds are ignored, never fatal (agents evolve).

use super::jsonrpc::{RpcError, RpcPeer};
use serde_json::Value;

pub const PROTOCOL_VERSION: u64 = 1;

/// The session/update variants M1/M2 consume. `available_commands_update`
/// arrives on the wire but maps to `None` until a later milestone.
#[derive(Debug, PartialEq)]
pub enum SessionUpdate {
    AgentMessageChunk { text: String },
    Thought { text: String },
    ToolCall { title: String, raw_input: String, tool_call_id: Option<String> },
    ToolCallUpdate { tool_call_id: String, status: String, detail: String },
    Plan { entries_json: String },
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
        .unwrap_or_else(|| {
            eprintln!("acp: initialize response lacks agentCapabilities.loadSession — assuming false");
            false
        }))
}

/// session/new → the agent-minted session id (persisted as external_thread_id).
/// A response without a sessionId is a hard error: an empty id would poison
/// every later session/prompt and resume.
pub async fn session_new(peer: &RpcPeer, cwd: &str) -> Result<String, RpcError> {
    let result = peer
        .request("session/new", serde_json::json!({"cwd": cwd, "mcpServers": []}))
        .await?;
    result
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| RpcError::Protocol("session/new: missing sessionId".into()))
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
        .unwrap_or_else(|| {
            eprintln!("acp: session/prompt response lacks stopReason — assuming completed");
            "completed"
        })
        .to_string())
}

/// Answer a session/request_permission request: `Some(option_id)` selects that
/// option, `None` reports the turn as cancelled. Keeps raw ACP JSON out of the
/// adapter.
pub async fn respond_permission(
    peer: &RpcPeer,
    id: Value,
    option_id: Option<&str>,
) -> Result<(), RpcError> {
    let outcome = match option_id {
        Some(option_id) => {
            serde_json::json!({"outcome": {"outcome": "selected", "optionId": option_id}})
        }
        None => serde_json::json!({"outcome": {"outcome": "cancelled"}}),
    };
    peer.respond(id, outcome).await
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
        "agent_thought_chunk" => {
            let text = update
                .pointer("/content/text")
                .and_then(Value::as_str)?
                .to_string();
            Some(SessionUpdate::Thought { text })
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
            tool_call_id: update
                .get("toolCallId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        }),
        "tool_call_update" => {
            let tool_call_id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())?
                .to_string();
            // Updates may carry only content/locations; without a status
            // transition there is nothing to surface.
            let status = update.get("status").and_then(Value::as_str)?.to_string();
            let detail = update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Some(SessionUpdate::ToolCallUpdate { tool_call_id, status, detail })
        }
        "plan" => {
            let entries = update.get("entries")?;
            if !entries.is_array() {
                return None;
            }
            Some(SessionUpdate::Plan { entries_json: entries.to_string() })
        }
        // available_commands_update: a later milestone.
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
    // "auto" is unreachable today (validate_permission_mode rejects it at the IPC
    // boundary) — kept for wire-compat if the unified mode set ever grows.
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
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader};

    /// Split a duplex: `peer` talks over one end; the test scripts the "agent"
    /// end. An agent task answers the next request with `result` (echoing the id).
    fn harness_answering(result: Value) -> (RpcPeer, tokio::task::JoinHandle<()>) {
        let (ours, theirs) = duplex(64 * 1024);
        let (read_half, write_half) = tokio::io::split(ours);
        let peer = RpcPeer::start(read_half, write_half);
        let (agent_read, mut agent_write) = tokio::io::split(theirs);
        let agent_task = tokio::spawn(async move {
            let mut lines = BufReader::new(agent_read).lines();
            let line = lines.next_line().await.unwrap().unwrap();
            let req: Value = serde_json::from_str(&line).unwrap();
            let resp = serde_json::json!({"jsonrpc": "2.0", "id": req["id"], "result": result});
            agent_write
                .write_all(format!("{resp}\n").as_bytes())
                .await
                .unwrap();
        });
        (peer, agent_task)
    }

    #[tokio::test]
    async fn session_new_errors_on_missing_session_id() {
        let (peer, agent_task) = harness_answering(serde_json::json!({}));
        let err = session_new(&peer, "/w").await.unwrap_err();
        assert!(matches!(err, RpcError::Protocol(_)), "got {err:?}");
        agent_task.await.unwrap();
    }

    #[tokio::test]
    async fn initialize_defaults_load_session_false_on_empty_result() {
        let (peer, agent_task) = harness_answering(serde_json::json!({}));
        assert!(!initialize(&peer).await.unwrap());
        agent_task.await.unwrap();
    }

    #[tokio::test]
    async fn session_prompt_defaults_stop_reason_completed() {
        let (peer, agent_task) = harness_answering(serde_json::json!({}));
        assert_eq!(session_prompt(&peer, "s", "hi").await.unwrap(), "completed");
        agent_task.await.unwrap();
    }

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
    fn parses_agent_thought_chunk_update() {
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text", "text": "pondering"}
            }
        });
        assert_eq!(
            parse_session_update(&params),
            Some(SessionUpdate::Thought { text: "pondering".into() })
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
            Some(SessionUpdate::ToolCall { title, raw_input, tool_call_id }) => {
                assert_eq!(title, "Read file");
                assert!(raw_input.contains("/x"));
                assert_eq!(tool_call_id.as_deref(), Some("t1"));
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }
    }

    #[test]
    fn parses_tool_call_update_status() {
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "completed",
                "title": "Read main.rs"
            }
        });
        assert_eq!(
            parse_session_update(&params),
            Some(SessionUpdate::ToolCallUpdate {
                tool_call_id: "t1".into(),
                status: "completed".into(),
                detail: "Read main.rs".into(),
            })
        );
    }

    #[test]
    fn tool_call_update_without_status_is_ignored() {
        // ACP allows updates carrying only content/locations; without a status
        // transition there is nothing for the chip to do.
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "tool_call_update", "toolCallId": "t1"}
        });
        assert_eq!(parse_session_update(&params), None);
    }

    #[test]
    fn unknown_update_kind_is_none_not_panic() {
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "sparkles_v9", "entries": []}
        });
        assert_eq!(parse_session_update(&params), None);
    }

    #[test]
    fn parses_plan_update_entries() {
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "plan", "entries": [
                {"content": "Read the file", "status": "completed", "priority": "medium"},
                {"content": "Edit it", "status": "in_progress", "priority": "high"}
            ]}
        });
        match parse_session_update(&params) {
            Some(SessionUpdate::Plan { entries_json }) => {
                assert!(entries_json.contains("Read the file"));
                assert!(entries_json.contains("in_progress"));
            }
            other => panic!("expected Plan, got {other:?}"),
        }
    }

    #[test]
    fn plan_update_without_entries_is_ignored() {
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "plan"}
        });
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

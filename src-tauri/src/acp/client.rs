//! Typed ACP layer over the ndjson JSON-RPC peer — the M1/M2 subset.
//! Unknown fields/update kinds are ignored, never fatal (agents evolve).

use super::jsonrpc::{RpcError, RpcPeer};
use serde_json::Value;

pub const PROTOCOL_VERSION: u64 = 1;

/// The session/update variants M1/M2 consume.
#[derive(Debug, PartialEq)]
pub enum SessionUpdate {
    AgentMessageChunk {
        text: String,
    },
    Thought {
        text: String,
    },
    ToolCall {
        title: String,
        raw_input: String,
        tool_call_id: Option<String>,
    },
    ToolCallUpdate {
        tool_call_id: String,
        status: String,
        detail: String,
    },
    Plan {
        entries_json: String,
    },
    /// `available_commands_update` — `commands_json` is a JSON array of
    /// `{name, description}`; entries without a name are dropped.
    AvailableCommands {
        commands_json: String,
    },
    /// `usage_update` — context-window occupancy for the session. `used` =
    /// tokens currently in context, `size` = total window. `cost_usd` rides
    /// only on claude-agent-acp's turn-final update (cumulative for the acp
    /// process, which Kine Agent spawns per turn — effectively per-turn).
    /// codex-acp emits {used,size} only and skips emission entirely when its
    /// model_context_window is unknown.
    UsageUpdate { used: u64, size: u64, cost_usd: Option<f64> },
    /// Vendor `_meta.terminal_output` on a `tool_call_update` — live output
    /// bytes for an execute tool call. NON-STANDARD, unversioned extension
    /// (claude-agent-acp sends ONE full-output blob at tool_result time;
    /// codex-acp streams per-read chunks). Keyed by toolCallId — both pinned
    /// agents set terminal_id == toolCallId, so terminal_id is ignored.
    TerminalOutput { tool_call_id: String, data: String },
    /// Vendor `_meta.terminal_exit` — command completion. Rides the same
    /// update as the final status for both agents; parsed as its own variant
    /// so one inbound message can yield ToolCallUpdate + TerminalExit.
    TerminalExit { tool_call_id: String, exit_code: Option<i64>, signal: Option<String> },
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
                // M4: the fs proxy is live — the agent routes file access through
                // fs/read_text_file / fs/write_text_file, worktree-enforced by us.
                // Vendor display flag (claude-agent-acp 0.54.1 / codex-acp 0.16.0): stream
                // command output as _meta.terminal_output deltas instead of a trailing
                // fenced block. Display-only — execution stays in the agent's own process
                // (security review 2026-07-03 §5). NOT the standard `terminal` capability,
                // which stays un-advertised by decision (§4).
                "clientCapabilities": {
                    "fs": {"readTextFile": true, "writeTextFile": true},
                    "_meta": {"terminal_output": true}
                },
                "clientInfo": {"name": "kine-agent", "version": env!("CARGO_PKG_VERSION")}
            }),
        )
        .await?;
    Ok(result
        .pointer("/agentCapabilities/loadSession")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            eprintln!(
                "acp: initialize response lacks agentCapabilities.loadSession — assuming false"
            );
            false
        }))
}

/// Session-mode state advertised by session/new (and session/load) responses.
/// Absent/malformed fields degrade to empty — mode syncing is best-effort.
/// `model_values`/`model_current` mirror the "model" entry of the response's
/// `configOptions` select, when advertised: codex-acp's bundled engine only
/// supports the models it lists there, and silently accepting an unknown slug
/// makes the TURN die later with -32603 (observed live 2026-07-21 with
/// gpt-5.6-terra on codex-acp 0.16.0). Empty = not advertised; the pick is
/// forwarded unvalidated as before (claude-agent-acp resolves aliases itself).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SessionModes {
    pub current: Option<String>,
    pub available: Vec<String>,
    pub model_values: Vec<String>,
    pub model_current: Option<String>,
}

pub fn parse_modes(result: &Value) -> SessionModes {
    let modes = result.get("modes");
    let model_option = result
        .get("configOptions")
        .and_then(Value::as_array)
        .and_then(|opts| {
            opts.iter()
                .find(|o| o.get("id").and_then(Value::as_str) == Some("model"))
        });
    SessionModes {
        current: modes
            .and_then(|m| m.get("currentModeId"))
            .and_then(Value::as_str)
            .map(str::to_string),
        available: modes
            .and_then(|m| m.get("availableModes"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        model_values: model_option
            .and_then(|o| o.get("options"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|o| o.get("value").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        model_current: model_option
            .and_then(|o| o.get("currentValue"))
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// Per-turn token split from the session/prompt RESPONSE's `usage` object
/// (claude-agent-acp populates it; codex-acp does not — UNSTABLE-flagged
/// upstream, so every field degrades to 0 and an absent object to None).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

pub fn parse_turn_usage(result: &Value) -> Option<TurnUsage> {
    let usage = result.get("usage")?;
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    Some(TurnUsage {
        input_tokens: n("inputTokens"),
        output_tokens: n("outputTokens"),
        cache_read_tokens: n("cachedReadTokens"),
        cache_write_tokens: n("cachedWriteTokens"),
    })
}

/// The ACP session mode a Kine Agent permission mode should run under. The agent
/// otherwise inherits the USER'S OWN settings default (e.g. permissions.defaultMode
/// "auto"), which silently auto-approves edits — "Ask before edits" must force
/// the agent into a mode that actually asks. Chains cover both claude-agent-acp ids
/// (acceptEdits, bypassPermissions, plan, dontAsk, auto) and codex-acp ids
/// (read-only, auto, full-access). Falls back along same-or-safer semantics when
/// the primary mapping isn't in `available`; an empty `available` (agent didn't
/// advertise) trusts the primary (claude-shaped) mapping. Name collision: "auto"
/// is claude's FULLY-AUTONOMOUS mode but codex's ask-on-escalation mode, so
/// acceptEdits only falls back to "auto" when the advertised list is codex-shaped.
pub fn acp_mode_for(permission_mode: Option<&str>, available: &[String]) -> String {
    // "auto" is two different modes wearing one name: codex-acp's auto asks on
    // escalation (safe fallback for acceptEdits), claude-agent-acp's auto is
    // fully autonomous (the M3 bug). Only trust it for acceptEdits when the
    // advertised list is codex-shaped — claude never advertises these ids.
    let codex_shaped = available
        .iter()
        .any(|a| a == "read-only" || a == "full-access");
    let chain: &[&str] = match permission_mode {
        Some("acceptEdits") if codex_shaped => &["acceptEdits", "auto", "default"],
        Some("acceptEdits") => &["acceptEdits", "default"],
        Some("plan") => &["plan", "read-only", "default"],
        Some("full") => &[
            "bypassPermissions",
            "full-access",
            "acceptEdits",
            "auto",
            "default",
        ],
        Some("dontAsk") => &["dontAsk", "full-access", "acceptEdits", "auto", "default"],
        Some("auto") => &["auto", "default"],
        _ => &["default", "read-only"],
    };
    if available.is_empty() {
        return chain[0].to_string();
    }
    chain
        .iter()
        .find(|m| available.iter().any(|a| a == *m))
        .unwrap_or(&"default")
        .to_string()
}

/// session/set_mode — point the agent at the session mode matching Kine Agent's
/// permission mode. Best-effort at the call site (a failure must not kill the run).
pub async fn session_set_mode(
    peer: &RpcPeer,
    session_id: &str,
    mode_id: &str,
) -> Result<(), RpcError> {
    peer.request(
        "session/set_mode",
        serde_json::json!({"sessionId": session_id, "modeId": mode_id}),
    )
    .await?;
    Ok(())
}

/// session/set_config_option — set a generic ACP session config option (the
/// model pick uses configId "model"; `value` is the bare string form both
/// pinned agents accept — claude-agent-acp resolves aliases like "sonnet",
/// codex-acp treats unknown values as raw model slugs). Best-effort at the
/// call site (a failure must not kill the run).
pub async fn session_set_config_option(
    peer: &RpcPeer,
    session_id: &str,
    config_id: &str,
    value: &str,
) -> Result<(), RpcError> {
    peer.request(
        "session/set_config_option",
        serde_json::json!({"sessionId": session_id, "configId": config_id, "value": value}),
    )
    .await?;
    Ok(())
}

/// session/new → the agent-minted session id (persisted as external_thread_id),
/// plus the session-mode state the response advertised.
/// A response without a sessionId is a hard error: an empty id would poison
/// every later session/prompt and resume.
pub async fn session_new(peer: &RpcPeer, cwd: &str) -> Result<(String, SessionModes), RpcError> {
    let result = peer
        .request(
            "session/new",
            serde_json::json!({"cwd": cwd, "mcpServers": []}),
        )
        .await?;
    let session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| RpcError::Protocol("session/new: missing sessionId".into()))?;
    Ok((session_id, parse_modes(&result)))
}

/// session/load for resume. Errors surface to the caller (falls back to session/new).
pub async fn session_load(
    peer: &RpcPeer,
    session_id: &str,
    cwd: &str,
) -> Result<SessionModes, RpcError> {
    let result = peer
        .request(
            "session/load",
            serde_json::json!({"sessionId": session_id, "cwd": cwd, "mcpServers": []}),
        )
        .await?;
    Ok(parse_modes(&result))
}

/// session/prompt → (stopReason, per-turn token usage if the agent reported
/// one in the response). stopReason: "completed" | "cancelled" | …
pub async fn session_prompt(
    peer: &RpcPeer,
    session_id: &str,
    text: &str,
) -> Result<(String, Option<TurnUsage>), RpcError> {
    let result = peer
        .request(
            "session/prompt",
            serde_json::json!({
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": text}]
            }),
        )
        .await?;
    let stop_reason = result
        .get("stopReason")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            eprintln!("acp: session/prompt response lacks stopReason — assuming completed");
            "completed"
        })
        .to_string();
    Ok((stop_reason, parse_turn_usage(&result)))
}

/// session/cancel — a NOTIFICATION (no response). The agent finishes the
/// in-flight session/prompt with stopReason "cancelled"; the client keeps
/// accepting updates until then and must answer pending permission requests
/// with the cancelled outcome (the adapter's cancel arm does both).
pub async fn session_cancel(peer: &RpcPeer, session_id: &str) -> Result<(), RpcError> {
    peer.notify(
        "session/cancel",
        serde_json::json!({"sessionId": session_id}),
    )
    .await
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

/// Parse a session/update notification's params into the M1 subset. One
/// inbound update can yield multiple SessionUpdates — e.g. a claude-agent-acp
/// tool_call_update carrying both a status transition and _meta.terminal_exit.
pub fn parse_session_updates(params: &Value) -> Vec<SessionUpdate> {
    let Some(update) = params.get("update") else { return Vec::new() };
    let Some(kind) = update.get("sessionUpdate").and_then(Value::as_str) else { return Vec::new() };
    match kind {
        "agent_message_chunk" => match update.pointer("/content/text").and_then(Value::as_str) {
            Some(text) => vec![SessionUpdate::AgentMessageChunk { text: text.to_string() }],
            None => Vec::new(),
        },
        "agent_thought_chunk" => match update.pointer("/content/text").and_then(Value::as_str) {
            Some(text) => vec![SessionUpdate::Thought { text: text.to_string() }],
            None => Vec::new(),
        },
        "tool_call" => vec![SessionUpdate::ToolCall {
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
        }],
        "tool_call_update" => {
            let Some(tool_call_id) = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                return Vec::new();
            };
            let mut updates = Vec::new();
            // Vendor terminal_output _meta (display-only; see SessionUpdate docs).
            // Malformed shapes are skipped with a log line — never fatal.
            if let Some(out) = update.pointer("/_meta/terminal_output") {
                match out.get("data").and_then(Value::as_str) {
                    Some(data) => updates.push(SessionUpdate::TerminalOutput {
                        tool_call_id: tool_call_id.to_string(),
                        data: data.to_string(),
                    }),
                    None => eprintln!("acp: terminal_output _meta without string data — skipped"),
                }
            }
            // Updates may carry only content/locations; without a status
            // transition there is no ToolCallUpdate to surface.
            if let Some(status) = update.get("status").and_then(Value::as_str) {
                updates.push(SessionUpdate::ToolCallUpdate {
                    tool_call_id: tool_call_id.to_string(),
                    status: status.to_string(),
                    detail: update.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
                });
            }
            if let Some(exit) = update.pointer("/_meta/terminal_exit") {
                updates.push(SessionUpdate::TerminalExit {
                    tool_call_id: tool_call_id.to_string(),
                    exit_code: exit.get("exit_code").and_then(Value::as_i64),
                    signal: exit.get("signal").and_then(Value::as_str).map(str::to_string),
                });
            }
            updates
        }
        "plan" => {
            let Some(entries) = update.get("entries") else { return Vec::new(); };
            if !entries.is_array() {
                return Vec::new();
            }
            vec![SessionUpdate::Plan {
                entries_json: entries.to_string(),
            }]
        }
        "available_commands_update" => {
            let Some(commands_array) = update.get("availableCommands").and_then(Value::as_array)
            else {
                return Vec::new();
            };
            let commands: Vec<Value> = commands_array
                .iter()
                .filter_map(|c| {
                    let name = c.get("name").and_then(Value::as_str)?;
                    Some(serde_json::json!({
                        "name": name,
                        "description": c.get("description").and_then(Value::as_str).unwrap_or(""),
                    }))
                })
                .collect();
            vec![SessionUpdate::AvailableCommands {
                commands_json: Value::Array(commands).to_string(),
            }]
        }
        "usage_update" => {
            // used/size are schema-required; drop malformed updates silently.
            let Some(used) = update.get("used").and_then(Value::as_u64) else {
                return Vec::new();
            };
            let Some(size) = update.get("size").and_then(Value::as_u64) else {
                return Vec::new();
            };
            let cost_usd = update.pointer("/cost/amount").and_then(Value::as_f64);
            vec![SessionUpdate::UsageUpdate { used, size, cost_usd }]
        }
        // unknown/future update kinds — ignored by design
        _ => Vec::new(),
    }
}

/// Params of fs/read_text_file: (path, 1-based start line, max lines).
/// `line` 0 and 1 both mean "from the start" (the schema allows 0; the
/// protocol convention is 1-based). None on malformed params.
pub fn parse_fs_read(params: &Value) -> Option<(String, Option<u64>, Option<u64>)> {
    let path = params.get("path").and_then(Value::as_str)?.to_string();
    let line = params.get("line").and_then(Value::as_u64);
    let limit = params.get("limit").and_then(Value::as_u64);
    Some((path, line, limit))
}

/// Params of fs/write_text_file: (path, content). None on malformed params.
pub fn parse_fs_write(params: &Value) -> Option<(String, String)> {
    let path = params.get("path").and_then(Value::as_str)?.to_string();
    let content = params.get("content").and_then(Value::as_str)?.to_string();
    Some((path, content))
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

/// Human-readable pieces of a session/request_permission request, for the
/// ApprovalNeeded event. ACP supplies its own description (the tool call's
/// title) — deliberately NOT routed through `mcp::describe` (spec §Inbound
/// request handling). Every field degrades to a safe fallback.
pub fn parse_permission_request(params: &Value) -> (String, String, String) {
    let tool_call = params.get("toolCall");
    let title = tool_call
        .and_then(|tc| tc.get("title"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let tool = title.unwrap_or("tool").to_string();
    let input = tool_call
        .and_then(|tc| tc.get("rawInput"))
        .map(|v| v.to_string())
        .unwrap_or_else(|| "{}".to_string());
    let prompt = title
        .map(str::to_string)
        .unwrap_or_else(|| "The agent requests permission to use a tool.".to_string());
    (tool, input, prompt)
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
    async fn session_new_returns_parsed_modes_alongside_session_id() {
        let (peer, agent_task) = harness_answering(serde_json::json!({
            "sessionId": "acp-abc",
            "modes": {
                "currentModeId": "auto",
                "availableModes": [
                    {"id": "auto", "name": "Auto"},
                    {"id": "default", "name": "Default"}
                ]
            }
        }));
        let (session_id, modes) = session_new(&peer, "/w").await.unwrap();
        assert_eq!(session_id, "acp-abc");
        assert_eq!(modes.current.as_deref(), Some("auto"));
        assert_eq!(
            modes.available,
            vec!["auto".to_string(), "default".to_string()]
        );
        agent_task.await.unwrap();
    }

    #[tokio::test]
    async fn session_load_returns_parsed_modes() {
        let (peer, agent_task) = harness_answering(serde_json::json!({
            "modes": {
                "currentModeId": "acceptEdits",
                "availableModes": [{"id": "acceptEdits"}, {"id": "default"}]
            }
        }));
        let modes = session_load(&peer, "s", "/w").await.unwrap();
        assert_eq!(modes.current.as_deref(), Some("acceptEdits"));
        assert_eq!(
            modes.available,
            vec!["acceptEdits".to_string(), "default".to_string()]
        );
        agent_task.await.unwrap();
    }

    #[tokio::test]
    async fn session_load_empty_result_yields_default_modes() {
        let (peer, agent_task) = harness_answering(serde_json::json!({}));
        let modes = session_load(&peer, "s", "/w").await.unwrap();
        assert_eq!(modes, SessionModes::default());
        agent_task.await.unwrap();
    }

    #[test]
    fn parse_modes_happy_path() {
        let result = serde_json::json!({
            "sessionId": "s",
            "modes": {
                "currentModeId": "plan",
                "availableModes": [
                    {"id": "plan", "name": "Plan"},
                    {"id": "default", "name": "Default"},
                    {"id": "acceptEdits", "name": "Accept Edits"}
                ]
            }
        });
        let modes = parse_modes(&result);
        assert_eq!(modes.current.as_deref(), Some("plan"));
        assert_eq!(
            modes.available,
            vec![
                "plan".to_string(),
                "default".to_string(),
                "acceptEdits".to_string()
            ]
        );
    }

    #[test]
    fn parse_modes_missing_modes_key_defaults_to_empty() {
        let modes = parse_modes(&serde_json::json!({"sessionId": "s"}));
        assert_eq!(modes, SessionModes::default());
    }

    #[test]
    fn acp_mode_for_maps_onto_codex_mode_ids() {
        // codex-acp v0.16.0 advertises these preset ids (source-verified).
        let codex = vec![
            "read-only".to_string(),
            "auto".to_string(),
            "full-access".to_string(),
        ];
        // "Ask before edits" must land on read-only — codex then requests
        // permission for mutations instead of silently applying them.
        assert_eq!(acp_mode_for(None, &codex), "read-only");
        assert_eq!(acp_mode_for(Some("plan"), &codex), "read-only");
        // acceptEdits ≈ codex auto (workspace-write, asks only for escalations).
        assert_eq!(acp_mode_for(Some("acceptEdits"), &codex), "auto");
        assert_eq!(acp_mode_for(Some("full"), &codex), "full-access");
        assert_eq!(acp_mode_for(Some("dontAsk"), &codex), "full-access");
        assert_eq!(acp_mode_for(Some("auto"), &codex), "auto");
    }

    #[test]
    fn acp_mode_for_mapping_table() {
        let all = vec![
            "default".to_string(),
            "acceptEdits".to_string(),
            "plan".to_string(),
            "bypassPermissions".to_string(),
            "dontAsk".to_string(),
            "auto".to_string(),
        ];
        assert_eq!(acp_mode_for(None, &all), "default");
        assert_eq!(acp_mode_for(Some("acceptEdits"), &all), "acceptEdits");
        assert_eq!(acp_mode_for(Some("plan"), &all), "plan");
        assert_eq!(acp_mode_for(Some("full"), &all), "bypassPermissions");
        assert_eq!(acp_mode_for(Some("dontAsk"), &all), "dontAsk");
        assert_eq!(acp_mode_for(Some("auto"), &all), "auto");

        // full → falls back to acceptEdits when bypassPermissions isn't advertised
        let no_bypass = vec!["default".to_string(), "acceptEdits".to_string()];
        assert_eq!(acp_mode_for(Some("full"), &no_bypass), "acceptEdits");

        // full → auto even on a non-codex-shaped list: full intends autonomy,
        // so the unguarded fallback chain is correct here.
        let only_auto = vec!["auto".to_string(), "default".to_string()];
        assert_eq!(acp_mode_for(Some("full"), &only_auto), "auto");

        // claude-shaped list advertising auto WITHOUT acceptEdits: auto is
        // claude's fully-autonomous mode — acceptEdits must NOT escalate to it.
        let claude_auto = vec!["auto".to_string(), "default".to_string()];
        assert_eq!(acp_mode_for(Some("acceptEdits"), &claude_auto), "default");

        // empty available (agent didn't advertise) → primary mapping unclamped
        assert_eq!(acp_mode_for(Some("acceptEdits"), &[]), "acceptEdits");
        assert_eq!(acp_mode_for(Some("full"), &[]), "bypassPermissions");

        // unknown-everything: only "default" advertised and permission_mode unmapped
        let only_default = vec!["default".to_string()];
        assert_eq!(acp_mode_for(Some("plan"), &only_default), "default");
        assert_eq!(
            acp_mode_for(Some("weird-unknown-mode"), &only_default),
            "default"
        );
    }

    #[tokio::test]
    async fn initialize_defaults_load_session_false_on_empty_result() {
        let (peer, agent_task) = harness_answering(serde_json::json!({}));
        assert!(!initialize(&peer).await.unwrap());
        agent_task.await.unwrap();
    }

    #[tokio::test]
    async fn session_cancel_sends_a_notification_without_awaiting_a_response() {
        let (ours, theirs) = duplex(64 * 1024);
        let (read_half, write_half) = tokio::io::split(ours);
        let peer = RpcPeer::start(read_half, write_half);
        let (agent_read, _w) = tokio::io::split(theirs);
        // Notification ⇒ resolves immediately; the agent never answers.
        session_cancel(&peer, "acp-abc").await.unwrap();
        let mut lines = BufReader::new(agent_read).lines();
        let msg: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(msg["method"], "session/cancel");
        assert_eq!(msg["params"]["sessionId"], "acp-abc");
        assert!(
            msg.get("id").is_none(),
            "cancel is a notification — no id, no response"
        );
    }

    #[tokio::test]
    async fn session_prompt_defaults_stop_reason_completed() {
        let (peer, agent_task) = harness_answering(serde_json::json!({}));
        let (stop, usage) = session_prompt(&peer, "s", "hi").await.unwrap();
        assert_eq!(stop, "completed");
        assert_eq!(usage, None);
        agent_task.await.unwrap();
    }

    #[test]
    fn parses_usage_update_with_and_without_cost() {
        // Turn-final shape (claude-agent-acp result site — the only one with cost).
        let with_cost = serde_json::json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "usage_update", "used": 48213, "size": 200000,
                       "cost": {"amount": 0.0731, "currency": "USD"}}
        });
        assert_eq!(
            parse_session_updates(&with_cost),
            vec![SessionUpdate::UsageUpdate { used: 48213, size: 200000, cost_usd: Some(0.0731) }]
        );
        // Mid-stream / codex shape — no cost key at all.
        let no_cost = serde_json::json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "usage_update", "used": 31044, "size": 1000000}
        });
        assert_eq!(
            parse_session_updates(&no_cost),
            vec![SessionUpdate::UsageUpdate { used: 31044, size: 1000000, cost_usd: None }]
        );
    }

    #[test]
    fn usage_update_missing_required_fields_is_ignored() {
        // used/size are schema-required; a malformed update must be dropped, not panic.
        let missing_size = serde_json::json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "usage_update", "used": 10}
        });
        assert_eq!(parse_session_updates(&missing_size), Vec::<SessionUpdate>::new());
        let missing_used = serde_json::json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "usage_update", "size": 200000}
        });
        assert_eq!(parse_session_updates(&missing_used), Vec::<SessionUpdate>::new());
    }

    #[test]
    fn parses_turn_usage_from_prompt_response() {
        // claude-agent-acp 0.54.1 response shape (UNSTABLE-flagged upstream).
        let result = serde_json::json!({
            "stopReason": "end_turn",
            "usage": {"inputTokens": 1200, "outputTokens": 340,
                      "cachedReadTokens": 18000, "cachedWriteTokens": 500, "totalTokens": 20040}
        });
        assert_eq!(
            parse_turn_usage(&result),
            Some(TurnUsage {
                input_tokens: 1200,
                output_tokens: 340,
                cache_read_tokens: 18000,
                cache_write_tokens: 500,
            })
        );
        // codex-acp populates no usage — None, not zeros.
        assert_eq!(parse_turn_usage(&serde_json::json!({"stopReason": "end_turn"})), None);
        // Nullable fields (cachedReadTokens etc.) may be null — degrade to 0.
        let nulls = serde_json::json!({
            "usage": {"inputTokens": 5, "outputTokens": 2, "cachedReadTokens": null, "totalTokens": 7}
        });
        assert_eq!(
            parse_turn_usage(&nulls),
            Some(TurnUsage { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 })
        );
    }

    #[tokio::test]
    async fn session_prompt_returns_stop_reason_and_turn_usage() {
        let (peer, agent_task) = harness_answering(serde_json::json!({
            "stopReason": "end_turn",
            "usage": {"inputTokens": 10, "outputTokens": 4, "totalTokens": 14}
        }));
        let (stop, usage) = session_prompt(&peer, "s", "hi").await.unwrap();
        assert_eq!(stop, "end_turn");
        assert_eq!(
            usage,
            Some(TurnUsage { input_tokens: 10, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0 })
        );
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
            parse_session_updates(&params),
            vec![SessionUpdate::AgentMessageChunk {
                text: "hello".into()
            }]
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
            parse_session_updates(&params),
            vec![SessionUpdate::Thought {
                text: "pondering".into()
            }]
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
        match parse_session_updates(&params).into_iter().next() {
            Some(SessionUpdate::ToolCall {
                title,
                raw_input,
                tool_call_id,
            }) => {
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
            parse_session_updates(&params),
            vec![SessionUpdate::ToolCallUpdate {
                tool_call_id: "t1".into(),
                status: "completed".into(),
                detail: "Read main.rs".into(),
            }]
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
        assert_eq!(parse_session_updates(&params), Vec::<SessionUpdate>::new());
    }

    #[test]
    fn parses_codex_terminal_output_delta_without_status() {
        // codex-acp streams deltas as tool_call_update with EMPTY fields (no status).
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {
                "_meta": {"terminal_output": {"terminal_id": "c1", "data": "chunk-1\n"}},
                "toolCallId": "c1",
                "sessionUpdate": "tool_call_update"
            }
        });
        assert_eq!(
            parse_session_updates(&params),
            vec![SessionUpdate::TerminalOutput { tool_call_id: "c1".into(), data: "chunk-1\n".into() }]
        );
    }

    #[test]
    fn parses_claude_combined_status_and_terminal_exit_update() {
        // claude-agent-acp's FINAL update carries status + terminal_exit together.
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {
                "_meta": {
                    "claudeCode": {"toolName": "Bash"},
                    "terminal_exit": {"terminal_id": "t1", "exit_code": 0, "signal": null}
                },
                "toolCallId": "t1",
                "sessionUpdate": "tool_call_update",
                "status": "completed",
                "content": [{"type": "terminal", "terminalId": "t1"}]
            }
        });
        assert_eq!(
            parse_session_updates(&params),
            vec![
                SessionUpdate::ToolCallUpdate { tool_call_id: "t1".into(), status: "completed".into(), detail: "".into() },
                SessionUpdate::TerminalExit { tool_call_id: "t1".into(), exit_code: Some(0), signal: None },
            ]
        );
    }

    #[test]
    fn parses_codex_terminal_exit_with_failure_code() {
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {
                "_meta": {"terminal_exit": {"terminal_id": "c1", "exit_code": 127, "signal": null}},
                "toolCallId": "c1",
                "sessionUpdate": "tool_call_update",
                "status": "failed"
            }
        });
        assert_eq!(
            parse_session_updates(&params),
            vec![
                SessionUpdate::ToolCallUpdate { tool_call_id: "c1".into(), status: "failed".into(), detail: "".into() },
                SessionUpdate::TerminalExit { tool_call_id: "c1".into(), exit_code: Some(127), signal: None },
            ]
        );
    }

    #[test]
    fn tolerates_malformed_terminal_meta_shapes() {
        // data not a string → that piece skipped; status still parsed. Never panics.
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {
                "_meta": {"terminal_output": {"terminal_id": "x", "data": 42}},
                "toolCallId": "x",
                "sessionUpdate": "tool_call_update",
                "status": "in_progress"
            }
        });
        assert_eq!(
            parse_session_updates(&params),
            vec![SessionUpdate::ToolCallUpdate { tool_call_id: "x".into(), status: "in_progress".into(), detail: "".into() }]
        );
        // exit_code non-numeric → None, event still emitted (exit is still real).
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {
                "_meta": {"terminal_exit": {"terminal_id": "x", "exit_code": "boom"}},
                "toolCallId": "x",
                "sessionUpdate": "tool_call_update"
            }
        });
        assert_eq!(
            parse_session_updates(&params),
            vec![SessionUpdate::TerminalExit { tool_call_id: "x".into(), exit_code: None, signal: None }]
        );
    }

    #[test]
    fn statusless_update_without_terminal_meta_yields_nothing() {
        // Pre-existing behavior preserved: content/locations-only updates are not surfaced.
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {"toolCallId": "t", "sessionUpdate": "tool_call_update", "content": []}
        });
        assert_eq!(parse_session_updates(&params), Vec::<SessionUpdate>::new());
    }

    #[test]
    fn terminal_signal_string_is_captured() {
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {
                "_meta": {"terminal_exit": {"terminal_id": "t", "exit_code": null, "signal": "SIGKILL"}},
                "toolCallId": "t",
                "sessionUpdate": "tool_call_update"
            }
        });
        assert_eq!(
            parse_session_updates(&params),
            vec![SessionUpdate::TerminalExit { tool_call_id: "t".into(), exit_code: None, signal: Some("SIGKILL".into()) }]
        );
    }

    #[test]
    fn unknown_update_kind_is_none_not_panic() {
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "sparkles_v9", "entries": []}
        });
        assert_eq!(parse_session_updates(&params), Vec::<SessionUpdate>::new());
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
        match parse_session_updates(&params).into_iter().next() {
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
        assert_eq!(parse_session_updates(&params), Vec::<SessionUpdate>::new());
    }

    #[test]
    fn parses_available_commands_update() {
        let params = serde_json::json!({
            "sessionId": "s",
            "update": {"sessionUpdate": "available_commands_update", "availableCommands": [
                {"name": "web", "description": "Search the web", "input": {"hint": "query"}},
                {"description": "no name — dropped"},
                {"name": "plan", "description": "Plan first"}
            ]}
        });
        match parse_session_updates(&params).into_iter().next() {
            Some(SessionUpdate::AvailableCommands { commands_json }) => {
                let parsed: serde_json::Value = serde_json::from_str(&commands_json).unwrap();
                let arr = parsed.as_array().unwrap();
                assert_eq!(arr.len(), 2); // nameless entry dropped
                assert_eq!(arr[0]["name"], "web");
                assert_eq!(arr[0]["description"], "Search the web");
                assert_eq!(arr[1]["name"], "plan");
            }
            other => panic!("expected AvailableCommands, got {other:?}"),
        }
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
    fn parse_permission_request_uses_tool_call_title_and_raw_input() {
        let params = serde_json::json!({
            "sessionId": "s",
            "toolCall": {"toolCallId": "t1", "title": "Edit main.rs", "rawInput": {"path": "main.rs"}},
            "options": []
        });
        let (tool, input, prompt) = parse_permission_request(&params);
        assert_eq!(tool, "Edit main.rs");
        assert!(input.contains("main.rs"));
        assert_eq!(prompt, "Edit main.rs");
    }

    #[test]
    fn parse_permission_request_degrades_on_missing_fields() {
        let (tool, input, prompt) = parse_permission_request(&serde_json::json!({}));
        assert_eq!(tool, "tool");
        assert_eq!(input, "{}");
        assert_eq!(prompt, "The agent requests permission to use a tool.");
    }

    #[test]
    fn parses_fs_read_params_with_optional_line_and_limit() {
        let params =
            serde_json::json!({"sessionId": "s", "path": "/w/x.txt", "line": 5, "limit": 10});
        assert_eq!(
            parse_fs_read(&params),
            Some(("/w/x.txt".to_string(), Some(5), Some(10)))
        );
        let bare = serde_json::json!({"sessionId": "s", "path": "/w/x.txt"});
        assert_eq!(
            parse_fs_read(&bare),
            Some(("/w/x.txt".to_string(), None, None))
        );
        assert_eq!(parse_fs_read(&serde_json::json!({"sessionId": "s"})), None);
    }

    #[test]
    fn parses_fs_write_params() {
        let params = serde_json::json!({"sessionId": "s", "path": "/w/x.txt", "content": "hi"});
        assert_eq!(
            parse_fs_write(&params),
            Some(("/w/x.txt".to_string(), "hi".to_string()))
        );
        assert_eq!(
            parse_fs_write(&serde_json::json!({"path": "/w/x.txt"})),
            None
        );
    }

    #[tokio::test]
    async fn initialize_advertises_fs_capability() {
        // Agent side captures the initialize request and asserts the fs caps.
        let (ours, theirs) = duplex(64 * 1024);
        let (read_half, write_half) = tokio::io::split(ours);
        let peer = RpcPeer::start(read_half, write_half);
        let (agent_read, mut agent_write) = tokio::io::split(theirs);
        let agent = tokio::spawn(async move {
            let mut lines = BufReader::new(agent_read).lines();
            let req: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(
                req["params"]["clientCapabilities"]["fs"]["readTextFile"],
                true
            );
            assert_eq!(
                req["params"]["clientCapabilities"]["fs"]["writeTextFile"],
                true
            );
            assert_eq!(
                req.pointer("/params/clientCapabilities/_meta/terminal_output"),
                Some(&serde_json::json!(true))
            );
            let resp = serde_json::json!({"jsonrpc":"2.0","id":req["id"],"result":{}});
            agent_write
                .write_all(format!("{resp}\n").as_bytes())
                .await
                .unwrap();
        });
        let _ = initialize(&peer).await.unwrap();
        agent.await.unwrap();
    }

    #[tokio::test]
    async fn session_set_config_option_sends_bare_string_value() {
        // Wire shape is ground-truth-pinned (2026-07-02) against BOTH agents:
        // {"sessionId", "configId", "value"} with value a BARE string — no
        // {"type": ...} wrapper (that form is only for the unstable boolean
        // config variant neither side needs here).
        let (ours, theirs) = duplex(64 * 1024);
        let (read_half, write_half) = tokio::io::split(ours);
        let peer = RpcPeer::start(read_half, write_half);
        let (agent_read, mut agent_write) = tokio::io::split(theirs);
        let agent = tokio::spawn(async move {
            let mut lines = BufReader::new(agent_read).lines();
            let req: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(req["method"], "session/set_config_option");
            assert_eq!(req["params"]["sessionId"], "acp-abc");
            assert_eq!(req["params"]["configId"], "model");
            assert_eq!(req["params"]["value"], "sonnet");
            assert!(
                req["params"]["value"].is_string(),
                "value must be a bare string"
            );
            let resp = serde_json::json!({"jsonrpc": "2.0", "id": req["id"],
                "result": {"configOptions": []}});
            agent_write
                .write_all(format!("{resp}\n").as_bytes())
                .await
                .unwrap();
        });
        session_set_config_option(&peer, "acp-abc", "model", "sonnet")
            .await
            .unwrap();
        agent.await.unwrap();
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

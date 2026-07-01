//! The Claude `--permission-prompt-tool` MCP bridge.
//!
//! Claude launches with `--permission-prompt-tool mcp__kineloop__approve`, a `--mcp-config`
//! that points at a Kineloop-hosted stdio MCP server, and `--strict-mcp-config` so only our
//! server loads. Before each gated tool call Claude invokes the `approve` tool with the tool
//! name + input; the handler registers an [`super::ApprovalRegistry`] request, emits
//! `AgentEvent::ApprovalNeeded` into that session's stream, awaits the user's decision, and
//! returns [`permission_tool_response`] wrapped as a tool result so Claude proceeds or is
//! denied.
//!
//! This module owns the two protocol-stable, fully-tested layers:
//!   - the MCP JSON-RPC message layer ([`handle_initialize`], [`tools_list_result`],
//!     [`tool_call_result`], [`parse_tool_call`]), and
//!   - the launch configuration ([`permission_prompt_tool`], [`mcp_config_json`]).
//!
//! What still needs a live Claude login to finish and verify is the transport wiring: the
//! stdio server loop and its bridge to the running app (see [`transport`]) and attaching the
//! flags in the Claude adapter. The exact tool-result envelope Claude expects for a decision
//! is under-documented (anthropics/claude-code #1175); it is isolated in
//! [`permission_tool_response`] + [`tool_call_result`] so it is a one-line change if the live
//! run shows a different shape. Codex `exec` and Antigravity `--print` have no equivalent
//! gate, so this bridge is Claude-only; the shared [`super`] core keeps the UI/IPC identical.

pub mod transport;

use serde_json::{json, Value};

use super::ApprovalDecision;

/// The MCP server name Kineloop registers under `--mcp-config`.
pub const SERVER_NAME: &str = "kineloop";
/// The permission tool exposed by that server.
pub const TOOL_NAME: &str = "approve";
/// The MCP protocol version we speak if the client doesn't pin one.
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";

/// The `--permission-prompt-tool` value: `mcp__<server>__<tool>`.
pub fn permission_prompt_tool() -> String {
    format!("mcp__{SERVER_NAME}__{TOOL_NAME}")
}

/// Build the inline `--mcp-config` JSON that registers our stdio server. Claude spawns
/// `program args...` (the Kineloop binary in approval-server mode) and speaks MCP over its
/// stdio. Pair with `--strict-mcp-config` so the user's other MCP servers don't load.
pub fn mcp_config_json(program: &str, args: &[String]) -> String {
    json!({
        "mcpServers": {
            SERVER_NAME: {
                "command": program,
                "args": args,
            }
        }
    })
    .to_string()
}

/// The `approve` tool's arguments as Claude sends them: the tool it wants to run plus that
/// tool's input. Field names are read leniently so a minor upstream rename doesn't break us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub tool_name: String,
    pub input: Value,
}

/// A short human-readable summary of a gated tool call, for the approval card title.
pub fn describe(tool_name: &str, input: &Value) -> String {
    // Bash is the common, highest-risk case: show the command.
    if tool_name == "Bash" {
        if let Some(cmd) = input.get("command").and_then(Value::as_str) {
            return format!("Run: {cmd}");
        }
    }
    // File tools: show the path.
    if let Some(path) = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
    {
        return format!("{tool_name}: {path}");
    }
    tool_name.to_string()
}

/// Build the JSON body the tool returns to Claude for a decision. The contract (from the
/// Agent SDK permission docs) is exactly:
///   - allow: `{ "behavior": "allow", "updatedInput": <input> }`
///   - deny:  `{ "behavior": "deny", "message": <reason> }`
///
/// On allow we echo the original input unchanged (Kineloop approves as-is; it does not
/// rewrite tool arguments). On deny we fall back to a generic reason when none was given.
pub fn permission_tool_response(decision: &ApprovalDecision, original_input: &Value) -> Value {
    if decision.allow {
        json!({ "behavior": "allow", "updatedInput": original_input })
    } else {
        json!({
            "behavior": "deny",
            "message": decision
                .message
                .clone()
                .unwrap_or_else(|| "User denied this action".to_string()),
        })
    }
}

// ── MCP JSON-RPC message layer ──────────────────────────────────────────────────

/// Response to an `initialize` request. Echoes the client's requested protocol version when
/// present (MCP requires the server to agree on a version) and advertises the tools capability.
pub fn handle_initialize(id: &Value, params: &Value) -> Value {
    let protocol_version = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_PROTOCOL_VERSION);
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": protocol_version,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

/// Response to `tools/list`: the single `approve` tool and its input schema.
pub fn tools_list_result(id: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "tools": [{
                "name": TOOL_NAME,
                "description": "Ask the Kineloop user to approve or deny a tool call.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tool_name": { "type": "string", "description": "The tool Claude wants to run." },
                        "input": { "type": "object", "description": "The tool's input arguments." }
                    },
                    "required": ["tool_name"]
                }
            }]
        }
    })
}

/// Parse the arguments of a `tools/call` request for the `approve` tool. Returns `None` when
/// the request isn't a call to our tool or lacks a tool name (leniently accepts a few field
/// spellings; missing input defaults to an empty object).
pub fn parse_tool_call(params: &Value) -> Option<ToolCall> {
    let name = params.get("name").and_then(Value::as_str)?;
    if name != TOOL_NAME {
        return None;
    }
    let args = params.get("arguments").unwrap_or(&Value::Null);
    let tool_name = args
        .get("tool_name")
        .or_else(|| args.get("toolName"))
        .or_else(|| args.get("tool"))
        .and_then(Value::as_str)?
        .to_string();
    let input = args
        .get("input")
        .or_else(|| args.get("tool_input"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    Some(ToolCall { tool_name, input })
}

/// Wrap a decision as the `tools/call` result Claude reads. Per the reverse-engineered
/// contract the decision travels as the JSON text of a single text content block.
pub fn tool_call_result(id: &Value, decision: &ApprovalDecision, original_input: &Value) -> Value {
    let body = permission_tool_response(decision, original_input);
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{ "type": "text", "text": body.to_string() }],
            "isError": false
        }
    })
}

/// A JSON-RPC error response (e.g. for an unknown method).
pub fn error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_prompt_tool_uses_the_mcp_naming_scheme() {
        assert_eq!(permission_prompt_tool(), "mcp__kineloop__approve");
    }

    #[test]
    fn mcp_config_registers_a_stdio_server() {
        let cfg = mcp_config_json("/usr/bin/kineloop", &["--approval-server".to_string()]);
        let v: Value = serde_json::from_str(&cfg).unwrap();
        assert_eq!(v["mcpServers"]["kineloop"]["command"], "/usr/bin/kineloop");
        assert_eq!(v["mcpServers"]["kineloop"]["args"][0], "--approval-server");
    }

    #[test]
    fn allow_echoes_input_unchanged() {
        let input = json!({ "command": "npm test" });
        let resp = permission_tool_response(&ApprovalDecision::allow(), &input);
        assert_eq!(resp["behavior"], "allow");
        assert_eq!(resp["updatedInput"], input);
        assert!(resp.get("message").is_none());
    }

    #[test]
    fn deny_carries_reason_and_omits_input() {
        let input = json!({ "command": "rm -rf /" });
        let resp = permission_tool_response(&ApprovalDecision::deny("blocked"), &input);
        assert_eq!(resp["behavior"], "deny");
        assert_eq!(resp["message"], "blocked");
        assert!(resp.get("updatedInput").is_none());
    }

    #[test]
    fn deny_without_reason_uses_a_generic_message() {
        let decision = ApprovalDecision {
            allow: false,
            message: None,
        };
        let resp = permission_tool_response(&decision, &json!({}));
        assert_eq!(resp["message"], "User denied this action");
    }

    #[test]
    fn initialize_echoes_the_clients_protocol_version_and_advertises_tools() {
        let resp = handle_initialize(&json!(1), &json!({ "protocolVersion": "2025-03-26" }));
        assert_eq!(resp["result"]["protocolVersion"], "2025-03-26");
        assert!(resp["result"]["capabilities"]["tools"].is_object());
        assert_eq!(resp["result"]["serverInfo"]["name"], "kineloop");
    }

    #[test]
    fn initialize_falls_back_to_a_default_protocol_version() {
        let resp = handle_initialize(&json!(1), &json!({}));
        assert_eq!(resp["result"]["protocolVersion"], DEFAULT_PROTOCOL_VERSION);
    }

    #[test]
    fn tools_list_exposes_the_approve_tool() {
        let resp = tools_list_result(&json!(2));
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "approve");
        assert!(tools[0]["inputSchema"]["properties"]["tool_name"].is_object());
    }

    #[test]
    fn parse_tool_call_reads_tool_name_and_input() {
        let params = json!({
            "name": "approve",
            "arguments": { "tool_name": "Bash", "input": { "command": "ls" } }
        });
        let call = parse_tool_call(&params).unwrap();
        assert_eq!(call.tool_name, "Bash");
        assert_eq!(call.input, json!({ "command": "ls" }));
    }

    #[test]
    fn parse_tool_call_defaults_missing_input_and_rejects_other_tools() {
        let no_input = json!({ "name": "approve", "arguments": { "tool_name": "Read" } });
        assert_eq!(parse_tool_call(&no_input).unwrap().input, json!({}));

        let other = json!({ "name": "something_else", "arguments": {} });
        assert!(parse_tool_call(&other).is_none());
    }

    #[test]
    fn tool_call_result_wraps_the_decision_as_a_text_block() {
        let input = json!({ "command": "ls" });
        let resp = tool_call_result(&json!(3), &ApprovalDecision::allow(), &input);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let decoded: Value = serde_json::from_str(text).unwrap();
        assert_eq!(decoded["behavior"], "allow");
        assert_eq!(decoded["updatedInput"], input);
        assert_eq!(resp["result"]["content"][0]["type"], "text");
    }

    #[test]
    fn describe_summarizes_common_tools() {
        assert_eq!(describe("Bash", &json!({ "command": "make" })), "Run: make");
        assert_eq!(describe("Edit", &json!({ "file_path": "a.rs" })), "Edit: a.rs");
        assert_eq!(describe("Read", &json!({})), "Read");
    }
}

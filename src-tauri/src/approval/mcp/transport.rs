//! MCP stdio transport: the loop that drives the permission-server protocol.
//!
//! [`run_stdio_server`] reads newline-delimited JSON-RPC from `reader`, dispatches each
//! message through the tested message layer in the parent module, and writes responses to
//! `writer`. It is generic over an async `decide` closure so it can be unit-tested with a
//! mock; the live server passes a closure that forwards the gated call to the running app
//! (which registers the request, emits `ApprovalNeeded`, and awaits the user's answer).
//!
//! STATUS: this driver is implemented and tested. What still needs a live Claude login to
//! finish and verify is the OS transport hosting around it — the Unix-socket bridge from this
//! subprocess to the app, the app-side listener, and the `main.rs` subcommand that starts the
//! server. See docs/approval-architecture.md.

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

use super::{
    error_response, handle_initialize, parse_tool_call, tool_call_result, tools_list_result,
    ToolCall,
};
use crate::approval::ApprovalDecision;

/// Drive the MCP stdio protocol until `reader` reaches EOF, handling one request per line:
/// `initialize` (capability handshake), `tools/list` (the `approve` tool), `tools/call`
/// (runs `decide(call).await` and returns the decision as a tool result), `ping` (empty
/// result), notifications with no `id` (ignored), and anything else with an id
/// (method-not-found error). Malformed non-JSON lines are skipped, mirroring the adapters'
/// resilience to junk output.
pub async fn run_stdio_server<R, W, F, Fut>(
    reader: R,
    mut writer: W,
    decide: F,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: Fn(ToolCall) -> Fut,
    Fut: std::future::Future<Output = ApprovalDecision>,
{
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(line) else {
            continue; // skip junk lines rather than aborting the session
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = req.get("params").cloned().unwrap_or(Value::Null);

        let response: Option<Value> = match method {
            "initialize" => Some(handle_initialize(&id, &params)),
            // Notifications carry no id and expect no response.
            "notifications/initialized" | "initialized" => None,
            "tools/list" => Some(tools_list_result(&id)),
            "tools/call" => match parse_tool_call(&params) {
                Some(call) => {
                    let input = call.input.clone();
                    let decision = decide(call).await;
                    Some(tool_call_result(&id, &decision, &input))
                }
                None => Some(error_response(
                    &id,
                    -32602,
                    "unknown or malformed tool call",
                )),
            },
            "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
            // Unknown notification (no id): ignore. Unknown request (has id): error.
            _ if id.is_null() => None,
            _ => Some(error_response(&id, -32601, "method not found")),
        };

        if let Some(resp) = response {
            let mut bytes = serde_json::to_vec(&resp).unwrap_or_default();
            bytes.push(b'\n');
            writer.write_all(&bytes).await?;
            writer.flush().await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed `input` through the server with a fixed decision, returning each response line
    /// parsed as JSON (notifications produce no line).
    async fn drive(input: &str, allow: bool) -> Vec<Value> {
        let reader = std::io::Cursor::new(input.to_string().into_bytes());
        let mut out: Vec<u8> = Vec::new();
        run_stdio_server(reader, &mut out, |_call: ToolCall| async move {
            if allow {
                ApprovalDecision::allow()
            } else {
                ApprovalDecision::deny("user denied")
            }
        })
        .await
        .unwrap();
        String::from_utf8(out)
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn initialize_then_tools_list_are_answered_in_order() {
        let input = concat!(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
            "\n",
        );
        let responses = drive(input, true).await;
        // The notification produced no response, so only two lines.
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["id"], 1);
        assert_eq!(responses[0]["result"]["serverInfo"]["name"], "kineloop");
        assert_eq!(responses[1]["id"], 2);
        assert_eq!(responses[1]["result"]["tools"][0]["name"], "approve");
    }

    #[tokio::test]
    async fn tools_call_allow_returns_the_allow_decision() {
        let input = concat!(
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Bash","input":{"command":"ls"}}}}"#,
            "\n",
        );
        let responses = drive(input, true).await;
        assert_eq!(responses.len(), 1);
        let text = responses[0]["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        let decision: Value = serde_json::from_str(text).unwrap();
        assert_eq!(decision["behavior"], "allow");
        assert_eq!(decision["updatedInput"], json!({ "command": "ls" }));
    }

    #[tokio::test]
    async fn tools_call_deny_returns_a_deny_decision_with_message() {
        let input = concat!(
            r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Bash","input":{"command":"rm -rf x"}}}}"#,
            "\n",
        );
        let responses = drive(input, false).await;
        let text = responses[0]["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        let decision: Value = serde_json::from_str(text).unwrap();
        assert_eq!(decision["behavior"], "deny");
        assert_eq!(decision["message"], "user denied");
    }

    #[tokio::test]
    async fn unknown_method_yields_method_not_found_and_junk_is_skipped() {
        let input = concat!(
            "not json at all\n",
            r#"{"jsonrpc":"2.0","id":9,"method":"resources/list","params":{}}"#,
            "\n",
        );
        let responses = drive(input, true).await;
        assert_eq!(
            responses.len(),
            1,
            "junk line skipped, only the request answered"
        );
        assert_eq!(responses[0]["id"], 9);
        assert_eq!(responses[0]["error"]["code"], -32601);
    }
}

//! Unix-domain-socket bridge between the MCP approval-server subprocess and the running app.
//!
//! The MCP permission server runs as a subprocess Claude spawns (it owns Claude's stdio), so
//! it can't reach the app's in-memory [`ApprovalRegistry`]/[`SessionEmitters`] directly. This
//! module is the channel: the app [`serve`]s a socket; the subprocess [`request_decision`]s
//! over it. The subprocess opens a fresh connection per gated tool call (no multiplexing to
//! get wrong), sends `{ sessionId, tool, input }`, and blocks reading the `{ allow, message }`
//! reply, which the app writes once the user answers.
//!
//! Unix only for now (`tokio::net::Unix*`). Windows named-pipe support is a documented TODO;
//! the approval feature is off by default, so Windows simply doesn't offer it until then.

#![cfg(unix)]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use super::mcp::ToolCall;
use super::{request_approval, ApprovalDecision, ApprovalRegistry, SessionEmitters};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecisionRequest {
    session_id: String,
    tool: String,
    input: Value,
}

#[derive(Serialize, Deserialize)]
struct DecisionReply {
    allow: bool,
    message: Option<String>,
}

/// Serve approval requests on `path` until the future is dropped (app side). Clears any stale
/// socket left by a prior crash, then accepts connections; each carries one request, run
/// through [`request_approval`] (surfaces `ApprovalNeeded`, awaits the user) and answered.
///
/// Connections are handled inline (not spawned): within a session Claude issues tool calls
/// sequentially, so one-at-a-time is correct, and it keeps the borrow simple so the caller's
/// `select!` can cancel the whole server cleanly when the run ends.
pub async fn serve(
    path: PathBuf,
    registry: &ApprovalRegistry,
    emitters: &SessionEmitters,
) -> std::io::Result<()> {
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    loop {
        let (stream, _) = listener.accept().await?;
        if let Err(e) = handle_conn(stream, registry, emitters).await {
            eprintln!("approval socket connection error: {e}");
        }
    }
}

async fn handle_conn(
    stream: UnixStream,
    registry: &ApprovalRegistry,
    emitters: &SessionEmitters,
) -> std::io::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();
    let Some(line) = lines.next_line().await? else {
        return Ok(());
    };
    let Ok(req) = serde_json::from_str::<DecisionRequest>(&line) else {
        return Ok(()); // ignore a malformed request rather than crash the task
    };
    let decision =
        request_approval(registry, emitters, &req.session_id, &req.tool, &req.input).await;
    let reply = DecisionReply {
        allow: decision.allow,
        message: decision.message,
    };
    let mut bytes = serde_json::to_vec(&reply).unwrap_or_default();
    bytes.push(b'\n');
    write_half.write_all(&bytes).await?;
    write_half.flush().await?;
    Ok(())
}

/// From the MCP server subprocess: ask the app to decide a gated tool call. Connects to the
/// app's socket, sends the request, reads the reply. Any IO error fails closed (deny), so a
/// broken bridge can never let a tool run unapproved.
pub async fn request_decision(path: &Path, session_id: &str, call: &ToolCall) -> ApprovalDecision {
    match request_decision_inner(path, session_id, call).await {
        Ok(decision) => decision,
        Err(e) => ApprovalDecision::deny(format!("approval bridge unavailable: {e}")),
    }
}

async fn request_decision_inner(
    path: &Path,
    session_id: &str,
    call: &ToolCall,
) -> std::io::Result<ApprovalDecision> {
    let stream = UnixStream::connect(path).await?;
    let (read_half, mut write_half) = stream.into_split();
    let req = DecisionRequest {
        session_id: session_id.to_string(),
        tool: call.tool_name.clone(),
        input: call.input.clone(),
    };
    let mut bytes = serde_json::to_vec(&req).unwrap_or_default();
    bytes.push(b'\n');
    write_half.write_all(&bytes).await?;
    write_half.flush().await?;

    let mut lines = BufReader::new(read_half).lines();
    let line = lines.next_line().await?.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "no reply from app")
    })?;
    let reply: DecisionReply = serde_json::from_str(&line)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok(ApprovalDecision {
        allow: reply.allow,
        selected_option_id: Some(if reply.allow {
            "allow".to_string()
        } else {
            "deny".to_string()
        }),
        message: reply.message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::AgentEvent;
    use std::sync::Arc;

    #[tokio::test]
    async fn socket_roundtrip_surfaces_and_returns_a_decision() {
        let dir = std::env::temp_dir().join(format!("kine-agent-approval-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.sock");

        let registry = Arc::new(ApprovalRegistry::new());
        let emitters = Arc::new(SessionEmitters::new());
        // Stand in for the UI: when a request is surfaced, answer it (deny with a reason).
        let reg_for_ui = registry.clone();
        emitters.register(
            "s1",
            Arc::new(move |ev| {
                if let AgentEvent::ApprovalNeeded { request_id, .. } = ev {
                    let reg = reg_for_ui.clone();
                    tokio::spawn(async move {
                        reg.resolve("s1", &request_id, ApprovalDecision::deny("nope"));
                    });
                }
            }),
        );

        let serve_path = path.clone();
        let (sreg, sem) = (registry.clone(), emitters.clone());
        let server = tokio::spawn(async move {
            let _ = serve(serve_path, &sreg, &sem).await;
        });

        // Wait for the socket to exist, then act as the subprocess would.
        while !path.exists() {
            tokio::task::yield_now().await;
        }
        let call = ToolCall {
            tool_name: "Bash".into(),
            input: serde_json::json!({ "command": "ls" }),
        };
        let decision = request_decision(&path, "s1", &call).await;
        assert!(!decision.allow);
        assert_eq!(decision.message.as_deref(), Some("nope"));

        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn request_decision_fails_closed_when_the_socket_is_absent() {
        let path = std::env::temp_dir().join("kine-agent-approval-nonexistent.sock");
        let _ = std::fs::remove_file(&path);
        let call = ToolCall {
            tool_name: "Bash".into(),
            input: serde_json::json!({}),
        };
        let decision = request_decision(&path, "s1", &call).await;
        assert!(!decision.allow, "no socket => deny, never allow");
    }
}

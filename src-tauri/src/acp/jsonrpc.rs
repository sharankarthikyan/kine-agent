//! Minimal newline-delimited JSON-RPC 2.0 peer for ACP.
//!
//! One JSON object per line ("Messages are delimited by newlines and MUST NOT
//! contain embedded newlines" — ACP transports spec). Hand-rolled instead of the
//! official `agent-client-protocol` crate because that crate is `!Send`
//! (Rc + LocalSet) and our `AgentAdapter::run` future must be `Send`.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    #[error("agent returned error {code}: {message}")]
    Remote { code: i64, message: String },
    #[error("connection closed before response")]
    Closed,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// A message initiated by the agent side: a request we must answer, or a notification.
#[derive(Debug)]
pub enum Inbound {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

/// One side of an ndjson JSON-RPC connection. Cheap to clone.
#[derive(Clone)]
pub struct RpcPeer {
    writer: Arc<tokio::sync::Mutex<Box<dyn AsyncWrite + Unpin + Send>>>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    inbound_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<Inbound>>>>,
}

impl RpcPeer {
    /// Start the peer: spawns the reader task routing incoming lines.
    pub fn start(
        read: impl AsyncRead + Unpin + Send + 'static,
        write: impl AsyncWrite + Unpin + Send + 'static,
    ) -> Self {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
        let reader_pending = Arc::clone(&pending);
        tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                route_line(&line, &reader_pending, &inbound_tx);
            }
            // EOF: fail every still-pending request so callers don't hang.
            let mut map = reader_pending.lock().unwrap_or_else(|p| p.into_inner());
            for (_, tx) in map.drain() {
                let _ = tx.send(Err(RpcError::Closed));
            }
        });
        Self {
            writer: Arc::new(tokio::sync::Mutex::new(Box::new(write))),
            pending,
            next_id: Arc::new(AtomicU64::new(1)),
            inbound_rx: Arc::new(Mutex::new(Some(inbound_rx))),
        }
    }

    /// Take the inbound stream (requests + notifications from the agent). Call once.
    pub fn inbound(&self) -> mpsc::UnboundedReceiver<Inbound> {
        self.inbound_rx
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
            .expect("RpcPeer::inbound() may only be taken once")
    }

    /// Send a request; resolves with the matched response's `result`.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, tx);
        let msg =
            serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(e) = self.write_line(&msg).await {
            // Writing failed: nobody will ever answer, so drop the pending slot.
            // (The reader task only drains entries present at EOF time; this one
            // may have been inserted after that drain.)
            self.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            // A broken pipe means the agent went away — report it as Closed so
            // callers see one consistent "connection is gone" error.
            return Err(match e {
                RpcError::Io(io_err)
                    if matches!(
                        io_err.kind(),
                        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof
                    ) =>
                {
                    RpcError::Closed
                }
                other => other,
            });
        }
        rx.await.map_err(|_| RpcError::Closed)?
    }

    /// Send a notification (no response expected).
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        self.write_line(&serde_json::json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .await
    }

    /// Answer an inbound request from the agent.
    pub async fn respond(&self, id: Value, result: Value) -> Result<(), RpcError> {
        self.write_line(&serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result}))
            .await
    }

    /// Reject an inbound request from the agent.
    pub async fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<(), RpcError> {
        self.write_line(&serde_json::json!({
            "jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}
        }))
        .await
    }

    async fn write_line(&self, msg: &Value) -> Result<(), RpcError> {
        let mut line = msg.to_string();
        line.push('\n');
        let mut w = self.writer.lock().await;
        w.write_all(line.as_bytes()).await?;
        w.flush().await?;
        Ok(())
    }
}

/// Route one incoming line: a response (has `id`, no `method`) resolves a pending
/// request; a request (has both) or notification (method only) goes to the inbound
/// channel. Anything unparseable is logged and skipped — never fatal.
fn route_line(line: &str, pending: &Pending, inbound: &mpsc::UnboundedSender<Inbound>) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            let preview: String = line.chars().take(200).collect();
            eprintln!("acp: skipping malformed line: {preview}");
            return;
        }
    };
    let method = v.get("method").and_then(Value::as_str);
    let id = v.get("id").cloned();
    match (method, id) {
        // Response to one of our requests.
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else { return };
            let tx = pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            if let Some(tx) = tx {
                let outcome = if let Some(err) = v.get("error") {
                    Err(RpcError::Remote {
                        code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                        message: err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown error")
                            .to_string(),
                    })
                } else {
                    Ok(v.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(outcome);
            }
        }
        // Request from the agent — must be answered by the consumer.
        (Some(m), Some(id)) => {
            let _ = inbound.send(Inbound::Request {
                id,
                method: m.to_string(),
                params: v.get("params").cloned().unwrap_or(Value::Null),
            });
        }
        // Notification.
        (Some(m), None) => {
            let _ = inbound.send(Inbound::Notification {
                method: m.to_string(),
                params: v.get("params").cloned().unwrap_or(Value::Null),
            });
        }
        (None, None) => {}
    }
}

// Compile-time guarantee: the peer must be usable inside `Send` adapter futures.
#[allow(dead_code)]
fn _assert_peer_is_send() {
    fn assert_send<T: Send>() {}
    assert_send::<RpcPeer>();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader};

    /// Split a duplex: `peer` talks over one end; the test scripts the "agent" end.
    fn harness() -> (RpcPeer, tokio::io::DuplexStream) {
        let (ours, theirs) = duplex(64 * 1024);
        let (read_half, write_half) = tokio::io::split(ours);
        let peer = RpcPeer::start(read_half, write_half);
        (peer, theirs)
    }

    #[tokio::test]
    async fn request_resolves_with_matching_id_result() {
        let (peer, agent) = harness();
        let (r, mut agent_tx) = tokio::io::split(agent);
        let mut agent_rx = BufReader::new(r).lines();
        let fut = peer.request("initialize", serde_json::json!({"protocolVersion": 1}));
        let agent_task = tokio::spawn(async move {
            let line = agent_rx.next_line().await.unwrap().unwrap();
            let req: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(req["method"], "initialize");
            let resp =
                serde_json::json!({"jsonrpc": "2.0", "id": req["id"], "result": {"ok": true}});
            agent_tx
                .write_all(format!("{resp}\n").as_bytes())
                .await
                .unwrap();
        });
        let result = fut.await.unwrap();
        assert_eq!(result["ok"], true);
        agent_task.await.unwrap();
    }

    #[tokio::test]
    async fn inbound_request_and_notification_reach_the_channel() {
        let (peer, agent) = harness();
        let (_r, mut agent_tx) = tokio::io::split(agent);
        let mut inbound = peer.inbound();
        agent_tx
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"n\":1}}\n")
            .await
            .unwrap();
        agent_tx
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"session/request_permission\",\"params\":{}}\n",
            )
            .await
            .unwrap();
        match inbound.recv().await.unwrap() {
            Inbound::Notification { method, .. } => assert_eq!(method, "session/update"),
            other => panic!("expected notification, got {other:?}"),
        }
        match inbound.recv().await.unwrap() {
            Inbound::Request { id, method, .. } => {
                assert_eq!(method, "session/request_permission");
                assert_eq!(id, serde_json::json!(7));
            }
            other => panic!("expected request, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn malformed_lines_are_skipped_not_fatal() {
        let (peer, agent) = harness();
        let (_r, mut agent_tx) = tokio::io::split(agent);
        let mut inbound = peer.inbound();
        agent_tx.write_all(b"not json at all\n").await.unwrap();
        agent_tx
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{}}\n")
            .await
            .unwrap();
        assert!(matches!(
            inbound.recv().await.unwrap(),
            Inbound::Notification { .. }
        ));
    }

    #[tokio::test]
    async fn error_response_rejects_the_pending_request() {
        let (peer, agent) = harness();
        let (r, mut agent_tx) = tokio::io::split(agent);
        let mut agent_rx = BufReader::new(r).lines();
        let fut = peer.request("x", serde_json::json!({}));
        let agent_task = tokio::spawn(async move {
            let line = agent_rx.next_line().await.unwrap().unwrap();
            let req: serde_json::Value = serde_json::from_str(&line).unwrap();
            let resp = serde_json::json!({
                "jsonrpc": "2.0", "id": req["id"],
                "error": {"code": -32601, "message": "method not found"}
            });
            agent_tx
                .write_all(format!("{resp}\n").as_bytes())
                .await
                .unwrap();
        });
        let err = fut.await.unwrap_err();
        assert!(err.to_string().contains("method not found"));
        agent_task.await.unwrap();
    }

    #[tokio::test]
    async fn eof_fails_pending_requests_instead_of_hanging() {
        let (peer, agent) = harness();
        let fut = peer.request("x", serde_json::json!({}));
        drop(agent); // close the connection with the request outstanding
        let err = fut.await.unwrap_err();
        assert!(matches!(err, RpcError::Closed));
    }
}

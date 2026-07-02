//! Minimal newline-delimited JSON-RPC 2.0 peer for ACP.
//!
//! One JSON object per line ("Messages are delimited by newlines and MUST NOT
//! contain embedded newlines" — ACP transports spec). Hand-rolled instead of the
//! official `agent-client-protocol` crate because that crate is `!Send`
//! (Rc + LocalSet) and our `AgentAdapter::run` future must be `Send`.

use crate::adapters::{read_capped_line, CappedLine, MAX_LINE_BYTES};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    #[error("agent returned error {code}: {message}")]
    Remote { code: i64, message: String },
    /// The transport is gone in some form: the reader hit EOF and drained this
    /// pending request, the post-EOF half-closed guard rejected the request, or
    /// a write hit a broken pipe / unexpected EOF (agent process died).
    #[error("connection closed before response")]
    Closed,
    /// The agent answered, but the response is missing a field the protocol
    /// requires (e.g. session/new without a sessionId).
    #[error("protocol violation: {0}")]
    Protocol(String),
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

/// Pending requests keyed by the id's canonical JSON encoding (`Value::to_string()`),
/// not by u64: JSON-RPC ids may be strings or floats, and a response echoing a
/// non-u64 id must still resolve its caller instead of leaking the oneshot.
/// Outbound ids stay numeric (`AtomicU64`); only the key representation is textual.
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, RpcError>>>>>;

/// One side of an ndjson JSON-RPC connection. Cheap to clone.
#[derive(Clone)]
pub struct RpcPeer {
    writer: Arc<tokio::sync::Mutex<Box<dyn AsyncWrite + Unpin + Send>>>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    inbound_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<Inbound>>>>,
    /// Set once the reader hits EOF. Guards the half-closed transport case: the
    /// agent's stdout is gone but its stdin still accepts writes, so a request
    /// issued after the EOF drain would write fine and then wait forever.
    closed: Arc<std::sync::atomic::AtomicBool>,
}

impl RpcPeer {
    /// Start the peer: spawns the reader task routing incoming lines.
    ///
    /// Reader-task lifecycle: the task exits only when the transport reaches EOF
    /// or a read error occurs. Dropping `RpcPeer` clones does NOT abort it. The
    /// owning adapter must kill the child process — closing its stdout and
    /// producing EOF — to end the task.
    pub fn start(
        read: impl AsyncRead + Unpin + Send + 'static,
        write: impl AsyncWrite + Unpin + Send + 'static,
    ) -> Self {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        // Unbounded inbound channel is deliberate for M1: the single consumer
        // (the adapter's event loop) drains it promptly, so it can't grow without
        // bound in practice. Revisit if a slow approval UI ever backs it up.
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
        let reader_pending = Arc::clone(&pending);
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader_closed = Arc::clone(&closed);
        // Created before the reader task is spawned so the reader can answer
        // oversized inbound requests inline instead of leaving them dangling.
        let writer: Arc<tokio::sync::Mutex<Box<dyn AsyncWrite + Unpin + Send>>> =
            Arc::new(tokio::sync::Mutex::new(Box::new(write)));
        let reader_writer = Arc::clone(&writer);
        tokio::spawn(async move {
            let mut reader = BufReader::new(read);
            loop {
                // Per-line size cap: a pathological line (huge embedded blob) is
                // skipped rather than buffered unbounded — never fatal.
                match read_capped_line(&mut reader, MAX_LINE_BYTES).await {
                    Ok(CappedLine::Eof) => break,
                    Ok(CappedLine::Skipped { total, head }) => {
                        eprintln!("acp: skipped an oversized stdout line ({total} bytes)");
                        handle_oversized(
                            &String::from_utf8_lossy(&head),
                            total,
                            &reader_pending,
                            &reader_writer,
                        )
                        .await;
                    }
                    Ok(CappedLine::Line(buf)) => {
                        let line = String::from_utf8_lossy(&buf);
                        route_line(&line, &reader_pending, &inbound_tx);
                    }
                    Err(e) => {
                        eprintln!("acp: transport read error: {e}");
                        break;
                    }
                }
            }
            // EOF/read error: mark closed FIRST, then fail every still-pending request. A
            // request that checks `closed` after inserting therefore either sees
            // the flag or has its entry drained here — no window to hang in.
            reader_closed.store(true, Ordering::SeqCst);
            let mut map = reader_pending.lock().unwrap_or_else(|p| p.into_inner());
            for (_, tx) in map.drain() {
                let _ = tx.send(Err(RpcError::Closed));
            }
        });
        Self {
            writer,
            pending,
            next_id: Arc::new(AtomicU64::new(1)),
            inbound_rx: Arc::new(Mutex::new(Some(inbound_rx))),
            closed,
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
        // Key by the id's canonical JSON encoding so route_line can match the raw
        // echoed id Value regardless of its JSON type (see `Pending`).
        let key = Value::from(id).to_string();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key.clone(), tx);
        let msg =
            serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(e) = self.write_line(&msg).await {
            // Writing failed: nobody will ever answer, so drop the pending slot.
            // (The reader task only drains entries present at EOF time; this one
            // may have been inserted after that drain.)
            self.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&key);
            return Err(e);
        }
        // Half-closed guard: if the reader already hit EOF, its drain may have run
        // before our insert — nothing would ever resolve this slot even though the
        // write succeeded. Checked AFTER insert to pair with the drain's store-then-
        // drain ordering above.
        if self.closed.load(Ordering::SeqCst) {
            self.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&key);
            return Err(RpcError::Closed);
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

    /// Write one ndjson line. A broken pipe / unexpected EOF means the agent went
    /// away — normalized to [`RpcError::Closed`] here so `request`, `notify`,
    /// `respond`, and `respond_error` all report the same "connection is gone" error.
    async fn write_line(&self, msg: &Value) -> Result<(), RpcError> {
        write_line_to(&self.writer, msg).await.map_err(|io_err| {
            if matches!(
                io_err.kind(),
                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof
            ) {
                RpcError::Closed
            } else {
                RpcError::Io(io_err)
            }
        })
    }
}

/// Write one ndjson line to a shared writer. Raw IO — error normalization
/// (BrokenPipe → Closed) stays in [`RpcPeer::write_line`].
async fn write_line_to(
    writer: &tokio::sync::Mutex<Box<dyn AsyncWrite + Unpin + Send>>,
    msg: &Value,
) -> std::io::Result<()> {
    let mut line = msg.to_string();
    line.push('\n');
    let mut w = writer.lock().await;
    w.write_all(line.as_bytes()).await?;
    w.flush().await
}

/// Best-effort extraction of the top-level `id` and `method` from the retained
/// head of an oversized JSON-RPC line. Heuristic: JSON serializers emit keys in
/// insertion order, so the top-level `jsonrpc`/`id`/`method` keys precede the
/// oversized `params`/`result` payload — the first occurrence in the head is
/// the top-level one. The alternative to this heuristic is a guaranteed hang.
fn salvage_id_and_method(head: &str) -> (Option<Value>, Option<String>) {
    fn scalar_after(head: &str, key: &str) -> Option<Value> {
        let pos = head.find(key)?;
        let rest = head[pos + key.len()..].trim_start();
        let rest = rest.strip_prefix(':')?.trim_start();
        serde_json::Deserializer::from_str(rest)
            .into_iter::<Value>()
            .next()?
            .ok()
    }
    // Only scalar ids are trustworthy; anything else means the match landed
    // inside nested payload text.
    let id = scalar_after(head, "\"id\"").filter(|v| v.is_number() || v.is_string());
    let method =
        scalar_after(head, "\"method\"").and_then(|v| v.as_str().map(str::to_string));
    (id, method)
}

/// An oversized line was dropped — do NOT leave the protocol hanging. A salvaged
/// request gets an error answer; a salvaged response fails its pending request;
/// an unsalvageable line is logged and skipped (the pre-M5 behavior).
async fn handle_oversized(
    head: &str,
    total: usize,
    pending: &Pending,
    writer: &tokio::sync::Mutex<Box<dyn AsyncWrite + Unpin + Send>>,
) {
    match salvage_id_and_method(head) {
        (Some(id), Some(method)) => {
            eprintln!("acp: answering oversized {method} request (id {id}) with an error");
            let msg = serde_json::json!({
                "jsonrpc": "2.0", "id": id,
                "error": {"code": -32600, "message": format!(
                    "message exceeds the {} MiB line limit ({total} bytes)",
                    MAX_LINE_BYTES / (1024 * 1024)
                )}
            });
            if let Err(e) = write_line_to(writer, &msg).await {
                eprintln!("acp: failed to answer oversized request: {e}");
            }
        }
        (Some(id), None) => {
            // A response to one of our requests, too big to parse.
            let key = id.to_string();
            let tx = pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&key);
            if let Some(tx) = tx {
                let _ = tx.send(Err(RpcError::Protocol(format!(
                    "oversized response dropped ({total} bytes)"
                ))));
            }
        }
        _ => eprintln!("acp: oversized line was unsalvageable — no id/method in its head"),
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
        // Response to one of our requests. Match by the raw id's canonical JSON
        // encoding — ids may be strings or floats, not just u64 (see `Pending`).
        (None, Some(id)) => {
            let key = id.to_string();
            let tx = pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&key);
            let Some(tx) = tx else {
                eprintln!("acp: response for unknown id {key}");
                return;
            };
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
    async fn out_of_order_responses_resolve_their_own_requests() {
        let (peer, agent) = harness();
        let (r, mut agent_tx) = tokio::io::split(agent);
        let mut agent_rx = BufReader::new(r).lines();
        let first = peer.request("one", serde_json::json!({}));
        let second = peer.request("two", serde_json::json!({}));
        let agent_task = tokio::spawn(async move {
            // Read BOTH request lines, then answer the second id first.
            let line_a = agent_rx.next_line().await.unwrap().unwrap();
            let line_b = agent_rx.next_line().await.unwrap().unwrap();
            let req_a: serde_json::Value = serde_json::from_str(&line_a).unwrap();
            let req_b: serde_json::Value = serde_json::from_str(&line_b).unwrap();
            for req in [&req_b, &req_a] {
                let resp = serde_json::json!({
                    "jsonrpc": "2.0", "id": req["id"],
                    "result": {"for": req["method"]}
                });
                agent_tx
                    .write_all(format!("{resp}\n").as_bytes())
                    .await
                    .unwrap();
            }
        });
        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.unwrap()["for"], "one");
        assert_eq!(second.unwrap()["for"], "two");
        agent_task.await.unwrap();
    }

    #[tokio::test]
    async fn route_line_matches_string_ids_via_canonical_key() {
        // Outbound ids are always numeric, so pin the key normalization directly:
        // a pending entry stored under the canonical JSON encoding of a STRING id
        // must be resolved by a response echoing that id.
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (inbound_tx, _inbound_rx) = mpsc::unbounded_channel();
        let (tx, rx) = oneshot::channel();
        pending
            .lock()
            .unwrap()
            .insert("\"abc\"".to_string(), tx);
        route_line(
            "{\"jsonrpc\":\"2.0\",\"id\":\"abc\",\"result\":{\"ok\":true}}",
            &pending,
            &inbound_tx,
        );
        let result = rx.await.expect("oneshot must resolve").unwrap();
        assert_eq!(result["ok"], true);
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn eof_fails_pending_requests_instead_of_hanging() {
        let (peer, agent) = harness();
        let fut = peer.request("x", serde_json::json!({}));
        drop(agent); // close the connection with the request outstanding
        let err = fut.await.unwrap_err();
        assert!(matches!(err, RpcError::Closed));
    }

    #[test]
    fn salvages_id_and_method_from_truncated_head() {
        let head = r#"{"jsonrpc":"2.0","id":5,"method":"fs/write_text_file","params":{"sessionId":"s","path":"/w/big.txt","content":"AAAAAA"#;
        let (id, method) = salvage_id_and_method(head);
        assert_eq!(id, Some(serde_json::json!(5)));
        assert_eq!(method.as_deref(), Some("fs/write_text_file"));

        // Response shape: id but no method.
        let head = r#"{"jsonrpc":"2.0","id":12,"result":{"content":"AAAA"#;
        let (id, method) = salvage_id_and_method(head);
        assert_eq!(id, Some(serde_json::json!(12)));
        assert_eq!(method, None);

        // String ids survive; unsalvageable garbage yields (None, None).
        let (id, _) = salvage_id_and_method(r#"{"id":"abc","method":"m"#);
        assert_eq!(id, Some(serde_json::json!("abc")));
        assert_eq!(salvage_id_and_method("garbage no json"), (None, None));
    }

    #[tokio::test]
    async fn oversized_inbound_request_is_answered_with_an_error_not_dropped() {
        let (peer, agent) = harness();
        let (r, mut agent_tx) = tokio::io::split(agent);
        let mut agent_rx = BufReader::new(r).lines();
        let _inbound = peer.inbound();
        // A request whose params blob blows the 8 MiB line cap.
        let blob = "A".repeat(MAX_LINE_BYTES + 1024);
        let line = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"fs/write_text_file\",\"params\":{{\"content\":\"{blob}\"}}}}\n"
        );
        let writer_task = tokio::spawn(async move {
            agent_tx.write_all(line.as_bytes()).await.unwrap();
            agent_tx
        });
        // The peer must ANSWER id 5 with an error instead of dropping it silently.
        let ans: serde_json::Value =
            serde_json::from_str(&agent_rx.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(ans["id"], 5);
        assert_eq!(ans["error"]["code"], -32600);
        assert!(ans["error"]["message"].as_str().unwrap().contains("line limit"));
        // The transport stays alive: a normal follow-up line still routes.
        let mut agent_tx = writer_task.await.unwrap();
        agent_tx
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{}}\n")
            .await
            .unwrap();
        drop(agent_tx);
    }

    #[tokio::test]
    async fn oversized_response_fails_its_pending_request_instead_of_hanging() {
        let (peer, agent) = harness();
        let (r, mut agent_tx) = tokio::io::split(agent);
        let mut agent_rx = BufReader::new(r).lines();
        let fut = peer.request("x", serde_json::json!({}));
        let agent_task = tokio::spawn(async move {
            let line = agent_rx.next_line().await.unwrap().unwrap();
            let req: serde_json::Value = serde_json::from_str(&line).unwrap();
            let blob = "A".repeat(MAX_LINE_BYTES + 1024);
            let resp = format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{{\"content\":\"{blob}\"}}}}\n",
                req["id"]
            );
            agent_tx.write_all(resp.as_bytes()).await.unwrap();
        });
        let err = tokio::time::timeout(std::time::Duration::from_secs(10), fut)
            .await
            .expect("must not hang")
            .unwrap_err();
        assert!(matches!(err, RpcError::Protocol(_)), "got {err:?}");
        agent_task.await.unwrap();
    }

    #[tokio::test]
    async fn request_on_half_closed_transport_returns_closed_instead_of_hanging() {
        // Reads EOF immediately, but writes still succeed — the live equivalent is
        // an agent that closed stdout while its stdin stays open. The successful
        // write means the write-failure path can't save us; the closed flag must.
        let peer = RpcPeer::start(tokio::io::empty(), tokio::io::sink());
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            peer.request("x", serde_json::json!({})),
        )
        .await
        .expect("request must not hang on a half-closed transport");
        assert!(matches!(result.unwrap_err(), RpcError::Closed));
    }
}

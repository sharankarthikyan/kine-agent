use crate::adapter::{AgentAdapter, EventSink, Prompt, SessionError};
use crate::events::AgentEvent;
use serde_json::Value;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

/// Concrete adapter that drives the `claude` CLI.
pub struct ClaudeAdapter;

impl AgentAdapter for ClaudeAdapter {
    fn run(
        &self,
        prompt: Prompt,
        cwd: PathBuf,
        session_id: String,
        resume: bool,
        sink: Box<dyn EventSink>,
    ) -> impl std::future::Future<Output = Result<(), SessionError>> + Send {
        spawn_and_stream(prompt, cwd, session_id, resume, sink)
    }
}

/// Parse one JSON line from `claude --output-format stream-json` into zero or more AgentEvents.
///
/// Returns an empty Vec for blank lines, non-JSON input, unknown event types, or system/init
/// lines — never panics on malformed agent output. An assistant message with multiple content
/// blocks (e.g. text followed by tool_use) produces one event per parseable block.
pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    let line = line.trim();
    if line.is_empty() {
        return vec![];
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    match v.get("type").and_then(Value::as_str) {
        Some("assistant") => parse_assistant(&v),
        Some("result") => {
            let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            let text = v.get("result").and_then(Value::as_str).unwrap_or("").to_string();
            if is_error {
                vec![AgentEvent::Error { message: text }]
            } else {
                vec![AgentEvent::Done { summary: text }]
            }
        }
        _ => vec![], // system/init and anything else: ignore in the skeleton
    }
}

fn parse_assistant(v: &Value) -> Vec<AgentEvent> {
    let blocks = match v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    {
        Some(b) => b,
        None => return vec![],
    };
    blocks
        .iter()
        .filter_map(|block| match block.get("type").and_then(Value::as_str)? {
            "text" => Some(AgentEvent::Token {
                text: block.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
            }),
            "tool_use" => Some(AgentEvent::ToolCall {
                name: block.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                // `input` is stored as compact JSON text (objects/arrays serialized).
                input: block.get("input").map(|i| i.to_string()).unwrap_or_default(),
            }),
            _ => None,
        })
        .collect()
}

/// Spawn `claude` headless, read stdout line-by-line, emit parsed events.
pub async fn spawn_and_stream(
    prompt: Prompt,
    cwd: PathBuf,
    session_id: String,
    resume: bool,
    sink: Box<dyn EventSink>,
) -> Result<(), SessionError> {
    let mut command = Command::new("claude");
    command
        .arg("-p")
        .arg(&prompt.text)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose");
    if resume {
        command.arg("--resume").arg(&session_id);
    } else {
        command.arg("--session-id").arg(&session_id);
    }
    let mut child = command
        .current_dir(&cwd)
        // Close stdin: claude otherwise waits ~3s for piped stdin before proceeding.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // If this future is dropped (e.g. cancelled), kill the child instead of leaking it.
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| SessionError::Spawn(e.to_string()))?;

    let stdout = child.stdout.take().ok_or_else(|| SessionError::Spawn("no stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| SessionError::Spawn("no stderr".into()))?;

    // Drain stderr concurrently on a separate task. Without this, claude --verbose can
    // write >64KB to stderr, fill the OS pipe buffer, block on write, and stop producing
    // stdout — causing the stdout loop below to hang forever.
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut buf).await;
        // Retain only the last 20 lines as a bounded diagnostic tail.
        let lines: Vec<&str> = buf.lines().collect();
        let start = lines.len().saturating_sub(20);
        lines[start..].join("\n")
    });

    let mut lines = BufReader::new(stdout).lines();

    while let Some(line) = lines.next_line().await? {
        for event in parse_line(&line) {
            sink.emit(event);
        }
        // Unparsed lines are intentionally skipped (logged by caller if needed).
    }

    // Collect stderr tail before waiting on the child so the pipe is fully drained.
    let stderr_tail = stderr_task.await.unwrap_or_default();

    let status = child.wait().await?;
    if !status.success() {
        let message = if stderr_tail.trim().is_empty() {
            format!("claude exited with {status}")
        } else {
            format!("claude exited with {status}: {}", stderr_tail.trim())
        };
        sink.emit(AgentEvent::Error { message });
    }
    Ok(())
}

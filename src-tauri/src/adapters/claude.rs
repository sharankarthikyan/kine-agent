use crate::adapter::{EventSink, Prompt, SessionError};
use crate::events::AgentEvent;
use serde_json::Value;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Parse one line of `claude --output-format stream-json` into an AgentEvent.
/// Returns None for blank lines, unknown types, or non-JSON (never panics).
pub fn parse_line(line: &str) -> Option<AgentEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    match v.get("type")?.as_str()? {
        "assistant" => parse_assistant(&v),
        "result" => Some(AgentEvent::Done {
            summary: v.get("result").and_then(Value::as_str).unwrap_or("").to_string(),
        }),
        _ => None, // system/init and anything else: ignore in the skeleton
    }
}

fn parse_assistant(v: &Value) -> Option<AgentEvent> {
    // Skeleton limitation: only the first content block is mapped. Real assistant
    // messages can carry multiple blocks (e.g. text + tool_use); the rest are
    // dropped here. Task 6 reconciles this against recorded real CLI output.
    let block = v.get("message")?.get("content")?.as_array()?.first()?;
    match block.get("type")?.as_str()? {
        "text" => Some(AgentEvent::Token {
            text: block.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
        }),
        "tool_use" => Some(AgentEvent::ToolCall {
            name: block.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            // `input` is stored as compact JSON text (objects/arrays serialized).
            input: block.get("input").map(|i| i.to_string()).unwrap_or_default(),
        }),
        _ => None,
    }
}

/// Spawn `claude` headless, read stdout line-by-line, emit parsed events.
pub async fn spawn_and_stream(
    prompt: Prompt,
    cwd: PathBuf,
    sink: Box<dyn EventSink>,
) -> Result<(), SessionError> {
    let mut child = Command::new("claude")
        .arg("-p")
        .arg(&prompt.text)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .current_dir(&cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| SessionError::Spawn(e.to_string()))?;

    let stdout = child.stdout.take().ok_or_else(|| SessionError::Spawn("no stdout".into()))?;
    let mut lines = BufReader::new(stdout).lines();

    while let Some(line) = lines.next_line().await? {
        if let Some(event) = parse_line(&line) {
            sink.emit(event);
        }
        // Unparsed lines are intentionally skipped (logged by caller if needed).
    }

    let status = child.wait().await?;
    if !status.success() {
        sink.emit(AgentEvent::Error {
            message: format!("claude exited with {status}"),
        });
    }
    Ok(())
}

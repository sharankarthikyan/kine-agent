use crate::adapter::{AgentAdapter, EventSink, Prompt, SessionError};
use crate::events::AgentEvent;
use crate::adapters::{read_capped_line, CappedLine, MAX_LINE_BYTES};
use serde_json::Value;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, BufReader};
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
            let text = v
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let terminal = if is_error {
                AgentEvent::Error { message: text }
            } else {
                AgentEvent::Done { summary: text }
            };
            // Emit Usage before the terminal event when the result carries usage data.
            match parse_usage(&v) {
                Some(usage) => vec![usage, terminal],
                None => vec![terminal],
            }
        }
        _ => vec![], // system/init and anything else: ignore in the skeleton
    }
}

/// Extract a Usage event from a Claude `result` JSON object, if usage is present.
fn parse_usage(v: &Value) -> Option<AgentEvent> {
    let usage = v.get("usage")?;
    let n = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    Some(AgentEvent::Usage {
        input_tokens: n("input_tokens"),
        output_tokens: n("output_tokens"),
        cache_read_tokens: n("cache_read_input_tokens"),
        cache_creation_tokens: n("cache_creation_input_tokens"),
        cost_usd: v.get("total_cost_usd").and_then(|x| x.as_f64()),
        model: v.get("model").and_then(|x| x.as_str()).map(String::from),
    })
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
                text: block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            }),
            "tool_use" => Some(AgentEvent::ToolCall {
                name: block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                // `input` is stored as compact JSON text (objects/arrays serialized).
                input: block
                    .get("input")
                    .map(|i| i.to_string())
                    .unwrap_or_default(),
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
    // Extract model and permission_mode before building the command so borrows on prompt
    // fields don't conflict with each other. Both are forwarded verbatim; None omits the flag.
    // Valid model values: short aliases (e.g. "opus", "sonnet", "haiku", "fable") or a full
    // model id (e.g. "claude-opus-4-5"). Valid permission_mode values are checked
    // in the command layer before this adapter is invoked.
    let model = prompt.model.as_deref();
    let permission_mode = prompt.permission_mode.as_deref();

    // Resolve via PATHEXT so the Windows npm shim (`claude.cmd`) is found, not just
    // `claude.exe`; on Unix this resolves the absolute path (or falls back to the name).
    let mut command = Command::new(crate::agent_paths::resolve_program("claude"));
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
    if let Some(m) = model {
        command.arg("--model").arg(m);
    }
    if let Some(pm) = permission_mode {
        command.arg("--permission-mode").arg(pm);
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

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| SessionError::Spawn("no stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| SessionError::Spawn("no stderr".into()))?;

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

    // Read newline-delimited stream-json with a per-line size cap and lossy UTF-8 decode.
    // `read_capped_line` bounds memory against a pathological huge line and never aborts
    // on invalid UTF-8 (a single bad byte would otherwise kill the session); genuine IO
    // errors still propagate.
    let mut reader = BufReader::new(stdout);
    loop {
        match read_capped_line(&mut reader, MAX_LINE_BYTES).await? {
            CappedLine::Eof => break,
            CappedLine::Skipped(bytes) => {
                eprintln!("claude: skipped an oversized stdout line ({bytes} bytes)");
            }
            CappedLine::Line(buf) => {
                let line = String::from_utf8_lossy(&buf);
                for event in parse_line(&line) {
                    sink.emit(event);
                }
                // Unparsed lines are intentionally skipped (logged by caller if needed).
            }
        }
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
    } else if !stderr_tail.trim().is_empty() {
        // Exited cleanly but wrote to stderr (deprecations, auth-refresh notices, …).
        // Not an error event, but log it so a silently-misbehaving run is diagnosable.
        eprintln!("claude exited 0 with stderr: {}", stderr_tail.trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::Prompt;

    // ---- parse_line tests ----

    #[test]
    fn parse_blank_line_returns_empty() {
        assert!(parse_line("").is_empty());
        assert!(parse_line("   ").is_empty());
    }

    #[test]
    fn parse_non_json_returns_empty() {
        assert!(parse_line("not json").is_empty());
    }

    #[test]
    fn parse_result_ok_emits_done() {
        let line = r#"{"type":"result","is_error":false,"result":"all done"}"#;
        let events = parse_line(line);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], AgentEvent::Done { summary } if summary == "all done"));
    }

    #[test]
    fn parse_result_error_emits_error() {
        let line = r#"{"type":"result","is_error":true,"result":"boom"}"#;
        let events = parse_line(line);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], AgentEvent::Error { message } if message == "boom"));
    }

    #[test]
    fn parse_result_with_usage_emits_usage_then_done() {
        let line = r#"{
            "type": "result",
            "is_error": false,
            "result": "task complete",
            "usage": {
                "input_tokens": 512,
                "output_tokens": 128,
                "cache_read_input_tokens": 64,
                "cache_creation_input_tokens": 32
            },
            "total_cost_usd": 0.00123,
            "model": "claude-opus-4-5"
        }"#;
        let events = parse_line(line);
        assert_eq!(events.len(), 2, "expected [Usage, Done], got {events:?}");
        match &events[0] {
            AgentEvent::Usage {
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                cost_usd,
                model,
            } => {
                assert_eq!(*input_tokens, 512);
                assert_eq!(*output_tokens, 128);
                assert_eq!(*cache_read_tokens, 64);
                assert_eq!(*cache_creation_tokens, 32);
                assert!((cost_usd.unwrap() - 0.00123).abs() < f64::EPSILON);
                assert_eq!(model.as_deref(), Some("claude-opus-4-5"));
            }
            other => panic!("expected Usage, got {other:?}"),
        }
        assert!(
            matches!(&events[1], AgentEvent::Done { summary } if summary == "task complete"),
            "expected Done as second event, got {:?}",
            events[1]
        );
    }

    #[test]
    fn parse_result_without_usage_emits_only_done() {
        let line = r#"{"type":"result","is_error":false,"result":"all done"}"#;
        let events = parse_line(line);
        assert_eq!(events.len(), 1, "expected [Done] only, got {events:?}");
        assert!(matches!(&events[0], AgentEvent::Done { summary } if summary == "all done"));
    }

    #[test]
    fn parse_assistant_text_block_emits_token() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#;
        let events = parse_line(line);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], AgentEvent::Token { text } if text == "hello"));
    }

    // ---- model field on Prompt ----

    #[test]
    fn prompt_model_some_carries_through() {
        let p = Prompt {
            text: "build it".into(),
            model: Some("opus".into()),
            permission_mode: None,
        };
        assert_eq!(p.model.as_deref(), Some("opus"));
    }

    #[test]
    fn prompt_model_none_is_absent() {
        let p = Prompt {
            text: "build it".into(),
            model: None,
            permission_mode: None,
        };
        assert!(p.model.is_none());
    }

    // ---- permission_mode field on Prompt ----

    #[test]
    fn prompt_permission_mode_some_carries_through() {
        let p = Prompt {
            text: "build it".into(),
            model: None,
            permission_mode: Some("acceptEdits".into()),
        };
        assert_eq!(p.permission_mode.as_deref(), Some("acceptEdits"));
    }

    #[test]
    fn prompt_permission_mode_none_is_absent() {
        let p = Prompt {
            text: "build it".into(),
            model: None,
            permission_mode: None,
        };
        assert!(p.permission_mode.is_none());
    }
}

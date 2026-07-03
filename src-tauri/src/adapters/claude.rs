use crate::adapter::{AgentAdapter, EventSink, Prompt, SessionError};
use crate::adapters::{
    feed_prompt_via_stdin, is_batch_shim, read_capped_line, CappedLine, MAX_LINE_BYTES,
};
use crate::events::AgentEvent;
use serde_json::Value;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, BufReader};

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
    let input_tokens = n("input_tokens");
    let output_tokens = n("output_tokens");
    let cache_read_tokens = n("cache_read_input_tokens");
    let cache_creation_tokens = n("cache_creation_input_tokens");
    let cost_usd = v.get("total_cost_usd").and_then(|x| x.as_f64());
    // A result whose counts are all zero comes from a turn that made no API call
    // (e.g. /usage or /status handled locally by the CLI) — not a real sample.
    let all_zero = input_tokens == 0
        && output_tokens == 0
        && cache_read_tokens == 0
        && cache_creation_tokens == 0;
    if all_zero && cost_usd.unwrap_or(0.0) == 0.0 {
        return None;
    }
    Some(AgentEvent::Usage {
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        cost_usd,
        model: v.get("model").and_then(|x| x.as_str()).map(String::from),
        context_used: None,
        context_window: None,
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
                // Claude's tool_use.id exists but has no consumer yet (YAGNI) —
                // ToolStatus is ACP-only in M2.
                tool_call_id: None,
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
    // Extract model and permission mode before building the command so borrows on prompt
    // fields don't conflict. Valid model values: short aliases (e.g. "opus", "sonnet",
    // "haiku", "fable") or a full model id (e.g. "claude-opus-4-5"). The permission mode
    // was validated in the command layer; Claude supports every unified mode natively, so
    // it maps 1:1 to `--permission-mode` (`full` ⇒ `bypassPermissions`). An unrecognized
    // value maps to None, omitting the flag and deferring to the CLI default.
    let model = prompt.model.as_deref();
    let permission_mode = prompt
        .permission_mode
        .as_deref()
        .and_then(crate::permission::PermissionMode::from_wire);

    // Resolve via PATHEXT so the Windows npm shim (`claude.cmd`) is found, not just
    // `claude.exe`; on Unix this resolves the absolute path (or falls back to the name).
    let program = crate::agent_paths::resolve_program("claude");
    // On a Windows batch shim the prompt cannot be a CLI argument (Rust rejects `\r`/`\n`
    // args to `.cmd`/`.bat`), so a multi-line prompt is fed over stdin instead. `claude -p`
    // reads the prompt from stdin when no positional prompt is supplied.
    let prompt_via_stdin = is_batch_shim(&program);
    let mut command = crate::proc::tokio_command(&program);
    command.arg("-p");
    if !prompt_via_stdin {
        command.arg(&prompt.text);
    }
    command
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
    if let Some(mode) = permission_mode {
        command.arg("--permission-mode").arg(mode.claude_flag());
    }
    // Interactive approval (opt-in): route gated tool calls through Kineloop's permission
    // MCP server. `--mcp-config` merges our server with the user's own MCP config, so their
    // tools keep working. Absent by default, leaving the launch unchanged.
    if let Some(approval) = prompt.approval.as_ref() {
        command
            .arg("--permission-prompt-tool")
            .arg(&approval.tool)
            .arg("--mcp-config")
            .arg(&approval.mcp_config);
    }
    let stdin_cfg = if prompt_via_stdin {
        // The prompt is written to stdin below, then stdin is closed (EOF).
        std::process::Stdio::piped()
    } else {
        // Close stdin: claude otherwise waits ~3s for piped stdin before proceeding.
        std::process::Stdio::null()
    };
    let mut child = command
        .current_dir(&cwd)
        .stdin(stdin_cfg)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // If this future is dropped (e.g. cancelled), kill the child instead of leaking it.
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| SessionError::Spawn(e.to_string()))?;

    if prompt_via_stdin {
        if let Some(stdin) = child.stdin.take() {
            feed_prompt_via_stdin(stdin, prompt.text.clone());
        }
    }

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
            CappedLine::Skipped { total: bytes, .. } => {
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
                ..
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
    fn parse_result_with_all_zero_usage_emits_only_done() {
        // Local slash-command turns (/usage, /status) make no API call; the CLI still
        // reports a usage object with every count at zero. That is not a real sample.
        let line = r#"{
            "type": "result",
            "is_error": false,
            "result": "You are currently using your subscription",
            "usage": {
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0
            },
            "total_cost_usd": 0.0
        }"#;
        let events = parse_line(line);
        assert_eq!(events.len(), 1, "expected [Done] only, got {events:?}");
        assert!(matches!(&events[0], AgentEvent::Done { .. }));
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
            ..Default::default()
        };
        assert_eq!(p.model.as_deref(), Some("opus"));
    }

    #[test]
    fn prompt_model_none_is_absent() {
        let p = Prompt {
            text: "build it".into(),
            ..Default::default()
        };
        assert!(p.model.is_none());
    }

    // ---- permission_mode field on Prompt ----

    #[test]
    fn prompt_permission_mode_some_carries_through() {
        let p = Prompt {
            text: "build it".into(),
            permission_mode: Some("acceptEdits".into()),
            ..Default::default()
        };
        assert_eq!(p.permission_mode.as_deref(), Some("acceptEdits"));
    }

    #[test]
    fn prompt_permission_mode_none_is_absent() {
        let p = Prompt {
            text: "build it".into(),
            ..Default::default()
        };
        assert!(p.permission_mode.is_none());
    }

    // ---- claude flag mapping ----

    #[test]
    fn claude_permission_flag_maps_full_to_bypass() {
        use crate::permission::PermissionMode;
        // The claude adapter forwards `mode.claude_flag()`; `full` must become the CLI's
        // `bypassPermissions` spelling, and the advanced modes pass through unchanged.
        assert_eq!(PermissionMode::Full.claude_flag(), "bypassPermissions");
        assert_eq!(PermissionMode::Plan.claude_flag(), "plan");
        assert_eq!(PermissionMode::DontAsk.claude_flag(), "dontAsk");
    }
}

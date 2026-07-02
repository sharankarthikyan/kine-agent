use crate::adapter::{AgentAdapter, EventSink, Prompt, SessionError};
use crate::events::AgentEvent;
use crate::adapters::{
    feed_prompt_via_stdin, is_batch_shim, read_capped_line, CappedLine, MAX_LINE_BYTES,
};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;

/// Adapter that drives the `codex` CLI via `codex exec --json`.
///
/// Codex mints its own conversation id (`thread_id`), reported in the first
/// `thread.started` event. We capture it into [`CodexAdapter::captured_thread`] so
/// the command layer can persist it and later resume with `codex exec resume <id>`.
pub struct CodexAdapter {
    captured_thread: Arc<Mutex<Option<String>>>,
}

impl CodexAdapter {
    pub fn new(captured_thread: Arc<Mutex<Option<String>>>) -> Self {
        Self { captured_thread }
    }
}

impl AgentAdapter for CodexAdapter {
    fn run(
        &self,
        prompt: Prompt,
        cwd: PathBuf,
        session_id: String,
        resume: bool,
        sink: Box<dyn EventSink>,
    ) -> impl std::future::Future<Output = Result<(), SessionError>> + Send {
        spawn_and_stream(
            prompt,
            cwd,
            session_id,
            resume,
            sink,
            self.captured_thread.clone(),
        )
    }
}

/// Parse one `codex exec --json` event line into zero or more AgentEvents.
///
/// Returns an empty Vec for blank lines, non-JSON input, and event types we don't
/// surface — never panics on malformed output. The `thread.started` id is handled
/// separately (it isn't an AgentEvent); see [`thread_id_from_line`].
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
        // Only the terminal `item.completed` is surfaced. `item.updated` carries the
        // same item in an in-progress form; emitting both would duplicate (and, for
        // incrementally-streamed text, repeatedly re-append) the item's content. The
        // completed form is authoritative, so updates are intentionally ignored.
        Some("item.completed") => parse_item(v.get("item")),
        Some("turn.completed") => parse_usage(v.get("usage")).into_iter().collect(),
        Some("turn.failed") | Some("error") => {
            let message = v
                .get("error")
                .and_then(|e| e.get("message").and_then(Value::as_str))
                .or_else(|| v.get("message").and_then(Value::as_str))
                .unwrap_or("codex turn failed")
                .to_string();
            vec![AgentEvent::Error { message }]
        }
        _ => vec![],
    }
}

/// Extract the conversation/thread id from a `thread.started` line, if present.
pub fn thread_id_from_line(line: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type").and_then(Value::as_str) != Some("thread.started") {
        return None;
    }
    v.get("thread_id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Map a Codex `item` object to an AgentEvent. Known item types:
/// `agent_message` (assistant text), `command_execution` (shell tool),
/// `file_change`/`patch` (file edits), `mcp_tool_call` (tool). Unknown types are ignored.
fn parse_item(item: Option<&Value>) -> Vec<AgentEvent> {
    let Some(item) = item else { return vec![] };
    match item.get("type").and_then(Value::as_str) {
        Some("agent_message") => item
            .get("text")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(|t| {
                vec![AgentEvent::Token {
                    text: t.to_string(),
                }]
            })
            .unwrap_or_default(),
        Some("command_execution") => {
            let command = item
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            vec![AgentEvent::ToolCall {
                name: "shell".to_string(),
                input: command,
            }]
        }
        Some("mcp_tool_call") => {
            let name = item
                .get("tool")
                .and_then(Value::as_str)
                .or_else(|| item.get("name").and_then(Value::as_str))
                .unwrap_or("tool")
                .to_string();
            let input = item
                .get("arguments")
                .map(|a| a.to_string())
                .unwrap_or_default();
            vec![AgentEvent::ToolCall { name, input }]
        }
        Some("file_change") | Some("patch") => file_paths_from_change(item)
            .into_iter()
            .map(|path| AgentEvent::FileWrite { path })
            .collect(),
        _ => vec![],
    }
}

/// Pull edited file paths out of a `file_change`/`patch` item. Codex reports changes
/// either as a `changes` array of `{path,...}` or as a `path` scalar.
fn file_paths_from_change(item: &Value) -> Vec<String> {
    if let Some(changes) = item.get("changes").and_then(Value::as_array) {
        return changes
            .iter()
            .filter_map(|c| {
                c.get("path")
                    .or_else(|| c.get("file"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
    }
    item.get("path")
        .and_then(Value::as_str)
        .map(|p| vec![p.to_string()])
        .unwrap_or_default()
}

/// Map a Codex `turn.completed` usage object to a Usage event. Codex reports no cost.
fn parse_usage(usage: Option<&Value>) -> Option<AgentEvent> {
    let usage = usage?;
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    Some(AgentEvent::Usage {
        input_tokens: n("input_tokens"),
        output_tokens: n("output_tokens"),
        cache_read_tokens: n("cached_input_tokens"),
        cache_creation_tokens: 0,
        cost_usd: None,
        model: None,
    })
}

/// Spawn `codex exec --json` headless, read stdout line-by-line, emit parsed events,
/// and capture the conversation id for resume. On resume, `session_id` is the
/// previously-captured Codex thread id passed to `codex exec resume`.
#[allow(clippy::too_many_arguments)]
pub async fn spawn_and_stream(
    prompt: Prompt,
    cwd: PathBuf,
    session_id: String,
    resume: bool,
    sink: Box<dyn EventSink>,
    captured_thread: Arc<Mutex<Option<String>>>,
) -> Result<(), SessionError> {
    let selected_model = prompt.model.clone();
    let model = selected_model.as_deref();
    // Headless `codex exec` has no interactive approval prompt, so the sandbox tier (or a
    // full bypass) is the only blast-radius control. Default `read-only`: "ask before
    // edits" genuinely doesn't write when there's no live approver. Unknown/None ⇒ Default.
    let mode = prompt
        .permission_mode
        .as_deref()
        .and_then(crate::permission::PermissionMode::from_wire)
        .unwrap_or(crate::permission::PermissionMode::Default);

    let program = crate::agent_paths::resolve_program("codex");
    // On a Windows batch shim the prompt cannot be a CLI argument (Rust rejects `\r`/`\n`
    // args to `.cmd`/`.bat`), so a multi-line prompt is fed over stdin instead. `codex exec`
    // reads the prompt from stdin when the positional prompt is `-`; stdin MUST then be
    // closed (EOF) or `codex exec` hangs waiting for more input.
    let prompt_via_stdin = is_batch_shim(&program);
    let mut command = Command::new(&program);
    command.arg("exec");
    // The sandbox/bypass flag is an `exec`-level option and MUST precede the `resume`
    // subcommand (`codex exec -s <tier> resume <id>` is accepted; `codex exec resume -s`
    // is not). Applying it on resume too — unlike the old code, which only set it on new
    // runs — is what makes a mid-session mode change actually take effect.
    if mode.is_full() {
        command.arg("--dangerously-bypass-approvals-and-sandbox");
    } else {
        command.arg("--sandbox").arg(mode.codex_sandbox());
    }
    if resume {
        // `session_id` here is the Codex thread id captured from the first run.
        command.arg("resume").arg(&session_id);
    }
    command.arg("--json").arg("--skip-git-repo-check");
    if let Some(m) = model {
        command.arg("--model").arg(m);
    }
    // `--cd` is only accepted on new runs; `exec resume` reuses the original session's cwd.
    if !resume {
        command.arg("--cd").arg(&cwd);
    }
    if prompt_via_stdin {
        command.arg("-");
    } else {
        command.arg(&prompt.text);
    }

    let stdin_cfg = if prompt_via_stdin {
        // The prompt is written to stdin below, then stdin is closed (EOF).
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    };
    let mut child = command
        .current_dir(&cwd)
        .stdin(stdin_cfg)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
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

    // Drain stderr concurrently so a full pipe buffer can't deadlock stdout. Codex
    // writes MCP/transport diagnostics here that we keep only as an error tail.
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut buf).await;
        let lines: Vec<&str> = buf.lines().collect();
        let start = lines.len().saturating_sub(20);
        lines[start..].join("\n")
    });

    let mut reader = BufReader::new(stdout);
    loop {
        match read_capped_line(&mut reader, MAX_LINE_BYTES).await? {
            CappedLine::Eof => break,
            CappedLine::Skipped(bytes) => {
                eprintln!("codex: skipped an oversized stdout line ({bytes} bytes)");
            }
            CappedLine::Line(buf) => {
                let line = String::from_utf8_lossy(&buf);
                if let Some(thread_id) = thread_id_from_line(&line) {
                    if let Ok(mut slot) = captured_thread.lock() {
                        *slot = Some(thread_id);
                    }
                }
                for event in parse_line(&line) {
                    let event = match event {
                        AgentEvent::Usage {
                            input_tokens,
                            output_tokens,
                            cache_read_tokens,
                            cache_creation_tokens,
                            cost_usd,
                            model: None,
                        } => AgentEvent::Usage {
                            input_tokens,
                            output_tokens,
                            cache_read_tokens,
                            cache_creation_tokens,
                            cost_usd,
                            model: selected_model.clone(),
                        },
                        other => other,
                    };
                    sink.emit(event);
                }
            }
        }
    }

    let stderr_tail = stderr_task.await.unwrap_or_default();
    let status = child.wait().await?;
    if !status.success() {
        let message = if stderr_tail.trim().is_empty() {
            format!("codex exited with {status}")
        } else {
            format!("codex exited with {status}: {}", stderr_tail.trim())
        };
        sink.emit(AgentEvent::Error { message });
    } else if !stderr_tail.trim().is_empty() {
        eprintln!("codex exited 0 with stderr: {}", stderr_tail.trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_blank_and_non_json_return_empty() {
        assert!(parse_line("").is_empty());
        assert!(parse_line("   ").is_empty());
        assert!(parse_line("not json").is_empty());
    }

    #[test]
    fn parse_agent_message_emits_token() {
        let line = r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}"#;
        let events = parse_line(line);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], AgentEvent::Token { text } if text == "pong"));
    }

    #[test]
    fn parse_item_updated_is_ignored_to_avoid_duplicate_text() {
        // The in-progress `item.updated` form must NOT emit — only the terminal
        // `item.completed` does — otherwise incrementally-streamed text duplicates.
        let updated = r#"{"type":"item.updated","item":{"type":"agent_message","text":"par"}}"#;
        assert!(parse_line(updated).is_empty());
        let completed =
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"partial then full"}}"#;
        let events = parse_line(completed);
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0], AgentEvent::Token { text } if text == "partial then full")
        );
    }

    #[test]
    fn parse_command_execution_emits_tool_call() {
        let line =
            r#"{"type":"item.completed","item":{"type":"command_execution","command":"ls -la"}}"#;
        let events = parse_line(line);
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0], AgentEvent::ToolCall { name, input } if name == "shell" && input == "ls -la"),
        );
    }

    #[test]
    fn parse_file_change_emits_file_writes() {
        let line = r#"{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"src/a.rs"},{"path":"src/b.rs"}]}}"#;
        let events = parse_line(line);
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], AgentEvent::FileWrite { path } if path == "src/a.rs"));
        assert!(matches!(&events[1], AgentEvent::FileWrite { path } if path == "src/b.rs"));
    }

    #[test]
    fn parse_turn_completed_emits_usage() {
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":12408,"cached_input_tokens":4992,"output_tokens":5,"reasoning_output_tokens":0}}"#;
        let events = parse_line(line);
        assert_eq!(events.len(), 1);
        match &events[0] {
            AgentEvent::Usage {
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cost_usd,
                ..
            } => {
                assert_eq!(*input_tokens, 12408);
                assert_eq!(*output_tokens, 5);
                assert_eq!(*cache_read_tokens, 4992);
                assert!(cost_usd.is_none());
            }
            other => panic!("expected Usage, got {other:?}"),
        }
    }

    #[test]
    fn parse_turn_failed_emits_error() {
        let line = r#"{"type":"turn.failed","error":{"message":"model overloaded"}}"#;
        let events = parse_line(line);
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0], AgentEvent::Error { message } if message == "model overloaded")
        );
    }

    #[test]
    fn thread_started_id_is_extracted() {
        let line =
            r#"{"type":"thread.started","thread_id":"019f19d0-c3cf-7623-9afa-b988b2d42763"}"#;
        assert_eq!(
            thread_id_from_line(line).as_deref(),
            Some("019f19d0-c3cf-7623-9afa-b988b2d42763")
        );
        assert!(thread_id_from_line(r#"{"type":"turn.started"}"#).is_none());
    }

    #[test]
    fn sandbox_mapping_matches_permission_mode() {
        use crate::permission::PermissionMode;
        // Plan and Default are both read-only headless (no live approver); acceptEdits
        // writes; Full is not a sandbox tier — it uses the bypass flag instead.
        assert_eq!(PermissionMode::Plan.codex_sandbox(), "read-only");
        assert_eq!(PermissionMode::Default.codex_sandbox(), "read-only");
        assert_eq!(PermissionMode::AcceptEdits.codex_sandbox(), "workspace-write");
        assert!(PermissionMode::Full.is_full());
    }
}

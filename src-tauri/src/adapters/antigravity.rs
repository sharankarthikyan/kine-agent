use crate::adapter::{AgentAdapter, EventSink, Prompt, SessionError};
use crate::adapters::{
    feed_prompt_via_stdin, is_batch_shim, read_capped_line, CappedLine, MAX_LINE_BYTES,
};
use crate::events::AgentEvent;
use serde_json::Value;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, BufReader};
use tokio::time::{timeout, Duration};

/// Adapter that drives the Antigravity CLI (`agy`).
///
/// `agy --print` runs a prompt non-interactively and prints only the final text —
/// it has no structured/JSON event stream — so this adapter surfaces the response as
/// `Token`s followed by `Done`. There are deliberately no tool-call, file-change, or
/// usage events: the CLI does not emit them.
///
/// Antigravity mints its own conversation id but `--print` does not echo it, so after
/// each run we recover it from `history.jsonl` (newest conversation for this cwd) into
/// [`AntigravityAdapter::captured_conversation`] for the command layer to persist.
pub struct AntigravityAdapter {
    captured_conversation: Arc<Mutex<Option<String>>>,
}

impl AntigravityAdapter {
    pub fn new(captured_conversation: Arc<Mutex<Option<String>>>) -> Self {
        Self {
            captured_conversation,
        }
    }
}

impl AgentAdapter for AntigravityAdapter {
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
            self.captured_conversation.clone(),
        )
    }
}

/// Spawn `agy --print` headless, stream its plain-text response as `Token`s, then
/// `Done`. On resume, `session_id` is the previously-captured conversation id passed
/// via `--conversation`.
pub async fn spawn_and_stream(
    prompt: Prompt,
    cwd: PathBuf,
    session_id: String,
    resume: bool,
    sink: Box<dyn EventSink>,
    captured_conversation: Arc<Mutex<Option<String>>>,
) -> Result<(), SessionError> {
    let program = crate::agent_paths::resolve_program("agy");
    if antigravity_auth_probe(&program).await == AntigravityAuthProbe::Unauthenticated {
        sink.emit(antigravity_auth_required_event());
        return Ok(());
    }

    // On a Windows batch shim the prompt cannot be a CLI argument (Rust rejects `\r`/`\n`
    // args to `.cmd`/`.bat`), so a multi-line prompt is fed over stdin instead. NOTE:
    // `agy --print` consuming its prompt from stdin is not yet verified live — needs a
    // Windows smoke test. Because stdin is closed (EOF) after the write, the worst case if
    // agy ignores stdin is a clean "no prompt" exit, not a hang.
    let prompt_via_stdin = is_batch_shim(&program);
    let mut command = crate::proc::tokio_command(&program);
    command.arg("--print");
    if !prompt_via_stdin {
        command.arg(&prompt.text);
    }
    // Antigravity is project-based and otherwise ignores the process cwd, which would
    // let it operate on the wrong repo. `--add-dir <worktree>` scopes its workspace to
    // this session's isolated worktree. (We intentionally avoid `--new-project`, which
    // both triggers project-scaffolding behavior AND hangs headlessly under `--print`.)
    //
    // CRITICAL: this only works when `cwd` has NO hidden (dot-prefixed) path component.
    // `agy` silently refuses to adopt a hidden-path workspace and falls back to its default
    // `scratch` project, so unqualified edits would land outside the worktree, breaking
    // isolation. That's why `commands::worktrees_root` puts worktrees under a VISIBLE
    // `~/Kineloop` rather than `~/.kineloop`. (Verified 2026-07-01 via `agy --print`.)
    command.arg("--add-dir").arg(&cwd);
    if let Some(m) = prompt.model.as_deref() {
        command.arg("--model").arg(m);
    }
    // `agy --print` has no edits-only tier — its only permission lever is blanket
    // skip-all — so only Full auto-approves everything; every other mode leaves the CLI's
    // settings-based gating in place. (Unknown/None ⇒ Default ⇒ gated.)
    let mode = prompt
        .permission_mode
        .as_deref()
        .and_then(crate::permission::PermissionMode::from_wire)
        .unwrap_or(crate::permission::PermissionMode::Default);
    if mode.antigravity_skip_permissions() {
        command.arg("--dangerously-skip-permissions");
    }
    // Orthogonal terminal sandbox: restrict shell commands' network/disk access. This is
    // independent of the permission mode (you can gate edits AND sandbox the terminal).
    if prompt.sandbox_terminal {
        command.arg("--sandbox");
    }
    if resume {
        command.arg("--conversation").arg(&session_id);
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

    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut buf).await;
        let lines: Vec<&str> = buf.lines().collect();
        let start = lines.len().saturating_sub(20);
        lines[start..].join("\n")
    });

    // Stream stdout line-by-line as Token events, re-adding the newline so multi-line
    // responses keep their formatting when concatenated in the UI. A per-line size cap
    // bounds memory against a pathological huge line.
    let mut reader = BufReader::new(stdout);
    let mut emitted_any = false;
    let mut stdout_auth_required = false;
    loop {
        match read_capped_line(&mut reader, MAX_LINE_BYTES).await? {
            CappedLine::Eof => break,
            CappedLine::Skipped { total: bytes, .. } => {
                eprintln!("agy: skipped an oversized stdout line ({bytes} bytes)");
            }
            CappedLine::Line(buf) => {
                let mut text = String::from_utf8_lossy(&buf).into_owned();
                text.push('\n');
                emitted_any = true;
                if auth_required_text(&text) {
                    stdout_auth_required = true;
                    continue;
                }
                sink.emit(AgentEvent::Token { text });
            }
        }
    }

    let stderr_tail = stderr_task.await.unwrap_or_default();
    let status = child.wait().await?;

    if !status.success() {
        let message = if stderr_tail.trim().is_empty() {
            format!("agy exited with {status}")
        } else {
            format!("agy exited with {status}: {}", stderr_tail.trim())
        };
        if let Some(event) = auth_required_from_stderr(&message) {
            sink.emit(event);
        } else if stdout_auth_required {
            sink.emit(antigravity_auth_required_event());
        } else {
            sink.emit(AgentEvent::Error { message });
        }
        return Ok(());
    } else if !stderr_tail.trim().is_empty() {
        eprintln!("agy exited 0 with stderr: {}", stderr_tail.trim());
    }

    // Recover the conversation id agy just wrote so follow-up turns can resume it.
    if let Some(id) = newest_conversation_for(&cwd) {
        if let Ok(mut slot) = captured_conversation.lock() {
            *slot = Some(id);
        }
    }

    // A successful run with no printed output still completes the turn.
    let _ = emitted_any;
    sink.emit(AgentEvent::Done {
        summary: String::new(),
    });
    Ok(())
}

fn auth_required_from_stderr(message: &str) -> Option<AgentEvent> {
    if !auth_required_text(message) {
        return None;
    }
    Some(antigravity_auth_required_event())
}

fn auth_required_text(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("not authenticated")
        || lower.contains("unauthenticated")
        || lower.contains("authentication required")
        || lower.contains("authentication failed")
        || lower.contains("auth required")
        || lower.contains("not logged in")
        || lower.contains("login required")
        || lower.contains("please sign in")
        || lower.contains("sign in")
        || lower.contains("sign-in")
        || (lower.contains("auth") && lower.contains("timed out"))
        || (lower.contains("credential") && lower.contains("login"))
}

fn antigravity_auth_required_event() -> AgentEvent {
    AgentEvent::AuthRequired {
        agent: "antigravity".to_string(),
        command: "agy --prompt-interactive \"Sign in to Antigravity\"".to_string(),
        message: "Antigravity is not signed in. Kineloop can open the real CLI login prompt, but the browser access code must be pasted into Antigravity's terminal prompt.".to_string(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AntigravityAuthProbe {
    Authenticated,
    Unauthenticated,
    Unknown,
}

async fn antigravity_auth_probe(program: &OsStr) -> AntigravityAuthProbe {
    let mut command = crate::proc::tokio_command(program);
    command
        .arg("models")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let output = match timeout(Duration::from_secs(8), command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(err)) => {
            eprintln!("agy auth probe failed to spawn: {err}");
            return AntigravityAuthProbe::Unknown;
        }
        Err(_) => {
            eprintln!("agy auth probe timed out");
            return AntigravityAuthProbe::Unknown;
        }
    };

    classify_auth_probe(
        output.status.success(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )
}

fn classify_auth_probe(status_success: bool, stdout: &str, stderr: &str) -> AntigravityAuthProbe {
    if status_success {
        return AntigravityAuthProbe::Authenticated;
    }
    let combined = format!("{stdout}\n{stderr}");
    if auth_required_text(&combined) {
        AntigravityAuthProbe::Unauthenticated
    } else {
        AntigravityAuthProbe::Unknown
    }
}

/// The newest Antigravity conversation id whose recorded `workspace` matches `cwd`,
/// read from `~/.gemini/antigravity-cli/history.jsonl`. Used to capture the id of a
/// conversation just created by `agy --print` (which does not echo it). Best-effort:
/// `None` when the history file is absent/unreadable or no entry matches.
fn newest_conversation_for(cwd: &Path) -> Option<String> {
    let history = crate::agent_paths::gemini_config_dir()?
        .join("antigravity-cli")
        .join("history.jsonl");
    let contents = std::fs::read(&history).ok()?;
    let text = String::from_utf8_lossy(&contents);
    let target = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());

    let mut best: Option<(i64, String)> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(workspace) = value.get("workspace").and_then(Value::as_str) else {
            continue;
        };
        let Some(conv) = value.get("conversationId").and_then(Value::as_str) else {
            continue;
        };
        let ws_path = std::fs::canonicalize(workspace).unwrap_or_else(|_| PathBuf::from(workspace));
        if ws_path != target && workspace != target.to_string_lossy() {
            continue;
        }
        let ts = value.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
        if best.as_ref().is_none_or(|(best_ts, _)| ts >= *best_ts) {
            best = Some((ts, conv.to_string()));
        }
    }
    best.map(|(_, conv)| conv)
}

/// Test seam: same logic as [`newest_conversation_for`] but against an explicit
/// history-file path, so tests don't depend on the real `~/.gemini` location.
#[cfg(test)]
fn newest_conversation_for_in(history: &Path, cwd: &Path) -> Option<String> {
    let contents = std::fs::read(history).ok()?;
    let text = String::from_utf8_lossy(&contents);
    let target = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let mut best: Option<(i64, String)> = None;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(workspace) = value.get("workspace").and_then(Value::as_str) else {
            continue;
        };
        let Some(conv) = value.get("conversationId").and_then(Value::as_str) else {
            continue;
        };
        let ws_path = std::fs::canonicalize(workspace).unwrap_or_else(|_| PathBuf::from(workspace));
        if ws_path != target && workspace != target.to_string_lossy() {
            continue;
        }
        let ts = value.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
        if best.as_ref().is_none_or(|(best_ts, _)| ts >= *best_ts) {
            best = Some((ts, conv.to_string()));
        }
    }
    best.map(|(_, conv)| conv)
}

#[cfg(test)]
mod tests {
    use std::fs;

    #[test]
    fn newest_conversation_prefers_latest_matching_workspace() {
        let dir = std::env::temp_dir().join(format!("ae-agy-{}", std::process::id()));
        let cli = dir.join(".gemini/antigravity-cli");
        fs::create_dir_all(&cli).unwrap();
        let ws = dir.join("repo");
        fs::create_dir_all(&ws).unwrap();
        let other = dir.join("other");
        fs::create_dir_all(&other).unwrap();
        let ws_str = ws.to_string_lossy();
        let other_str = other.to_string_lossy();

        // Built via serde_json rather than hand-formatted strings: on Windows the
        // workspace path contains `\`, and splicing it into a JSON string literal
        // unescaped produces invalid escapes (`\U`, `\A`, …) that fail to parse —
        // silently dropping the line and losing the match this test expects.
        let history = cli.join("history.jsonl");
        let line_old =
            serde_json::json!({"timestamp": 1, "workspace": ws_str, "conversationId": "old"})
                .to_string();
        let line_other = serde_json::json!({
            "timestamp": 5, "workspace": other_str, "conversationId": "unrelated"
        })
        .to_string();
        let line_new =
            serde_json::json!({"timestamp": 9, "workspace": ws_str, "conversationId": "new"})
                .to_string();
        fs::write(&history, format!("{line_old}\n{line_other}\n{line_new}\n")).unwrap();

        // Newest matching workspace wins; entries for other workspaces are ignored.
        let got = super::newest_conversation_for_in(&history, &ws);
        assert_eq!(got.as_deref(), Some("new"));

        // An unrelated cwd resolves to nothing.
        let none = super::newest_conversation_for_in(&history, &dir.join("nope"));
        assert_eq!(none, None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn auth_required_from_stderr_classifies_login_failures() {
        let event = super::auth_required_from_stderr(
            "agy exited with exit status: 1: authentication required",
        )
        .expect("auth event");
        assert!(matches!(
            event,
            crate::events::AgentEvent::AuthRequired { agent, command, message }
                if agent == "antigravity"
                    && command == "agy --prompt-interactive \"Sign in to Antigravity\""
                    && message.contains("access code")
        ));
    }

    #[test]
    fn auth_required_text_classifies_antigravity_timeout_output() {
        assert!(super::auth_required_text(
            "Error: authentication failed or timed out"
        ));
        assert!(super::auth_required_text("auth flow timed out"));
        assert!(super::auth_required_text(
            "Error: Please sign in to view available models. Launch the CLI without arguments to sign in."
        ));
    }

    #[test]
    fn auth_required_from_stderr_ignores_regular_failures() {
        assert!(
            super::auth_required_from_stderr("agy exited with exit status: 1: no prompt").is_none()
        );
        assert!(!super::auth_required_text("agy exited with exit status: 1"));
    }

    #[test]
    fn auth_probe_classifies_models_sign_in_output() {
        assert_eq!(
            super::classify_auth_probe(
                false,
                "",
                "Error: Please sign in to view available models. Launch the CLI without arguments to sign in."
            ),
            super::AntigravityAuthProbe::Unauthenticated,
        );
    }

    #[test]
    fn auth_probe_success_means_authenticated() {
        assert_eq!(
            super::classify_auth_probe(true, "gemini-2.5-pro\n", ""),
            super::AntigravityAuthProbe::Authenticated,
        );
    }

    #[test]
    fn auth_probe_unknown_failure_still_allows_real_run_to_surface_details() {
        assert_eq!(
            super::classify_auth_probe(false, "", "network unavailable"),
            super::AntigravityAuthProbe::Unknown,
        );
    }
}

use crate::store::{SessionSummary, StoredEvent};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_SESSION_FILES_PER_AGENT: usize = 300;

#[derive(Debug, Clone)]
struct ExternalFile {
    agent: &'static str,
    path: PathBuf,
}

/// Transcript discovery roots, honoring the CLIs' own relocation env vars
/// (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and resolving the home dir cross-platform.
/// Gemini has no relocation var; its saved chats live under `~/.gemini/tmp`.
fn discovery_roots() -> DiscoveryRoots {
    let gemini = crate::agent_paths::gemini_config_dir();
    DiscoveryRoots {
        claude_projects: crate::agent_paths::claude_config_dir().map(|c| c.join("projects")),
        codex_sessions: crate::agent_paths::codex_home_dir().map(|c| c.join("sessions")),
        gemini_tmp: gemini.as_ref().map(|c| c.join("tmp")),
        // Antigravity CLI (the successor to Gemini CLI) lives under
        // `~/.gemini/antigravity-cli`.
        antigravity_cli: gemini.map(|c| c.join("antigravity-cli")),
    }
}

/// The per-agent discovery roots, threaded through so tests can point them at a
/// hermetic temp home instead of the real profile.
#[derive(Debug, Default, Clone)]
struct DiscoveryRoots {
    claude_projects: Option<PathBuf>,
    codex_sessions: Option<PathBuf>,
    gemini_tmp: Option<PathBuf>,
    antigravity_cli: Option<PathBuf>,
}

pub fn list_sessions() -> Vec<SessionSummary> {
    list_sessions_from(&discovery_roots())
}

pub fn events_for_session(session_id: &str) -> Option<Vec<StoredEvent>> {
    events_for_session_from(&discovery_roots(), session_id)
}

pub fn events_page_for_session(
    session_id: &str,
    offset: usize,
    limit: usize,
) -> Option<Vec<StoredEvent>> {
    events_page_for_session_from(&discovery_roots(), session_id, offset, limit)
}

/// The on-disk repository path for an external session, used to resolve its
/// customizations scope (`.claude` etc.). Returns `None` when the session can't
/// be found or its summary carries only a placeholder label rather than a real
/// directory (e.g. a transcript with no recorded cwd).
pub fn repo_for_session(session_id: &str) -> Option<PathBuf> {
    repo_for_session_from(&discovery_roots(), session_id)
}

fn repo_for_session_from(roots: &DiscoveryRoots, session_id: &str) -> Option<PathBuf> {
    let file = discover_files(roots)
        .into_iter()
        .find(|f| external_id(f.agent, &f.path) == session_id)?;
    let summary = match file.agent {
        "claude" => summarize_claude(&file.path),
        "codex" => summarize_codex(&file.path),
        "gemini" => summarize_gemini(&file.path),
        "antigravity" => summarize_antigravity(&file.path),
        _ => None,
    }?;
    path_looks_absolute(&summary.repo).then(|| PathBuf::from(summary.repo))
}

/// Whether `path` looks absolute under *either* Unix or Windows conventions,
/// independent of the host OS. [`Path::is_absolute`] only recognizes the host's
/// own form — on macOS it rejects `C:\repo`, on Windows it rejects `/repo` — so
/// a transcript written on the other OS (or simply a Windows session read by the
/// host's `is_absolute`) would have its repo wrongly dropped. We only need to
/// tell a real directory apart from a placeholder label like `"Claude CLI"`, so
/// a syntactic check covering both forms is sufficient and host-agnostic.
fn path_looks_absolute(path: &str) -> bool {
    // Unix absolute (`/repo`) or UNC / Windows root (`\\server`, `\repo`).
    if path.starts_with('/') || path.starts_with('\\') {
        return true;
    }
    // Windows drive-absolute: `C:\repo` or `C:/repo`.
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn list_sessions_from(roots: &DiscoveryRoots) -> Vec<SessionSummary> {
    let mut sessions = scan_external_sessions(roots);
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    sessions
}

fn events_for_session_from(roots: &DiscoveryRoots, session_id: &str) -> Option<Vec<StoredEvent>> {
    let file = discover_files(roots)
        .into_iter()
        .find(|f| external_id(f.agent, &f.path) == session_id)?;
    match file.agent {
        "claude" => Some(parse_claude_events(&file.path)),
        "codex" => Some(parse_codex_events(&file.path)),
        "gemini" => Some(parse_gemini_events(&file.path)),
        "antigravity" => Some(parse_antigravity_events(&file.path)),
        _ => None,
    }
}

fn events_page_for_session_from(
    roots: &DiscoveryRoots,
    session_id: &str,
    offset: usize,
    limit: usize,
) -> Option<Vec<StoredEvent>> {
    let file = discover_files(roots)
        .into_iter()
        .find(|f| external_id(f.agent, &f.path) == session_id)?;
    match file.agent {
        "claude" => Some(parse_claude_events_page(&file.path, offset, limit)),
        "codex" => Some(parse_codex_events_page(&file.path, offset, limit)),
        "gemini" => Some(slice_recent_events(
            parse_gemini_events(&file.path),
            offset,
            limit,
        )),
        "antigravity" => Some(parse_antigravity_events_page(&file.path, offset, limit)),
        _ => None,
    }
}

fn scan_external_sessions(roots: &DiscoveryRoots) -> Vec<SessionSummary> {
    let mut sessions = Vec::new();
    for file in discover_files(roots) {
        let parsed = match file.agent {
            "claude" => summarize_claude(&file.path),
            "codex" => summarize_codex(&file.path),
            "gemini" => summarize_gemini(&file.path),
            "antigravity" => summarize_antigravity(&file.path),
            _ => None,
        };
        if let Some(summary) = parsed {
            sessions.push(summary);
        }
    }
    sessions
}

fn discover_files(roots: &DiscoveryRoots) -> Vec<ExternalFile> {
    let mut files = Vec::new();
    if let Some(root) = roots.claude_projects.as_deref() {
        collect_jsonl("claude", root, 6, &mut files);
    }
    if let Some(root) = roots.codex_sessions.as_deref() {
        collect_jsonl("codex", root, 6, &mut files);
    }
    if let Some(root) = roots.gemini_tmp.as_deref() {
        collect_gemini_chats(root, &mut files);
    }
    if let Some(root) = roots.antigravity_cli.as_deref() {
        collect_antigravity_chats(root, &mut files);
    }
    files
}

/// Gemini stores each saved conversation as a single JSON object at
/// `<tmp>/<project-slug>/chats/session-*.json` (not line-delimited JSON like
/// Claude/Codex). Collect those, newest-first, capped per agent.
fn collect_gemini_chats(tmp_root: &Path, out: &mut Vec<ExternalFile>) {
    if !tmp_root.is_dir() {
        return;
    }
    let before = out.len();
    let Ok(entries) = fs::read_dir(tmp_root) else {
        return;
    };
    for entry in entries.flatten() {
        let chats_dir = entry.path().join("chats");
        let Ok(chat_entries) = fs::read_dir(&chats_dir) else {
            continue;
        };
        for chat in chat_entries.flatten() {
            let path = chat.path();
            if path.extension().is_some_and(|ext| ext == "json") && readable_session_file(&path) {
                out.push(ExternalFile {
                    agent: "gemini",
                    path,
                });
            }
        }
    }
    out[before..].sort_by_cached_key(|f| std::cmp::Reverse(modified_ms(&f.path)));
    if out[before..].len() > MAX_SESSION_FILES_PER_AGENT {
        out.truncate(before + MAX_SESSION_FILES_PER_AGENT);
    }
}

/// Antigravity CLI (the Gemini CLI successor) stores each conversation's
/// transcript at `<antigravity-cli>/brain/<conversation-id>/.system_generated/
/// logs/transcript_full.jsonl` (line-delimited JSON, richer than the sibling
/// `transcript.jsonl`). Collect those, newest-first, capped per agent.
fn collect_antigravity_chats(cli_root: &Path, out: &mut Vec<ExternalFile>) {
    let brain = cli_root.join("brain");
    if !brain.is_dir() {
        return;
    }
    let before = out.len();
    let Ok(entries) = fs::read_dir(&brain) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry
            .path()
            .join(".system_generated")
            .join("logs")
            .join("transcript_full.jsonl");
        if readable_session_file(&path) {
            out.push(ExternalFile {
                agent: "antigravity",
                path,
            });
        }
    }
    out[before..].sort_by_cached_key(|f| std::cmp::Reverse(modified_ms(&f.path)));
    if out[before..].len() > MAX_SESSION_FILES_PER_AGENT {
        out.truncate(before + MAX_SESSION_FILES_PER_AGENT);
    }
}

fn collect_jsonl(agent: &'static str, root: &Path, max_depth: usize, out: &mut Vec<ExternalFile>) {
    if !root.is_dir() {
        return;
    }
    let before = out.len();
    collect_jsonl_inner(agent, root, max_depth, out);
    out[before..].sort_by_cached_key(|f| std::cmp::Reverse(modified_ms(&f.path)));
    let agent_count = out[before..].len();
    if agent_count > MAX_SESSION_FILES_PER_AGENT {
        out.truncate(before + MAX_SESSION_FILES_PER_AGENT);
    }
}

fn collect_jsonl_inner(agent: &'static str, dir: &Path, depth: usize, out: &mut Vec<ExternalFile>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_jsonl_inner(agent, &path, depth - 1, out);
        } else if path.extension().is_some_and(|ext| ext == "jsonl")
            && readable_session_file(&path)
            && !is_claude_subagent_path(&path)
        {
            out.push(ExternalFile { agent, path });
        }
    }
}

/// Whether `path` is a regular file worth considering as a session transcript.
///
/// Deliberately does NOT reject large files: an active Claude/Codex session can be tens
/// of MB (and grows while running). Parsing streams JSONL line-by-line so large sessions
/// are not hidden or artificially truncated by Kineloop.
fn readable_session_file(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_file()).unwrap_or(false)
}

fn summarize_claude(path: &Path) -> Option<SessionSummary> {
    let mut title: Option<String> = None;
    let mut repo: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut has_conversation = false;
    let mut turn_count = 0_u32;
    let mut tool_call_count = 0_u32;
    let mut file_actions = BTreeSet::new();

    // Stream the transcript (no full Vec<Value> in memory) so even a multi-GB session
    // summarizes with bounded memory.
    visit_json_lines(path, |value| {
        let typ = value.get("type").and_then(Value::as_str);
        if repo.is_none() {
            repo = value
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }
        if branch.is_none() {
            branch = value
                .get("gitBranch")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }
        match typ {
            Some("ai-title") => {
                title = value
                    .get("aiTitle")
                    .and_then(Value::as_str)
                    .map(title_from_text);
            }
            Some("user") => {
                // Count only genuine user prompts as turns. Tool results are also stored
                // as `type:"user"` but carry no prompt text, so they must not inflate the
                // count (this is what the rendered conversation actually shows).
                if let Some(text) = claude_user_text(&value) {
                    has_conversation = true;
                    turn_count = turn_count.saturating_add(1);
                    if title.is_none() {
                        title = Some(title_from_text(&text));
                    }
                }
            }
            Some("assistant") => {
                has_conversation = true;
                if let Some(content) = value
                    .get("message")
                    .and_then(|message| message.get("content"))
                    .and_then(Value::as_array)
                {
                    for item in content {
                        if item.get("type").and_then(Value::as_str) != Some("tool_use") {
                            continue;
                        }
                        tool_call_count = tool_call_count.saturating_add(1);
                        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
                        if matches!(name, "Edit" | "MultiEdit" | "Write") {
                            if let Some(path) = item
                                .get("input")
                                .and_then(|input| {
                                    input.get("file_path").or_else(|| input.get("path"))
                                })
                                .and_then(Value::as_str)
                            {
                                file_actions.insert(path.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        true
    });

    if !has_conversation {
        return None;
    }
    let repo = repo.unwrap_or_else(|| "Claude CLI".to_string());
    if is_kineloop_worktree(&repo) {
        return None;
    }
    let updated_at = modified_ms(path);
    Some(SessionSummary {
        id: external_id("claude", path),
        agent: "claude".to_string(),
        repo,
        branch: branch.unwrap_or_else(|| "external".to_string()),
        title: title.unwrap_or_else(|| "Claude CLI session".to_string()),
        status: "idle".to_string(),
        source: "external".to_string(),
        // Kineloop doesn't own external runs, so it has no permission setting for them.
        permission_mode: None,
        sandbox_terminal: false,
        turn_count: Some(turn_count),
        tool_call_count: Some(tool_call_count),
        file_action_count: Some(file_actions.len() as u32),
        created_at: updated_at,
        updated_at,
    })
}

fn summarize_codex(path: &Path) -> Option<SessionSummary> {
    let mut title: Option<String> = None;
    let mut repo: Option<String> = None;
    let mut model: Option<String> = None;
    let mut has_conversation = false;
    let mut turn_count = 0_u32;
    let mut tool_call_count = 0_u32;
    let mut file_actions = BTreeSet::new();
    // `is_subagent` lets a `session_meta` subagent marker abort the summary even though
    // streaming can't early-return out of the closure.
    let mut is_subagent = false;

    visit_json_lines(path, |value| {
        match value.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                let payload = value.get("payload").unwrap_or(&Value::Null);
                if payload.get("thread_source").and_then(Value::as_str) == Some("subagent")
                    || payload.get("source").is_some_and(Value::is_object)
                {
                    is_subagent = true;
                    return false; // stop reading; this transcript is skipped entirely
                }
                repo = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                model = payload
                    .get("model")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
            }
            Some("event_msg") => {
                let payload = value.get("payload").unwrap_or(&Value::Null);
                if payload.get("type").and_then(Value::as_str) == Some("user_message") {
                    if let Some(text) = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .and_then(visible_external_prompt_text)
                    {
                        has_conversation = true;
                        turn_count = turn_count.saturating_add(1);
                        if title.is_none() {
                            title = Some(title_from_text(&text));
                        }
                    }
                }
            }
            Some("response_item") => {
                let payload = value.get("payload").unwrap_or(&Value::Null);
                if matches!(
                    payload.get("type").and_then(Value::as_str),
                    Some("function_call" | "custom_tool_call" | "tool_search_call")
                ) {
                    tool_call_count = tool_call_count.saturating_add(1);
                    if payload.get("name").and_then(Value::as_str) == Some("apply_patch") {
                        if let Some(input) = payload
                            .get("input")
                            .or_else(|| payload.get("arguments"))
                            .and_then(Value::as_str)
                        {
                            collect_patch_file_paths(input, &mut file_actions);
                        }
                    }
                }
                if payload.get("role").and_then(Value::as_str) == Some("assistant") {
                    has_conversation = true;
                }
            }
            _ => {}
        }
        true
    });

    if is_subagent || !has_conversation {
        return None;
    }
    let updated_at = modified_ms(path);
    Some(SessionSummary {
        id: external_id("codex", path),
        agent: "codex".to_string(),
        repo: repo.unwrap_or_else(|| "Codex CLI".to_string()),
        branch: model.unwrap_or_else(|| "external".to_string()),
        title: title.unwrap_or_else(|| "Codex CLI session".to_string()),
        status: "idle".to_string(),
        source: "external".to_string(),
        // Kineloop doesn't own external runs, so it has no permission setting for them.
        permission_mode: None,
        sandbox_terminal: false,
        turn_count: Some(turn_count),
        tool_call_count: Some(tool_call_count),
        file_action_count: Some(file_actions.len() as u32),
        created_at: updated_at,
        updated_at,
    })
}

fn parse_claude_events(path: &Path) -> Vec<StoredEvent> {
    let mut out = Vec::new();
    visit_claude_events(path, |kind, payload| {
        push_event(&mut out, kind, payload);
        true
    });
    out
}

fn parse_claude_events_page(path: &Path, offset: usize, limit: usize) -> Vec<StoredEvent> {
    reverse_events_page(path, offset, limit, claude_event_pairs)
}

fn visit_claude_events(path: &Path, mut emit: impl FnMut(&str, Value) -> bool) {
    visit_json_lines(path, |value| {
        for (kind, payload) in claude_event_pairs(&value) {
            if !emit(&kind, payload) {
                return false;
            }
        }
        true
    });
}

fn claude_event_pairs(value: &Value) -> Vec<(String, Value)> {
    let mut events = Vec::new();
    match value.get("type").and_then(Value::as_str) {
        Some("user") => {
            if let Some(text) = claude_user_text(value) {
                events.push(("prompt".to_string(), serde_json::json!({ "text": text })));
            } else if let Some(text) =
                claude_user_raw_text(value).and_then(|text| external_control_status_text(&text))
            {
                events.push(("status".to_string(), serde_json::json!({ "text": text })));
            }
        }
        Some("assistant") => {
            let message = value.get("message").unwrap_or(&Value::Null);
            if let Some(content) = message.get("content").and_then(Value::as_array) {
                for item in content {
                    match item.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                events.push((
                                    "token".to_string(),
                                    serde_json::json!({ "text": text }),
                                ));
                            }
                        }
                        Some("tool_use") => {
                            let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                            let input = item
                                .get("input")
                                .map(compact_json)
                                .unwrap_or_else(|| "".to_string());
                            events.push((
                                "toolCall".to_string(),
                                serde_json::json!({ "name": name, "input": input }),
                            ));
                        }
                        _ => {}
                    }
                }
            }
            if let Some(usage) = message.get("usage") {
                events.push((
                    "usage".to_string(),
                    usage_payload(usage, message.get("model").and_then(Value::as_str)),
                ));
            }
        }
        _ => {}
    }
    events
}

fn parse_codex_events(path: &Path) -> Vec<StoredEvent> {
    let mut out = Vec::new();
    visit_codex_events(path, |kind, payload| {
        push_event(&mut out, kind, payload);
        true
    });
    out
}

fn parse_codex_events_page(path: &Path, offset: usize, limit: usize) -> Vec<StoredEvent> {
    reverse_events_page(path, offset, limit, codex_event_pairs)
}

fn visit_codex_events(path: &Path, mut emit: impl FnMut(&str, Value) -> bool) {
    visit_json_lines(path, |value| {
        for (kind, payload) in codex_event_pairs(&value) {
            if !emit(&kind, payload) {
                return false;
            }
        }
        true
    });
}

fn codex_event_pairs(value: &Value) -> Vec<(String, Value)> {
    let mut events = Vec::new();
    let payload = value.get("payload").unwrap_or(&Value::Null);
    match value.get("type").and_then(Value::as_str) {
        Some("event_msg")
            if payload.get("type").and_then(Value::as_str) == Some("user_message") =>
        {
            if let Some(text) = payload.get("message").and_then(Value::as_str) {
                if let Some(prompt) = visible_external_prompt_text(text) {
                    events.push(("prompt".to_string(), serde_json::json!({ "text": prompt })));
                } else if let Some(status) = external_control_status_text(text) {
                    events.push(("status".to_string(), serde_json::json!({ "text": status })));
                }
            }
        }
        Some("response_item") => match payload.get("type").and_then(Value::as_str) {
            Some("message") if payload.get("role").and_then(Value::as_str) == Some("assistant") => {
                let text = message_content_text(payload.get("content"));
                if !text.is_empty() {
                    events.push(("token".to_string(), serde_json::json!({ "text": text })));
                }
            }
            Some("function_call") | Some("custom_tool_call") | Some("tool_search_call") => {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let input = payload
                    .get("input")
                    .or_else(|| payload.get("arguments"))
                    .map(|v| match v {
                        Value::String(s) => s.clone(),
                        other => compact_json(other),
                    })
                    .unwrap_or_default();
                events.push((
                    "toolCall".to_string(),
                    serde_json::json!({ "name": name, "input": input }),
                ));
            }
            _ => {}
        },
        _ => {}
    }
    events
}

fn summarize_gemini(path: &Path) -> Option<SessionSummary> {
    let root = read_json_object(path)?;
    let messages = root.get("messages").and_then(Value::as_array)?;

    let mut title: Option<String> = None;
    let mut model: Option<String> = None;
    let mut has_conversation = false;
    let mut turn_count = 0_u32;
    let mut tool_call_count = 0_u32;
    let mut file_actions = BTreeSet::new();

    for message in messages {
        match message.get("type").and_then(Value::as_str) {
            Some("user") => {
                if let Some(text) = gemini_user_text(message) {
                    has_conversation = true;
                    turn_count = turn_count.saturating_add(1);
                    if title.is_none() {
                        title = Some(title_from_text(&text));
                    }
                }
            }
            Some("gemini") => {
                has_conversation = true;
                if model.is_none() {
                    model = message
                        .get("model")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                }
                if let Some(tool_calls) = message.get("toolCalls").and_then(Value::as_array) {
                    for call in tool_calls {
                        tool_call_count = tool_call_count.saturating_add(1);
                        let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                        if matches!(name, "write_file" | "replace") {
                            if let Some(file) = call
                                .get("args")
                                .and_then(|args| args.get("file_path"))
                                .and_then(Value::as_str)
                            {
                                file_actions.insert(file.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if !has_conversation {
        return None;
    }
    let repo = gemini_project_root(path).unwrap_or_else(|| "Gemini CLI".to_string());
    if is_kineloop_worktree(&repo) {
        return None;
    }
    let updated_at = modified_ms(path);
    Some(SessionSummary {
        id: external_id("gemini", path),
        agent: "gemini".to_string(),
        repo,
        branch: model.unwrap_or_else(|| "external".to_string()),
        title: title.unwrap_or_else(|| "Gemini CLI session".to_string()),
        status: "idle".to_string(),
        source: "external".to_string(),
        // Kineloop doesn't own external runs, so it has no permission setting for them.
        permission_mode: None,
        sandbox_terminal: false,
        turn_count: Some(turn_count),
        tool_call_count: Some(tool_call_count),
        file_action_count: Some(file_actions.len() as u32),
        created_at: updated_at,
        updated_at,
    })
}

fn parse_gemini_events(path: &Path) -> Vec<StoredEvent> {
    let mut out = Vec::new();
    let Some(root) = read_json_object(path) else {
        return out;
    };
    let Some(messages) = root.get("messages").and_then(Value::as_array) else {
        return out;
    };
    for message in messages {
        match message.get("type").and_then(Value::as_str) {
            Some("user") => {
                if let Some(text) = gemini_user_text(message) {
                    push_event(&mut out, "prompt", serde_json::json!({ "text": text }));
                } else if let Some(text) = gemini_user_raw_text(message)
                    .and_then(|text| external_control_status_text(&text))
                {
                    push_event(&mut out, "status", serde_json::json!({ "text": text }));
                }
            }
            Some("gemini") => {
                if let Some(text) = message.get("content").and_then(Value::as_str) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        push_event(&mut out, "token", serde_json::json!({ "text": trimmed }));
                    }
                }
                if let Some(tool_calls) = message.get("toolCalls").and_then(Value::as_array) {
                    for call in tool_calls {
                        let name = call.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let input = call
                            .get("args")
                            .map(compact_json)
                            .unwrap_or_else(String::new);
                        push_event(
                            &mut out,
                            "toolCall",
                            serde_json::json!({ "name": name, "input": input }),
                        );
                    }
                }
                if let Some(tokens) = message.get("tokens") {
                    push_gemini_usage(
                        &mut out,
                        tokens,
                        message.get("model").and_then(Value::as_str),
                    );
                }
            }
            _ => {}
        }
    }
    out
}

/// Extract a user prompt's text from a Gemini message. `content` is either a
/// plain string or an array of `{ "text": ... }` blocks (e.g. with `@file`
/// mentions). Returns `None` for empty content so blank turns aren't counted.
fn gemini_user_text(message: &Value) -> Option<String> {
    gemini_user_raw_text(message).and_then(|text| visible_external_prompt_text(&text))
}

fn gemini_user_raw_text(message: &Value) -> Option<String> {
    let content = message.get("content")?;

    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }

    if let Some(blocks) = content.as_array() {
        let text = blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        return (!text.trim().is_empty()).then_some(text);
    }

    None
}

/// The project root for a Gemini chat: the sibling `.project_root` file at
/// `<tmp>/<slug>/.project_root` (the chat lives in `<slug>/chats/`).
fn gemini_project_root(chat_path: &Path) -> Option<String> {
    let slug_dir = chat_path.parent()?.parent()?;
    let contents = fs::read_to_string(slug_dir.join(".project_root")).ok()?;
    let trimmed = contents.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn push_gemini_usage(out: &mut Vec<StoredEvent>, tokens: &Value, model: Option<&str>) {
    push_event(
        out,
        "usage",
        serde_json::json!({
            "inputTokens": tokens.get("input").and_then(Value::as_u64).unwrap_or(0),
            "outputTokens": tokens.get("output").and_then(Value::as_u64).unwrap_or(0),
            "cacheReadTokens": tokens.get("cached").and_then(Value::as_u64).unwrap_or(0),
            "cacheCreationTokens": 0,
            "costUsd": null,
            "model": model,
        }),
    );
}

/// Read and parse a whole JSON object file (Gemini saved chats).
fn read_json_object(path: &Path) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn summarize_antigravity(path: &Path) -> Option<SessionSummary> {
    let mut title: Option<String> = None;
    let mut has_conversation = false;
    let mut turn_count = 0_u32;
    let mut tool_call_count = 0_u32;
    let mut file_actions = BTreeSet::new();

    visit_json_lines(path, |value| {
        match value.get("type").and_then(Value::as_str) {
            Some("USER_INPUT") => {
                if let Some(text) = antigravity_user_text(&value) {
                    has_conversation = true;
                    turn_count = turn_count.saturating_add(1);
                    if title.is_none() {
                        title = Some(title_from_text(&text));
                    }
                }
            }
            Some("PLANNER_RESPONSE") => has_conversation = true,
            _ => {}
        }
        // Tool calls ride on the model steps (typically PLANNER_RESPONSE).
        if let Some(calls) = value.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                tool_call_count = tool_call_count.saturating_add(1);
                if let Some(file) = antigravity_tool_file_path(call) {
                    file_actions.insert(file);
                }
            }
        }
        true
    });

    if !has_conversation {
        return None;
    }
    let repo = antigravity_workspace(path).unwrap_or_else(|| "Antigravity CLI".to_string());
    if is_kineloop_worktree(&repo) {
        return None;
    }
    let updated_at = modified_ms(path);
    Some(SessionSummary {
        id: external_id("antigravity", path),
        agent: "antigravity".to_string(),
        repo,
        branch: "external".to_string(),
        title: title.unwrap_or_else(|| "Antigravity CLI session".to_string()),
        status: "idle".to_string(),
        source: "external".to_string(),
        // Kineloop doesn't own external runs, so it has no permission setting for them.
        permission_mode: None,
        sandbox_terminal: false,
        turn_count: Some(turn_count),
        tool_call_count: Some(tool_call_count),
        file_action_count: Some(file_actions.len() as u32),
        created_at: updated_at,
        updated_at,
    })
}

fn parse_antigravity_events(path: &Path) -> Vec<StoredEvent> {
    let mut out = Vec::new();
    visit_antigravity_events(path, |kind, payload| {
        push_event(&mut out, kind, payload);
        true
    });
    out
}

fn parse_antigravity_events_page(path: &Path, offset: usize, limit: usize) -> Vec<StoredEvent> {
    reverse_events_page(path, offset, limit, antigravity_event_pairs)
}

fn visit_antigravity_events(path: &Path, mut emit: impl FnMut(&str, Value) -> bool) {
    visit_json_lines(path, |value| {
        for (kind, payload) in antigravity_event_pairs(&value) {
            if !emit(&kind, payload) {
                return false;
            }
        }
        true
    });
}

fn antigravity_event_pairs(value: &Value) -> Vec<(String, Value)> {
    let mut events = Vec::new();
    match value.get("type").and_then(Value::as_str) {
        Some("USER_INPUT") => {
            if let Some(text) = antigravity_user_text(value) {
                events.push(("prompt".to_string(), serde_json::json!({ "text": text })));
            } else if let Some(text) = value
                .get("content")
                .and_then(Value::as_str)
                .and_then(external_control_status_text)
            {
                events.push(("status".to_string(), serde_json::json!({ "text": text })));
            }
        }
        Some("PLANNER_RESPONSE") => {
            if let Some(text) = value.get("content").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    events.push(("token".to_string(), serde_json::json!({ "text": trimmed })));
                }
            }
        }
        _ => {}
    }
    if let Some(calls) = value.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let name = call.get("name").and_then(Value::as_str).unwrap_or("tool");
            let input = call.get("args").map(compact_json).unwrap_or_default();
            events.push((
                "toolCall".to_string(),
                serde_json::json!({ "name": name, "input": input }),
            ));
        }
    }
    events
}

/// Pull the real prompt out of an Antigravity `USER_INPUT` step. Its `content`
/// wraps the prompt in `<USER_REQUEST>…</USER_REQUEST>` alongside metadata tags;
/// return just the request text (or the whole content if the tag is absent).
fn antigravity_user_text(value: &Value) -> Option<String> {
    let content = value.get("content").and_then(Value::as_str)?;
    let inner = extract_xml_tag(content, "USER_REQUEST").unwrap_or(content);
    visible_external_prompt_text(inner)
}

/// Extract the text between `<tag>` and `</tag>`. Returns `None` if either
/// marker is missing.
fn extract_xml_tag<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let rest = &text[start..];
    let end = rest.find(&close)?;
    Some(rest[..end].trim())
}

/// File path touched by an Antigravity tool call, for write/edit-style tools.
fn antigravity_tool_file_path(call: &Value) -> Option<String> {
    let name = call
        .get("name")
        .and_then(Value::as_str)?
        .to_ascii_lowercase();
    let writes = name.contains("write")
        || name.contains("edit")
        || name.contains("replace")
        || name.contains("create");
    if !writes {
        return None;
    }
    let args = call.get("args")?;
    for key in [
        "AbsolutePath",
        "TargetFile",
        "FilePath",
        "file_path",
        "Path",
        "path",
    ] {
        if let Some(p) = args.get(key).and_then(Value::as_str) {
            let trimmed = p.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Resolve the workspace (repo) for an Antigravity conversation by matching its
/// id against `<antigravity-cli>/history.jsonl`, which records the `workspace`
/// per `conversationId`. The transcript lives at
/// `<cli>/brain/<id>/.system_generated/logs/transcript_full.jsonl`.
fn antigravity_workspace(transcript_path: &Path) -> Option<String> {
    let id_dir = transcript_path.parent()?.parent()?.parent()?;
    let conversation_id = id_dir.file_name()?.to_str()?;
    let cli_root = id_dir.parent()?.parent()?;
    let history = cli_root.join("history.jsonl");
    for value in read_json_lines(&history) {
        if value.get("conversationId").and_then(Value::as_str) == Some(conversation_id) {
            if let Some(ws) = value.get("workspace").and_then(Value::as_str) {
                let trimmed = ws.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

fn read_json_lines(path: &Path) -> Vec<Value> {
    let mut values = Vec::new();
    visit_json_lines(path, |value| {
        values.push(value);
        true
    });
    values
}

fn visit_json_lines(path: &Path, mut visit: impl FnMut(Value) -> bool) {
    let Ok(file) = fs::File::open(path) else {
        return;
    };
    // Stream line-by-line instead of applying a byte/event budget. Individual malformed
    // or non-UTF-8 lines are skipped, but later valid lines are still parsed. A read
    // error stops iteration rather than spinning: `BufReader::split(..).filter_map(ok)`
    // would silently drop a persistent `Err` and re-poll the same failing position
    // forever, so we drive `read_until` directly and break on error.
    let mut reader = BufReader::new(file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(_) => break, // stop on read error instead of looping on it
        }
        while matches!(buf.last(), Some(b'\n' | b'\r')) {
            buf.pop();
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !visit(value) {
            break;
        }
    }
}

fn visit_json_lines_reversed(path: &Path, mut visit: impl FnMut(Value) -> bool) {
    const CHUNK_SIZE: u64 = 64 * 1024;
    let Ok(mut file) = fs::File::open(path) else {
        return;
    };
    let Ok(mut pos) = file.seek(SeekFrom::End(0)) else {
        return;
    };
    let mut carry: Vec<u8> = Vec::new();

    while pos > 0 {
        let read_size = pos.min(CHUNK_SIZE);
        pos -= read_size;
        if file.seek(SeekFrom::Start(pos)).is_err() {
            return;
        }
        let mut chunk = vec![0; read_size as usize];
        if file.read_exact(&mut chunk).is_err() {
            return;
        }
        chunk.extend_from_slice(&carry);
        let mut parts = chunk.split(|b| *b == b'\n').collect::<Vec<_>>();
        carry = parts.first().map_or_else(Vec::new, |part| part.to_vec());
        for part in parts.drain(1..).rev() {
            if part.is_empty() {
                continue;
            }
            let Ok(line) = std::str::from_utf8(part) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if !visit(value) {
                return;
            }
        }
    }

    if !carry.is_empty() {
        if let Ok(line) = std::str::from_utf8(&carry) {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                let _ = visit(value);
            }
        }
    }
}

fn visible_external_prompt_text(text: &str) -> Option<String> {
    let sanitized = sanitize_external_text(text);
    let trimmed = sanitized.trim();
    if trimmed.is_empty() || is_external_control_prompt(trimmed) {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn external_control_status_text(text: &str) -> Option<String> {
    let extracted = extract_local_command_output(text)?;
    let sanitized = sanitize_external_text(extracted);
    let trimmed = sanitized.trim();
    (!trimmed.is_empty()).then(|| title_from_text(trimmed))
}

fn extract_local_command_output(text: &str) -> Option<&str> {
    extract_xml_tag(text, "local-command-stdout")
        .or_else(|| extract_xml_tag(text, "local-command-stderr"))
}

fn sanitize_external_text(text: &str) -> String {
    strip_ansi_sequences(text)
        .chars()
        .filter(|ch| {
            *ch == '\n'
                || *ch == '\t'
                || !ch.is_control()
                || matches!(*ch, '\u{200b}' | '\u{200c}' | '\u{200d}')
        })
        .collect()
}

fn strip_ansi_sequences(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if (ch == '\x1b' || ch == '\u{fffd}') && chars.peek() == Some(&'[') {
            let _ = chars.next();
            for terminator in chars.by_ref() {
                if ('@'..='~').contains(&terminator) {
                    break;
                }
            }
            continue;
        }
        out.push(ch);
    }

    out
}

fn is_external_control_prompt(text: &str) -> bool {
    const CONTROL_TAGS: &[&str] = &[
        "command-name",
        "command-message",
        "command-args",
        "local-command-stdout",
        "local-command-stderr",
        "local-command-caveat",
    ];

    CONTROL_TAGS
        .iter()
        .any(|tag| contains_xml_tag_pair(text, tag))
}

fn contains_xml_tag_pair(text: &str, tag: &str) -> bool {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    text.contains(&open) && text.contains(&close)
}

/// Extract a real user prompt's text from a Claude `type:"user"` entry.
///
/// Claude stores BOTH genuine user prompts and tool results as `type:"user"`. A prompt's
/// `message.content` is either a plain string or an array of blocks that includes `text`
/// blocks (e.g. when images are attached). A tool result is an array containing only
/// `tool_result` blocks. We return text for the former and `None` for the latter, so
/// tool results are neither rendered as prompts nor counted as conversation turns.
fn claude_user_text(value: &Value) -> Option<String> {
    claude_user_raw_text(value).and_then(|text| visible_external_prompt_text(&text))
}

fn claude_user_raw_text(value: &Value) -> Option<String> {
    let content = value.get("message").and_then(|m| m.get("content"))?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }

    if let Some(blocks) = content.as_array() {
        let text = blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        return (!text.trim().is_empty()).then_some(text);
    }

    None
}

fn message_content_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };
    items
        .iter()
        .filter_map(|item| {
            item.get("text")
                .or_else(|| item.get("content"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn usage_payload(usage: &Value, model: Option<&str>) -> Value {
    serde_json::json!({
        "inputTokens": usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
        "outputTokens": usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
        "cacheReadTokens": usage.get("cache_read_input_tokens").and_then(Value::as_u64).unwrap_or(0),
        "cacheCreationTokens": usage.get("cache_creation_input_tokens").and_then(Value::as_u64).unwrap_or(0),
        "costUsd": null,
        "model": model,
    })
}

fn slice_recent_events(events: Vec<StoredEvent>, offset: usize, limit: usize) -> Vec<StoredEvent> {
    if limit == 0 || offset >= events.len() {
        return Vec::new();
    }
    let end = events.len() - offset;
    let start = end.saturating_sub(limit);
    events[start..end].to_vec()
}

fn reverse_events_page(
    path: &Path,
    offset: usize,
    limit: usize,
    pairs: impl Fn(&Value) -> Vec<(String, Value)>,
) -> Vec<StoredEvent> {
    let mut seen = 0_usize;
    let mut newest_first: Vec<(String, Value)> = Vec::new();
    visit_json_lines_reversed(path, |value| {
        let mut events = pairs(&value);
        while let Some((kind, payload)) = events.pop() {
            if seen < offset {
                seen = seen.saturating_add(1);
                continue;
            }
            if newest_first.len() >= limit {
                return false;
            }
            newest_first.push((kind, payload));
            seen = seen.saturating_add(1);
        }
        true
    });
    newest_first.reverse();
    newest_first
        .into_iter()
        .enumerate()
        .map(|(seq, (kind, payload))| StoredEvent {
            seq: seq as i64,
            kind,
            payload_json: payload.to_string(),
            ts: 0,
        })
        .collect()
}

fn push_event(out: &mut Vec<StoredEvent>, kind: &str, payload: Value) {
    out.push(StoredEvent {
        seq: out.len() as i64,
        kind: kind.to_string(),
        payload_json: payload.to_string(),
        ts: 0,
    });
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "".to_string())
}

fn collect_patch_file_paths(patch: &str, out: &mut BTreeSet<String>) {
    for line in patch.lines() {
        let path = line
            .strip_prefix("*** Update File: ")
            .or_else(|| line.strip_prefix("*** Add File: "))
            .or_else(|| line.strip_prefix("*** Delete File: "));
        if let Some(path) = path {
            let trimmed = path.trim();
            if !trimmed.is_empty() {
                out.insert(trimmed.to_string());
            }
        }
    }
}

fn title_from_text(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.is_empty() {
        return "Untitled session".to_string();
    }
    let capped: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        let mut truncated: String = capped.chars().take(59).collect();
        truncated.push('…');
        truncated
    } else {
        capped
    }
}

fn external_id(agent: &str, path: &Path) -> String {
    // Hash the path's raw OS bytes, NOT a lossy UTF-8 string. `to_string_lossy` replaces
    // invalid byte sequences with U+FFFD, so two distinct paths differing only in
    // non-UTF-8 bytes (legal on Unix/macOS) could collapse to the same id and resolve to
    // the wrong transcript. Raw bytes are collision-free, and for the common valid-UTF-8
    // path they equal the previous hash input, so existing ids are preserved.
    let mut identity = Vec::with_capacity(agent.len() + 1 + 96);
    identity.extend_from_slice(agent.as_bytes());
    identity.push(0);
    identity.extend_from_slice(&os_path_bytes(path));
    format!("external:{agent}:{:016x}", stable_hash(&identity))
}

/// The path's native OS bytes, losslessly. On Unix these are the raw path bytes; on
/// Windows the UTF-16 code units encoded little-endian. Used for collision-free hashing.
#[cfg(unix)]
fn os_path_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
fn os_path_bytes(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .flat_map(|unit| unit.to_le_bytes())
        .collect()
}

fn stable_hash(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn modified_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// True when `path` is one of Kineloop's own per-session worktrees, so the app doesn't
/// list a duplicate of a session it created. Handles both the raw cwd form (with the
/// OS-native separator — `/` on Unix, `\` on Windows) and Claude's dash-encoded project
/// directory form. Matches both the current `.kineloop` directory and the legacy
/// `.agent-editor` one so transcripts recorded before the rename are still recognized.
fn is_kineloop_worktree(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.contains("/.kineloop/worktrees/")
        || normalized.contains("/.agent-editor/worktrees/")
        || path.contains("-kineloop-worktrees-")
        || path.contains("-agent-editor-worktrees-")
}

fn is_claude_subagent_path(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == "subagents")
}

/// Test seam: discover under an explicit home (`<home>/.claude/projects`,
/// `<home>/.codex/sessions`, `<home>/.gemini/tmp`) so tests are hermetic and never
/// read the real profile or env overrides.
#[cfg(test)]
fn test_roots(home: &Path) -> DiscoveryRoots {
    DiscoveryRoots {
        claude_projects: Some(home.join(".claude").join("projects")),
        codex_sessions: Some(home.join(".codex").join("sessions")),
        gemini_tmp: Some(home.join(".gemini").join("tmp")),
        antigravity_cli: Some(home.join(".gemini").join("antigravity-cli")),
    }
}

#[cfg(test)]
fn list_sessions_in(home: &Path) -> Vec<SessionSummary> {
    list_sessions_from(&test_roots(home))
}

#[cfg(test)]
fn events_for_session_in(home: &Path, session_id: &str) -> Option<Vec<StoredEvent>> {
    events_for_session_from(&test_roots(home), session_id)
}

#[cfg(test)]
fn events_page_for_session_in(
    home: &Path,
    session_id: &str,
    offset: usize,
    limit: usize,
) -> Option<Vec<StoredEvent>> {
    events_page_for_session_from(&test_roots(home), session_id, offset, limit)
}

#[cfg(test)]
fn repo_for_session_in(home: &Path, session_id: &str) -> Option<PathBuf> {
    repo_for_session_from(&test_roots(home), session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ae-external-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_oversized_claude_session() {
        // Regression: an active transcript can grow very large. It must still appear in
        // the list, and the summary counts must include events after the old 8 MB budget.
        let home = temp_home("claude-big");
        let dir = home.join(".claude/projects/-repo");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.jsonl");

        let mut content = String::from(
            r#"{"type":"user","cwd":"/work/repo","gitBranch":"main","message":{"role":"user","content":"Find the bug"}}"#,
        );
        content.push('\n');
        // Pad past 8 MB with valid assistant lines so the file exceeds the old read cap,
        // then add another user turn after that boundary. The second turn proves the
        // summary parser did not stop early.
        let filler = format!(
            "{}\n",
            format_args!(
                r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{}"}}]}}}}"#,
                "x".repeat(1000)
            )
        );
        while content.len() < 9 * 1024 * 1024 {
            content.push_str(&filler);
        }
        content.push_str(
            r#"{"type":"user","cwd":"/work/repo","gitBranch":"main","message":{"role":"user","content":"After old cap"}}"#,
        );
        content.push('\n');
        fs::write(&path, &content).unwrap();

        let sessions = list_sessions_in(&home);
        assert_eq!(sessions.len(), 1, "oversized session must still be listed");
        assert_eq!(sessions[0].agent, "claude");
        assert_eq!(sessions[0].title, "Find the bug");
        assert_eq!(sessions[0].repo, "/work/repo");
        assert_eq!(sessions[0].turn_count, Some(2));

        let events = events_for_session_in(&home, &sessions[0].id).unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.payload_json.contains("After old cap")),
            "events after the old byte cap must still be returned"
        );
        let first_page = events_page_for_session_in(&home, &sessions[0].id, 0, 1).unwrap();
        let second_page = events_page_for_session_in(&home, &sessions[0].id, 1, 1).unwrap();
        assert_eq!(first_page.len(), 1);
        assert_eq!(second_page.len(), 1);
        assert!(
            first_page[0].payload_json.contains("After old cap"),
            "first page must start from the newest end of the transcript"
        );
        assert!(
            !second_page[0].payload_json.contains("After old cap"),
            "second page must move older from the newest page"
        );

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn read_json_lines_reads_all_valid_lines() {
        let home = temp_home("all-lines");
        let path = home.join("lines.jsonl");
        let line = r#"{"n":1}"#;
        fs::write(&path, format!("{line}\nnot json\n{line}\n{line}\n")).unwrap();
        let got = read_json_lines(&path);
        assert_eq!(got.len(), 3);
        assert!(got
            .iter()
            .all(|value| value.get("n").and_then(Value::as_u64) == Some(1)));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn readable_session_file_does_not_reject_large_files() {
        let home = temp_home("readable");
        let path = home.join("big.jsonl");
        fs::write(&path, "x".repeat(9 * 1024 * 1024)).unwrap();
        assert!(readable_session_file(&path));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn lists_and_reads_claude_project_session() {
        let home = temp_home("claude");
        let dir = home.join(".claude/projects/-repo");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("abc.jsonl");
        fs::write(
            &path,
            r#"{"type":"user","sessionId":"abc","cwd":"/repo","gitBranch":"main","message":{"role":"user","content":"Build the thing"}}"#
                .to_string()
                + "\n"
                + r#"{"type":"assistant","sessionId":"abc","cwd":"/repo","message":{"role":"assistant","model":"opus","content":[{"type":"text","text":"Done"},{"type":"tool_use","name":"Edit","input":{"file_path":"x.ts"}}],"usage":{"input_tokens":3,"output_tokens":4}}}"#
                + "\n",
        )
        .unwrap();

        let sessions = list_sessions_in(&home);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].agent, "claude");
        assert_eq!(sessions[0].source, "external");
        assert_eq!(sessions[0].title, "Build the thing");
        assert_eq!(sessions[0].turn_count, Some(1));
        assert_eq!(sessions[0].tool_call_count, Some(1));
        assert_eq!(sessions[0].file_action_count, Some(1));

        let events = events_for_session_in(&home, &sessions[0].id).unwrap();
        assert_eq!(events[0].kind, "prompt");
        assert!(events.iter().any(|e| e.kind == "toolCall"));
        assert!(events.iter().any(|e| e.kind == "usage"));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn lists_and_reads_codex_session() {
        let home = temp_home("codex");
        let dir = home.join(".codex/sessions/2026/06/29");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout.jsonl");
        fs::write(
            &path,
            r#"{"type":"session_meta","payload":{"session_id":"codex-1","cwd":"/repo","model":"gpt-5"}}"#
                .to_string()
                + "\n"
                + r#"{"type":"event_msg","payload":{"type":"user_message","message":"Fix sessions"}}"#
                + "\n"
                + r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Implemented"}]}}"#
                + "\n"
                + r#"{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"test\"}"}}"#
                + "\n"
                + r#"{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-old\n+new\n*** End Patch"}}"#
                + "\n",
        )
        .unwrap();

        let sessions = list_sessions_in(&home);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].agent, "codex");
        assert_eq!(sessions[0].repo, "/repo");
        assert_eq!(sessions[0].title, "Fix sessions");
        assert_eq!(sessions[0].turn_count, Some(1));
        assert_eq!(sessions[0].tool_call_count, Some(2));
        assert_eq!(sessions[0].file_action_count, Some(1));

        let events = events_for_session_in(&home, &sessions[0].id).unwrap();
        assert_eq!(events[0].kind, "prompt");
        assert!(events.iter().any(|e| e.kind == "token"));
        assert!(events.iter().any(|e| e.kind == "toolCall"));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn codex_control_messages_are_not_rendered_or_counted() {
        let home = temp_home("codex-control");
        let dir = home.join(".codex/sessions/2026/07/01");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout.jsonl");
        fs::write(
            &path,
            [
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {"session_id": "codex-control", "cwd": "/repo", "model": "gpt-5"}
                })
                .to_string(),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "user_message",
                        "message": "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"
                    }
                })
                .to_string(),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": {
                        "type": "user_message",
                        "message": "<local-command-stdout>\u{1b}[2mCompacted\u{1b}[22m</local-command-stdout>"
                    }
                })
                .to_string(),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": {"type": "user_message", "message": "Real user task"}
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let sessions = list_sessions_in(&home);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "Real user task");
        assert_eq!(sessions[0].turn_count, Some(1));

        let events = events_for_session_in(&home, &sessions[0].id).unwrap();
        let prompts: Vec<&str> = events
            .iter()
            .filter(|e| e.kind == "prompt")
            .map(|e| e.payload_json.as_str())
            .collect();
        assert_eq!(
            prompts.len(),
            1,
            "control prompts should be hidden: {prompts:?}"
        );
        assert!(prompts[0].contains("Real user task"));
        assert!(!prompts[0].contains("command-name"));
        assert!(!prompts[0].contains("local-command-stdout"));
        let statuses: Vec<&str> = events
            .iter()
            .filter(|e| e.kind == "status")
            .map(|e| e.payload_json.as_str())
            .collect();
        assert_eq!(statuses.len(), 1);
        assert!(statuses[0].contains("Compacted"));
        assert!(!statuses[0].contains("\\u001b"));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn lists_and_reads_gemini_chat_session() {
        let home = temp_home("gemini");
        let slug = home.join(".gemini/tmp/myproj");
        fs::create_dir_all(slug.join("chats")).unwrap();
        fs::write(slug.join(".project_root"), "/repo").unwrap();
        let path = slug.join("chats/session-2026-04-26T13-20-abc.json");
        fs::write(
            &path,
            r#"{
              "sessionId":"abc",
              "messages":[
                {"type":"info","content":"update available"},
                {"type":"user","content":"Build the landing page"},
                {"type":"gemini","content":"On it.","model":"gemini-3-pro","tokens":{"input":10,"output":5,"cached":0},
                 "toolCalls":[
                   {"name":"read_file","args":{"file_path":"a.ts"}},
                   {"name":"write_file","args":{"file_path":"b.ts","content":"x"}}
                 ]},
                {"type":"user","content":[{"text":"@src now refactor"}]}
              ]
            }"#,
        )
        .unwrap();

        let sessions = list_sessions_in(&home);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].agent, "gemini");
        assert_eq!(sessions[0].source, "external");
        assert_eq!(sessions[0].repo, "/repo");
        assert_eq!(sessions[0].title, "Build the landing page");
        assert_eq!(sessions[0].branch, "gemini-3-pro");
        // Two genuine user prompts (string + array-form); the info line is not a turn.
        assert_eq!(sessions[0].turn_count, Some(2));
        assert_eq!(sessions[0].tool_call_count, Some(2));
        // Only write_file counts as a file action, not read_file.
        assert_eq!(sessions[0].file_action_count, Some(1));

        let events = events_for_session_in(&home, &sessions[0].id).unwrap();
        let prompts: Vec<&str> = events
            .iter()
            .filter(|e| e.kind == "prompt")
            .map(|e| e.payload_json.as_str())
            .collect();
        assert_eq!(prompts.len(), 2);
        assert!(prompts.iter().any(|p| p.contains("landing page")));
        assert!(prompts.iter().any(|p| p.contains("refactor")));
        assert!(events.iter().any(|e| e.kind == "token"));
        assert!(events.iter().any(|e| e.kind == "toolCall"));
        assert!(events.iter().any(|e| e.kind == "usage"));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn repo_for_session_resolves_external_session_repo() {
        // A CLI session's customizations scope is its real repo path, so the
        // Customizations tab can read that repo's `.claude` config.
        let home = temp_home("repo-scope");
        let dir = home.join(".claude/projects/-repo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("abc.jsonl"),
            r#"{"type":"user","cwd":"/work/myrepo","message":{"role":"user","content":"hi"}}"#,
        )
        .unwrap();

        let sessions = list_sessions_in(&home);
        assert_eq!(sessions.len(), 1);
        let repo = repo_for_session_in(&home, &sessions[0].id);
        assert_eq!(repo, Some(PathBuf::from("/work/myrepo")));

        // Unknown id resolves to nothing.
        assert_eq!(repo_for_session_in(&home, "external:claude:deadbeef"), None);

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn lists_and_reads_antigravity_cli_session() {
        let home = temp_home("antigravity");
        let conv = "372889f6-a3d2-4126-8b99-88998fbf2da9";
        let cli = home.join(".gemini/antigravity-cli");
        let logs = cli.join(format!("brain/{conv}/.system_generated/logs"));
        fs::create_dir_all(&logs).unwrap();
        // history.jsonl maps conversationId -> workspace.
        fs::write(
            cli.join("history.jsonl"),
            [
                r#"{"display":"/q","timestamp":1,"workspace":"/repo"}"#,
                &format!(
                    r#"{{"display":"Hi","timestamp":2,"workspace":"/repo","conversationId":"{conv}"}}"#
                ),
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            logs.join("transcript_full.jsonl"),
            [
                r#"{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_REQUEST>\nBuild the page\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>"}"#,
                r#"{"step_index":1,"source":"SYSTEM","type":"CONVERSATION_HISTORY"}"#,
                r#"{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","content":"On it.","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/repo/a.ts"}},{"name":"write_file","args":{"AbsolutePath":"/repo/b.ts"}}]}"#,
                r#"{"step_index":3,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_REQUEST>\nnow refactor\n</USER_REQUEST>"}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let sessions = list_sessions_in(&home);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].agent, "antigravity");
        assert_eq!(sessions[0].source, "external");
        assert_eq!(sessions[0].repo, "/repo");
        assert_eq!(sessions[0].title, "Build the page");
        assert_eq!(sessions[0].turn_count, Some(2));
        assert_eq!(sessions[0].tool_call_count, Some(2));
        // Only write_file is a file action, not view_file.
        assert_eq!(sessions[0].file_action_count, Some(1));

        let events = events_for_session_in(&home, &sessions[0].id).unwrap();
        let prompts: Vec<&str> = events
            .iter()
            .filter(|e| e.kind == "prompt")
            .map(|e| e.payload_json.as_str())
            .collect();
        assert_eq!(prompts.len(), 2);
        assert!(prompts.iter().any(|p| p.contains("Build the page")));
        assert!(prompts.iter().any(|p| p.contains("refactor")));
        // The <USER_REQUEST> wrapper and metadata tags must be stripped.
        assert!(!prompts.iter().any(|p| p.contains("USER_REQUEST")));
        assert!(events.iter().any(|e| e.kind == "token"));
        assert!(events.iter().any(|e| e.kind == "toolCall"));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn claude_turn_count_excludes_tool_results_and_renders_array_text_prompts() {
        // A real session shape: one string prompt, one array-form (image+text) prompt,
        // a tool_result (also type:"user"), and an assistant turn. Only the two genuine
        // prompts count as turns and render; the tool_result must not.
        let home = temp_home("claude-turns");
        let dir = home.join(".claude/projects/-repo");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        fs::write(
            &path,
            [
                r#"{"type":"user","cwd":"/repo","message":{"role":"user","content":"first prompt"}}"#,
                r#"{"type":"assistant","cwd":"/repo","message":{"role":"assistant","content":[{"type":"text","text":"ok"},{"type":"tool_use","name":"Read","input":{"file_path":"a.ts"}}]}}"#,
                r#"{"type":"user","cwd":"/repo","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file body"}]}}"#,
                r#"{"type":"user","cwd":"/repo","message":{"role":"user","content":[{"type":"text","text":"[Image #1] second prompt"}]}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let sessions = list_sessions_in(&home);
        assert_eq!(sessions.len(), 1);
        // 2 real prompts, NOT 3 (tool_result excluded).
        assert_eq!(sessions[0].turn_count, Some(2));

        let events = events_for_session_in(&home, &sessions[0].id).unwrap();
        let prompts: Vec<&str> = events
            .iter()
            .filter(|e| e.kind == "prompt")
            .map(|e| e.payload_json.as_str())
            .collect();
        assert_eq!(prompts.len(), 2, "both prompts should render: {prompts:?}");
        assert!(prompts.iter().any(|p| p.contains("first prompt")));
        // The array-form (image+text) prompt must render, not be dropped.
        assert!(prompts.iter().any(|p| p.contains("second prompt")));
        // The tool_result must NOT have produced a prompt event.
        assert!(!prompts.iter().any(|p| p.contains("file body")));
    }

    #[test]
    fn visible_prompt_text_filters_cli_control_wrappers_and_ansi() {
        assert_eq!(
            visible_external_prompt_text("  \x1b[2mActual prompt\x1b[22m  "),
            Some("Actual prompt".to_string())
        );
        assert_eq!(
            visible_external_prompt_text("  \u{fffd}[2mActual prompt\u{fffd}[22m  "),
            Some("Actual prompt".to_string())
        );
        assert_eq!(
            visible_external_prompt_text(
                "<command-name>/compact</command-name>\n<command-message>compact</command-message>"
            ),
            None
        );
        assert_eq!(
            visible_external_prompt_text("<local-command-stdout>Compacted</local-command-stdout>"),
            None
        );
        assert_eq!(
            external_control_status_text(
                "<local-command-stdout>\x1b[2mCompacted\x1b[22m</local-command-stdout>"
            ),
            Some("Compacted".to_string())
        );
    }

    #[test]
    fn path_looks_absolute_accepts_both_conventions_and_rejects_labels() {
        // Unix absolute.
        assert!(path_looks_absolute("/work/myrepo"));
        // Windows drive-absolute, both separator styles.
        assert!(path_looks_absolute(r"C:\Users\me\repo"));
        assert!(path_looks_absolute("C:/Users/me/repo"));
        // UNC / Windows root.
        assert!(path_looks_absolute(r"\\server\share\repo"));
        // Placeholder labels (no recorded cwd) must be rejected.
        assert!(!path_looks_absolute("Claude CLI"));
        assert!(!path_looks_absolute("Codex CLI"));
        assert!(!path_looks_absolute("Gemini CLI"));
        assert!(!path_looks_absolute("Antigravity CLI"));
        // Relative paths are not a resolvable scope.
        assert!(!path_looks_absolute("repo"));
        assert!(!path_looks_absolute("./repo"));
        assert!(!path_looks_absolute(""));
        // Drive-relative (`C:repo`, no separator) is not absolute on Windows.
        assert!(!path_looks_absolute("C:repo"));
    }

    #[test]
    fn repo_for_session_accepts_windows_cwd_on_any_host() {
        // A session recorded on Windows carries a `C:\…` cwd. The repo must
        // resolve regardless of the host OS reading it — `Path::is_absolute`
        // would have dropped it on macOS.
        let home = temp_home("win-cwd");
        let dir = home.join(".claude/projects/-repo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("abc.jsonl"),
            r#"{"type":"user","cwd":"C:\\Users\\me\\proj","message":{"role":"user","content":"hi"}}"#,
        )
        .unwrap();
        let sessions = list_sessions_in(&home);
        let repo = repo_for_session_in(&home, &sessions[0].id);
        assert_eq!(repo, Some(PathBuf::from(r"C:\Users\me\proj")));
    }

    #[test]
    fn repo_for_session_accepts_windows_cwd_for_codex() {
        // Codex records cwd in session_meta; on Windows it is a `C:\…` path
        // (JSON-escaped backslashes). It must resolve as the scope on any host.
        let home = temp_home("win-codex");
        let dir = home.join(".codex/sessions/2026/06/29");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("rollout.jsonl"),
            r#"{"type":"session_meta","payload":{"session_id":"c1","cwd":"C:\\work\\proj","model":"gpt-5.5"}}"#.to_string()
                + "\n"
                + r#"{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}"#
                + "\n",
        )
        .unwrap();
        let sessions = list_sessions_in(&home);
        let repo = repo_for_session_in(&home, &sessions[0].id);
        assert_eq!(repo, Some(PathBuf::from(r"C:\work\proj")));
    }

    #[test]
    fn repo_for_session_accepts_windows_workspace_for_antigravity() {
        // Antigravity maps conversationId -> workspace in history.jsonl; on
        // Windows the workspace is a `C:\…` path that must resolve on any host.
        let home = temp_home("win-agy");
        let conv = "conv-win";
        let cli = home.join(".gemini/antigravity-cli");
        let logs = cli.join(format!("brain/{conv}/.system_generated/logs"));
        fs::create_dir_all(&logs).unwrap();
        fs::write(
            cli.join("history.jsonl"),
            format!(
                r#"{{"display":"Hi","timestamp":2,"workspace":"C:\\work\\proj","conversationId":"{conv}"}}"#
            ) + "\n",
        )
        .unwrap();
        fs::write(
            logs.join("transcript_full.jsonl"),
            r#"{"step_index":1,"source":"USER","type":"USER_INPUT","content":"<USER_REQUEST>Hi</USER_REQUEST>"}"#.to_string() + "\n",
        )
        .unwrap();
        let sessions = list_sessions_in(&home);
        let repo = repo_for_session_in(&home, &sessions[0].id);
        assert_eq!(repo, Some(PathBuf::from(r"C:\work\proj")));
    }

    #[test]
    fn is_kineloop_worktree_matches_unix_and_windows_paths() {
        // Current `.kineloop` worktree (Unix + Windows).
        assert!(is_kineloop_worktree("/Users/me/.kineloop/worktrees/abc"));
        assert!(is_kineloop_worktree(r"C:\Users\me\.kineloop\worktrees\abc"));
        // Legacy `.agent-editor` worktree (pre-rename transcripts) still recognized.
        assert!(is_kineloop_worktree(
            "/Users/me/.agent-editor/worktrees/abc"
        ));
        assert!(is_kineloop_worktree(
            r"C:\Users\me\.agent-editor\worktrees\abc"
        ));
        // Claude's dash-encoded project-dir form (current + legacy).
        assert!(is_kineloop_worktree("-Users-me--kineloop-worktrees-id"));
        assert!(is_kineloop_worktree("-Users-me--agent-editor-worktrees-id"));
        // A normal repo must NOT be treated as a Kineloop worktree.
        assert!(!is_kineloop_worktree("/Users/me/projects/my-app"));
        assert!(!is_kineloop_worktree(r"C:\Users\me\projects\my-app"));
    }

    #[test]
    fn malformed_line_does_not_truncate_later_events() {
        // A non-JSON line between two valid events must be skipped, not stop the parse
        // and drop everything after it (regression guard for `map_while` truncation).
        let home = temp_home("malformed");
        let dir = home.join(".claude/projects/-repo");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("abc.jsonl");
        fs::write(
            &path,
            r#"{"type":"user","cwd":"/repo","message":{"role":"user","content":"first"}}"#
                .to_string()
                + "\n"
                + "this is not valid json at all {{{\n"
                + r#"{"type":"assistant","cwd":"/repo","message":{"role":"assistant","content":[{"type":"text","text":"after the bad line"}]}}"#
                + "\n",
        )
        .unwrap();

        let sessions = list_sessions_in(&home);
        assert_eq!(sessions.len(), 1);
        let events = events_for_session_in(&home, &sessions[0].id).unwrap();
        // The assistant token AFTER the malformed line must survive.
        assert!(
            events.iter().any(|e| e.kind == "token"),
            "events after a malformed line were dropped: {events:?}"
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn skips_kineloop_claude_worktree_duplicates() {
        let home = temp_home("skip");
        let dir = home.join(".claude/projects/-Users-me--agent-editor-worktrees-id");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("abc.jsonl"),
            r#"{"type":"user","sessionId":"abc","cwd":"/Users/me/.agent-editor/worktrees/abc","message":{"content":"hi"}}"#,
        )
        .unwrap();

        assert!(list_sessions_in(&home).is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn skips_claude_subagent_transcripts() {
        let home = temp_home("claude-subagent");
        let dir = home.join(".claude/projects/-repo/session-1/subagents");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("agent-reviewer.jsonl"),
            r#"{"type":"user","sessionId":"session-1","isSidechain":true,"cwd":"/repo","message":{"content":"Review task"}}"#,
        )
        .unwrap();

        assert!(list_sessions_in(&home).is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn skips_codex_subagent_threads() {
        let home = temp_home("codex-subagent");
        let dir = home.join(".codex/sessions/2026/06/29");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("rollout-subagent.jsonl"),
            r#"{"type":"session_meta","payload":{"session_id":"parent","cwd":"/repo","model":"gpt-5","thread_source":"subagent","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}}}"#
                .to_string()
                + "\n"
                + r#"{"type":"event_msg","payload":{"type":"user_message","message":"Read-only review"}}"#,
        )
        .unwrap();

        assert!(list_sessions_in(&home).is_empty());
        let _ = fs::remove_dir_all(home);
    }
}

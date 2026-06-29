use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum InspectError {
    #[error("path not allowed: {0}")]
    Forbidden(String),
    #[error("content too large (max 1 MiB)")]
    ContentTooLarge,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Worktree(#[from] crate::worktree::WorktreeError),
}

/// A rule/memory/config file the agent may load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFile {
    pub path: String,
    pub label: String,
    pub scope: String, // "project" | "global"
    pub exists: bool,
}

/// Candidate rule/config files for a worktree + known global config locations.
pub fn rule_candidates(worktree: &Path) -> Vec<RuleFile> {
    let mut out = Vec::new();
    let project = [
        ("CLAUDE.md", "CLAUDE.md"),
        (".claude/CLAUDE.md", ".claude/CLAUDE.md"),
        ("AGENTS.md", "AGENTS.md"),
        ("GEMINI.md", "GEMINI.md"),
        (".mcp.json", "MCP config (.mcp.json)"),
    ];
    for (rel, label) in project {
        let p = worktree.join(rel);
        out.push(RuleFile {
            exists: p.is_file(),
            path: p.display().to_string(),
            label: label.into(),
            scope: "project".into(),
        });
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let global = [
            (".claude/CLAUDE.md", "~/.claude/CLAUDE.md"),
            (".codex/config.toml", "~/.codex/config.toml"),
            (".gemini/GEMINI.md", "~/.gemini/GEMINI.md"),
        ];
        for (rel, label) in global {
            let p = home.join(rel);
            out.push(RuleFile {
                exists: p.is_file(),
                path: p.display().to_string(),
                label: label.into(),
                scope: "global".into(),
            });
        }
    }
    out
}

/// Build the set of paths that both `read_text_file` and `write_text_file` are
/// permitted to access. Keeping this in one place ensures the two operations share
/// identical validation — a drift between them would create a security gap.
///
/// Includes:
/// - Rule/config candidates (CLAUDE.md, AGENTS.md, etc.) whose canonical path
///   resides INSIDE the canonical worktree OR is one of the exact expected global
///   config files (`is_expected_global`).
/// - Capability backing files (skills, subagents, commands) whose canonical path
///   resides INSIDE the canonical worktree OR inside the user's `~/.claude` tree.
///
/// Every path is already canonicalized (symlinks fully resolved) so containment
/// checks are exact; a symlink that escapes the allowed roots is excluded.
fn allowed_read_write_paths(worktree: &Path, canonical_worktree: &Path) -> Vec<PathBuf> {
    let mut allowed: Vec<PathBuf> = rule_candidates(worktree)
        .into_iter()
        .filter(|r| r.exists)
        .filter_map(|r| {
            let cp = std::fs::canonicalize(&r.path).ok()?;
            if cp.starts_with(canonical_worktree) || is_expected_global(&cp) {
                Some(cp)
            } else {
                None
            }
        })
        .collect();
    // Also permit files discovered by list_capabilities — skills, subagents, and
    // commands — including user-scoped ones under `~/.claude`. Re-apply the same
    // boundary guard used for rule files: the canonical path must resolve INSIDE
    // the worktree or the user's `~/.claude` tree. A symlinked capability that
    // resolves outside those roots (e.g. ~/.ssh/id_rsa) is rejected — defence in
    // depth against a compromised WebView.
    let canonical_user_claude = std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|h| std::fs::canonicalize(h.join(".claude")).ok());
    let caps = list_capabilities("claude", worktree);
    for cap in caps.skills.into_iter().chain(caps.subagents).chain(caps.commands) {
        if cap.path.is_empty() {
            continue;
        }
        if let Ok(cp) = std::fs::canonicalize(&cap.path) {
            let in_worktree = cp.starts_with(canonical_worktree);
            let in_user_claude = canonical_user_claude
                .as_ref()
                .map(|h| cp.starts_with(h))
                .unwrap_or(false);
            if in_worktree || in_user_claude {
                allowed.push(cp);
            }
        }
    }
    allowed
}

/// Read a rule/config file, but ONLY if it is one of the exact files returned by
/// `rule_candidates(worktree)` or discovered by `list_capabilities`. Exact
/// canonicalized-path matching prevents a caller from reading arbitrary files inside
/// the worktree or the global config dirs (e.g. `~/.claude/.credentials.json`).
/// Payload is streamed-and-capped at 256 KB so a large file cannot be slurped into
/// RAM before the limit is applied.
///
/// Security: every candidate is canonicalized (symlinks fully resolved) and checked
/// against the worktree boundary or the known global config roots before being
/// added to the allowlist. See `allowed_read_write_paths` for the shared logic.
pub fn read_text_file(path: &str, worktree: &Path) -> Result<String, InspectError> {
    let target = std::fs::canonicalize(path)?;
    let canonical_worktree = std::fs::canonicalize(worktree)?;
    let allowed = allowed_read_write_paths(worktree, &canonical_worktree);
    if !allowed.contains(&target) {
        return Err(InspectError::Forbidden(path.to_string()));
    }
    use std::io::Read;
    let f = std::fs::File::open(&target)?;
    let mut buf = Vec::new();
    f.take(256 * 1024).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// Write `content` to `path`, but ONLY if `path` resolves to a file already in
/// the allowlist produced by `allowed_read_write_paths` — identical to the set
/// that `read_text_file` accepts. This guarantees read and write enforce the same
/// boundary with no risk of the two drifting apart.
///
/// The file must already exist (`canonicalize` fails for nonexistent paths): we edit
/// discovered files, we do not create arbitrary new ones.
///
/// Content larger than 1 MiB is rejected before writing to prevent the UI from
/// accidentally overwriting a file with a huge payload.
pub fn write_text_file(path: &str, content: &str, worktree: &Path) -> Result<(), InspectError> {
    // File must already exist — canonicalize resolves symlinks AND errors when absent.
    let target = std::fs::canonicalize(path)?;
    let canonical_worktree = std::fs::canonicalize(worktree)?;
    let allowed = allowed_read_write_paths(worktree, &canonical_worktree);
    if !allowed.contains(&target) {
        return Err(InspectError::Forbidden(path.to_string()));
    }
    // 1 MiB cap — large enough for any realistic agent customization file.
    if content.len() > 1024 * 1024 {
        return Err(InspectError::ContentTooLarge);
    }
    std::fs::write(&target, content)?;
    Ok(())
}

/// Returns true when `path` (already canonicalized by the caller) is one of the
/// exact global config files the app is permitted to read. The expected paths are
/// also canonicalized so that a `~/.claude` directory that is itself a symlink
/// does not produce a false-negative.
fn is_expected_global(path: &Path) -> bool {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return false };
    [".claude/CLAUDE.md", ".codex/config.toml", ".gemini/GEMINI.md"]
        .iter()
        .any(|rel| {
            std::fs::canonicalize(home.join(rel))
                .map(|c| c == path)
                .unwrap_or(false)
        })
}

// ──────────────────────────────────────────────────────────────────────────────
// Capability discovery
// ──────────────────────────────────────────────────────────────────────────────

/// A single discoverable capability (skill, subagent, or slash command).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub name: String,
    pub description: Option<String>,
    /// `"project"` when found in the worktree, `"user"` when found in `~/.claude/`.
    pub source: String,
    /// Absolute path to the capability's backing file on disk.
    /// Empty string when the capability has no known backing file.
    pub path: String,
}

/// All capability categories discovered for an agent in a worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub skills: Vec<Capability>,
    pub subagents: Vec<Capability>,
    pub commands: Vec<Capability>,
}

/// Discover an agent's skills/subagents/commands from known on-disk locations.
/// Only Claude is mapped today; others return empty (their adapters land later).
pub fn list_capabilities(agent: &str, worktree: &Path) -> Capabilities {
    if agent != "claude" {
        return Capabilities { skills: vec![], subagents: vec![], commands: vec![] };
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut subagents = Vec::new();
    let mut skills = Vec::new();
    let mut commands = Vec::new();

    collect_md(&worktree.join(".claude/agents"), "project", &mut subagents);
    if let Some(h) = &home {
        collect_md(&h.join(".claude/agents"), "user", &mut subagents);
    }
    collect_skill_dirs(&worktree.join(".claude/skills"), "project", &mut skills);
    if let Some(h) = &home {
        collect_skill_dirs(&h.join(".claude/skills"), "user", &mut skills);
    }
    collect_md(&worktree.join(".claude/commands"), "project", &mut commands);
    if let Some(h) = &home {
        collect_md(&h.join(".claude/commands"), "user", &mut commands);
    }

    subagents.sort_by(|a, b| a.name.cmp(&b.name));
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    commands.sort_by(|a, b| a.name.cmp(&b.name));

    Capabilities { skills, subagents, commands }
}

/// Push one `Capability` per `*.md` file found in `dir`.
/// Name = file stem; description is extracted best-effort; path is the absolute file path.
fn collect_md(dir: &Path, source: &str, out: &mut Vec<Capability>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        out.push(Capability {
            name: name.to_string(),
            description: first_description(&path),
            source: source.to_string(),
            path: path.display().to_string(),
        });
    }
}

/// Push one `Capability` per subdirectory of `dir` that contains a `SKILL.md`.
/// The `path` field is set to the absolute path of the `SKILL.md` file.
fn collect_skill_dirs(dir: &Path, source: &str, out: &mut Vec<Capability>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let skill_md = entry.path().join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let Some(name) = entry.path().file_name().and_then(|s| s.to_str()).map(String::from)
        else {
            continue;
        };
        out.push(Capability {
            name,
            description: first_description(&skill_md),
            source: source.to_string(),
            path: skill_md.display().to_string(),
        });
    }
}

/// Extract the first useful description line from a markdown or frontmatter file.
///
/// Scanning order:
///  1. A `description:` key on any line (YAML frontmatter or inline), stripping
///     surrounding double-quotes. This pass runs over the whole file first.
///  2. The first non-empty, non-heading (`#`), non-separator (`---`) line,
///     capped at 140 characters.
///
/// Returns `None` when the file is empty or unreadable.
fn first_description(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    // Pass 1: look for an explicit `description:` key anywhere in the file.
    for (i, line) in lines.iter().enumerate() {
        let Some(rest) = line.trim_start().strip_prefix("description:") else {
            continue;
        };
        let value = rest.trim();
        // YAML block scalar (`>`, `>-`, `|`, `|-`, …) or an empty value means the
        // real text lives on the following more-indented lines — fold them into
        // one line instead of returning the `>-`/`|` indicator itself.
        let is_block = value.is_empty() || value.starts_with('>') || value.starts_with('|');
        if is_block {
            let key_indent = line.len() - line.trim_start().len();
            let mut folded = String::new();
            for next in &lines[i + 1..] {
                if next.trim().is_empty() {
                    if folded.is_empty() {
                        continue; // leading blank lines inside the block
                    }
                    break; // blank line ends the first paragraph
                }
                let indent = next.len() - next.trim_start().len();
                if indent <= key_indent {
                    break; // dedent → next key or closing `---`
                }
                if !folded.is_empty() {
                    folded.push(' ');
                }
                folded.push_str(next.trim());
                if folded.len() >= 140 {
                    break;
                }
            }
            let folded = folded.trim();
            return if folded.is_empty() {
                None
            } else {
                Some(folded.chars().take(140).collect())
            };
        }
        return Some(value.trim_matches('"').chars().take(140).collect());
    }
    // Pass 2: first non-empty, non-heading, non-separator line.
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') || l.starts_with("---") {
            continue;
        }
        return Some(l.chars().take(140).collect());
    }
    None
}

// ──────────────────────────────────────────────────────────────────────────────
// Customization lists
// ──────────────────────────────────────────────────────────────────────────────

/// A single hook rule as configured in a Claude settings file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEntry {
    pub event: String,
    pub matcher: Option<String>,
    pub command: String,
    /// `"project"` when found in the worktree, `"user"` when found in `~/.claude/`.
    pub source: String,
}

/// A single MCP server declaration.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    pub name: String,
    pub detail: Option<String>,
    /// `"project"` when found in `<worktree>/.mcp.json`, `"user"` from `~/.claude.json`.
    pub source: String,
}

/// A single installed Claude Code plugin.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub name: String,
    pub detail: Option<String>,
    /// `"user"` if any installation is user-scope, `"project"` if only project-scoped.
    pub source: String,
}

/// Return all hook rules configured in `<worktree>/.claude/settings.json` and
/// `~/.claude/settings.json`. Each leaf command becomes one `HookEntry`. Best-effort:
/// missing or unparseable files contribute nothing.
pub fn list_hooks(worktree: &Path) -> Vec<HookEntry> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    list_hooks_with_home(worktree, home.as_deref())
}

fn list_hooks_with_home(worktree: &Path, home: Option<&Path>) -> Vec<HookEntry> {
    let mut entries = Vec::new();
    parse_hooks_from_settings(&worktree.join(".claude/settings.json"), "project", &mut entries);
    if let Some(h) = home {
        parse_hooks_from_settings(&h.join(".claude/settings.json"), "user", &mut entries);
    }
    entries
}

/// Parse the `hooks` object from a Claude settings JSON file, appending one
/// `HookEntry` per leaf command to `out`. The expected shape is:
/// `{ "hooks": { "<EventName>": [ { "matcher?": "...", "hooks": [ { "type": "command", "command": "..." } ] } ] } }`
fn parse_hooks_from_settings(path: &Path, source: &str, out: &mut Vec<HookEntry>) {
    let Ok(content) = std::fs::read_to_string(path) else { return };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else { return };
    let Some(hooks_obj) = json.get("hooks").and_then(|v| v.as_object()) else { return };

    for (event_name, groups_val) in hooks_obj {
        let Some(groups) = groups_val.as_array() else { continue };
        for group in groups {
            let matcher = group
                .get("matcher")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string());
            let Some(leaf_hooks) = group.get("hooks").and_then(|h| h.as_array()) else {
                continue;
            };
            for hook in leaf_hooks {
                // Prefer the "command" string; fall back to "type" as a brief descriptor.
                let command = hook
                    .get("command")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        hook.get("type")
                            .and_then(|t| t.as_str())
                            .unwrap_or("unknown")
                            .to_string()
                    });
                out.push(HookEntry {
                    event: event_name.clone(),
                    matcher: matcher.clone(),
                    command,
                    source: source.to_string(),
                });
            }
        }
    }
}

/// Return all MCP servers declared in `<worktree>/.mcp.json` and `~/.claude.json`.
/// Best-effort: missing or unparseable files contribute nothing.
pub fn list_mcp_servers(worktree: &Path) -> Vec<McpServerEntry> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    list_mcp_servers_with_home(worktree, home.as_deref())
}

fn list_mcp_servers_with_home(worktree: &Path, home: Option<&Path>) -> Vec<McpServerEntry> {
    let mut entries = Vec::new();
    parse_mcp_from_file(&worktree.join(".mcp.json"), "project", &mut entries);
    if let Some(h) = home {
        parse_mcp_from_file(&h.join(".claude.json"), "user", &mut entries);
    }
    entries
}

fn parse_mcp_from_file(path: &Path, source: &str, out: &mut Vec<McpServerEntry>) {
    let Ok(content) = std::fs::read_to_string(path) else { return };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else { return };
    let Some(servers) = json.get("mcpServers").and_then(|v| v.as_object()) else { return };

    for (name, config) in servers {
        // Pick the most informative single-line descriptor available.
        let detail = config
            .get("command")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| config.get("url").and_then(|v| v.as_str()).map(String::from))
            .or_else(|| config.get("type").and_then(|v| v.as_str()).map(String::from));
        out.push(McpServerEntry {
            name: name.clone(),
            detail,
            source: source.to_string(),
        });
    }
}

/// Return installed Claude Code plugins from `~/.claude/plugins/installed_plugins.json`.
/// Best-effort: missing or unparseable file returns an empty Vec. The `worktree`
/// parameter is reserved for future per-project plugin support.
pub fn list_plugins(worktree: &Path) -> Vec<PluginEntry> {
    let _ = worktree;
    let home = std::env::var_os("HOME").map(PathBuf::from);
    list_plugins_with_home(home.as_deref())
}

fn list_plugins_with_home(home: Option<&Path>) -> Vec<PluginEntry> {
    let Some(h) = home else { return Vec::new() };
    let path = h.join(".claude/plugins/installed_plugins.json");
    let Ok(content) = std::fs::read_to_string(&path) else { return Vec::new() };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else { return Vec::new() };
    let Some(plugins) = json.get("plugins").and_then(|v| v.as_object()) else {
        return Vec::new();
    };

    let mut entries = Vec::new();
    for (key, records_val) in plugins {
        // Key format: "pluginName@marketplace" (e.g. "frontend-design@claude-plugins-official").
        let (name, marketplace) = if let Some(at_pos) = key.find('@') {
            (key[..at_pos].to_string(), Some(key[at_pos + 1..].to_string()))
        } else {
            (key.clone(), None)
        };
        // "user" scope takes precedence; fall back to "project" if only project installs exist.
        let source = records_val
            .as_array()
            .map(|arr| {
                if arr
                    .iter()
                    .any(|r| r.get("scope").and_then(|s| s.as_str()) == Some("user"))
                {
                    "user"
                } else {
                    "project"
                }
            })
            .unwrap_or("user");
        entries.push(PluginEntry {
            name,
            detail: marketplace,
            source: source.to_string(),
        });
    }
    entries
}

// ──────────────────────────────────────────────────────────────────────────────
// Customization counts
// ──────────────────────────────────────────────────────────────────────────────

/// Aggregate count of per-workspace and user-level customizations. All fields are
/// best-effort: missing or unparseable files contribute 0 rather than an error.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomizationCounts {
    pub agents: u32,
    pub skills: u32,
    pub instructions: u32,
    pub hooks: u32,
    pub mcp_servers: u32,
}

/// Count customizations for a worktree + the user's ~/.claude home. Best-effort:
/// any parse failure silently contributes 0 to the relevant field.
pub fn customizations_counts(worktree: &Path) -> CustomizationCounts {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    customizations_counts_with_home(worktree, home.as_deref())
}

/// Inner implementation that accepts an explicit `home` path, enabling tests to
/// inject a fake empty directory without mutating the global environment.
fn customizations_counts_with_home(worktree: &Path, home: Option<&Path>) -> CustomizationCounts {
    let caps = list_capabilities("claude", worktree);
    let instructions = rule_candidates(worktree).into_iter().filter(|r| r.exists).count() as u32;
    let hooks = count_hooks(worktree, home);
    let mcp_servers = count_mcp(worktree, home);
    CustomizationCounts {
        agents: caps.subagents.len() as u32,
        skills: caps.skills.len() as u32,
        instructions,
        hooks,
        mcp_servers,
    }
}

/// Count hook rules — DRY: delegates to `list_hooks_with_home`.
fn count_hooks(worktree: &Path, home: Option<&Path>) -> u32 {
    list_hooks_with_home(worktree, home).len() as u32
}

/// Count MCP servers — DRY: delegates to `list_mcp_servers_with_home`.
fn count_mcp(worktree: &Path, home: Option<&Path>) -> u32 {
    list_mcp_servers_with_home(worktree, home).len() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_flag_existing_project_files() {
        let dir = std::env::temp_dir().join(format!("ae-insp-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("CLAUDE.md"), "# rules\n").unwrap();
        let cands = rule_candidates(&dir);
        let claude = cands.iter().find(|r| r.label == "CLAUDE.md").unwrap();
        assert!(claude.exists);
        assert_eq!(claude.scope, "project");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_inside_worktree_ok_outside_forbidden() {
        let dir = std::env::temp_dir().join(format!("ae-insp2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);

        // A candidate rule file — must be readable.
        std::fs::write(dir.join("CLAUDE.md"), "hello rules").unwrap();
        let inside = dir.join("CLAUDE.md");
        assert_eq!(
            read_text_file(&inside.display().to_string(), &dir).unwrap(),
            "hello rules"
        );

        // A file outside the worktree entirely — must be forbidden.
        assert!(matches!(
            read_text_file("/etc/hosts", &dir),
            Err(InspectError::Forbidden(_))
        ));

        // A non-candidate file inside the worktree — must also be forbidden,
        // proving the allow-list is per-file, not per-directory.
        std::fs::write(dir.join("secret.txt"), "credentials").unwrap();
        let non_candidate = dir.join("secret.txt");
        assert!(matches!(
            read_text_file(&non_candidate.display().to_string(), &dir),
            Err(InspectError::Forbidden(_))
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_rejects_symlink_escaping_worktree() {
        let dir = std::env::temp_dir().join(format!("ae-insp3-{}", std::process::id()));
        let worktree = dir.join("worktree");
        let outside = dir.join("outside");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        // Create a secret file outside the worktree boundary.
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "TOPSECRET").unwrap();

        // Place a symlink at CLAUDE.md (a candidate path) pointing to the secret.
        // is_file() follows symlinks, so rule_candidates will mark it as existing —
        // but read_text_file must detect that the canonical target escapes the
        // worktree and return Forbidden rather than returning the secret content.
        let link = worktree.join("CLAUDE.md");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        assert!(matches!(
            read_text_file(&link.display().to_string(), &worktree),
            Err(InspectError::Forbidden(_))
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_capabilities_discovers_subagent_and_skill_for_claude() {
        let dir =
            std::env::temp_dir().join(format!("ae-caps-{}", std::process::id()));

        // Create .claude/agents/foo.md (subagent)
        let agents_dir = dir.join(".claude/agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(
            agents_dir.join("foo.md"),
            "---\nname: foo\ndescription: Does foo\n---\n",
        )
        .unwrap();

        // Create .claude/skills/bar/SKILL.md (skill)
        let skill_dir = dir.join(".claude/skills/bar");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "---\ndescription: Bar skill\n---\n").unwrap();

        let caps = list_capabilities("claude", &dir);

        // Subagent "foo" must be found with the right description and source.
        let foo = caps.subagents.iter().find(|c| c.name == "foo")
            .expect("subagent 'foo' not found");
        assert_eq!(foo.description.as_deref(), Some("Does foo"));
        assert_eq!(foo.source, "project");

        // Skill "bar" must be found via SKILL.md.
        let bar = caps.skills.iter().find(|c| c.name == "bar")
            .expect("skill 'bar' not found");
        assert_eq!(bar.description.as_deref(), Some("Bar skill"));
        assert_eq!(bar.source, "project");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn description_folds_yaml_block_scalar_instead_of_returning_indicator() {
        let dir = std::env::temp_dir().join(format!("ae-caps-fold-{}", std::process::id()));
        let agents_dir = dir.join(".claude/agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        // YAML folded block scalar — the real description is on the indented lines.
        std::fs::write(
            agents_dir.join("folded.md"),
            "---\nname: folded\ndescription: >-\n  Use this agent for thorough\n  code reviews.\n---\n",
        )
        .unwrap();

        let caps = list_capabilities("claude", &dir);
        let folded = caps
            .subagents
            .iter()
            .find(|c| c.name == "folded")
            .expect("subagent 'folded' not found");
        // Not the ">-" indicator — the folded text, joined into one line.
        assert_eq!(
            folded.description.as_deref(),
            Some("Use this agent for thorough code reviews.")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_capabilities_returns_empty_for_non_claude_agents() {
        let dir =
            std::env::temp_dir().join(format!("ae-caps-nc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Even if there happened to be claude dirs, codex should still return empty.
        let caps = list_capabilities("codex", &dir);
        assert!(caps.skills.is_empty());
        assert!(caps.subagents.is_empty());
        assert!(caps.commands.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn customizations_counts_detects_agent_and_mcp() {
        let dir = std::env::temp_dir().join(format!("ae-cust-{}", std::process::id()));
        // Empty fake home passed directly to the inner helper — no global env mutation,
        // so this test is safe to run in parallel with siblings that also read HOME.
        let fake_home = std::env::temp_dir().join(format!("ae-cust-home-{}", std::process::id()));
        std::fs::create_dir_all(&fake_home).unwrap();

        // .claude/agents/foo.md — counts as one subagent.
        let agents_dir = dir.join(".claude/agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(agents_dir.join("foo.md"), "---\ndescription: Foo agent\n---\n").unwrap();

        // .mcp.json with exactly 1 MCP server.
        std::fs::write(
            dir.join(".mcp.json"),
            r#"{"mcpServers":{"my-server":{"command":"node","args":["server.js"]}}}"#,
        )
        .unwrap();

        let counts = customizations_counts_with_home(&dir, Some(&fake_home));
        assert!(counts.agents >= 1, "expected at least 1 agent, got {}", counts.agents);
        assert_eq!(counts.mcp_servers, 1, "expected exactly 1 MCP server");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&fake_home);
    }

    #[test]
    fn capability_path_is_populated_for_discovered_agent() {
        let dir = std::env::temp_dir().join(format!("ae-cappath-{}", std::process::id()));
        let agents_dir = dir.join(".claude/agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(agents_dir.join("foo.md"), "---\ndescription: Does foo\n---\n").unwrap();

        let caps = list_capabilities("claude", &dir);
        let foo = caps.subagents.iter().find(|c| c.name == "foo")
            .expect("subagent 'foo' not found");
        assert!(
            foo.path.ends_with("/.claude/agents/foo.md"),
            "expected path ending with /.claude/agents/foo.md, got {:?}",
            foo.path
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_text_file_succeeds_for_discovered_capability() {
        let dir = std::env::temp_dir().join(format!("ae-capread-{}", std::process::id()));
        let agents_dir = dir.join(".claude/agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        let agent_file = agents_dir.join("foo.md");
        std::fs::write(&agent_file, "agent content here").unwrap();

        let result = read_text_file(&agent_file.display().to_string(), &dir);
        assert_eq!(result.unwrap(), "agent content here");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_text_file_forbidden_for_arbitrary_file_not_in_capabilities() {
        let dir = std::env::temp_dir().join(format!("ae-capforbid-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A file inside the worktree directory but NOT a rule/capability file.
        let arbitrary = dir.join("arbitrary.txt");
        std::fs::write(&arbitrary, "should not be readable").unwrap();

        assert!(
            matches!(
                read_text_file(&arbitrary.display().to_string(), &dir),
                Err(InspectError::Forbidden(_))
            ),
            "expected Forbidden for a file not in the rules/capabilities allowlist"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn read_rejects_capability_symlink_escaping_roots() {
        let dir = std::env::temp_dir().join(format!("ae-capescape-{}", std::process::id()));
        let agents_dir = dir.join(".claude/agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        // A secret OUTSIDE the worktree and outside ~/.claude.
        let secret = std::env::temp_dir().join(format!("ae-capsecret-{}.txt", std::process::id()));
        std::fs::write(&secret, "TOP SECRET").unwrap();
        // A capability file that is a symlink to the secret. collect_md checks the
        // extension, so discovery surfaces it; canonicalize resolves to the secret.
        let link = agents_dir.join("evil.md");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        assert!(
            matches!(
                read_text_file(&link.display().to_string(), &dir),
                Err(InspectError::Forbidden(_))
            ),
            "expected Forbidden for a capability symlink resolving outside the worktree / ~/.claude"
        );

        let _ = std::fs::remove_file(&secret);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── write_text_file tests ────────────────────────────────────────────────

    #[test]
    fn write_succeeds_for_discovered_capability_file() {
        let dir = std::env::temp_dir().join(format!("ae-wrt1-{}", std::process::id()));
        let agents_dir = dir.join(".claude/agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        let agent_file = agents_dir.join("foo.md");
        std::fs::write(&agent_file, "original content").unwrap();

        let new_content = "updated agent instructions";
        write_text_file(&agent_file.display().to_string(), new_content, &dir).unwrap();

        // Verify the new content was written by reading back from disk directly.
        let on_disk = std::fs::read_to_string(&agent_file).unwrap();
        assert_eq!(on_disk, new_content);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_forbidden_for_arbitrary_file_not_in_allowlist() {
        let dir = std::env::temp_dir().join(format!("ae-wrt2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // An arbitrary file inside the worktree but NOT a rule/capability file.
        let arbitrary = dir.join("arbitrary.txt");
        std::fs::write(&arbitrary, "should not be writable").unwrap();

        assert!(
            matches!(
                write_text_file(&arbitrary.display().to_string(), "new content", &dir),
                Err(InspectError::Forbidden(_))
            ),
            "expected Forbidden for a file not in the allowlist"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_hooks_returns_entries_from_settings() {
        let dir = std::env::temp_dir().join(format!("ae-hooks-{}", std::process::id()));
        let fake_home =
            std::env::temp_dir().join(format!("ae-hooks-home-{}", std::process::id()));
        let claude_dir = dir.join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&fake_home).unwrap();

        // Two hooks in SessionStart: one without a matcher, one with.
        std::fs::write(
            claude_dir.join("settings.json"),
            r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo start"}]},{"matcher":"Bash","hooks":[{"type":"command","command":"echo bash"}]}]}}"#,
        )
        .unwrap();

        let entries = list_hooks_with_home(&dir, Some(&fake_home));
        assert_eq!(entries.len(), 2, "expected 2 hook entries, got {entries:?}");

        let no_matcher = entries.iter().find(|e| e.matcher.is_none()).unwrap();
        assert_eq!(no_matcher.event, "SessionStart");
        assert_eq!(no_matcher.command, "echo start");
        assert_eq!(no_matcher.source, "project");

        let with_matcher = entries.iter().find(|e| e.matcher.as_deref() == Some("Bash")).unwrap();
        assert_eq!(with_matcher.command, "echo bash");

        // count_hooks must equal list length.
        assert_eq!(count_hooks(&dir, Some(&fake_home)), 2);

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&fake_home);
    }

    #[test]
    fn list_mcp_servers_returns_entries_from_mcp_json() {
        let dir = std::env::temp_dir().join(format!("ae-mcp-list-{}", std::process::id()));
        let fake_home =
            std::env::temp_dir().join(format!("ae-mcp-list-home-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&fake_home).unwrap();

        std::fs::write(
            dir.join(".mcp.json"),
            r#"{"mcpServers":{"server-a":{"command":"node","args":["a.js"]},"server-b":{"url":"http://localhost:3000"}}}"#,
        )
        .unwrap();

        let entries = list_mcp_servers_with_home(&dir, Some(&fake_home));
        assert_eq!(entries.len(), 2, "expected 2 MCP servers, got {entries:?}");

        let a = entries.iter().find(|e| e.name == "server-a").unwrap();
        assert_eq!(a.detail.as_deref(), Some("node"));
        assert_eq!(a.source, "project");

        let b = entries.iter().find(|e| e.name == "server-b").unwrap();
        assert_eq!(b.detail.as_deref(), Some("http://localhost:3000"));

        // count_mcp must equal list length.
        assert_eq!(count_mcp(&dir, Some(&fake_home)), 2);

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&fake_home);
    }

    #[test]
    fn list_plugins_returns_empty_when_no_plugins_dir() {
        let fake_home =
            std::env::temp_dir().join(format!("ae-plugins-empty-{}", std::process::id()));
        std::fs::create_dir_all(&fake_home).unwrap();
        // No ~/.claude/plugins/ directory at all — must return empty gracefully.
        let entries = list_plugins_with_home(Some(&fake_home));
        assert!(entries.is_empty(), "expected empty plugin list, got {entries:?}");
        let _ = std::fs::remove_dir_all(&fake_home);
    }

    #[cfg(unix)]
    #[test]
    fn write_forbidden_for_capability_symlink_escaping_roots() {
        let dir = std::env::temp_dir().join(format!("ae-wrt3-{}", std::process::id()));
        let agents_dir = dir.join(".claude/agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        // A file OUTSIDE the worktree and outside ~/.claude.
        let outside = std::env::temp_dir().join(format!("ae-wrtsec-{}.txt", std::process::id()));
        std::fs::write(&outside, "TARGET OUTSIDE").unwrap();
        // A .md capability symlink pointing at the outside file — would be discovered
        // by collect_md, but the symlink-escape guard must still reject it.
        let link = agents_dir.join("evil.md");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        assert!(
            matches!(
                write_text_file(&link.display().to_string(), "injected", &dir),
                Err(InspectError::Forbidden(_))
            ),
            "expected Forbidden for a write via a symlink escaping the worktree / ~/.claude"
        );

        // Confirm the outside file was NOT modified.
        let unchanged = std::fs::read_to_string(&outside).unwrap();
        assert_eq!(unchanged, "TARGET OUTSIDE");

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_rejects_content_exceeding_size_cap() {
        let dir = std::env::temp_dir().join(format!("ae-wrt4-{}", std::process::id()));
        // A candidate rule file that is allowed.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("CLAUDE.md"), "initial").unwrap();
        let target = dir.join("CLAUDE.md");

        // Content just over 1 MiB.
        let oversized = "x".repeat(1024 * 1024 + 1);
        assert!(
            matches!(
                write_text_file(&target.display().to_string(), &oversized, &dir),
                Err(InspectError::ContentTooLarge)
            ),
            "expected ContentTooLarge for payload exceeding 1 MiB"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}

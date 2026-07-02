use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum InspectError {
    #[error("path not allowed: {0}")]
    Forbidden(String),
    #[error("content too large (max 1 MiB)")]
    ContentTooLarge,
    #[error("invalid name: {0}")]
    InvalidName(String),
    #[error("already exists: {0}")]
    AlreadyExists(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid config: {0}")]
    InvalidConfig(String),
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
    // Global config — resolved cross-platform and honoring each CLI's relocation env var
    // (CLAUDE_CONFIG_DIR / CODEX_HOME).
    let global = [
        (
            crate::agent_paths::claude_config_dir().map(|c| c.join("CLAUDE.md")),
            "~/.claude/CLAUDE.md",
        ),
        (
            crate::agent_paths::codex_home_dir().map(|c| c.join("config.toml")),
            "~/.codex/config.toml",
        ),
        (
            crate::agent_paths::gemini_config_dir().map(|c| c.join("GEMINI.md")),
            "~/.gemini/GEMINI.md",
        ),
    ];
    for (path, label) in global {
        if let Some(p) = path {
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

/// Build the set of paths that both `read_text_file` and `write_customization_file` are
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
    // commands. A capability file is allowed only if its canonical path resolves
    // under one of the CANONICALIZED discovery roots below. Canonicalizing the
    // roots follows directory symlinks (e.g. a `~/.claude/skills` that points at
    // `~/.agents/skills`), so legitimate symlinked capability dirs work — while a
    // FILE symlink escaping to an unrelated location (e.g. ~/.ssh/id_rsa) still
    // resolves outside every root and is rejected. Defence in depth against a
    // compromised WebView, without breaking the common symlinked-config setup.
    let mut cap_roots: Vec<PathBuf> = Vec::new();
    let worktree_claude = worktree.join(".claude");
    for sub in ["agents", "skills", "commands"] {
        if let Ok(c) = std::fs::canonicalize(worktree_claude.join(sub)) {
            cap_roots.push(c);
        }
    }
    // Must mirror the user-scope roots scanned by `list_capabilities` (honors
    // CLAUDE_CONFIG_DIR, cross-platform home).
    if let Some(claude) = crate::agent_paths::claude_config_dir() {
        for sub in ["agents", "skills", "commands"] {
            if let Ok(c) = std::fs::canonicalize(claude.join(sub)) {
                cap_roots.push(c);
            }
        }
    }
    let caps = list_capabilities("claude", worktree);
    for cap in caps
        .skills
        .into_iter()
        .chain(caps.subagents)
        .chain(caps.commands)
    {
        if cap.path.is_empty() {
            continue;
        }
        let Ok(cp) = std::fs::canonicalize(&cap.path) else {
            continue;
        };
        if cap_roots.iter().any(|root| cp.starts_with(root)) {
            allowed.push(cp);
        } else if capability_file_is_real_behind_dir_symlinks(&cap.path, &cp) {
            // Per-ENTRY directory symlink: skill managers symlink each skill dir
            // into `.claude/skills` (skills/foo -> ~/.agents/skills/foo), so the
            // canonical path escapes every discovery root even though the file is
            // genuine. Allowed only when resolving the parent directories keeps
            // the file inside them — a FILE symlink (SKILL.md -> ~/.ssh/id_rsa)
            // still resolves elsewhere and stays rejected.
            allowed.push(cp);
        }
    }
    allowed
}

/// True when `path`'s final component is a real file once its parent directories
/// are resolved — i.e. any symlinks on the way are DIRECTORY symlinks, and the
/// file itself is not a symlink. `canonical` must be `canonicalize(path)`.
fn capability_file_is_real_behind_dir_symlinks(path: &str, canonical: &Path) -> bool {
    let p = Path::new(path);
    let (Some(parent), Some(file_name)) = (p.parent(), p.file_name()) else {
        return false;
    };
    let Ok(canonical_parent) = std::fs::canonicalize(parent) else {
        return false;
    };
    let candidate = canonical_parent.join(file_name);
    let Ok(meta) = std::fs::symlink_metadata(&candidate) else {
        return false;
    };
    !meta.file_type().is_symlink() && candidate == canonical
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

/// Overwrite an existing customization file. Writable targets are exactly the files
/// the read allowlist already surfaces: rule/config files and discovered capabilities
/// resolving inside the worktree OR the user's `~/.claude` tree (plus the known global
/// config files). Editing a user-scope (`~/.claude`) customization is intentionally
/// permitted — the user asked to manage their global customizations — but every write
/// still passes the canonicalized allowlist check, so a compromised renderer cannot
/// reach an arbitrary path outside those roots.
pub fn write_customization_file(
    path: &str,
    content: &str,
    worktree: &Path,
) -> Result<(), InspectError> {
    let target = std::fs::canonicalize(path)?;
    let canonical_worktree = std::fs::canonicalize(worktree)?;
    let allowed = allowed_read_write_paths(worktree, &canonical_worktree);
    if !allowed.contains(&target) {
        return Err(InspectError::Forbidden(path.to_string()));
    }
    if content.len() > 1024 * 1024 {
        return Err(InspectError::ContentTooLarge);
    }
    std::fs::write(&target, content)?;
    Ok(())
}

/// A creatable capability category and its on-disk shape under a `.claude` root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityKind {
    /// `agents/<name>.md`
    Agent,
    /// `skills/<name>/SKILL.md`
    Skill,
    /// `commands/<name>.md`
    Command,
}

impl CapabilityKind {
    pub fn parse(kind: &str) -> Result<Self, InspectError> {
        match kind {
            "agent" => Ok(Self::Agent),
            "skill" => Ok(Self::Skill),
            "command" => Ok(Self::Command),
            other => Err(InspectError::InvalidName(format!("unknown kind: {other}"))),
        }
    }
}

/// Validate a user-supplied capability name. Must be a single path component made of
/// `[A-Za-z0-9._-]`, starting alphanumeric, at most 64 chars — this blocks path
/// separators, `..` traversal, absolute paths, and hidden dotfiles before the name is
/// ever joined onto a filesystem root.
fn validate_customization_name(name: &str) -> Result<(), InspectError> {
    let invalid = |reason: &str| Err(InspectError::InvalidName(format!("{name:?}: {reason}")));
    if name.is_empty() {
        return invalid("empty");
    }
    if name.len() > 64 {
        return invalid("longer than 64 characters");
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return invalid("must start with a letter or digit");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return invalid("only letters, digits, '.', '_', '-' allowed");
    }
    Ok(())
}

/// Scaffold body for a freshly created capability, so it validates as soon as it's saved.
fn scaffold_for(kind: CapabilityKind, name: &str) -> String {
    match kind {
        CapabilityKind::Agent => format!(
            "---\nname: {name}\ndescription: Describe when this subagent should be used.\n---\n\nWrite the subagent's system prompt here.\n"
        ),
        CapabilityKind::Skill => format!(
            "---\nname: {name}\ndescription: Describe when this skill should be used.\n---\n\n# {name}\n\nWrite the skill instructions here.\n"
        ),
        CapabilityKind::Command => {
            "---\ndescription: Describe what this command does.\n---\n\nWrite the command prompt here. Use $ARGUMENTS for user input.\n".to_string()
        }
    }
}

/// Create a new capability file under `claude_root` (a worktree's `.claude` or the user's
/// `~/.claude`). Returns the absolute path of the created backing file. Rejects invalid
/// names and refuses to overwrite an existing capability.
pub fn create_capability(
    claude_root: &Path,
    kind: CapabilityKind,
    name: &str,
) -> Result<String, InspectError> {
    validate_customization_name(name)?;
    let (dir, file): (PathBuf, PathBuf) = match kind {
        CapabilityKind::Agent => {
            let d = claude_root.join("agents");
            (d.clone(), d.join(format!("{name}.md")))
        }
        CapabilityKind::Skill => {
            let d = claude_root.join("skills").join(name);
            (d.clone(), d.join("SKILL.md"))
        }
        CapabilityKind::Command => {
            let d = claude_root.join("commands");
            (d.clone(), d.join(format!("{name}.md")))
        }
    };
    if file.exists() {
        return Err(InspectError::AlreadyExists(file.display().to_string()));
    }
    std::fs::create_dir_all(&dir)?;
    std::fs::write(&file, scaffold_for(kind, name))?;
    Ok(file.display().to_string())
}

/// Delete an existing capability, validated against the same allowlist as reads/writes.
/// A skill is stored as a directory (`skills/<name>/SKILL.md` plus references), so deleting
/// its `SKILL.md` removes the whole skill directory; agents and commands are single files.
/// Rule/config files are NOT deletable here — only discovered capabilities.
pub fn delete_capability(path: &str, worktree: &Path) -> Result<(), InspectError> {
    let target = std::fs::canonicalize(path)?;
    let canonical_worktree = std::fs::canonicalize(worktree)?;
    if !allowed_read_write_paths(worktree, &canonical_worktree).contains(&target) {
        return Err(InspectError::Forbidden(path.to_string()));
    }
    // A SKILL.md whose grandparent directory is named `skills` identifies a skill; remove
    // the containing `<name>` directory so the skill disappears entirely. The grandparent
    // check keeps us from ever deleting the shared `skills` root itself.
    let is_skill_md = target.file_name().and_then(|f| f.to_str()) == Some("SKILL.md");
    let skill_dir = target.parent();
    let under_skills_root = skill_dir
        .and_then(|d| d.parent())
        .and_then(|g| g.file_name())
        .and_then(|f| f.to_str())
        == Some("skills");
    if is_skill_md && under_skills_root {
        std::fs::remove_dir_all(skill_dir.unwrap())?;
    } else {
        std::fs::remove_file(&target)?;
    }
    Ok(())
}

/// Returns true when `path` (already canonicalized by the caller) is one of the
/// exact global config files the app is permitted to read. The expected paths are
/// also canonicalized so that a `~/.claude` directory that is itself a symlink
/// does not produce a false-negative.
fn is_expected_global(path: &Path) -> bool {
    [
        crate::agent_paths::claude_config_dir().map(|c| c.join("CLAUDE.md")),
        crate::agent_paths::codex_home_dir().map(|c| c.join("config.toml")),
        crate::agent_paths::gemini_config_dir().map(|c| c.join("GEMINI.md")),
    ]
    .into_iter()
    .flatten()
    .any(|expected| {
        std::fs::canonicalize(&expected)
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
        return Capabilities {
            skills: vec![],
            subagents: vec![],
            commands: vec![],
        };
    }
    let user_claude = crate::agent_paths::claude_config_dir();
    let worktree_claude = worktree.join(".claude");
    let mut subagents = Vec::new();
    let mut skills = Vec::new();
    let mut commands = Vec::new();

    // Subagents: their authoritative identity is the frontmatter `name` field, not the
    // filename (Claude Code invokes the agent by `name`; the filename is irrelevant). So we
    // display `name`, falling back to the file stem only when it is absent.
    collect_md(&worktree_claude.join("agents"), "project", true, &mut subagents);
    if let Some(c) = &user_claude {
        collect_md(&c.join("agents"), "user", true, &mut subagents);
    }
    collect_skill_dirs(&worktree_claude.join("skills"), "project", &mut skills);
    if let Some(c) = &user_claude {
        collect_skill_dirs(&c.join("skills"), "user", &mut skills);
    }
    // Slash commands are invoked by their filename (`/<stem>`), so the file stem is the
    // authoritative identifier — no frontmatter `name` override.
    collect_md(&worktree_claude.join("commands"), "project", false, &mut commands);
    if let Some(c) = &user_claude {
        collect_md(&c.join("commands"), "user", false, &mut commands);
    }

    subagents.sort_by(|a, b| a.name.cmp(&b.name));
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    commands.sort_by(|a, b| a.name.cmp(&b.name));

    Capabilities {
        skills,
        subagents,
        commands,
    }
}

/// Push one `Capability` per `*.md` file found in `dir`. Description is extracted
/// best-effort; path is the absolute file path. When `use_frontmatter_name` is set, the
/// display name is the file's frontmatter `name:` (the single source of truth for
/// subagents), falling back to the file stem when it is absent; otherwise the file stem is
/// used directly (slash commands, invoked by filename).
fn collect_md(dir: &Path, source: &str, use_frontmatter_name: bool, out: &mut Vec<Capability>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let name = if use_frontmatter_name {
            frontmatter_name(&path).unwrap_or_else(|| stem.to_string())
        } else {
            stem.to_string()
        };
        out.push(Capability {
            name,
            description: first_description(&path),
            source: source.to_string(),
            path: path.display().to_string(),
        });
    }
}

/// Push one `Capability` per subdirectory of `dir` that contains a `SKILL.md`.
/// The `path` field is set to the absolute path of the `SKILL.md` file. The display name
/// is the frontmatter `name:` when present (the label Claude shows in skill listings),
/// falling back to the directory name (which remains the `/`-invocation identifier).
fn collect_skill_dirs(dir: &Path, source: &str, out: &mut Vec<Capability>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let skill_md = entry.path().join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let Some(dir_name) = entry
            .path()
            .file_name()
            .and_then(|s| s.to_str())
            .map(String::from)
        else {
            continue;
        };
        let name = frontmatter_name(&skill_md).unwrap_or(dir_name);
        out.push(Capability {
            name,
            description: first_description(&skill_md),
            source: source.to_string(),
            path: skill_md.display().to_string(),
        });
    }
}

/// Extract the `name:` scalar from a file's leading YAML frontmatter block (`---` … `---`),
/// stripping surrounding quotes. Returns `None` when there is no frontmatter, no `name:`
/// key inside it, or the value is empty. Restricting the scan to the frontmatter block
/// avoids matching a stray `name:` in the document body.
fn frontmatter_name(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    // Frontmatter must open on the first line with a `---` fence.
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed.trim() == "---" {
            break; // end of frontmatter
        }
        if let Some(rest) = trimmed.trim_start().strip_prefix("name:") {
            let value = rest.trim().trim_matches(|c| c == '"' || c == '\'').trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
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
    let home = crate::agent_paths::home_dir();
    list_hooks_with_home(worktree, home.as_deref())
}

fn list_hooks_with_home(worktree: &Path, home: Option<&Path>) -> Vec<HookEntry> {
    let mut entries = Vec::new();
    parse_hooks_from_settings(
        &worktree.join(".claude/settings.json"),
        "project",
        &mut entries,
    );
    if let Some(h) = home {
        parse_hooks_from_settings(&h.join(".claude/settings.json"), "user", &mut entries);
    }
    entries
}

/// Parse the `hooks` object from a Claude settings JSON file, appending one
/// `HookEntry` per leaf command to `out`. The expected shape is:
/// `{ "hooks": { "<EventName>": [ { "matcher?": "...", "hooks": [ { "type": "command", "command": "..." } ] } ] } }`
fn parse_hooks_from_settings(path: &Path, source: &str, out: &mut Vec<HookEntry>) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };
    let Some(hooks_obj) = json.get("hooks").and_then(|v| v.as_object()) else {
        return;
    };

    for (event_name, groups_val) in hooks_obj {
        let Some(groups) = groups_val.as_array() else {
            continue;
        };
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
    let home = crate::agent_paths::home_dir();
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
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };
    let Some(servers) = json.get("mcpServers").and_then(|v| v.as_object()) else {
        return;
    };

    for (name, config) in servers {
        // Pick the most informative single-line descriptor available.
        let detail = config
            .get("command")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| config.get("url").and_then(|v| v.as_str()).map(String::from))
            .or_else(|| {
                config
                    .get("type")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            });
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
    let home = crate::agent_paths::home_dir();
    list_plugins_with_home(home.as_deref())
}

fn list_plugins_with_home(home: Option<&Path>) -> Vec<PluginEntry> {
    let Some(h) = home else { return Vec::new() };
    let path = h.join(".claude/plugins/installed_plugins.json");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Vec::new();
    };
    let Some(plugins) = json.get("plugins").and_then(|v| v.as_object()) else {
        return Vec::new();
    };

    let mut entries = Vec::new();
    for (key, records_val) in plugins {
        // Key format: "pluginName@marketplace" (e.g. "frontend-design@claude-plugins-official").
        let (name, marketplace) = if let Some(at_pos) = key.find('@') {
            (
                key[..at_pos].to_string(),
                Some(key[at_pos + 1..].to_string()),
            )
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
// Hooks & MCP mutation (config-fragment editing)
// ──────────────────────────────────────────────────────────────────────────────

/// Read a JSON file into its top-level object, or an empty object when the file is absent.
/// A present-but-non-object (or unparseable) file is rejected rather than silently
/// clobbered, so a hand-edited config is never destroyed by a mutation.
fn read_json_object(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>, InspectError> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Ok(serde_json::Map::new());
            }
            let value: serde_json::Value = serde_json::from_str(trimmed)
                .map_err(|e| InspectError::InvalidConfig(format!("{}: {e}", path.display())))?;
            match value {
                serde_json::Value::Object(map) => Ok(map),
                _ => Err(InspectError::InvalidConfig(format!(
                    "{}: top level is not a JSON object",
                    path.display()
                ))),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Map::new()),
        Err(e) => Err(e.into()),
    }
}

/// Pretty-print a JSON object back to disk (2-space indent + trailing newline), creating
/// parent directories as needed.
fn write_json_object(
    path: &Path,
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), InspectError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut text = serde_json::to_string_pretty(&serde_json::Value::Object(map.clone()))
        .map_err(|e| InspectError::InvalidConfig(e.to_string()))?;
    text.push('\n');
    std::fs::write(path, text)?;
    Ok(())
}

/// Append a hook command to a Claude settings JSON file as its own group under `event`.
/// Creates the file (and parent dirs) when absent; preserves every other key. The shape
/// mirrors what `parse_hooks_from_settings` reads back.
pub fn add_hook(
    settings_path: &Path,
    event: &str,
    matcher: Option<&str>,
    command: &str,
) -> Result<(), InspectError> {
    if event.trim().is_empty() {
        return Err(InspectError::InvalidName("hook event is empty".into()));
    }
    if command.trim().is_empty() {
        return Err(InspectError::InvalidName("hook command is empty".into()));
    }
    let mut root = read_json_object(settings_path)?;
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| InspectError::InvalidConfig("`hooks` is not an object".into()))?;
    let groups = hooks
        .entry(event.to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    let groups = groups
        .as_array_mut()
        .ok_or_else(|| InspectError::InvalidConfig(format!("`hooks.{event}` is not an array")))?;

    let mut group = serde_json::Map::new();
    if let Some(m) = matcher.filter(|m| !m.is_empty()) {
        group.insert("matcher".into(), serde_json::Value::String(m.to_string()));
    }
    group.insert(
        "hooks".into(),
        serde_json::json!([{ "type": "command", "command": command }]),
    );
    groups.push(serde_json::Value::Object(group));

    write_json_object(settings_path, &root)
}

/// Remove the first hook leaf matching `(event, matcher, command)` from a settings file,
/// pruning any group and event key left empty. Returns `NotFound` when nothing matches.
pub fn delete_hook(
    settings_path: &Path,
    event: &str,
    matcher: Option<&str>,
    command: &str,
) -> Result<(), InspectError> {
    let mut root = read_json_object(settings_path)?;
    let removed = (|| {
        let groups = root
            .get_mut("hooks")?
            .as_object_mut()?
            .get_mut(event)?
            .as_array_mut()?;
        let mut removed = false;
        for group in groups.iter_mut() {
            let group_matcher = group.get("matcher").and_then(|m| m.as_str());
            // A leaf's effective matcher is its group's matcher; both `None` also matches.
            if group_matcher != matcher {
                continue;
            }
            if let Some(leaves) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                let before = leaves.len();
                leaves.retain(|h| h.get("command").and_then(|c| c.as_str()) != Some(command));
                if leaves.len() != before {
                    removed = true;
                    break;
                }
            }
        }
        Some(removed)
    })()
    .unwrap_or(false);

    if !removed {
        return Err(InspectError::NotFound(format!("hook {event}: {command}")));
    }
    prune_empty_hook_groups(&mut root, event);
    write_json_object(settings_path, &root)
}

/// After a leaf removal, drop any hook group with no remaining leaves and any event with
/// no remaining groups.
fn prune_empty_hook_groups(root: &mut serde_json::Map<String, serde_json::Value>, event: &str) {
    let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return;
    };
    if let Some(groups) = hooks.get_mut(event).and_then(|g| g.as_array_mut()) {
        groups.retain(|g| {
            g.get("hooks")
                .and_then(|h| h.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false)
        });
        if groups.is_empty() {
            hooks.remove(event);
        }
    }
}

/// Add an stdio MCP server (`command` + optional `args`) under `mcpServers` in an MCP JSON
/// file. Rejects a duplicate name; creates the file when absent; preserves other keys.
pub fn add_mcp_server(
    mcp_path: &Path,
    name: &str,
    command: &str,
    args: &[String],
) -> Result<(), InspectError> {
    validate_customization_name(name)?;
    if command.trim().is_empty() {
        return Err(InspectError::InvalidName("server command is empty".into()));
    }
    let mut root = read_json_object(mcp_path)?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| InspectError::InvalidConfig("`mcpServers` is not an object".into()))?;
    if servers.contains_key(name) {
        return Err(InspectError::AlreadyExists(name.to_string()));
    }
    let mut config = serde_json::Map::new();
    config.insert("command".into(), serde_json::Value::String(command.to_string()));
    if !args.is_empty() {
        config.insert(
            "args".into(),
            serde_json::Value::Array(
                args.iter()
                    .map(|a| serde_json::Value::String(a.clone()))
                    .collect(),
            ),
        );
    }
    servers.insert(name.to_string(), serde_json::Value::Object(config));
    write_json_object(mcp_path, &root)
}

/// Remove an MCP server by name from an MCP JSON file. Returns `NotFound` when absent.
pub fn delete_mcp_server(mcp_path: &Path, name: &str) -> Result<(), InspectError> {
    let mut root = read_json_object(mcp_path)?;
    let removed = root
        .get_mut("mcpServers")
        .and_then(|s| s.as_object_mut())
        .map(|servers| servers.remove(name).is_some())
        .unwrap_or(false);
    if !removed {
        return Err(InspectError::NotFound(name.to_string()));
    }
    write_json_object(mcp_path, &root)
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
    let home = crate::agent_paths::home_dir();
    customizations_counts_with_home(worktree, home.as_deref())
}

/// Inner implementation that accepts an explicit `home` path, enabling tests to
/// inject a fake empty directory without mutating the global environment.
fn customizations_counts_with_home(worktree: &Path, home: Option<&Path>) -> CustomizationCounts {
    let caps = list_capabilities("claude", worktree);
    let instructions = rule_candidates(worktree)
        .into_iter()
        .filter(|r| r.exists)
        .count() as u32;
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

    #[cfg(unix)]
    #[test]
    fn read_allows_capability_under_symlinked_skills_dir() {
        // Mirrors the common setup where `.claude/skills` is a directory symlink
        // pointing elsewhere (e.g. `~/.agents/skills`). The skill's canonical path
        // is outside `.claude`, but it lives under the canonicalized discovery
        // root, so it must remain readable.
        let dir = std::env::temp_dir().join(format!("ae-symdir-{}", std::process::id()));
        let real_skills =
            std::env::temp_dir().join(format!("ae-realskills-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::create_dir_all(real_skills.join("bar")).unwrap();
        std::fs::write(real_skills.join("bar/SKILL.md"), "skill body").unwrap();
        // .claude/skills -> real_skills (directory symlink)
        std::os::unix::fs::symlink(&real_skills, dir.join(".claude/skills")).unwrap();

        let skill_via_link = dir.join(".claude/skills/bar/SKILL.md");
        assert_eq!(
            read_text_file(&skill_via_link.display().to_string(), &dir).unwrap(),
            "skill body"
        );

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&real_skills);
    }

    #[cfg(unix)]
    #[test]
    fn read_allows_capability_under_per_entry_symlinked_skill_dir() {
        // Skill managers install by symlinking EACH skill directory into
        // `.claude/skills` (e.g. `skills/agent-browser -> ~/.agents/skills/agent-browser`)
        // while `skills` itself stays a real directory. The SKILL.md canonicalizes
        // outside every discovery root, but it is a real file reached through a
        // directory symlink — it must remain readable.
        let dir = std::env::temp_dir().join(format!("ae-syment-{}", std::process::id()));
        let real = std::env::temp_dir().join(format!("ae-realent-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".claude/skills")).unwrap();
        std::fs::create_dir_all(real.join("bar")).unwrap();
        std::fs::write(real.join("bar/SKILL.md"), "skill body").unwrap();
        // .claude/skills/bar -> real/bar (per-entry directory symlink)
        std::os::unix::fs::symlink(real.join("bar"), dir.join(".claude/skills/bar")).unwrap();

        let skill_via_link = dir.join(".claude/skills/bar/SKILL.md");
        assert_eq!(
            read_text_file(&skill_via_link.display().to_string(), &dir).unwrap(),
            "skill body"
        );

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&real);
    }

    #[cfg(unix)]
    #[test]
    fn read_rejects_file_symlink_inside_real_skill_dir() {
        // A FILE symlink jumping out of a real skill dir (SKILL.md -> secret) must
        // stay Forbidden even once per-entry directory symlinks are allowed.
        let dir = std::env::temp_dir().join(format!("ae-symfile-{}", std::process::id()));
        let skill_dir = dir.join(".claude/skills/evil");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let secret = std::env::temp_dir().join(format!("ae-symfile-secret-{}", std::process::id()));
        std::fs::write(&secret, "TOP SECRET").unwrap();
        std::os::unix::fs::symlink(&secret, skill_dir.join("SKILL.md")).unwrap();

        assert!(matches!(
            read_text_file(&skill_dir.join("SKILL.md").display().to_string(), &dir),
            Err(InspectError::Forbidden(_))
        ));

        let _ = std::fs::remove_file(&secret);
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
        let dir = std::env::temp_dir().join(format!("ae-caps-{}", std::process::id()));

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
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\ndescription: Bar skill\n---\n",
        )
        .unwrap();

        let caps = list_capabilities("claude", &dir);

        // Subagent "foo" must be found with the right description and source.
        let foo = caps
            .subagents
            .iter()
            .find(|c| c.name == "foo")
            .expect("subagent 'foo' not found");
        assert_eq!(foo.description.as_deref(), Some("Does foo"));
        assert_eq!(foo.source, "project");

        // Skill "bar" must be found via SKILL.md.
        let bar = caps
            .skills
            .iter()
            .find(|c| c.name == "bar")
            .expect("skill 'bar' not found");
        assert_eq!(bar.description.as_deref(), Some("Bar skill"));
        assert_eq!(bar.source, "project");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subagent_display_name_comes_from_frontmatter_not_filename() {
        // SSOT: the file is `dummy.md` but declares `name: real-reviewer`. Claude Code
        // invokes the agent by its frontmatter name, so the UI must display "real-reviewer",
        // never the filename — otherwise the list could show a name the file doesn't back.
        let dir = std::env::temp_dir().join(format!("ae-ssot-agent-{}", std::process::id()));
        let agents_dir = dir.join(".claude/agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(
            agents_dir.join("dummy.md"),
            "---\nname: real-reviewer\ndescription: Reviews code\n---\n",
        )
        .unwrap();

        let caps = list_capabilities("claude", &dir);
        assert!(
            caps.subagents.iter().any(|c| c.name == "real-reviewer"),
            "expected display name from frontmatter, got {:?}",
            caps.subagents.iter().map(|c| &c.name).collect::<Vec<_>>()
        );
        assert!(
            !caps.subagents.iter().any(|c| c.name == "dummy"),
            "filename must not be shown when frontmatter declares a name"
        );
        // The backing path still points at the real file for read/edit/delete.
        let cap = caps.subagents.iter().find(|c| c.name == "real-reviewer").unwrap();
        assert!(cap.path.ends_with("/dummy.md"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subagent_falls_back_to_filename_without_frontmatter_name() {
        let dir = std::env::temp_dir().join(format!("ae-ssot-agent2-{}", std::process::id()));
        let agents_dir = dir.join(".claude/agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(agents_dir.join("solo.md"), "just a body, no frontmatter\n").unwrap();

        let caps = list_capabilities("claude", &dir);
        assert!(caps.subagents.iter().any(|c| c.name == "solo"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn skill_display_name_prefers_frontmatter_over_dirname() {
        // Skill dir is `dummy` but its SKILL.md label is `shiny-skill`; the listing shows
        // the frontmatter label (matching Claude's skill listing), while the dir name
        // remains the invocation id via the backing path.
        let dir = std::env::temp_dir().join(format!("ae-ssot-skill-{}", std::process::id()));
        let skill_dir = dir.join(".claude/skills/dummy");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: shiny-skill\ndescription: Does shiny things\n---\n",
        )
        .unwrap();

        let caps = list_capabilities("claude", &dir);
        assert!(caps.skills.iter().any(|c| c.name == "shiny-skill"));
        assert!(!caps.skills.iter().any(|c| c.name == "dummy"));

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
        let dir = std::env::temp_dir().join(format!("ae-caps-nc-{}", std::process::id()));
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
        std::fs::write(
            agents_dir.join("foo.md"),
            "---\ndescription: Foo agent\n---\n",
        )
        .unwrap();

        // .mcp.json with exactly 1 MCP server.
        std::fs::write(
            dir.join(".mcp.json"),
            r#"{"mcpServers":{"my-server":{"command":"node","args":["server.js"]}}}"#,
        )
        .unwrap();

        let counts = customizations_counts_with_home(&dir, Some(&fake_home));
        assert!(
            counts.agents >= 1,
            "expected at least 1 agent, got {}",
            counts.agents
        );
        assert_eq!(counts.mcp_servers, 1, "expected exactly 1 MCP server");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&fake_home);
    }

    #[test]
    fn capability_path_is_populated_for_discovered_agent() {
        let dir = std::env::temp_dir().join(format!("ae-cappath-{}", std::process::id()));
        let agents_dir = dir.join(".claude/agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        std::fs::write(
            agents_dir.join("foo.md"),
            "---\ndescription: Does foo\n---\n",
        )
        .unwrap();

        let caps = list_capabilities("claude", &dir);
        let foo = caps
            .subagents
            .iter()
            .find(|c| c.name == "foo")
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

    // ── write_customization_file tests (the IPC write path) ───────────────────

    #[test]
    fn write_succeeds_for_discovered_capability_file() {
        let dir = std::env::temp_dir().join(format!("ae-wrt1-{}", std::process::id()));
        let agents_dir = dir.join(".claude/agents");
        std::fs::create_dir_all(&agents_dir).unwrap();
        let agent_file = agents_dir.join("foo.md");
        std::fs::write(&agent_file, "original content").unwrap();

        let new_content = "updated agent instructions";
        write_customization_file(&agent_file.display().to_string(), new_content, &dir).unwrap();

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
                write_customization_file(&arbitrary.display().to_string(), "new content", &dir),
                Err(InspectError::Forbidden(_))
            ),
            "expected Forbidden for a file not in the allowlist"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_hooks_returns_entries_from_settings() {
        let dir = std::env::temp_dir().join(format!("ae-hooks-{}", std::process::id()));
        let fake_home = std::env::temp_dir().join(format!("ae-hooks-home-{}", std::process::id()));
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

        let with_matcher = entries
            .iter()
            .find(|e| e.matcher.as_deref() == Some("Bash"))
            .unwrap();
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
        assert!(
            entries.is_empty(),
            "expected empty plugin list, got {entries:?}"
        );
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
                write_customization_file(&link.display().to_string(), "injected", &dir),
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
                write_customization_file(&target.display().to_string(), &oversized, &dir),
                Err(InspectError::ContentTooLarge)
            ),
            "expected ContentTooLarge for payload exceeding 1 MiB"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── create_capability / delete_capability tests ──────────────────────────

    #[test]
    fn create_capability_scaffolds_each_kind() {
        let dir = std::env::temp_dir().join(format!("ae-create-{}", std::process::id()));
        let claude = dir.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();

        let agent = create_capability(&claude, CapabilityKind::Agent, "reviewer").unwrap();
        assert!(agent.ends_with("/.claude/agents/reviewer.md"), "{agent}");
        assert!(std::fs::read_to_string(&agent).unwrap().contains("name: reviewer"));

        let skill = create_capability(&claude, CapabilityKind::Skill, "deploy").unwrap();
        assert!(skill.ends_with("/.claude/skills/deploy/SKILL.md"), "{skill}");
        assert!(std::fs::read_to_string(&skill).unwrap().contains("description:"));

        let cmd = create_capability(&claude, CapabilityKind::Command, "ship").unwrap();
        assert!(cmd.ends_with("/.claude/commands/ship.md"), "{cmd}");

        // Freshly created capabilities are discoverable by list_capabilities.
        let caps = list_capabilities("claude", &dir);
        assert!(caps.subagents.iter().any(|c| c.name == "reviewer"));
        assert!(caps.skills.iter().any(|c| c.name == "deploy"));
        assert!(caps.commands.iter().any(|c| c.name == "ship"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_capability_rejects_existing_and_bad_names() {
        let dir = std::env::temp_dir().join(format!("ae-create2-{}", std::process::id()));
        let claude = dir.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();

        create_capability(&claude, CapabilityKind::Agent, "foo").unwrap();
        assert!(matches!(
            create_capability(&claude, CapabilityKind::Agent, "foo"),
            Err(InspectError::AlreadyExists(_))
        ));

        for bad in ["../escape", "a/b", "", ".hidden", "with space"] {
            assert!(
                matches!(
                    create_capability(&claude, CapabilityKind::Skill, bad),
                    Err(InspectError::InvalidName(_))
                ),
                "expected InvalidName for {bad:?}"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_capability_removes_file_and_whole_skill_dir() {
        let dir = std::env::temp_dir().join(format!("ae-del-{}", std::process::id()));
        let claude = dir.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();

        let agent = create_capability(&claude, CapabilityKind::Agent, "gone").unwrap();
        assert!(Path::new(&agent).exists());
        delete_capability(&agent, &dir).unwrap();
        assert!(!Path::new(&agent).exists(), "agent file should be gone");

        let skill = create_capability(&claude, CapabilityKind::Skill, "removeme").unwrap();
        let skill_dir = Path::new(&skill).parent().unwrap().to_path_buf();
        // Add a sibling reference file the skill owns — deleting must take the whole dir.
        std::fs::write(skill_dir.join("helper.py"), "print('x')").unwrap();
        delete_capability(&skill, &dir).unwrap();
        assert!(!skill_dir.exists(), "whole skill directory should be gone");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_capability_forbidden_for_non_capability() {
        let dir = std::env::temp_dir().join(format!("ae-del2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let arbitrary = dir.join("arbitrary.txt");
        std::fs::write(&arbitrary, "keep me").unwrap();

        assert!(matches!(
            delete_capability(&arbitrary.display().to_string(), &dir),
            Err(InspectError::Forbidden(_))
        ));
        assert!(arbitrary.exists(), "arbitrary file must not be deleted");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── add_hook / delete_hook tests ─────────────────────────────────────────

    #[test]
    fn add_hook_creates_file_and_roundtrips_via_list() {
        let dir = std::env::temp_dir().join(format!("ae-addhook-{}", std::process::id()));
        let claude = dir.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        let settings = claude.join("settings.json");

        add_hook(&settings, "SessionStart", None, "echo start").unwrap();
        add_hook(&settings, "PreToolUse", Some("Bash"), "echo bash").unwrap();

        // Reads back through the same parser the UI uses.
        let entries = list_hooks_with_home(&dir, None);
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert!(entries
            .iter()
            .any(|e| e.event == "SessionStart" && e.command == "echo start" && e.matcher.is_none()));
        assert!(entries
            .iter()
            .any(|e| e.event == "PreToolUse" && e.command == "echo bash"
                && e.matcher.as_deref() == Some("Bash")));

        // Preserves unrelated existing keys.
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert!(raw.get("hooks").is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_hook_preserves_other_settings_keys() {
        let dir = std::env::temp_dir().join(format!("ae-addhook2-{}", std::process::id()));
        let claude = dir.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        let settings = claude.join("settings.json");
        std::fs::write(&settings, r#"{"model":"opus","permissions":{"allow":["Bash"]}}"#).unwrap();

        add_hook(&settings, "Stop", None, "echo done").unwrap();

        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(raw.get("model").and_then(|v| v.as_str()), Some("opus"));
        assert!(raw.get("permissions").is_some());
        assert!(raw.get("hooks").is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_hook_removes_matching_leaf_and_prunes() {
        let dir = std::env::temp_dir().join(format!("ae-delhook-{}", std::process::id()));
        let claude = dir.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        let settings = claude.join("settings.json");

        add_hook(&settings, "SessionStart", None, "echo one").unwrap();
        add_hook(&settings, "SessionStart", None, "echo two").unwrap();
        assert_eq!(list_hooks_with_home(&dir, None).len(), 2);

        delete_hook(&settings, "SessionStart", None, "echo one").unwrap();
        let after = list_hooks_with_home(&dir, None);
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].command, "echo two");

        // Removing the last one prunes the event key entirely.
        delete_hook(&settings, "SessionStart", None, "echo two").unwrap();
        assert!(list_hooks_with_home(&dir, None).is_empty());
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert!(raw
            .get("hooks")
            .and_then(|h| h.as_object())
            .map(|o| !o.contains_key("SessionStart"))
            .unwrap_or(true));

        // Deleting a non-existent hook reports NotFound.
        assert!(matches!(
            delete_hook(&settings, "SessionStart", None, "nope"),
            Err(InspectError::NotFound(_))
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── add_mcp_server / delete_mcp_server tests ─────────────────────────────

    #[test]
    fn add_mcp_server_roundtrips_and_rejects_dupes() {
        let dir = std::env::temp_dir().join(format!("ae-addmcp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mcp = dir.join(".mcp.json");

        add_mcp_server(&mcp, "my-server", "node", &["server.js".to_string()]).unwrap();
        let entries = list_mcp_servers_with_home(&dir, None);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "my-server");
        assert_eq!(entries[0].detail.as_deref(), Some("node"));

        // Duplicate name rejected.
        assert!(matches!(
            add_mcp_server(&mcp, "my-server", "python", &[]),
            Err(InspectError::AlreadyExists(_))
        ));
        // Bad name rejected.
        assert!(matches!(
            add_mcp_server(&mcp, "../evil", "node", &[]),
            Err(InspectError::InvalidName(_))
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_mcp_server_removes_and_reports_missing() {
        let dir = std::env::temp_dir().join(format!("ae-delmcp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mcp = dir.join(".mcp.json");
        add_mcp_server(&mcp, "keep", "node", &[]).unwrap();
        add_mcp_server(&mcp, "drop", "python", &[]).unwrap();

        delete_mcp_server(&mcp, "drop").unwrap();
        let entries = list_mcp_servers_with_home(&dir, None);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "keep");

        assert!(matches!(
            delete_mcp_server(&mcp, "missing"),
            Err(InspectError::NotFound(_))
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }
}

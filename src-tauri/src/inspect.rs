use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum InspectError {
    #[error("path not allowed: {0}")]
    Forbidden(String),
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

/// Read a rule/config file, but ONLY if it is one of the exact files returned by
/// `rule_candidates(worktree)`. Exact canonicalized-path matching prevents a caller
/// from reading arbitrary files inside the worktree or the global config dirs (e.g.
/// `~/.claude/.credentials.json`). Payload is streamed-and-capped at 256 KB so a
/// large file cannot be slurped into RAM before the limit is applied.
///
/// Security: candidates are further filtered so their canonical (symlink-resolved)
/// path must either reside INSIDE the canonical worktree OR be one of the exact
/// global config files. This prevents a symlinked rule file from becoming a read
/// gadget for secrets outside the worktree boundary.
pub fn read_text_file(path: &str, worktree: &Path) -> Result<String, InspectError> {
    let target = std::fs::canonicalize(path)?;
    let canonical_worktree = std::fs::canonicalize(worktree)?;
    let mut allowed: Vec<PathBuf> = rule_candidates(worktree)
        .into_iter()
        .filter(|r| r.exists)
        .filter_map(|r| {
            let cp = std::fs::canonicalize(&r.path).ok()?;
            if cp.starts_with(&canonical_worktree) || is_expected_global(&cp) {
                Some(cp)
            } else {
                None
            }
        })
        .collect();
    // Also permit files discovered by list_capabilities — skills, subagents, and
    // commands. These are enumerated only from trusted, fixed discovery roots
    // (project `.claude/...` and the user's `~/.claude/...`), so any path the
    // discovery returns is a legitimate capability file and safe to read,
    // including user-scoped agents/skills outside the worktree. The exact-match
    // guard below still prevents reading any path that discovery didn't surface.
    let caps = list_capabilities("claude", worktree);
    for cap in caps.skills.into_iter().chain(caps.subagents).chain(caps.commands) {
        if cap.path.is_empty() {
            continue;
        }
        if let Ok(cp) = std::fs::canonicalize(&cap.path) {
            allowed.push(cp);
        }
    }
    if !allowed.contains(&target) {
        return Err(InspectError::Forbidden(path.to_string()));
    }
    use std::io::Read;
    let f = std::fs::File::open(&target)?;
    let mut buf = Vec::new();
    f.take(256 * 1024).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).to_string())
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

/// Sum the number of hook rules configured in `<wt>/.claude/settings.json` and
/// `<home>/.claude/settings.json`. Each top-level entry inside the `hooks` object's
/// per-event arrays counts as one rule. Returns 0 on any missing/parse error.
fn count_hooks(worktree: &Path, home: Option<&Path>) -> u32 {
    let mut total = 0u32;
    total += hooks_from_settings(&worktree.join(".claude/settings.json"));
    if let Some(h) = home {
        total += hooks_from_settings(&h.join(".claude/settings.json"));
    }
    total
}

fn hooks_from_settings(path: &Path) -> u32 {
    (|| -> Option<u32> {
        let content = std::fs::read_to_string(path).ok()?;
        let json: serde_json::Value = serde_json::from_str(&content).ok()?;
        let hooks = json.get("hooks")?.as_object()?;
        // Each element of each per-event array is one hook rule.
        let count: usize = hooks.values().filter_map(|v| v.as_array()).map(|a| a.len()).sum();
        Some(count as u32)
    })()
    .unwrap_or(0)
}

/// Count MCP servers declared in `<wt>/.mcp.json` + `<home>/.claude.json`. Returns 0
/// on any missing/parse error.
fn count_mcp(worktree: &Path, home: Option<&Path>) -> u32 {
    let mut total = 0u32;
    total += mcp_servers_from_file(&worktree.join(".mcp.json"));
    if let Some(h) = home {
        total += mcp_servers_from_file(&h.join(".claude.json"));
    }
    total
}

fn mcp_servers_from_file(path: &Path) -> u32 {
    (|| -> Option<u32> {
        let content = std::fs::read_to_string(path).ok()?;
        let json: serde_json::Value = serde_json::from_str(&content).ok()?;
        let servers = json.get("mcpServers")?.as_object()?;
        Some(servers.len() as u32)
    })()
    .unwrap_or(0)
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
}

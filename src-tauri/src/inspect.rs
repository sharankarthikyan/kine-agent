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
pub fn read_text_file(path: &str, worktree: &Path) -> Result<String, InspectError> {
    let target = std::fs::canonicalize(path)?;
    let allowed: Vec<PathBuf> = rule_candidates(worktree)
        .into_iter()
        .filter(|r| r.exists)
        .filter_map(|r| std::fs::canonicalize(&r.path).ok())
        .collect();
    if !allowed.contains(&target) {
        return Err(InspectError::Forbidden(path.to_string()));
    }
    use std::io::Read;
    let f = std::fs::File::open(&target)?;
    let mut buf = Vec::new();
    f.take(256 * 1024).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).to_string())
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

    Capabilities { skills, subagents, commands }
}

/// Push one `Capability` per `*.md` file found in `dir`.
/// Name = file stem; description is extracted best-effort.
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
        });
    }
}

/// Push one `Capability` per subdirectory of `dir` that contains a `SKILL.md`.
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
    // Pass 1: look for an explicit `description:` key anywhere in the file.
    for line in text.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("description:") {
            return Some(rest.trim().trim_matches('"').to_string());
        }
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
}

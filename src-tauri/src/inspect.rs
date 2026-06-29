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

/// Read a text file, but ONLY if it is inside the worktree root or the user's
/// `~/.claude`/`~/.codex`/`~/.gemini` config dirs. Rejects traversal/other paths.
pub fn read_text_file(path: &str, worktree: &Path) -> Result<String, InspectError> {
    let target = std::fs::canonicalize(path)?;
    let mut allowed: Vec<PathBuf> = Vec::new();
    if let Ok(wt) = std::fs::canonicalize(worktree) {
        allowed.push(wt);
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for d in [".claude", ".codex", ".gemini"] {
            if let Ok(c) = std::fs::canonicalize(home.join(d)) {
                allowed.push(c);
            }
        }
    }
    if !allowed.iter().any(|root| target.starts_with(root)) {
        return Err(InspectError::Forbidden(path.to_string()));
    }
    // Cap at ~256KB so a huge file can't blow up the IPC payload.
    let bytes = std::fs::read(&target)?;
    let slice = &bytes[..bytes.len().min(256 * 1024)];
    Ok(String::from_utf8_lossy(slice).to_string())
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
        std::fs::write(dir.join("CLAUDE.md"), "hello rules").unwrap();
        let inside = dir.join("CLAUDE.md");
        assert_eq!(
            read_text_file(&inside.display().to_string(), &dir).unwrap(),
            "hello rules"
        );
        assert!(matches!(
            read_text_file("/etc/hosts", &dir),
            Err(InspectError::Forbidden(_))
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

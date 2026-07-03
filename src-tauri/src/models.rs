use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// An agent CLI that Kineloop can drive, with an `installed` flag
/// indicating whether the binary is reachable on PATH.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub installed: bool,
}

/// A single model entry offered to the user in the model selector.
///
/// `value` is forwarded verbatim to `--model` on the CLI. Kineloop drives the
/// Claude CLI under the user's subscription auth (never an API key), so the
/// values are the CLI's family aliases (`opus`, `sonnet`, `haiku`). Each alias
/// always resolves to the latest released version of that family, so the list
/// never goes stale without a CLI update.
///
/// `label` is the friendly display name. It upgrades from the bare family name
/// (`"Claude Opus"`) to the resolved versioned name (`"Claude Opus 4.8"`) once
/// the alias has been resolved against the CLI (see [`refresh_claude_models`]).
/// `description` carries the resolved full model id (`claude-opus-4-8`) when
/// known, for display and debugging.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub value: String,
    pub label: String,
    pub agent: String,
    pub description: Option<String>,
    pub disabled: bool,
    /// Maximum input tokens for this model. The CLI's `system/init` event does
    /// not report a context window, so this is a sensible default for the
    /// current Claude family. Serialized as `contextWindow` for the UI.
    pub context_window: Option<u32>,
}

/// Probe PATH for each supported agent CLI and return all three with their
/// `installed` flag. The frontend enables selectors for installed agents and
/// disables (greyed-out) ones that are missing.
pub fn detect_agents() -> Vec<AgentInfo> {
    [
        ("claude", "claude", "Claude Code"),
        ("codex", "codex", "OpenAI Codex"),
        ("antigravity", "agy", "Antigravity"),
        ("gemini", "gemini", "Gemini"),
    ]
    .iter()
    .map(|(id, bin, label)| AgentInfo {
        id: id.to_string(),
        label: label.to_string(),
        installed: which::which(bin).is_ok(),
    })
    .collect()
}

/// The Claude family aliases Kineloop offers, paired with their bare
/// (unresolved) display labels. Ordered opus-first so the frontend can use
/// index 0 as the default.
const CLAUDE_ALIASES: [(&str, &str); 3] = [
    ("opus", "Claude Opus"),
    ("sonnet", "Claude Sonnet"),
    ("haiku", "Claude Haiku"),
];

/// Default context window for the current Claude family. The CLI does not
/// expose this headlessly; 200k matches the standard Claude context size.
const CLAUDE_CONTEXT_WINDOW: u32 = 200_000;

/// How long a resolved-model cache stays fresh before [`refresh_claude_models`]
/// re-probes the CLI. Aliases rarely change version, so a day is plenty.
const CACHE_TTL_SECS: u64 = 24 * 60 * 60;

/// Return available models for `agent`. `"claude"` and `"codex"` are
/// implemented; all other agents return an empty list (they will be added as
/// their adapters mature).
///
/// This is the fast, non-blocking path: it returns immediately from the on-disk
/// cache (Claude also has bare alias labels as a cold-cache fallback). Call
/// [`refresh_claude_models`] / [`refresh_codex_models`] to (re-)resolve the
/// list against the CLI.
pub fn list_models(agent: &str) -> Vec<ModelInfo> {
    match agent {
        "claude" => aliases_to_models(&read_cache().unwrap_or_default()),
        "codex" => list_codex_models(),
        "antigravity" => list_antigravity_models(),
        _ => vec![],
    }
}

/// Re-resolve every Claude alias to its current versioned model id by probing
/// the CLI, then persist the result and return the upgraded list. Skips the
/// probe (returning the cached list) when the cache is still fresh: same CLI
/// version and younger than [`CACHE_TTL_SECS`].
///
/// Probing spawns a headless session per alias and reads only the `system/init`
/// event, which reports the resolved model id. The process is killed right
/// after — init arrives before any model completion, so this costs no tokens.
pub fn refresh_claude_models() -> Vec<ModelInfo> {
    let current_version = claude_cli_version();

    if let Some(cache) = read_cache() {
        let fresh = !cache.models.is_empty()
            && cache.cli_version == current_version
            && now_unix().saturating_sub(cache.fetched_at) < CACHE_TTL_SECS;
        if fresh {
            return aliases_to_models(&cache);
        }
    }

    let mut cache = ModelCache {
        cli_version: current_version,
        fetched_at: now_unix(),
        models: BTreeMap::new(),
    };
    for (alias, _) in CLAUDE_ALIASES.iter() {
        if let Some(id) = probe_alias(alias) {
            cache.models.insert(
                alias.to_string(),
                ResolvedModel {
                    label: label_from_model_id(&id),
                    id,
                },
            );
        }
    }

    // Only overwrite the cache when at least one probe succeeded — offline or a
    // transient CLI failure should not clobber a previously good cache.
    if !cache.models.is_empty() {
        write_cache(&cache);
        return aliases_to_models(&cache);
    }
    aliases_to_models(&read_cache().unwrap_or_default())
}

/// Pure mapping from the alias table + a (possibly empty) resolution cache to
/// the model list. Kept separate from disk I/O so it can be unit-tested.
fn aliases_to_models(cache: &ModelCache) -> Vec<ModelInfo> {
    CLAUDE_ALIASES
        .iter()
        .map(|(alias, family_label)| {
            let resolved = cache.models.get(*alias);
            ModelInfo {
                value: alias.to_string(),
                label: resolved
                    .map(|r| r.label.clone())
                    .unwrap_or_else(|| family_label.to_string()),
                agent: "claude".to_string(),
                description: resolved.map(|r| r.id.clone()),
                disabled: false,
                context_window: Some(CLAUDE_CONTEXT_WINDOW),
            }
        })
        .collect()
}

// ===== Codex models =====

/// Return Codex models from the on-disk cache. Codex model slugs are concrete
/// (`gpt-5.5`), not auto-resolving family aliases like Claude, so there is no
/// bare-label fallback: a cold cache yields no Codex models until
/// [`refresh_codex_models`] populates it.
pub fn list_codex_models() -> Vec<ModelInfo> {
    codex_cache_to_models(&read_codex_cache().unwrap_or_default())
}

/// Re-read the Codex model catalog from the CLI and persist it. Skips the read
/// when the cache is still fresh (same CLI version, younger than
/// [`CACHE_TTL_SECS`]).
///
/// `codex debug models` renders the CLI's built-in catalog as JSON locally — no
/// network call and no tokens — so this is cheap, but it still spawns a process,
/// hence the cache and the background-refresh flow shared with Claude. The cache
/// is never clobbered on failure or an empty parse.
pub fn refresh_codex_models() -> Vec<ModelInfo> {
    let current_version = codex_cli_version();

    if let Some(cache) = read_codex_cache() {
        let fresh = !cache.models.is_empty()
            && cache.cli_version == current_version
            && now_unix().saturating_sub(cache.fetched_at) < CACHE_TTL_SECS;
        if fresh {
            return codex_cache_to_models(&cache);
        }
    }

    let Some(catalog) = fetch_codex_catalog() else {
        return codex_cache_to_models(&read_codex_cache().unwrap_or_default());
    };
    let models = parse_codex_catalog(&catalog);
    if models.is_empty() {
        return codex_cache_to_models(&read_codex_cache().unwrap_or_default());
    }
    let cache = CodexModelCache {
        cli_version: current_version,
        fetched_at: now_unix(),
        models,
    };
    write_codex_cache(&cache);
    codex_cache_to_models(&cache)
}

/// Pure mapping from cached Codex entries to the UI model list. Kept separate
/// from disk and CLI I/O so it can be unit-tested.
fn codex_cache_to_models(cache: &CodexModelCache) -> Vec<ModelInfo> {
    cache
        .models
        .iter()
        .map(|m| ModelInfo {
            value: m.slug.clone(),
            label: m.label.clone(),
            agent: "codex".to_string(),
            description: Some(m.slug.clone()),
            disabled: false,
            context_window: m.context_window,
        })
        .collect()
}

/// Parse `codex debug models` JSON into the cached model list: keep only
/// user-selectable entries (`visibility == "list"` and API-supported), ordered
/// by the catalog's own `priority` (lowest first). Returns an empty list when
/// the JSON doesn't parse, so callers can fall back to the existing cache.
fn parse_codex_catalog(json: &str) -> Vec<CodexCachedModel> {
    let Ok(catalog) = serde_json::from_str::<RawCodexCatalog>(json) else {
        return vec![];
    };
    let mut models: Vec<RawCodexModel> = catalog
        .models
        .into_iter()
        .filter(|m| m.visibility == "list" && m.supported_in_api)
        .collect();
    models.sort_by_key(|m| m.priority);
    models
        .into_iter()
        .map(|m| CodexCachedModel {
            label: if m.display_name.is_empty() {
                m.slug.clone()
            } else {
                m.display_name
            },
            slug: m.slug,
            context_window: m.context_window,
        })
        .collect()
}

/// Run `codex debug models` and return its stdout. `None` on any failure
/// (CLI missing, non-zero exit, non-UTF8 output).
fn fetch_codex_catalog() -> Option<String> {
    let program = crate::agent_paths::resolve_program("codex");
    let output = crate::proc::std_command(program)
        .args(["debug", "models"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

/// Read the Codex CLI version string (e.g. `"codex-cli 0.142.4"`), used as a
/// cache-invalidation key. Empty string on failure.
fn codex_cli_version() -> String {
    let program = crate::agent_paths::resolve_program("codex");
    crate::proc::std_command(program)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Subset of a `codex debug models` entry that we care about. Everything else
/// in the rich catalog (base instructions, tool configs, …) is ignored.
#[derive(Deserialize)]
struct RawCodexCatalog {
    #[serde(default)]
    models: Vec<RawCodexModel>,
}

#[derive(Deserialize)]
struct RawCodexModel {
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    visibility: String,
    #[serde(default)]
    priority: i64,
    #[serde(default)]
    context_window: Option<u32>,
    #[serde(default)]
    supported_in_api: bool,
}

/// On-disk cache of the Codex catalog, keyed by CLI version so an upgrade forces
/// a re-read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CodexModelCache {
    #[serde(default)]
    models: Vec<CodexCachedModel>,
    #[serde(default)]
    cli_version: String,
    #[serde(default)]
    fetched_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CodexCachedModel {
    slug: String,
    label: String,
    context_window: Option<u32>,
}

fn codex_cache_path() -> PathBuf {
    crate::agent_paths::data_dir().join("codex-model-cache.json")
}

fn read_codex_cache() -> Option<CodexModelCache> {
    let bytes = std::fs::read(codex_cache_path()).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_codex_cache(cache: &CodexModelCache) {
    let path = codex_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_vec_pretty(cache) {
        let _ = std::fs::write(path, json);
    }
}

// ===== Antigravity models =====

/// Return Antigravity models from the on-disk cache. Like Codex, the list comes from
/// the CLI itself (`agy models`) and is cached; a cold cache yields none until
/// [`refresh_antigravity_models`] runs.
pub fn list_antigravity_models() -> Vec<ModelInfo> {
    antigravity_cache_to_models(&read_antigravity_cache().unwrap_or_default())
}

/// Re-read the Antigravity model list from `agy models` and persist it. Skips the read
/// while the cache is fresh (younger than [`CACHE_TTL_SECS`]). `agy models` prints one
/// human-readable model name per line, which is also what `--model` accepts, so each
/// line is used verbatim as both value and label.
pub fn refresh_antigravity_models() -> Vec<ModelInfo> {
    if let Some(cache) = read_antigravity_cache() {
        let fresh = !cache.models.is_empty()
            && now_unix().saturating_sub(cache.fetched_at) < CACHE_TTL_SECS;
        if fresh {
            return antigravity_cache_to_models(&cache);
        }
    }

    let Some(output) = fetch_antigravity_models() else {
        return antigravity_cache_to_models(&read_antigravity_cache().unwrap_or_default());
    };
    let models = parse_antigravity_models(&output);
    if models.is_empty() {
        return antigravity_cache_to_models(&read_antigravity_cache().unwrap_or_default());
    }
    let cache = AntigravityModelCache {
        fetched_at: now_unix(),
        models,
    };
    write_antigravity_cache(&cache);
    antigravity_cache_to_models(&cache)
}

/// Parse `agy models` output into the cached model name list: every non-empty,
/// trimmed line, de-duplicated while preserving order.
fn parse_antigravity_models(output: &str) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| seen.insert(l.to_string()))
        .map(str::to_string)
        .collect()
}

fn antigravity_cache_to_models(cache: &AntigravityModelCache) -> Vec<ModelInfo> {
    cache
        .models
        .iter()
        .map(|name| ModelInfo {
            value: name.clone(),
            label: name.clone(),
            agent: "antigravity".to_string(),
            description: None,
            disabled: false,
            context_window: None,
        })
        .collect()
}

fn fetch_antigravity_models() -> Option<String> {
    let program = crate::agent_paths::resolve_program("agy");
    let output = crate::proc::std_command(program)
        .arg("models")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

/// On-disk cache of `agy models`. No CLI-version key (agy exposes no stable version
/// string headlessly); freshness is TTL-only.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AntigravityModelCache {
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    fetched_at: u64,
}

fn antigravity_cache_path() -> PathBuf {
    crate::agent_paths::data_dir().join("antigravity-model-cache.json")
}

fn read_antigravity_cache() -> Option<AntigravityModelCache> {
    let bytes = std::fs::read(antigravity_cache_path()).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_antigravity_cache(cache: &AntigravityModelCache) {
    let path = antigravity_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_vec_pretty(cache) {
        let _ = std::fs::write(path, json);
    }
}

/// Turn a full Claude model id into a friendly label.
/// `claude-opus-4-8` → `"Claude Opus 4.8"`; `claude-fable-5` → `"Claude Fable 5"`.
/// A trailing 8-digit date snapshot (`-20251101`) is dropped. Falls back to the
/// raw id when it doesn't match the expected `claude-<family>-<nums>` shape.
fn label_from_model_id(id: &str) -> String {
    let Some(rest) = id.strip_prefix("claude-") else {
        return id.to_string();
    };
    let mut parts = rest.split('-');
    let Some(family) = parts.next().filter(|f| !f.is_empty()) else {
        return id.to_string();
    };
    // Version segments are the numeric parts after the family, stopping at an
    // 8-digit date snapshot (or any non-numeric segment).
    let nums: Vec<&str> = parts
        .take_while(|p| !p.is_empty() && p.len() < 8 && p.chars().all(|c| c.is_ascii_digit()))
        .collect();
    let family_label = capitalize(family);
    if nums.is_empty() {
        format!("Claude {family_label}")
    } else {
        format!("Claude {} {}", family_label, nums.join("."))
    }
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Spawn a headless Claude session for `alias` and read events until the
/// `system/init` line, which reports the resolved versioned model id. Returns
/// `None` on any failure (CLI missing, auth error, timeout, no init event).
fn probe_alias(alias: &str) -> Option<String> {
    let program = crate::agent_paths::resolve_program("claude");
    let mut child = crate::proc::std_command(program)
        .args([
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            alias,
            // Prompt content is irrelevant — the process is killed after the
            // init event, before any completion runs.
            "probe",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel::<String>();
    // Read on a worker thread so a hung CLI cannot block us indefinitely; the
    // recv_timeout below bounds the wait and we kill the child regardless.
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            let is_init = value.get("type").and_then(|v| v.as_str()) == Some("system")
                && value.get("subtype").and_then(|v| v.as_str()) == Some("init");
            if is_init {
                if let Some(model) = value.get("model").and_then(|v| v.as_str()) {
                    let _ = tx.send(model.to_string());
                }
                return;
            }
        }
    });

    let resolved = rx.recv_timeout(Duration::from_secs(20)).ok();
    let _ = child.kill();
    let _ = child.wait();
    resolved
}

/// Read the Claude CLI version string (e.g. `"2.1.196 (Claude Code)"`), used as
/// a cache-invalidation key. Empty string on failure.
fn claude_cli_version() -> String {
    let program = crate::agent_paths::resolve_program("claude");
    crate::proc::std_command(program)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// On-disk cache of alias → resolved model, keyed by CLI version so a CLI
/// upgrade forces a re-probe.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ModelCache {
    #[serde(default)]
    models: BTreeMap<String, ResolvedModel>,
    #[serde(default)]
    cli_version: String,
    #[serde(default)]
    fetched_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ResolvedModel {
    id: String,
    label: String,
}

fn cache_path() -> PathBuf {
    crate::agent_paths::data_dir().join("model-cache.json")
}

fn read_cache() -> Option<ModelCache> {
    let bytes = std::fs::read(cache_path()).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_cache(cache: &ModelCache) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_vec_pretty(cache) {
        let _ = std::fs::write(path, json);
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_agents_returns_all_known_agents() {
        let agents = detect_agents();
        assert_eq!(agents.len(), 4);
        let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&"claude"));
        assert!(ids.contains(&"codex"));
        assert!(ids.contains(&"antigravity"));
        assert!(ids.contains(&"gemini"));
    }

    #[test]
    fn parse_antigravity_models_trims_dedups_and_drops_blanks() {
        let out = "Gemini 3.5 Flash (Medium)\n\n  Claude Opus 4.6 (Thinking)  \nGemini 3.5 Flash (Medium)\n";
        let models = parse_antigravity_models(out);
        assert_eq!(
            models,
            vec![
                "Gemini 3.5 Flash (Medium)".to_string(),
                "Claude Opus 4.6 (Thinking)".to_string(),
            ]
        );
    }

    #[test]
    #[ignore = "requires Claude Code on PATH; run manually with cargo test -- --ignored"]
    fn claude_is_installed_on_this_machine() {
        let agents = detect_agents();
        assert!(
            agents.iter().any(|a| a.id == "claude" && a.installed),
            "claude binary not found on PATH — is Claude Code installed?"
        );
    }

    #[test]
    fn list_models_unknown_returns_empty() {
        assert!(list_models("unknown-agent").is_empty());
    }

    #[test]
    fn parse_codex_catalog_filters_hidden_unsupported_and_sorts_by_priority() {
        let json = r#"{"models":[
            {"slug":"gpt-5.4","display_name":"GPT-5.4","visibility":"list","priority":16,"context_window":272000,"supported_in_api":true},
            {"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","priority":7,"context_window":272000,"supported_in_api":true},
            {"slug":"codex-auto-review","display_name":"Codex Auto Review","visibility":"hide","priority":43,"context_window":272000,"supported_in_api":true},
            {"slug":"gpt-internal","display_name":"GPT Internal","visibility":"list","priority":1,"context_window":100,"supported_in_api":false}
        ]}"#;
        let models = parse_codex_catalog(json);
        // hidden + non-API entries dropped, remaining ordered by priority asc.
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].slug, "gpt-5.5");
        assert_eq!(models[0].label, "GPT-5.5");
        assert_eq!(models[0].context_window, Some(272_000));
        assert_eq!(models[1].slug, "gpt-5.4");
    }

    #[test]
    fn parse_codex_catalog_falls_back_to_slug_when_no_display_name() {
        let json = r#"{"models":[
            {"slug":"gpt-5.5","visibility":"list","priority":7,"supported_in_api":true}
        ]}"#;
        let models = parse_codex_catalog(json);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].label, "gpt-5.5");
        assert_eq!(models[0].context_window, None);
    }

    #[test]
    fn parse_codex_catalog_returns_empty_on_bad_json() {
        assert!(parse_codex_catalog("not json").is_empty());
    }

    #[test]
    fn codex_cache_to_models_maps_fields() {
        let cache = CodexModelCache {
            cli_version: "codex-cli 0.142.4".to_string(),
            fetched_at: 0,
            models: vec![CodexCachedModel {
                slug: "gpt-5.5".to_string(),
                label: "GPT-5.5".to_string(),
                context_window: Some(272_000),
            }],
        };
        let models = codex_cache_to_models(&cache);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].value, "gpt-5.5");
        assert_eq!(models[0].label, "GPT-5.5");
        assert_eq!(models[0].agent, "codex");
        assert_eq!(models[0].description.as_deref(), Some("gpt-5.5"));
        assert_eq!(models[0].context_window, Some(272_000));
        assert!(!models[0].disabled);
    }

    #[test]
    fn aliases_to_models_with_empty_cache_returns_bare_family_labels() {
        let models = aliases_to_models(&ModelCache::default());
        assert_eq!(models.len(), 3);
        assert!(
            models.iter().all(|m| m.agent == "claude" && !m.disabled),
            "all entries must be agent=claude, enabled"
        );
        assert_eq!(models[0].value, "opus", "opus must be first (default)");
        assert_eq!(models[0].label, "Claude Opus");
        assert!(
            models.iter().all(|m| m.description.is_none()),
            "unresolved entries have no model id"
        );
        assert!(
            models.iter().all(|m| m.context_window == Some(200_000)),
            "all entries report the default context window"
        );
    }

    #[test]
    fn aliases_to_models_with_cache_upgrades_to_versioned_labels() {
        let mut cache = ModelCache::default();
        cache.models.insert(
            "opus".to_string(),
            ResolvedModel {
                id: "claude-opus-4-8".to_string(),
                label: "Claude Opus 4.8".to_string(),
            },
        );
        let models = aliases_to_models(&cache);
        let opus = models.iter().find(|m| m.value == "opus").unwrap();
        assert_eq!(opus.label, "Claude Opus 4.8");
        assert_eq!(opus.description.as_deref(), Some("claude-opus-4-8"));
        // Unresolved families keep the bare label.
        let sonnet = models.iter().find(|m| m.value == "sonnet").unwrap();
        assert_eq!(sonnet.label, "Claude Sonnet");
        assert!(sonnet.description.is_none());
    }

    #[test]
    fn label_from_model_id_handles_versions_dates_and_fallbacks() {
        assert_eq!(label_from_model_id("claude-opus-4-8"), "Claude Opus 4.8");
        assert_eq!(
            label_from_model_id("claude-sonnet-4-6"),
            "Claude Sonnet 4.6"
        );
        assert_eq!(label_from_model_id("claude-haiku-4-5"), "Claude Haiku 4.5");
        // Trailing date snapshot dropped.
        assert_eq!(
            label_from_model_id("claude-opus-4-1-20250805"),
            "Claude Opus 4.1"
        );
        // Single-segment version (no minor).
        assert_eq!(label_from_model_id("claude-fable-5"), "Claude Fable 5");
        // Unknown shape falls back to the raw id.
        assert_eq!(label_from_model_id("gpt-4o"), "gpt-4o");
        assert_eq!(label_from_model_id("claude-"), "claude-");
    }
}

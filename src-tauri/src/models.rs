use serde::Serialize;

/// An agent CLI that agent-editor can drive, with an `installed` flag
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
/// `value` is forwarded verbatim to `--model` on the CLI; it is either a
/// short alias (`opus`, `sonnet`, `haiku`, `fable`) or a full model id
/// (`claude-opus-4-5`). `source` is `"api"` when the list came from the
/// Anthropic REST API and `"fallback"` when it came from the hardcoded alias
/// list (no API key, network error, or empty response).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub value: String,
    pub label: String,
    pub agent: String,
    pub description: Option<String>,
    pub source: String,
    pub disabled: bool,
}

/// Probe PATH for each supported agent CLI and return all three with their
/// `installed` flag. The frontend enables selectors for installed agents and
/// disables (greyed-out) ones that are missing.
pub fn detect_agents() -> Vec<AgentInfo> {
    [
        ("claude", "Claude Code"),
        ("codex", "OpenAI Codex"),
        ("gemini", "Gemini"),
    ]
    .iter()
    .map(|(bin, label)| AgentInfo {
        id: bin.to_string(),
        label: label.to_string(),
        installed: which::which(bin).is_ok(),
    })
    .collect()
}

/// Return available models for `agent`. Currently only `"claude"` is
/// implemented; all other agents return an empty list (they will be added as
/// their adapters mature).
pub fn list_models(agent: &str) -> Vec<ModelInfo> {
    match agent {
        "claude" => claude_models(),
        _ => vec![],
    }
}

/// Try the live Anthropic API first; fall back to hardcoded aliases on any
/// error (missing key, network failure, unexpected response shape).
fn claude_models() -> Vec<ModelInfo> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        if !key.is_empty() {
            if let Some(models) = fetch_anthropic_models(&key) {
                return models;
            }
        }
    }
    claude_fallback()
}

/// Hardcoded short-alias fallback list for Claude. These aliases always
/// resolve to the latest released variant of each tier (Anthropic guarantees
/// this), so they never go stale without a code change. Ordered opus-first so
/// the frontend can use index 0 as the default.
pub fn claude_fallback() -> Vec<ModelInfo> {
    [
        ("opus", "Claude Opus", "Latest Claude Opus (alias)"),
        ("sonnet", "Claude Sonnet", "Latest Claude Sonnet (alias)"),
        ("haiku", "Claude Haiku", "Latest Claude Haiku (alias)"),
    ]
    .iter()
    .map(|(value, label, description)| ModelInfo {
        value: value.to_string(),
        label: label.to_string(),
        agent: "claude".to_string(),
        description: Some(description.to_string()),
        source: "fallback".to_string(),
        disabled: false,
    })
    .collect()
}

/// Pure JSON→`Vec<ModelInfo>` mapper. Expects the parsed Anthropic `/v1/models`
/// response body. Returns `None` if the `data` key is absent or the array is
/// empty (so the caller can fall back). Never panics on unexpected JSON shapes.
///
/// Only `id` is required per item; `display_name` is optional and falls back to
/// `id` when absent.
fn parse_models(body: &serde_json::Value) -> Option<Vec<ModelInfo>> {
    let data = body.get("data")?.as_array()?;
    let models: Vec<ModelInfo> = data
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?;
            // display_name is optional: fall back to the id string when absent.
            let label = item.get("display_name").and_then(|v| v.as_str()).unwrap_or(id);
            Some(ModelInfo {
                value: id.to_string(),
                label: label.to_string(),
                agent: "claude".to_string(),
                description: None,
                source: "api".to_string(),
                disabled: false,
            })
        })
        .collect();
    if models.is_empty() { None } else { Some(models) }
}

/// Call `GET /v1/models` against the Anthropic REST API and map the response
/// to `ModelInfo` entries. Returns `None` on ANY failure — network error,
/// timeout, non-200 status, missing fields, empty list — so the caller can fall
/// back gracefully. Never panics.
fn fetch_anthropic_models(key: &str) -> Option<Vec<ModelInfo>> {
    let response = ureq::get("https://api.anthropic.com/v1/models?limit=1000")
        .set("x-api-key", key)
        .set("anthropic-version", "2023-06-01")
        // Without an explicit timeout ureq has no deadline; a hung connection
        // would block the spawn_blocking thread indefinitely.
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .ok()?;

    let body: serde_json::Value = response.into_json().ok()?;
    parse_models(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_agents_returns_exactly_three_entries() {
        let agents = detect_agents();
        assert_eq!(agents.len(), 3);
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
    fn claude_fallback_returns_three_fallback_models_agent_claude_opus_first() {
        let models = claude_fallback();
        assert_eq!(models.len(), 3);
        assert!(
            models.iter().all(|m| m.source == "fallback" && m.agent == "claude" && !m.disabled),
            "all models must be source=fallback, agent=claude, disabled=false"
        );
        assert_eq!(models[0].value, "opus", "opus must be first (default)");
    }

    #[test]
    fn list_models_codex_returns_empty() {
        assert!(list_models("codex").is_empty());
    }

    #[test]
    fn list_models_unknown_returns_empty() {
        assert!(list_models("unknown-agent").is_empty());
    }

    #[test]
    fn parse_models_maps_data_with_display_name_fallback_to_id() {
        let json = serde_json::json!({
            "data": [
                { "id": "claude-opus-4-6", "display_name": "Claude Opus 4.6" },
                { "id": "claude-x" }   // no display_name — must fall back to id
            ]
        });
        let models = parse_models(&json).expect("should parse non-empty data array");
        assert_eq!(models.len(), 2);
        // first entry: display_name present
        assert_eq!(models[0].value, "claude-opus-4-6");
        assert_eq!(models[0].label, "Claude Opus 4.6");
        assert_eq!(models[0].source, "api");
        assert!(!models[0].disabled);
        // second entry: display_name absent — label must equal id
        assert_eq!(models[1].value, "claude-x");
        assert_eq!(models[1].label, "claude-x");
        assert_eq!(models[1].source, "api");
    }

    #[test]
    fn parse_models_returns_none_for_empty_data_array() {
        let json = serde_json::json!({ "data": [] });
        assert!(parse_models(&json).is_none());
    }
}

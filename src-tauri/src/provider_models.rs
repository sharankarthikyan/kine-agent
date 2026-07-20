//! Live provider model lists for BYOK agents.
//!
//! Only claude (Anthropic) and codex (OpenAI) — antigravity has no key path.
//! The API key is read by the CALLER from the keychain and passed in; this
//! module never logs it and never persists anything. Parsing is separated
//! from fetching so tests are fixture-driven with no network.

use crate::models::ModelInfo;
use serde::Deserialize;
use std::time::Duration;

const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models";
const OPENAI_MODELS_URL: &str = "https://api.openai.com/v1/models";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
struct AnthropicModelsResponse {
    data: Vec<AnthropicModel>,
}

#[derive(Deserialize)]
struct AnthropicModel {
    id: String,
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
}

/// Parse Anthropic's GET /v1/models body. Every entry is chat-capable.
pub fn parse_anthropic_models(json: &str) -> Result<Vec<ModelInfo>, String> {
    let resp: AnthropicModelsResponse =
        serde_json::from_str(json).map_err(|_| "parse".to_string())?;
    Ok(resp
        .data
        .into_iter()
        .map(|m| ModelInfo {
            label: m.display_name.unwrap_or_else(|| m.id.clone()),
            description: Some(m.id.clone()),
            value: m.id,
            agent: "claude".to_string(),
            disabled: false,
            context_window: None,
        })
        .collect())
}

/// Whether an OpenAI model id is plausibly chat/codex-capable. The /v1/models
/// list is polluted (whisper, dall-e, embeddings, tts, realtime); anything the
/// filter wrongly drops remains addable by hand in the UI.
fn openai_id_is_chat(id: &str) -> bool {
    const EXCLUDE: [&str; 8] = [
        "tts", "image", "audio", "realtime", "transcribe",
        "embedding", "moderation", "search",
    ];
    if EXCLUDE.iter().any(|frag| id.contains(frag)) {
        return false;
    }
    if id.starts_with("gpt-") || id.contains("codex") {
        return true;
    }
    let mut chars = id.chars();
    chars.next() == Some('o') && chars.next().is_some_and(|c| c.is_ascii_digit())
}

/// Parse OpenAI's GET /v1/models body, filtered to chat-capable ids.
pub fn parse_openai_models(json: &str) -> Result<Vec<ModelInfo>, String> {
    let resp: OpenAiModelsResponse =
        serde_json::from_str(json).map_err(|_| "parse".to_string())?;
    Ok(resp
        .data
        .into_iter()
        .filter(|m| openai_id_is_chat(&m.id))
        .map(|m| ModelInfo {
            label: m.id.clone(),
            value: m.id,
            agent: "codex".to_string(),
            description: None,
            disabled: false,
            context_window: None,
        })
        .collect())
}

/// Anthropic paginates GET /v1/models (default page size 20, max 1000, with
/// a `has_more` cursor). We request the max page instead of following the
/// cursor — 1000 comfortably covers the realistic active-model list size.
fn anthropic_models_url() -> String {
    format!("{ANTHROPIC_MODELS_URL}?limit=1000")
}

/// Fetch the provider's live model list using the given API key.
/// Error codes (stable strings the frontend maps to copy):
/// "unsupported-agent" | "bad-key" | "network" | "parse".
pub async fn fetch_provider_models(agent: &str, key: &str) -> Result<Vec<ModelInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|_| "network".to_string())?;
    let request = match agent {
        "claude" => client
            .get(anthropic_models_url())
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        "codex" => client
            .get(OPENAI_MODELS_URL)
            .header("authorization", format!("Bearer {key}")),
        _ => return Err("unsupported-agent".to_string()),
    };
    let response = request.send().await.map_err(|_| "network".to_string())?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("bad-key".to_string());
    }
    if !status.is_success() {
        return Err("network".to_string());
    }
    let body = response.text().await.map_err(|_| "network".to_string())?;
    match agent {
        "claude" => parse_anthropic_models(&body),
        _ => parse_openai_models(&body),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANTHROPIC_FIXTURE: &str = r#"{
      "data": [
        {"type": "model", "id": "claude-opus-4-8", "display_name": "Claude Opus 4.8", "created_at": "2026-05-01T00:00:00Z"},
        {"type": "model", "id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5", "created_at": "2025-10-01T00:00:00Z"}
      ],
      "has_more": false, "first_id": "claude-opus-4-8", "last_id": "claude-haiku-4-5-20251001"
    }"#;

    const OPENAI_FIXTURE: &str = r#"{
      "object": "list",
      "data": [
        {"id": "gpt-5.2-codex", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "gpt-4o", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "o3-mini", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "whisper-1", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "dall-e-3", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "text-embedding-3-small", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "gpt-4o-mini-tts", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "omni-moderation-latest", "object": "model", "created": 1, "owned_by": "openai"}
      ]
    }"#;

    #[test]
    fn anthropic_parse_maps_display_name_and_id() {
        let models = parse_anthropic_models(ANTHROPIC_FIXTURE).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].value, "claude-opus-4-8");
        assert_eq!(models[0].label, "Claude Opus 4.8");
        assert_eq!(models[0].description.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(models[0].agent, "claude");
        assert!(!models[0].disabled);
    }

    #[test]
    fn anthropic_missing_display_name_falls_back_to_id() {
        let json = r#"{"data": [{"id": "claude-test-1"}]}"#;
        let models = parse_anthropic_models(json).unwrap();
        assert_eq!(models[0].label, "claude-test-1");
    }

    #[test]
    fn openai_parse_filters_non_chat_models() {
        let models = parse_openai_models(OPENAI_FIXTURE).unwrap();
        let ids: Vec<&str> = models.iter().map(|m| m.value.as_str()).collect();
        assert_eq!(ids, vec!["gpt-5.2-codex", "gpt-4o", "o3-mini"]);
        assert!(models.iter().all(|m| m.agent == "codex"));
    }

    #[test]
    fn malformed_json_is_a_parse_error_not_a_panic() {
        assert_eq!(parse_anthropic_models("{nope").unwrap_err(), "parse");
        assert_eq!(parse_openai_models("[]").unwrap_err(), "parse");
    }

    #[test]
    fn openai_chat_filter_rejects_lookalikes() {
        assert!(openai_id_is_chat("gpt-5.2"));
        assert!(openai_id_is_chat("codex-mini-latest"));
        assert!(openai_id_is_chat("o4-mini"));
        assert!(!openai_id_is_chat("whisper-1"));
        assert!(!openai_id_is_chat("omni-moderation-latest")); // 'o' not followed by digit + excluded
        assert!(!openai_id_is_chat("gpt-4o-mini-tts"));
        assert!(!openai_id_is_chat("davinci-002"));
    }

    #[tokio::test]
    async fn unsupported_agent_is_rejected_before_any_request() {
        assert_eq!(
            fetch_provider_models("antigravity", "sk-x").await.unwrap_err(),
            "unsupported-agent"
        );
    }

    #[test]
    fn anthropic_url_requests_max_page_size() {
        assert!(anthropic_models_url().contains("limit=1000"));
    }
}

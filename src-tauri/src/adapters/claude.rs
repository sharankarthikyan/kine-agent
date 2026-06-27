use crate::events::AgentEvent;
use serde_json::Value;

/// Parse one line of `claude --output-format stream-json` into an AgentEvent.
/// Returns None for blank lines, unknown types, or non-JSON (never panics).
pub fn parse_line(line: &str) -> Option<AgentEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    match v.get("type")?.as_str()? {
        "assistant" => parse_assistant(&v),
        "result" => Some(AgentEvent::Done {
            summary: v.get("result").and_then(Value::as_str).unwrap_or("").to_string(),
        }),
        _ => None, // system/init and anything else: ignore in the skeleton
    }
}

fn parse_assistant(v: &Value) -> Option<AgentEvent> {
    // Skeleton limitation: only the first content block is mapped. Real assistant
    // messages can carry multiple blocks (e.g. text + tool_use); the rest are
    // dropped here. Task 6 reconciles this against recorded real CLI output.
    let block = v.get("message")?.get("content")?.as_array()?.first()?;
    match block.get("type")?.as_str()? {
        "text" => Some(AgentEvent::Token {
            text: block.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
        }),
        "tool_use" => Some(AgentEvent::ToolCall {
            name: block.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            // `input` is stored as compact JSON text (objects/arrays serialized).
            input: block.get("input").map(|i| i.to_string()).unwrap_or_default(),
        }),
        _ => None,
    }
}

use kineloop_lib::adapters::claude::parse_line;
use kineloop_lib::events::AgentEvent;

fn fixture() -> Vec<String> {
    let raw = include_str!("fixtures/claude_stream.jsonl");
    raw.lines().map(|l| l.to_string()).collect()
}

#[test]
fn parses_assistant_text_as_token() {
    let events: Vec<AgentEvent> = fixture().iter().flat_map(|l| parse_line(l)).collect();
    assert!(events.contains(&AgentEvent::Token {
        text: "Hello".into()
    }));
}

#[test]
fn parses_tool_use_as_tool_call() {
    let events: Vec<AgentEvent> = fixture().iter().flat_map(|l| parse_line(l)).collect();
    assert!(events
        .iter()
        .any(|e| matches!(e, AgentEvent::ToolCall { name, .. } if name == "Write")));
}

#[test]
fn parses_result_as_done() {
    let events: Vec<AgentEvent> = fixture().iter().flat_map(|l| parse_line(l)).collect();
    assert!(events.contains(&AgentEvent::Done {
        summary: "Done writing a.txt".into()
    }));
}

#[test]
fn result_is_error_maps_to_error_event() {
    let events: Vec<AgentEvent> = fixture().iter().flat_map(|l| parse_line(l)).collect();
    assert!(
        events.contains(&AgentEvent::Error {
            message: "Auth failed".into()
        }),
        "is_error:true result must produce AgentEvent::Error, not Done"
    );
}

#[test]
fn two_block_assistant_emits_token_and_tool_call() {
    // A single assistant line with [text, tool_use] must produce both events — the second
    // block must not be silently dropped.
    let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Here is the file"},{"type":"tool_use","name":"Write","input":{"file_path":"b.txt"}}]}}"#;
    let events = parse_line(line);
    assert_eq!(
        events.len(),
        2,
        "expected exactly two events from a two-block assistant line"
    );
    assert!(
        events.contains(&AgentEvent::Token {
            text: "Here is the file".into()
        }),
        "text block must produce a Token event"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolCall { name, .. } if name == "Write")),
        "tool_use block must produce a ToolCall event"
    );
}

#[test]
fn ignores_garbage_lines_without_panicking() {
    assert!(parse_line("not-json-garbage-line").is_empty());
}

/// Regression guard against schema drift: recorded from a real
/// `claude -p "say hi in exactly one word" --output-format stream-json --verbose`
/// run (Claude Code 2.1.195; hook_started/hook_response lines removed — they
/// contained personal developer config). Confirms the parser maps the real
/// assistant/result shapes and ignores rate_limit lines — three events out of
/// the remaining stream: Token, Usage (from the result's usage object), Done.
#[test]
fn parses_real_recorded_stream() {
    let raw = include_str!("fixtures/claude_stream_real.jsonl");
    let events: Vec<AgentEvent> = raw.lines().flat_map(parse_line).collect();
    assert_eq!(
        events,
        vec![
            AgentEvent::Token { text: "Hi.".into() },
            AgentEvent::Usage {
                input_tokens: 20090,
                output_tokens: 6,
                cache_read_tokens: 14376,
                cache_creation_tokens: 5872,
                cost_usd: Some(0.166508),
                model: None,
                context_used: None,
                context_window: None,
            },
            AgentEvent::Done {
                summary: "Hi.".into()
            },
        ],
        "real-output parsing drifted; re-record the fixture and reconcile parse_line"
    );
}

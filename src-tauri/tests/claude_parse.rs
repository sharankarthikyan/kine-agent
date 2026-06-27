use agent_editor_lib::adapters::claude::parse_line;
use agent_editor_lib::events::AgentEvent;

fn fixture() -> Vec<String> {
    let raw = include_str!("fixtures/claude_stream.jsonl");
    raw.lines().map(|l| l.to_string()).collect()
}

#[test]
fn parses_assistant_text_as_token() {
    let events: Vec<AgentEvent> = fixture().iter().filter_map(|l| parse_line(l)).collect();
    assert!(events.contains(&AgentEvent::Token { text: "Hello".into() }));
}

#[test]
fn parses_tool_use_as_tool_call() {
    let events: Vec<AgentEvent> = fixture().iter().filter_map(|l| parse_line(l)).collect();
    assert!(events.iter().any(|e| matches!(e, AgentEvent::ToolCall { name, .. } if name == "Write")));
}

#[test]
fn parses_result_as_done() {
    let events: Vec<AgentEvent> = fixture().iter().filter_map(|l| parse_line(l)).collect();
    assert!(events.contains(&AgentEvent::Done { summary: "Done writing a.txt".into() }));
}

#[test]
fn ignores_garbage_lines_without_panicking() {
    assert_eq!(parse_line("not-json-garbage-line"), None);
}

/// Regression guard against schema drift: recorded from a real
/// `claude -p "say hi in exactly one word" --output-format stream-json --verbose`
/// run (Claude Code 2.1.195; verbose env-dump init line removed). Confirms the
/// parser maps the real assistant/result shapes and ignores system/hook/rate_limit
/// lines — exactly two events out of the whole stream.
#[test]
fn parses_real_recorded_stream() {
    let raw = include_str!("fixtures/claude_stream_real.jsonl");
    let events: Vec<AgentEvent> = raw.lines().filter_map(parse_line).collect();
    assert_eq!(
        events,
        vec![
            AgentEvent::Token { text: "Hi.".into() },
            AgentEvent::Done { summary: "Hi.".into() },
        ],
        "real-output parsing drifted; re-record the fixture and reconcile parse_line"
    );
}

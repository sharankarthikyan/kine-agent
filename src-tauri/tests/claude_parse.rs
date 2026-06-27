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

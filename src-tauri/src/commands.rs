use crate::adapter::{AgentAdapter, EventSink, Prompt};
use crate::adapters::claude::ClaudeAdapter;
use crate::events::AgentEvent;
use tauri::ipc::Channel;

/// Adapts a Tauri Channel into our EventSink trait.
struct ChannelSink(Channel<AgentEvent>);

impl EventSink for ChannelSink {
    fn emit(&self, event: AgentEvent) {
        // Ignore send errors (frontend may have navigated away).
        let _ = self.0.send(event);
    }
}

#[tauri::command]
pub async fn start_session(
    prompt: String,
    cwd: String,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    let sink = Box::new(ChannelSink(on_event));
    ClaudeAdapter
        .run(Prompt { text: prompt }, cwd.into(), sink)
        .await
        .map_err(|e| e.to_string())
}

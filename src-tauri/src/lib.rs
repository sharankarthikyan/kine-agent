pub mod adapter;
pub mod adapters;
mod commands;
pub mod events;
pub mod review;
pub mod worktree;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::start_session,
            commands::cleanup_session,
            commands::review_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

pub mod adapter;
pub mod adapters;
mod commands;
pub mod events;
pub mod inspect;
pub mod models;
pub mod review;
pub mod store;
pub mod worktree;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Open the session store before building (block on the async connect once).
    let store = tauri::async_runtime::block_on(async {
        store::SessionStore::connect(&store::default_db_path())
            .await
            .expect("failed to open session store")
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(store)
        .invoke_handler(tauri::generate_handler![
            commands::start_session,
            commands::cleanup_session,
            commands::review_session,
            commands::send_message,
            commands::list_sessions,
            commands::session_events,
            commands::detect_agents,
            commands::list_models,
            commands::inspect_rules,
            commands::read_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

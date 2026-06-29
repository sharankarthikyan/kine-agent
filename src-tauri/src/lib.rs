pub mod adapter;
pub mod adapters;
mod commands;
pub mod events;
pub mod git;
pub mod inspect;
pub mod models;
pub mod review;
pub mod store;
pub mod worktree;

use tauri::Manager;

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
        .plugin(tauri_plugin_dialog::init())
        .manage(store)
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                // Paint the native window (including the transparent Overlay titlebar region on
                // macOS) opaque dark so the desktop never bleeds through the top edge.
                // The backgroundColor in tauri.conf.json is compiled-in; this runtime call
                // forces the native layer to apply it reliably on every launch.
                let _ = win.set_background_color(Some(tauri::window::Color(9, 9, 11, 255)));
            }
            Ok(())
        })
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
            commands::read_text_file,
            commands::write_text_file,
            commands::list_capabilities,
            commands::customizations_counts,
            commands::session_diffstat,
            commands::worktree_tree,
            commands::branch_changes,
            commands::commit_session,
            commands::open_in_editor,
            commands::open_terminal
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

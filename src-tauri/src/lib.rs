pub mod adapter;
pub mod adapters;
pub mod agent_paths;
pub mod approval;
mod commands;
pub mod events;
pub mod external_sessions;
pub mod fsbrowse;
pub mod git;
pub mod inspect;
pub mod models;
pub mod permission;
pub mod review;
pub mod store;
pub mod worktree;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Migrate the pre-rename data dir (~/.agent-editor → ~/.kineloop) before anything
    // touches the store, so existing sessions and worktrees carry over.
    agent_paths::migrate_legacy_data_dir();

    // Open the session store before building (block on the async connect once).
    let store = tauri::async_runtime::block_on(async {
        let store = store::SessionStore::connect(&store::default_db_path())
            .await
            .expect("failed to open session store");
        // Crash recovery: the in-memory run registry starts empty, so any session still
        // marked "running" from a previous process is from a run that died with the app.
        // Reconcile it to "error" so it isn't stranded "running" forever. Best-effort.
        if let Err(e) = store.reset_running_sessions().await {
            eprintln!("failed to reconcile stale running sessions on startup: {e}");
        }
        store
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(store)
        .manage(commands::RunRegistry::default())
        .manage(approval::ApprovalRegistry::default())
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
            commands::pick_repository,
            commands::list_trusted_repos,
            commands::start_session,
            commands::continue_external_session,
            commands::cleanup_session,
            commands::stop_session,
            commands::respond_to_approval,
            commands::review_session,
            commands::send_message,
            commands::list_sessions,
            commands::rename_session,
            commands::session_events,
            commands::session_events_page,
            commands::detect_agents,
            commands::list_models,
            commands::refresh_models,
            commands::inspect_rules,
            commands::read_text_file,
            commands::write_text_file,
            commands::read_worktree_file,
            commands::list_dir,
            commands::read_any_file,
            commands::list_capabilities,
            commands::customizations_counts,
            commands::session_diffstat,
            commands::worktree_tree,
            commands::branch_changes,
            commands::commit_session,
            commands::open_in_editor,
            commands::open_terminal,
            commands::list_hooks,
            commands::list_mcp_servers,
            commands::list_plugins
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

pub mod acp;
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
pub mod proc;
pub mod review;
pub mod store;
pub mod worktree;

use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{Emitter, Manager};

/// Event id fired at the webview when the native "Check for Updates…" menu item is
/// clicked. `UpdaterHost.tsx` listens for it and runs the JS updater flow.
const MENU_CHECK_UPDATES_EVENT: &str = "menu://check-for-updates";
const MENU_CHECK_UPDATES_ID: &str = "check-for-updates";

/// Add a "Check for Updates…" item to the native menu. On macOS it goes into the
/// app menu (the "Kineloop" submenu, right under About, per platform convention);
/// on Windows/Linux it's appended to the last submenu (Help). Clicking it emits
/// `MENU_CHECK_UPDATES_EVENT` to the frontend — see the builder's on_menu_event.
fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let check = MenuItem::with_id(
        app,
        MENU_CHECK_UPDATES_ID,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let items = menu.items()?;
    #[cfg(target_os = "macos")]
    if let Some(MenuItemKind::Submenu(app_menu)) = items.first() {
        // Index 1 = just below "About Kineloop".
        app_menu.insert(&check, 1)?;
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(MenuItemKind::Submenu(help_menu)) = items.last() {
        help_menu.append(&check)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A Finder/desktop launch inherits launchd's minimal PATH (no Homebrew/npm/
    // ~/.local/bin), making every agent CLI look "not installed" in the packaged app.
    // Adopt the user's login-shell PATH before anything resolves or spawns a CLI.
    agent_paths::adopt_login_shell_path();

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

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());

    // The self-updater is desktop-only (no mobile artifacts to update).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .on_menu_event(|app, event| {
            if event.id().as_ref() == MENU_CHECK_UPDATES_ID {
                let _ = app.emit(MENU_CHECK_UPDATES_EVENT, ());
            }
        })
        .manage(store)
        .manage(commands::RunRegistry::default())
        .manage(approval::ApprovalRegistry::default())
        .setup(|app| {
            if let Err(e) = install_menu(app.handle()) {
                eprintln!("failed to install native menu: {e}");
            }
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
            commands::node_available,
            commands::inspect_rules,
            commands::read_text_file,
            commands::write_text_file,
            commands::create_customization,
            commands::delete_customization,
            commands::add_hook,
            commands::delete_hook,
            commands::add_mcp_server,
            commands::delete_mcp_server,
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
            commands::open_agent_login,
            commands::list_hooks,
            commands::list_mcp_servers,
            commands::list_plugins
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

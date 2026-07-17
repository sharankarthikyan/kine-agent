// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Approval-server mode: Claude spawns this binary as an MCP permission server
    // (`kine-agent --approval-server --session <id> --socket <path>`). Speak MCP over stdio
    // and bridge decisions to the running app over the socket, then exit — never start the GUI.
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--approval-server") {
        #[cfg(unix)]
        {
            let session = flag_value(&args, "--session").unwrap_or_default();
            let socket = flag_value(&args, "--socket").unwrap_or_default();
            if let Err(e) = kine_agent_lib::approval::run_approval_server(
                session,
                std::path::PathBuf::from(socket),
            ) {
                eprintln!("approval server error: {e}");
                std::process::exit(1);
            }
            return;
        }
        #[cfg(not(unix))]
        {
            eprintln!("the approval server is not supported on this platform yet");
            std::process::exit(1);
        }
    }

    kine_agent_lib::run()
}

/// The value following `flag` in `args` (e.g. `--session <value>`), if present.
#[cfg(unix)]
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

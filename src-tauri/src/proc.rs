//! Process-spawn constructors that keep child consoles off-screen on Windows.
//!
//! Kineloop's release binary is a GUI-subsystem app (`windows_subsystem = "windows"`
//! in main.rs), so it owns no console. On Windows, every console-subsystem child —
//! git, `claude.cmd` → cmd.exe → node, codex, agy, npx — then allocates its OWN
//! console, i.e. a visible terminal window flashing on app open (model discovery)
//! and on every prompt (agent + git spawns). `CREATE_NO_WINDOW` gives the child a
//! console with no window instead, and descendants inherit that hidden console, so
//! the whole npx → node → claude.exe chain stays off-screen.
//!
//! Deliberately NOT `DETACHED_PROCESS`: a detached child has no console at all, so
//! any console-subsystem grandchild would allocate a fresh — visible — one. The
//! flag is ignored for GUI-subsystem children (VS Code, Windows Terminal), which
//! makes wrapping those harmless.
//!
//! Every spawn in non-test code must come from this module; `every_spawn_goes_through_proc`
//! below fails the build tree on any naked `Command::new` elsewhere.

use std::ffi::OsStr;

/// `CREATE_NO_WINDOW` from winbase.h — run the console child without a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `std::process::Command` whose console never shows a window on Windows.
/// Use for every background spawn (git, CLI probes, version checks).
#[cfg(windows)]
pub fn std_command(program: impl AsRef<OsStr>) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// A `std::process::Command` whose console never shows a window on Windows.
/// Use for every background spawn (git, CLI probes, version checks).
#[cfg(not(windows))]
pub fn std_command(program: impl AsRef<OsStr>) -> std::process::Command {
    std::process::Command::new(program)
}

/// A `tokio::process::Command` whose console never shows a window on Windows.
/// Use for every background spawn (agent adapters, npx ACP bridges).
#[cfg(windows)]
pub fn tokio_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// A `tokio::process::Command` whose console never shows a window on Windows.
/// Use for every background spawn (agent adapters, npx ACP bridges).
#[cfg(not(windows))]
pub fn tokio_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    tokio::process::Command::new(program)
}

/// A `std::process::Command` that is MEANT to show a window — the "Open terminal"
/// features whose entire purpose is putting a console in front of the user. Exists
/// (rather than a naked `Command::new`) so the spawn-guard test can pin every other
/// spawn to the hidden constructors above.
pub fn user_facing_std_command(program: impl AsRef<OsStr>) -> std::process::Command {
    std::process::Command::new(program)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[test]
    fn constructors_target_the_requested_program() {
        assert_eq!(super::std_command("git").get_program(), "git");
        assert_eq!(super::user_facing_std_command("git").get_program(), "git");
        assert_eq!(super::tokio_command("git").as_std().get_program(), "git");
    }

    /// The hidden flag must not break spawning or piped stdio — the exact shape
    /// every call site relies on (`.output()` with captured stdout).
    #[cfg(windows)]
    #[test]
    fn hidden_std_command_spawns_with_piped_io() {
        let out = super::std_command("cmd")
            .args(["/C", "echo kineloop-hidden"])
            .output()
            .expect("spawn cmd");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("kineloop-hidden"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn hidden_tokio_command_spawns_with_piped_io() {
        let out = super::tokio_command("cmd")
            .args(["/C", "echo kineloop-hidden"])
            .output()
            .await
            .expect("spawn cmd");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("kineloop-hidden"));
    }

    /// Regression guard for the Windows console-flash bug: a naked `Command::new`
    /// in shipped code bypasses CREATE_NO_WINDOW and pops a terminal window on
    /// users' screens. Test modules (everything from the first `#[cfg(test)]` to
    /// EOF — the tail-of-file convention in this codebase) are exempt: their
    /// spawns never run in the app.
    #[test]
    fn every_spawn_goes_through_proc() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        scan_dir(&src, &mut offenders);
        assert!(
            offenders.is_empty(),
            "naked Command::new outside proc.rs — route it through proc::std_command / \
             proc::tokio_command (hidden console on Windows) or proc::user_facing_std_command \
             (deliberately visible):\n{}",
            offenders.join("\n")
        );
    }

    fn scan_dir(dir: &Path, offenders: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).expect("readable src dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                scan_dir(&path, offenders);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs")
                || path.file_name().and_then(|n| n.to_str()) == Some("proc.rs")
            {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("readable source file");
            let non_test = text.split("#[cfg(test)]").next().unwrap_or("");
            for (i, line) in non_test.lines().enumerate() {
                // Doc/line comments may cite Command::new (agent_paths.rs does) — only
                // executable occurrences matter.
                if line.trim_start().starts_with("//") {
                    continue;
                }
                if line.contains("Command::new(") {
                    offenders.push(format!("{}:{}: {}", path.display(), i + 1, line.trim()));
                }
            }
        }
    }
}

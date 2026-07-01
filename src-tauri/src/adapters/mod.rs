pub mod antigravity;
pub mod claude;
pub mod codex;

use std::ffi::OsStr;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt};
use tokio::process::ChildStdin;

/// Maximum bytes retained for a single line of agent stdout. A pathological line — e.g. a
/// stream-json event embedding a huge base64 blob, or an agent dumping a multi-MB file
/// into one event — is skipped rather than buffered unbounded, protecting against OOM
/// without killing the stream. Generous enough for any legitimate event.
pub(crate) const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Outcome of [`read_capped_line`].
pub(crate) enum CappedLine {
    /// A complete line within the cap, with any trailing CR/LF stripped.
    Line(Vec<u8>),
    /// A line exceeded the cap and was dropped; carries its total byte length for logging.
    Skipped(usize),
    /// End of stream.
    Eof,
}

/// Read one newline-delimited line from `reader`, retaining at most `cap` bytes.
///
/// A line longer than `cap` is still fully consumed from the stream (so parsing realigns
/// to the next line) but only its length is reported (`Skipped`) — the retained buffer
/// never exceeds `cap`. Unlike `read_until`, which grows its buffer to the full line
/// length first, this bounds memory for adversarial/oversized input. IO errors propagate.
pub(crate) async fn read_capped_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    cap: usize,
) -> std::io::Result<CappedLine> {
    let mut buf: Vec<u8> = Vec::new();
    let mut total: usize = 0;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if total == 0 {
                return Ok(CappedLine::Eof);
            }
            break; // EOF after a final line with no trailing newline
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            let keep = cap.saturating_sub(buf.len()).min(pos);
            buf.extend_from_slice(&available[..keep]);
            total += pos;
            reader.consume(pos + 1);
            break;
        }
        let len = available.len();
        let keep = cap.saturating_sub(buf.len()).min(len);
        buf.extend_from_slice(&available[..keep]);
        total += len;
        reader.consume(len);
    }
    if total > cap {
        return Ok(CappedLine::Skipped(total));
    }
    while matches!(buf.last(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
    Ok(CappedLine::Line(buf))
}

/// True when `program` resolves to a Windows batch shim (`.cmd`/`.bat`).
///
/// npm installs the agent CLIs as `.cmd` shims on Windows. `std::process::Command`
/// (wrapped by `tokio::process::Command`) refuses to pass any argument containing `\r`
/// or `\n` to a batch file: it wraps the call in `cmd.exe` and returns
/// `InvalidInput: "batch file arguments are invalid"` — hardening added in Rust 1.77.2
/// for CVE-2024-24576. A multi-line prompt therefore can't ride on the command line and
/// must be delivered over stdin instead. On Unix the resolved path is a real executable,
/// never `.cmd`/`.bat`, so this is always `false` and the prompt keeps going as an
/// argument (the existing, verified behavior is untouched).
pub(crate) fn is_batch_shim(program: &OsStr) -> bool {
    let lower = program.to_string_lossy().to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// Write `prompt` to a spawned child's `stdin` on a background task, then close stdin
/// (EOF). Used when the prompt is delivered over stdin instead of as a CLI argument
/// (see [`is_batch_shim`]). The write runs on its own task so a prompt larger than the OS
/// pipe buffer can't deadlock against the child writing stdout at the same time. Errors
/// are ignored: a child that exits early or never reads stdin surfaces through its own
/// exit status and stderr, not here.
pub(crate) fn feed_prompt_via_stdin(mut stdin: ChildStdin, prompt: String) {
    tokio::spawn(async move {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    async fn collect(input: &[u8], cap: usize) -> Vec<CappedLine> {
        let mut reader = BufReader::new(input);
        let mut out = Vec::new();
        loop {
            let line = read_capped_line(&mut reader, cap).await.unwrap();
            let stop = matches!(line, CappedLine::Eof);
            out.push(line);
            if stop {
                break;
            }
        }
        out
    }

    #[tokio::test]
    async fn reads_lines_and_strips_newlines() {
        let lines = collect(b"alpha\nbeta\r\ngamma", 1024).await;
        // alpha, beta, gamma, eof
        assert_eq!(lines.len(), 4);
        assert!(matches!(&lines[0], CappedLine::Line(b) if b == b"alpha"));
        assert!(matches!(&lines[1], CappedLine::Line(b) if b == b"beta"));
        assert!(matches!(&lines[2], CappedLine::Line(b) if b == b"gamma"));
        assert!(matches!(&lines[3], CappedLine::Eof));
    }

    #[tokio::test]
    async fn skips_oversized_line_but_keeps_following_lines() {
        let mut input = vec![b'x'; 50];
        input.push(b'\n');
        input.extend_from_slice(b"ok\n");
        let lines = collect(&input, 8).await;
        // oversized (skipped), "ok", eof
        assert_eq!(lines.len(), 3);
        assert!(matches!(lines[0], CappedLine::Skipped(50)));
        assert!(matches!(&lines[1], CappedLine::Line(b) if b == b"ok"));
        assert!(matches!(lines[2], CappedLine::Eof));
    }

    #[tokio::test]
    async fn line_exactly_at_cap_is_kept() {
        let lines = collect(b"12345678\n", 8).await;
        assert!(matches!(&lines[0], CappedLine::Line(b) if b == b"12345678"));
    }

    #[test]
    fn batch_shim_detected_case_insensitively() {
        use std::ffi::OsString;
        // Windows npm shims — prompt must go via stdin.
        assert!(is_batch_shim(&OsString::from(r"C:\Users\me\AppData\Roaming\npm\claude.cmd")));
        assert!(is_batch_shim(&OsString::from(r"C:\npm\codex.CMD")));
        assert!(is_batch_shim(&OsString::from("agy.bat")));
        // Real executables and Unix paths — prompt stays a CLI argument.
        assert!(!is_batch_shim(&OsString::from("/usr/local/bin/claude")));
        assert!(!is_batch_shim(&OsString::from(r"C:\Program Files\nodejs\claude.exe")));
        assert!(!is_batch_shim(&OsString::from("claude")));
    }
}

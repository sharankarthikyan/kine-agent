# Kineloop

> Keep every agent loop under control.

Kineloop is a local-first desktop app that spawns and supervises AI coding-agent
CLIs — Claude Code, OpenAI Codex, and Antigravity — as subprocesses, and presents
them in one structured orchestrator UI: a session list, live status, diff viewer,
and approval gates, with per-session git-worktree isolation.

Instead of juggling several agent CLIs across terminal tabs, you drive them all from
one window. Each session runs in its own isolated git worktree, so an agent's edits
never touch your working tree until you review them.

> Formerly "agent-editor". Existing `~/.agent-editor/` data is migrated to
> `~/.kineloop/` automatically on first launch.

## Highlights

- **Multiple agents, one UI.** Start a session with Claude, Codex, or Antigravity;
  the session list, diff viewer, and approval flow are identical across agents.
- **Per-session isolation.** Every session gets its own git worktree
  (`~/.kineloop/worktrees/<id>`) on a dedicated branch — blast-radius containment by
  default. Review the diff, then merge or discard.
- **Live, normalized events.** Three different agent CLIs emit three different JSON
  shapes; an adapter layer normalizes them to one event stream (tokens, tool calls,
  file writes, usage, done/error).
- **Reads your existing CLI history.** Past Claude / Codex / Gemini / Antigravity CLI
  sessions on disk are listed read-only alongside Kineloop's own — searchable and
  filterable by status and source.
- **Model discovery, no API keys.** Models are discovered from each CLI itself (under
  your existing subscription auth), never via API credentials.
- **Cross-platform.** macOS, Windows, and Linux (paths and CLI shims resolved per OS).

## Agent support

| Agent | New sessions | History (read-only) | Notes |
|-------|:---:|:---:|-------|
| **Claude Code** | ✅ full | ✅ | `claude -p --output-format stream-json` |
| **OpenAI Codex** | ✅ full | ✅ | `codex exec --json`; resumes by captured thread id |
| **Antigravity** (`agy`) | ✅ text-only | ✅ | `agy --print` emits final text only — no live tool/file/usage events; scoped to the worktree via `--add-dir` |
| **Gemini CLI** | — | ✅ | deprecated upstream (succeeded by Antigravity); history listed, spawning gated |

## Stack

- **Backend core:** Rust, in a Tauri 2 desktop shell (`kineloop` crate / `kineloop_lib`)
- **Frontend:** React + Vite + TypeScript + Tailwind v4 + shadcn/ui, running in the
  system WebView
- **Persistence:** SQLite via `sqlx` (`~/.kineloop/kineloop.db`); append-only event log
- **Secrets:** OS keychain via the `keyring` crate (never SQLite or logs)
- **Agents:** driven headless as subprocesses; one `AgentAdapter` per agent normalizing
  to a single `AgentEvent` enum

## Architecture

```
React UI  ──Tauri IPC──▶  Rust core
                          ├─ Supervisor      spawn / stream / cancel agent CLIs
                          ├─ AgentAdapter     claude · codex · antigravity (one per agent)
                          ├─ WorktreeManager  one git worktree per session
                          └─ SessionStore     SQLite: sessions + append-only events
```

The frontend cannot call arbitrary FS/shell — IPC is capability-allowlisted. Adding a
new agent means writing one adapter; the UI is untouched.

## Getting started

Prerequisites: [Rust](https://rustup.rs/), Node.js 20+, and the agent CLIs you want to
drive on your `PATH` (`claude`, `codex`, and/or `agy`).

```bash
npm install
npm run tauri dev      # run the desktop app in dev mode
```

### Build

```bash
npm run tauri build    # produce a platform bundle
```

### Tests

```bash
npm test                       # frontend (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml   # backend (Rust)
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
```

## Data & privacy

- All data is local. Sessions, worktrees, and the event log live under `~/.kineloop/`.
- Agent CLIs run under your own subscription/auth; Kineloop does not store API keys.
- Agents default to their own sandbox; full-access modes are opt-in per session.

## Status

MVP, local-only. Cloud/remote control, live-terminal attach, and mobile are
intentionally deferred to later phases.

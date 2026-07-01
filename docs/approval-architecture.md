# Tool-approval architecture

Unified, agent-agnostic manual approval: when an agent wants to run a gated tool, Kineloop
surfaces Approve/Deny in the UI and blocks the tool until the user answers.

## Why a shared core (not a per-agent hack)

The three CLIs diverge sharply on what they expose (verified against each CLI, not assumed):

| Agent | Headless invocation | Answerable approval gate? |
|---|---|---|
| **claude** | `claude -p --output-format stream-json` | Yes, via `--permission-prompt-tool` (MCP) or `PreToolUse` hooks |
| **codex** | `codex exec --json` | No. `codex exec` has no interactive-approval flag at all |
| **antigravity** | `agy --print` | No. Gated actions stall to `--print-timeout`, then continue |

Because only Claude can be wired today, the unification has to live at Kineloop's layer, not
the CLI's. The approval flow is therefore an agent-neutral core that every adapter reaches the
same way. Codex and Antigravity attach to the identical core the moment their CLIs expose a
gate, with zero UI or IPC changes.

## The unified core (built and tested)

- **`AgentEvent::ApprovalNeeded { request_id, tool, input, prompt }`** (`events.rs`): the one
  event any agent raises. `request_id` correlates the UI's answer back to the waiting bridge.
- **`approval::ApprovalRegistry`** (`approval/mod.rs`): in-flight requests keyed by
  `request_id`. `register` returns a oneshot the bridge awaits; `resolve` (session-checked)
  delivers the decision; `cancel_session` drops a session's pending requests when its run ends
  so a gated tool never hangs a finished run. Managed as Tauri state.
- **`respond_to_approval(session_id, request_id, approve, message)`** (`commands.rs`): the IPC
  the Approve/Deny buttons call. Resolves the pending request; an unknown/foreign/stale id is a
  harmless no-op (untrusted-boundary hardening).
- **UI** (`EventStream.tsx`): an `approvalNeeded` event renders Approve/Deny when an answer
  handler is wired (a live turn), or a read-only notice otherwise, so the card never shows a
  dead button. Threaded `App -> Conversation -> EventStream`, answerable only on the live turn.

Nothing raises `ApprovalNeeded` yet, so the core is inert at runtime until a per-agent
mechanism is attached. It is fully unit-tested (registry lifecycle, IPC resolve, response
mapping, UI buttons).

## The Claude mechanism (`--permission-prompt-tool` MCP)

Chosen over hooks because it holds one persistent connection per session instead of spawning a
hook subprocess per gated tool call: no per-call process churn, better scaling under high
tool-call volume. The mechanism is swappable behind the core, so hooks remain a fallback.

Flow:

1. Launch Claude with `--permission-prompt-tool mcp__kineloop__approve`, an `--mcp-config` that
   registers a Kineloop-hosted stdio MCP server, and `--strict-mcp-config` so only our server
   loads (`permission_prompt_tool()` + `mcp_config_json()` in `approval/mcp.rs`).
2. Claude spawns the server and, before each gated tool call, invokes `approve` with
   `{ tool_name, input }`.
3. The handler: `register(request_id, session_id)` -> emit `ApprovalNeeded` into that session's
   stream -> await the decision -> return `tool_call_result(...)`, whose text content is
   `permission_tool_response(...)`: `{ "behavior": "allow", "updatedInput": <input> }` or
   `{ "behavior": "deny", "message": <reason> }`.

### Built and unit-tested (transport-agnostic, correct-by-research)

- **MCP message layer** (`approval/mcp.rs`): `handle_initialize`, `tools_list_result`,
  `parse_tool_call`, `tool_call_result`, `permission_tool_response`, `error_response`, plus
  `permission_prompt_tool()` / `mcp_config_json()` and a `describe()` summary. 12 tests.
- **MCP stdio protocol driver** (`approval/mcp/transport.rs`): `run_stdio_server(reader, writer,
  decide)` drives initialize / tools/list / tools/call / ping / notifications over
  newline-delimited JSON-RPC, generic over an async `decide` closure. 4 tests with in-memory IO.

### Remaining live seam (needs a live Claude login to finish and verify)

Only the OS transport hosting is left; the protocol above is done:

- A `main.rs` subcommand that runs `run_stdio_server` as the MCP server process, with a `decide`
  closure that forwards the gated call to the running app.
- The subprocess-to-app bridge (Unix domain socket / Windows named pipe) and the app-side
  listener that calls into the core: `register` -> emit `ApprovalNeeded` -> await -> reply.
- A per-session event-emitter registry so the listener can emit into a running session's
  `StoreSink` (register on run start, deregister on end).
- Attaching the launch flags in the Claude adapter behind an off-by-default `Prompt` field.
- Confirming the exact tool-result envelope Claude expects (isolated in `tool_call_result` /
  `permission_tool_response`; a one-line change if the live run shows a different shape).

### Verification checklist (live env)

- [ ] `claude -p --permission-prompt-tool ... --mcp-config ... --strict-mcp-config` spawns the server and calls `approve` before a gated action.
- [ ] The tool call blocks Claude until the handler returns.
- [ ] `{ behavior: "allow", updatedInput }` lets the tool run; `{ behavior: "deny", message }` blocks it and Claude sees the reason.
- [ ] Multiple concurrent sessions resolve to the correct session.
- [ ] A run that ends while a request is pending does not strand Claude (`cancel_session`).

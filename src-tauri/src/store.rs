use crate::events::AgentEvent;
use serde::Serialize;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::Row;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Safety cap on the non-paged [`SessionStore::session_events`] query. Far beyond any
/// real session's transcript; the UI uses the paged path, so this only bounds the
/// convenience method against a runaway result set.
const SESSION_EVENTS_CAP: i64 = 50_000;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("db error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// One row of the session list (wire type for `list_sessions`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub agent: String,
    pub repo: String,
    pub branch: String,
    pub title: String,
    /// "running" | "idle" | "error".
    pub status: String,
    /// "kineloop" for app-created worktree sessions, "external" for CLI history.
    pub source: String,
    /// User turns found in the session transcript, when known.
    pub turn_count: Option<u32>,
    /// Tool calls found in the session transcript, when known.
    pub tool_call_count: Option<u32>,
    /// Distinct files with verified write/patch actions in the transcript, when known.
    pub file_action_count: Option<u32>,
    /// The unified permission mode last used for this session (`default`/`acceptEdits`/
    /// `plan`/`full`/`dontAsk`/`auto`), or `None` before any run recorded one. Always
    /// `None` for external CLI-history sessions (Kineloop doesn't own their runs).
    pub permission_mode: Option<String>,
    /// Antigravity terminal-sandbox toggle last used for this session. Always false for
    /// external sessions and non-Antigravity agents.
    pub sandbox_terminal: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One persisted event (wire type for `session_events`). `kind` is "prompt" (a user
/// turn boundary) or an `AgentEvent` kind; `payload_json` is that event's `data` object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    pub seq: i64,
    pub kind: String,
    pub payload_json: String,
    pub ts: i64,
}

/// SQLite-backed session + event store. Cheaply cloneable (clones share the pool).
#[derive(Clone)]
pub struct SessionStore {
    pool: SqlitePool,
}

impl SessionStore {
    /// Open (creating if needed) the database at `db_path` and run migrations.
    pub async fn connect(db_path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = db_path.parent() {
            ensure_private_dir(parent)?;
        }
        let opts = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(std::time::Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;
        let store = Self { pool };
        store.migrate().await?;
        harden_file_permissions(db_path)?;
        Ok(store)
    }

    /// In-memory store for tests (single connection so the DB persists across queries).
    #[cfg(test)]
    pub async fn connect_in_memory() -> Result<Self, StoreError> {
        let opts = SqliteConnectOptions::new().filename(":memory:");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await?;
        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    async fn migrate(&self) -> Result<(), StoreError> {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                agent TEXT NOT NULL,
                repo TEXT NOT NULL,
                worktree_path TEXT NOT NULL,
                branch TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                ts INTEGER NOT NULL
            )",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS trusted_repos (
                path TEXT PRIMARY KEY,
                trusted_at INTEGER NOT NULL
            )",
        )
        .execute(&self.pool)
        .await?;
        // Custom titles for sessions we don't own the storage of — chiefly external CLI
        // history, whose transcript files on disk we never rewrite. The override is keyed
        // by session id and applied at list time, leaving the source transcript untouched.
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS session_title_overrides (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&self.pool)
        .await?;
        // Resume key for agents that mint their own conversation id (Codex thread id,
        // Antigravity conversation id). Added via ALTER for DBs created before this
        // column existed. The duplicate-column error is expected on every run after the
        // first and is ignored; ANY other error (disk full, locked/corrupt DB) is
        // surfaced so a half-applied schema fails loudly here instead of as a confusing
        // "no such column" at query time later.
        if let Err(e) = sqlx::query("ALTER TABLE sessions ADD COLUMN external_thread_id TEXT")
            .execute(&self.pool)
            .await
        {
            let msg = e.to_string().to_lowercase();
            if !msg.contains("duplicate column") {
                return Err(e.into());
            }
        }
        // Per-session permission mode + Antigravity terminal-sandbox flag, so each session
        // remembers its autonomy setting and the UI seeds its control correctly. Added via
        // ALTER (same duplicate-column-tolerant pattern as external_thread_id) for DBs that
        // predate these columns. `permission_mode` is NULL until a run records one.
        for stmt in [
            "ALTER TABLE sessions ADD COLUMN permission_mode TEXT",
            "ALTER TABLE sessions ADD COLUMN sandbox_terminal INTEGER NOT NULL DEFAULT 0",
        ] {
            if let Err(e) = sqlx::query(stmt).execute(&self.pool).await {
                let msg = e.to_string().to_lowercase();
                if !msg.contains("duplicate column") {
                    return Err(e.into());
                }
            }
        }
        // Per-session streaming engine ("pipe" = CLI adapters, "acp" = Agent Client
        // Protocol). Same ALTER-tolerant pattern as the columns above.
        for stmt in ["ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'pipe'"] {
            if let Err(e) = sqlx::query(stmt).execute(&self.pool).await {
                let msg = e.to_string().to_lowercase();
                if !msg.contains("duplicate column") {
                    return Err(e.into());
                }
            }
        }
        Ok(())
    }

    /// Insert a new session row (status "running").
    pub async fn create_session(
        &self,
        id: &str,
        agent: &str,
        repo: &str,
        worktree_path: &str,
        branch: &str,
        title: &str,
    ) -> Result<(), StoreError> {
        let now = now_ms();
        sqlx::query(
            "INSERT INTO sessions
                (id, agent, repo, worktree_path, branch, title, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)",
        )
        .bind(id)
        .bind(agent)
        .bind(repo)
        .bind(worktree_path)
        .bind(branch)
        .bind(title)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The agent that owns a session (`"claude"`, `"codex"`, `"antigravity"`), or
    /// `None` if the session row is absent.
    pub async fn get_agent(&self, id: &str) -> Result<Option<String>, StoreError> {
        let agent = sqlx::query_scalar::<_, String>("SELECT agent FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(agent)
    }

    /// The agent-native conversation id used to resume a session (Codex thread id /
    /// Antigravity conversation id). `None` when unset or the session is absent.
    pub async fn get_external_thread_id(&self, id: &str) -> Result<Option<String>, StoreError> {
        let v = sqlx::query_scalar::<_, Option<String>>(
            "SELECT external_thread_id FROM sessions WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(v.flatten())
    }

    /// Record the agent-native conversation id captured from the CLI's first run, so
    /// later turns can resume the same conversation. Bumps `updated_at`.
    pub async fn set_external_thread_id(
        &self,
        id: &str,
        thread_id: &str,
    ) -> Result<(), StoreError> {
        sqlx::query("UPDATE sessions SET external_thread_id = ?, updated_at = ? WHERE id = ?")
            .bind(thread_id)
            .bind(now_ms())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// The streaming engine recorded for a session ("pipe" | "acp"). Defaults to
    /// "pipe" when the session is absent, so callers degrade to today's behavior.
    pub async fn get_engine(&self, id: &str) -> Result<String, StoreError> {
        let v = sqlx::query_scalar::<_, Option<String>>("SELECT engine FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(v.flatten().unwrap_or_else(|| "pipe".to_string()))
    }

    /// Record the engine a session runs on. Bumps `updated_at`.
    pub async fn set_engine(&self, id: &str, engine: &str) -> Result<(), StoreError> {
        sqlx::query("UPDATE sessions SET engine = ?, updated_at = ? WHERE id = ?")
            .bind(engine)
            .bind(now_ms())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Record the permission mode + terminal-sandbox flag used for a run, so the UI can
    /// seed the session's control from its last choice. Deliberately does NOT bump
    /// `updated_at` — this is configuration, not activity, and shouldn't reorder the list.
    pub async fn set_permission_mode(
        &self,
        id: &str,
        mode: &str,
        sandbox_terminal: bool,
    ) -> Result<(), StoreError> {
        sqlx::query("UPDATE sessions SET permission_mode = ?, sandbox_terminal = ? WHERE id = ?")
            .bind(mode)
            .bind(sandbox_terminal as i64)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Rename a session and bump `updated_at`. Affects only the given row; returns the
    /// number of rows changed so callers can tell a missing/non-Kineloop id from a hit.
    pub async fn set_title(&self, id: &str, title: &str) -> Result<u64, StoreError> {
        let result = sqlx::query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
            .bind(title)
            .bind(now_ms())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected())
    }

    /// Set (or replace) a custom title for a session whose storage we don't own —
    /// external CLI history. Keyed by session id; the source transcript is never touched.
    pub async fn set_title_override(&self, id: &str, title: &str) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO session_title_overrides (id, title, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
        )
        .bind(id)
        .bind(title)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// All custom title overrides as an (id → title) map, applied at list time so external
    /// sessions show the user's chosen name without rewriting their on-disk transcripts.
    pub async fn title_overrides(
        &self,
    ) -> Result<std::collections::HashMap<String, String>, StoreError> {
        let rows = sqlx::query("SELECT id, title FROM session_title_overrides")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.get::<String, _>("id"), r.get::<String, _>("title")))
            .collect())
    }

    /// Update a session's status and bump `updated_at`.
    pub async fn set_status(&self, id: &str, status: &str) -> Result<(), StoreError> {
        sqlx::query("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
            .bind(status)
            .bind(now_ms())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Permanently delete a Kineloop session: its row, all of its events, and any title
    /// override — in one transaction so a torn-down session never leaves orphan rows.
    /// Used by `cleanup_session`. Returns the number of session rows removed (0 when the
    /// id was unknown).
    pub async fn delete_session(&self, id: &str) -> Result<u64, StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM events WHERE session_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM session_title_overrides WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let result = sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(result.rows_affected())
    }

    /// Mark every session still recorded as "running" as "error". Called once at startup:
    /// the in-memory run registry starts empty, so any row left "running" by a previous
    /// process is from a run that died with the app and would otherwise be stranded
    /// "running" forever (blocking nothing, but misreporting state). Returns rows updated.
    pub async fn reset_running_sessions(&self) -> Result<u64, StoreError> {
        let result =
            sqlx::query("UPDATE sessions SET status = 'error', updated_at = ? WHERE status = 'running'")
                .bind(now_ms())
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected())
    }

    /// Append one event to a session (auto-assigning the next per-session `seq`).
    pub async fn append_event(
        &self,
        session_id: &str,
        kind: &str,
        payload_json: &str,
    ) -> Result<i64, StoreError> {
        let seq = sqlx::query_scalar::<_, i64>(
            "INSERT INTO events (session_id, seq, kind, payload_json, ts)
             SELECT ?, COALESCE(MAX(seq), -1) + 1, ?, ?, ?
             FROM events WHERE session_id = ?
             RETURNING seq",
        )
        .bind(session_id)
        .bind(kind)
        .bind(payload_json)
        .bind(now_ms())
        .bind(session_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(seq)
    }

    /// Persist a repository path that was selected through the native backend dialog.
    pub async fn trust_repo(&self, path: &str) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO trusted_repos (path, trusted_at)
             VALUES (?, ?)
             ON CONFLICT(path) DO UPDATE SET trusted_at = excluded.trusted_at",
        )
        .bind(path)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// True only for repository paths previously selected through the native dialog.
    pub async fn is_trusted_repo(&self, path: &str) -> Result<bool, StoreError> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM trusted_repos WHERE path = ?")
            .bind(path)
            .fetch_one(&self.pool)
            .await?;
        Ok(count > 0)
    }

    pub async fn trusted_repos(&self) -> Result<Vec<String>, StoreError> {
        let rows = sqlx::query("SELECT path FROM trusted_repos ORDER BY trusted_at DESC LIMIT 8")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.iter().map(|r| r.get("path")).collect())
    }

    /// All sessions, most-recently-updated first.
    pub async fn list_sessions(&self) -> Result<Vec<SessionSummary>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, agent, repo, branch, title, status,
                    permission_mode, sandbox_terminal, created_at, updated_at
             FROM sessions ORDER BY updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;

        // One grouped pass over the events table yields per-session activity counts so
        // Kineloop rows read the same way as external CLI history (turns · tools · files):
        //   - turns: `prompt` events (user turn boundaries)
        //   - tools: `toolCall` events
        //   - files: distinct `fileWrite` payloads. The FileWrite payload is always
        //     exactly `{"path":"…"}`, so DISTINCT over the raw JSON counts distinct files
        //     without depending on SQLite's JSON1 extension.
        let count_rows = sqlx::query(
            "SELECT session_id,
                    COUNT(CASE WHEN kind = 'prompt' THEN 1 END) AS turns,
                    COUNT(CASE WHEN kind = 'toolCall' THEN 1 END) AS tools,
                    COUNT(DISTINCT CASE WHEN kind = 'fileWrite' THEN payload_json END) AS files
             FROM events
             GROUP BY session_id",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut counts: HashMap<String, (i64, i64, i64)> = HashMap::new();
        for r in &count_rows {
            counts.insert(
                r.get("session_id"),
                (r.get("turns"), r.get("tools"), r.get("files")),
            );
        }

        Ok(rows
            .iter()
            .map(|r| {
                let id: String = r.get("id");
                // Every Kineloop session reports counts (0 when it has no events yet) so
                // the sidebar meta line is consistent with external CLI sessions.
                let (turns, tools, files) = counts.get(&id).copied().unwrap_or((0, 0, 0));
                SessionSummary {
                    agent: r.get("agent"),
                    repo: r.get("repo"),
                    branch: r.get("branch"),
                    title: r.get("title"),
                    status: r.get("status"),
                    source: "kineloop".to_string(),
                    turn_count: Some(turns as u32),
                    tool_call_count: Some(tools as u32),
                    file_action_count: Some(files as u32),
                    permission_mode: r.get("permission_mode"),
                    // Stored as INTEGER (0/1); read as i64 then narrow to bool.
                    sandbox_terminal: r.get::<i64, _>("sandbox_terminal") != 0,
                    created_at: r.get("created_at"),
                    updated_at: r.get("updated_at"),
                    id,
                }
            })
            .collect())
    }

    /// All events for one session, in `seq` order (powers turn rehydration).
    ///
    /// Bounded by [`SESSION_EVENTS_CAP`] so a pathological session can't materialize an
    /// unbounded result set over IPC. The UI lazy-loads via [`session_events_recent_page`];
    /// this convenience path only needs the cap as a safety net.
    pub async fn session_events(&self, session_id: &str) -> Result<Vec<StoredEvent>, StoreError> {
        let rows = sqlx::query(
            "SELECT seq, kind, payload_json, ts FROM events
             WHERE session_id = ? ORDER BY seq ASC LIMIT ?",
        )
        .bind(session_id)
        .bind(SESSION_EVENTS_CAP)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|r| StoredEvent {
                seq: r.get("seq"),
                kind: r.get("kind"),
                payload_json: r.get("payload_json"),
                ts: r.get("ts"),
            })
            .collect())
    }

    /// One ordered page of events for a session.
    pub async fn session_events_recent_page(
        &self,
        session_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<StoredEvent>, StoreError> {
        let rows = sqlx::query(
            "SELECT seq, kind, payload_json, ts FROM events
             WHERE session_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?",
        )
        .bind(session_id)
        .bind(limit as i64)
        .bind(offset as i64)
        .fetch_all(&self.pool)
        .await?;
        let mut events = rows
            .iter()
            .map(|r| StoredEvent {
                seq: r.get("seq"),
                kind: r.get("kind"),
                payload_json: r.get("payload_json"),
                ts: r.get("ts"),
            })
            .collect::<Vec<_>>();
        events.reverse();
        Ok(events)
    }

    pub async fn session_repo(&self, session_id: &str) -> Result<Option<String>, StoreError> {
        let repo = sqlx::query_scalar::<_, String>("SELECT repo FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(repo)
    }
}

/// Default on-disk DB location: `<home>/.kineloop/kineloop.db` (mirrors the worktrees
/// root). Falls back to the temp dir only if the home dir is unavailable. The legacy
/// `~/.agent-editor/agent-editor.db` is migrated to this path at startup.
pub fn default_db_path() -> PathBuf {
    crate::agent_paths::data_dir().join("kineloop.db")
}

/// Split an AgentEvent into its persisted (kind, payload_json) — payload is the `data`
/// sub-object so it round-trips back into `{ kind, data }` on the frontend.
pub fn split_event(event: &AgentEvent) -> (String, String) {
    let value = serde_json::to_value(event).unwrap_or_else(
        |_| serde_json::json!({ "kind": "error", "data": { "message": "serialize failed" } }),
    );
    let kind = value
        .get("kind")
        .and_then(|k| k.as_str())
        .unwrap_or("error")
        .to_string();
    let payload = value
        .get("data")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    (kind, payload.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ensure_private_dir(path: &Path) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn harden_file_permissions(path: &Path) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        for suffix in ["-wal", "-shm"] {
            let sidecar = PathBuf::from(format!("{}{}", path.display(), suffix));
            if sidecar.exists() {
                std::fs::set_permissions(sidecar, std::fs::Permissions::from_mode(0o600))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_event_extracts_kind_and_data() {
        let (kind, payload) = split_event(&AgentEvent::Token { text: "hi".into() });
        assert_eq!(kind, "token");
        assert_eq!(payload, r#"{"text":"hi"}"#);
    }

    #[tokio::test]
    async fn create_then_list_returns_the_session() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store
            .create_session(
                "s1",
                "claude",
                "/repo",
                "/wt/s1",
                "agent/s1",
                "do the thing",
            )
            .await
            .unwrap();
        let sessions = store.list_sessions().await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "s1");
        assert_eq!(sessions[0].title, "do the thing");
        assert_eq!(sessions[0].status, "running");
        assert_eq!(sessions[0].branch, "agent/s1");
    }

    #[tokio::test]
    async fn engine_defaults_to_pipe_and_roundtrips() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store
            .create_session("s1", "claude", "/repo", "/wt/s1", "agent/s1", "engine test")
            .await
            .unwrap();
        assert_eq!(store.get_engine("s1").await.unwrap(), "pipe");
        store.set_engine("s1", "acp").await.unwrap();
        assert_eq!(store.get_engine("s1").await.unwrap(), "acp");
        // Absent session degrades to the default, not an error.
        assert_eq!(store.get_engine("nope").await.unwrap(), "pipe");
    }

    #[tokio::test]
    async fn set_title_renames_only_the_target_row() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store
            .create_session("s1", "claude", "/repo", "/wt/s1", "agent/s1", "old title")
            .await
            .unwrap();
        store
            .create_session("s2", "claude", "/repo", "/wt/s2", "agent/s2", "untouched")
            .await
            .unwrap();

        let rows = store.set_title("s1", "new title").await.unwrap();
        assert_eq!(rows, 1, "exactly one row should change");

        let sessions = store.list_sessions().await.unwrap();
        let s1 = sessions.iter().find(|s| s.id == "s1").unwrap();
        let s2 = sessions.iter().find(|s| s.id == "s2").unwrap();
        assert_eq!(s1.title, "new title");
        assert_eq!(s2.title, "untouched");
    }

    #[tokio::test]
    async fn set_title_reports_zero_rows_for_missing_session() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        let rows = store.set_title("ghost", "whatever").await.unwrap();
        assert_eq!(rows, 0);
    }

    #[tokio::test]
    async fn title_override_upserts_and_is_returned_in_map() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store
            .set_title_override("external:claude:abc", "first name")
            .await
            .unwrap();
        // A second write to the same id replaces, not duplicates.
        store
            .set_title_override("external:claude:abc", "second name")
            .await
            .unwrap();
        store
            .set_title_override("external:codex:def", "other")
            .await
            .unwrap();

        let overrides = store.title_overrides().await.unwrap();
        assert_eq!(overrides.len(), 2);
        assert_eq!(
            overrides.get("external:claude:abc").map(String::as_str),
            Some("second name")
        );
        assert_eq!(
            overrides.get("external:codex:def").map(String::as_str),
            Some("other")
        );
    }

    #[tokio::test]
    async fn events_persist_in_seq_order() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store
            .create_session("s1", "claude", "/repo", "/wt/s1", "agent/s1", "t")
            .await
            .unwrap();
        store
            .append_event("s1", "prompt", r#"{"text":"hello"}"#)
            .await
            .unwrap();
        store
            .append_event("s1", "token", r#"{"text":"hi there"}"#)
            .await
            .unwrap();
        store
            .append_event("s1", "done", r#"{"summary":"ok"}"#)
            .await
            .unwrap();
        let events = store.session_events("s1").await.unwrap();
        assert_eq!(
            events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(events[0].kind, "prompt");
        assert_eq!(events[2].kind, "done");
    }

    #[tokio::test]
    async fn list_sessions_counts_turns_tools_and_distinct_files() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store
            .create_session("s1", "claude", "/repo", "/wt/s1", "agent/s1", "t")
            .await
            .unwrap();
        // Two user turns.
        store.append_event("s1", "prompt", r#"{"text":"one"}"#).await.unwrap();
        store.append_event("s1", "prompt", r#"{"text":"two"}"#).await.unwrap();
        // Three tool calls.
        for _ in 0..3 {
            store
                .append_event("s1", "toolCall", r#"{"name":"Bash","input":"{}"}"#)
                .await
                .unwrap();
        }
        // Two distinct files across three writes (a.rs written twice, b.rs once).
        store.append_event("s1", "fileWrite", r#"{"path":"a.rs"}"#).await.unwrap();
        store.append_event("s1", "fileWrite", r#"{"path":"a.rs"}"#).await.unwrap();
        store.append_event("s1", "fileWrite", r#"{"path":"b.rs"}"#).await.unwrap();
        // Non-counted kinds must not inflate any tally.
        store.append_event("s1", "token", r#"{"text":"hi"}"#).await.unwrap();
        store.append_event("s1", "done", r#"{"summary":"ok"}"#).await.unwrap();

        let sessions = store.list_sessions().await.unwrap();
        let s1 = sessions.iter().find(|s| s.id == "s1").unwrap();
        assert_eq!(s1.turn_count, Some(2));
        assert_eq!(s1.tool_call_count, Some(3));
        assert_eq!(s1.file_action_count, Some(2));
    }

    #[tokio::test]
    async fn list_sessions_reports_zero_counts_for_session_without_events() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store
            .create_session("s1", "claude", "/repo", "/wt/s1", "agent/s1", "t")
            .await
            .unwrap();
        let sessions = store.list_sessions().await.unwrap();
        let s1 = sessions.iter().find(|s| s.id == "s1").unwrap();
        // Fresh Kineloop sessions report 0 (not null) so the sidebar stays consistent
        // with external CLI rows, which always carry counts.
        assert_eq!(s1.turn_count, Some(0));
        assert_eq!(s1.tool_call_count, Some(0));
        assert_eq!(s1.file_action_count, Some(0));
    }

    #[tokio::test]
    async fn permission_mode_defaults_to_none_then_round_trips() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store
            .create_session("s1", "antigravity", "/repo", "/wt/s1", "agent/s1", "t")
            .await
            .unwrap();

        // A fresh session has no recorded mode and no terminal sandbox.
        let before = store.list_sessions().await.unwrap();
        let s1 = before.iter().find(|s| s.id == "s1").unwrap();
        assert_eq!(s1.permission_mode, None);
        assert!(!s1.sandbox_terminal);

        // Recording a run's choice round-trips through list_sessions.
        store.set_permission_mode("s1", "full", true).await.unwrap();
        let after = store.list_sessions().await.unwrap();
        let s1 = after.iter().find(|s| s.id == "s1").unwrap();
        assert_eq!(s1.permission_mode.as_deref(), Some("full"));
        assert!(s1.sandbox_terminal);
    }

    #[tokio::test]
    async fn set_status_updates_and_orders_by_updated_at() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store
            .create_session("a", "claude", "/r", "/wt/a", "agent/a", "first")
            .await
            .unwrap();
        store
            .create_session("b", "claude", "/r", "/wt/b", "agent/b", "second")
            .await
            .unwrap();
        store.set_status("a", "idle").await.unwrap(); // bumps a's updated_at to newest
        let sessions = store.list_sessions().await.unwrap();
        assert_eq!(sessions[0].id, "a");
        assert_eq!(sessions[0].status, "idle");
    }

    #[tokio::test]
    async fn events_are_scoped_per_session() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store
            .create_session("a", "claude", "/r", "/wt/a", "agent/a", "t")
            .await
            .unwrap();
        store
            .create_session("b", "claude", "/r", "/wt/b", "agent/b", "t")
            .await
            .unwrap();
        store
            .append_event("a", "token", r#"{"text":"x"}"#)
            .await
            .unwrap();
        assert_eq!(store.session_events("a").await.unwrap().len(), 1);
        assert!(store.session_events("b").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_session_removes_row_events_and_override() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store
            .create_session("s1", "claude", "/repo", "/wt/s1", "agent/s1", "doomed")
            .await
            .unwrap();
        store
            .create_session("s2", "claude", "/repo", "/wt/s2", "agent/s2", "kept")
            .await
            .unwrap();
        store.append_event("s1", "token", r#"{"text":"x"}"#).await.unwrap();
        store.set_title_override("s1", "renamed").await.unwrap();

        let removed = store.delete_session("s1").await.unwrap();
        assert_eq!(removed, 1, "exactly the target session row is deleted");

        let sessions = store.list_sessions().await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "s2", "untargeted session survives");
        assert!(
            store.session_events("s1").await.unwrap().is_empty(),
            "deleted session's events are gone"
        );
        assert!(
            !store.title_overrides().await.unwrap().contains_key("s1"),
            "deleted session's title override is gone"
        );
    }

    #[tokio::test]
    async fn delete_session_reports_zero_for_unknown_id() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        assert_eq!(store.delete_session("ghost").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn reset_running_sessions_marks_only_running_as_error() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store
            .create_session("running1", "claude", "/r", "/wt/r1", "agent/r1", "t")
            .await
            .unwrap(); // create_session inserts status "running"
        store
            .create_session("idle1", "claude", "/r", "/wt/i1", "agent/i1", "t")
            .await
            .unwrap();
        store.set_status("idle1", "idle").await.unwrap();

        let reset = store.reset_running_sessions().await.unwrap();
        assert_eq!(reset, 1, "only the still-running session is reset");

        let sessions = store.list_sessions().await.unwrap();
        let running1 = sessions.iter().find(|s| s.id == "running1").unwrap();
        let idle1 = sessions.iter().find(|s| s.id == "idle1").unwrap();
        assert_eq!(running1.status, "error", "stale running → error");
        assert_eq!(idle1.status, "idle", "already-idle session untouched");
    }

    #[tokio::test]
    async fn on_disk_connect_uses_wal() {
        let dir = std::env::temp_dir().join(format!("ae-store-wal-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let db = dir.join("t.db");
        let store = SessionStore::connect(&db).await.unwrap();
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

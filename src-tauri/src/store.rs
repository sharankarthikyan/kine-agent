use crate::events::AgentEvent;
use serde::Serialize;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::Row;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
            "SELECT id, agent, repo, branch, title, status, created_at, updated_at
             FROM sessions ORDER BY updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|r| SessionSummary {
                id: r.get("id"),
                agent: r.get("agent"),
                repo: r.get("repo"),
                branch: r.get("branch"),
                title: r.get("title"),
                status: r.get("status"),
                source: "kineloop".to_string(),
                turn_count: None,
                tool_call_count: None,
                file_action_count: None,
                created_at: r.get("created_at"),
                updated_at: r.get("updated_at"),
            })
            .collect())
    }

    /// All events for one session, in `seq` order (powers turn rehydration).
    pub async fn session_events(&self, session_id: &str) -> Result<Vec<StoredEvent>, StoreError> {
        let rows = sqlx::query(
            "SELECT seq, kind, payload_json, ts FROM events
             WHERE session_id = ? ORDER BY seq ASC",
        )
        .bind(session_id)
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

use crate::events::AgentEvent;
use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("db error: {0}")]
    Db(#[from] sqlx::Error),
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
            let _ = std::fs::create_dir_all(parent);
        }
        let opts = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;
        let store = Self { pool };
        store.migrate().await?;
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
        sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)")
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
        let seq: i64 =
            sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(seq), -1) + 1 FROM events WHERE session_id = ?")
                .bind(session_id)
                .fetch_one(&self.pool)
                .await?;
        sqlx::query(
            "INSERT INTO events (session_id, seq, kind, payload_json, ts) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(seq)
        .bind(kind)
        .bind(payload_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(seq)
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
}

/// Default on-disk DB location: `$HOME/.agent-editor/agent-editor.db` (mirrors the
/// worktrees root). Falls back to the temp dir only if HOME is unset.
pub fn default_db_path() -> PathBuf {
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join(".agent-editor").join("agent-editor.db")
}

/// Split an AgentEvent into its persisted (kind, payload_json) — payload is the `data`
/// sub-object so it round-trips back into `{ kind, data }` on the frontend.
pub fn split_event(event: &AgentEvent) -> (String, String) {
    let value = serde_json::to_value(event)
        .unwrap_or_else(|_| serde_json::json!({ "kind": "error", "data": { "message": "serialize failed" } }));
    let kind = value
        .get("kind")
        .and_then(|k| k.as_str())
        .unwrap_or("error")
        .to_string();
    let payload = value.get("data").cloned().unwrap_or_else(|| serde_json::json!({}));
    (kind, payload.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
            .create_session("s1", "claude", "/repo", "/wt/s1", "agent/s1", "do the thing")
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
        store.append_event("s1", "prompt", r#"{"text":"hello"}"#).await.unwrap();
        store.append_event("s1", "token", r#"{"text":"hi there"}"#).await.unwrap();
        store.append_event("s1", "done", r#"{"summary":"ok"}"#).await.unwrap();
        let events = store.session_events("s1").await.unwrap();
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(events[0].kind, "prompt");
        assert_eq!(events[2].kind, "done");
    }

    #[tokio::test]
    async fn set_status_updates_and_orders_by_updated_at() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store.create_session("a", "claude", "/r", "/wt/a", "agent/a", "first").await.unwrap();
        store.create_session("b", "claude", "/r", "/wt/b", "agent/b", "second").await.unwrap();
        store.set_status("a", "idle").await.unwrap(); // bumps a's updated_at to newest
        let sessions = store.list_sessions().await.unwrap();
        assert_eq!(sessions[0].id, "a");
        assert_eq!(sessions[0].status, "idle");
    }

    #[tokio::test]
    async fn events_are_scoped_per_session() {
        let store = SessionStore::connect_in_memory().await.unwrap();
        store.create_session("a", "claude", "/r", "/wt/a", "agent/a", "t").await.unwrap();
        store.create_session("b", "claude", "/r", "/wt/b", "agent/b", "t").await.unwrap();
        store.append_event("a", "token", r#"{"text":"x"}"#).await.unwrap();
        assert_eq!(store.session_events("a").await.unwrap().len(), 1);
        assert!(store.session_events("b").await.unwrap().is_empty());
    }
}

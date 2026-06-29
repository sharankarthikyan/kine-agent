import type { CSSProperties } from "react";
import type { SessionStatus, SessionSummary } from "../lib/sessions";

interface SessionListProps {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

const STATUS_COLOR: Record<SessionStatus, string> = {
  running: "var(--status-running)",
  idle: "var(--text-muted)",
  error: "var(--status-error)",
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "Running",
  idle: "Idle",
  error: "Error",
};

export function SessionList({ sessions, activeId, onSelect, onNew }: SessionListProps) {
  return (
    <nav style={pane} aria-label="Sessions">
      <div style={header}>
        <span style={heading}>SESSIONS</span>
        <button type="button" onClick={onNew} style={newButton}>+ New session</button>
      </div>
      {sessions.length === 0 ? (
        <p style={emptyHint}>No sessions yet.</p>
      ) : (
        <ul style={list}>
          {sessions.map((session) => {
            const active = session.id === activeId;
            return (
              <li key={session.id}>
                <button
                  type="button"
                  aria-current={active || undefined}
                  onClick={() => onSelect(session.id)}
                  style={{ ...row, ...(active ? rowActive : null) }}
                >
                  <span
                    aria-hidden
                    style={{ ...dot, background: STATUS_COLOR[session.status] ?? "var(--text-muted)" }}
                  />
                  <span style={title}>{session.title}</span>
                  <span style={statusText}>{STATUS_LABEL[session.status]}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

const pane: CSSProperties = {
  display: "flex", flexDirection: "column", height: "100%",
  borderRight: "1px solid var(--border-hairline)", background: "var(--bg-surface)",
  minHeight: 0, overflow: "auto",
};
const header: CSSProperties = { padding: "var(--space-4) var(--space-3) var(--space-2)" };
const heading: CSSProperties = {
  color: "var(--text-muted)", fontSize: "var(--fs-12)",
  textTransform: "uppercase", letterSpacing: "0.04em",
};
const newButton: CSSProperties = {
  marginTop: "var(--space-3)", width: "100%", textAlign: "left",
  padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-hairline)", background: "var(--bg-card)",
  color: "var(--text-primary)", cursor: "pointer", fontSize: "var(--fs-13)",
};
const list: CSSProperties = { listStyle: "none", margin: 0, padding: "0 var(--space-2)" };
const row: CSSProperties = {
  display: "flex", alignItems: "center", gap: "var(--space-2)", width: "100%",
  padding: "var(--space-2) var(--space-3)", border: "none", borderLeft: "2px solid transparent",
  borderRadius: "var(--radius-md)", background: "transparent", color: "var(--text-body)",
  cursor: "pointer", fontSize: "var(--fs-13)", textAlign: "left",
};
const rowActive: CSSProperties = {
  background: "var(--surface-raised)", color: "var(--text-primary)",
  borderLeft: "2px solid var(--status-running)", fontWeight: 600,
};
const dot: CSSProperties = { width: 8, height: 8, borderRadius: "var(--radius-full)", flex: "0 0 auto" };
const title: CSSProperties = { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const statusText: CSSProperties = { color: "var(--text-muted)", fontSize: "var(--fs-12)", flex: "0 0 auto" };
const emptyHint: CSSProperties = { color: "var(--text-muted)", fontSize: "var(--fs-13)", padding: "0 var(--space-3)" };

import type { CSSProperties } from "react";
import type { ChangeStatus, SessionDiff } from "../lib/review";
import { parsePatch, type DiffLineKind } from "../lib/parsePatch";

interface DiffViewerProps {
  diff: SessionDiff;
}

const STATUS_COLOR: Record<ChangeStatus, string> = {
  added: "var(--status-success)",
  modified: "var(--status-running)",
  deleted: "var(--status-error)",
};
const STATUS_LABEL: Record<ChangeStatus, string> = { added: "A", modified: "M", deleted: "D" };

const LINE_BG: Partial<Record<DiffLineKind, string>> = {
  add: "var(--status-success-soft)",
  del: "var(--status-error-soft)",
};
const LINE_FG: Partial<Record<DiffLineKind, string>> = {
  add: "var(--status-success)",
  del: "var(--status-error)",
  hunk: "var(--text-muted)",
  meta: "var(--text-muted)",
};

export function DiffViewer({ diff }: DiffViewerProps) {
  if (diff.files.length === 0) {
    return <p style={{ color: "var(--text-muted)", padding: "var(--space-4)" }}>No changes.</p>;
  }
  const count = diff.files.length;
  const patchFiles = parsePatch(diff.patch);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <header style={{ padding: "var(--space-2) var(--space-3)", color: "var(--text-muted)", fontSize: "var(--fs-13)" }}>
        {count} file{count === 1 ? "" : "s"} changed
      </header>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, flexShrink: 0 }}>
        {diff.files.map((file) => (
          <li key={file.path} style={fileRow}>
            <span style={{ color: STATUS_COLOR[file.status], fontFamily: "var(--font-mono)", width: "1.5em" }}>
              {STATUS_LABEL[file.status]}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
              {file.path}
            </span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--status-success)" }}>+{file.additions}</span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--status-error)" }}>-{file.deletions}</span>
          </li>
        ))}
      </ul>
      <div style={patchScroll}>
        {patchFiles.map((pf) => (
          <section key={pf.path} style={{ marginBottom: "var(--space-3)" }}>
            <div style={patchFileHeader} aria-hidden="true">
              {pf.path.split("/").pop() ?? pf.path}
            </div>
            <div>
              {pf.lines.map((line, i) => (
                <div
                  key={i}
                  style={{
                    fontFamily: "var(--font-mono)", fontSize: "var(--fs-13)", whiteSpace: "pre",
                    padding: "0 var(--space-3)",
                    background: LINE_BG[line.kind] ?? "transparent",
                    color: LINE_FG[line.kind] ?? "var(--text-body)",
                  }}
                >
                  {line.text || " "}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

const fileRow: CSSProperties = {
  display: "flex", gap: "var(--space-2)", alignItems: "center",
  padding: "var(--space-1) var(--space-3)",
  borderBottom: "1px solid var(--border-hairline)", fontSize: "var(--fs-13)",
};
const patchScroll: CSSProperties = {
  flex: 1, overflow: "auto", minHeight: 0,
  borderTop: "1px solid var(--border-hairline)", paddingTop: "var(--space-2)",
  background: "var(--bg-card)",
};
const patchFileHeader: CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: "var(--fs-13)", color: "var(--text-muted)",
  padding: "var(--space-1) var(--space-3)", position: "sticky", top: 0, background: "var(--bg-card)",
};

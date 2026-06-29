import type { CSSProperties } from "react";

export function RunningIndicator() {
  return (
    <div
      role="status"
      style={{
        display: "flex", alignItems: "center", gap: "var(--space-2)",
        padding: "var(--space-3)", color: "var(--text-muted)", fontSize: "var(--fs-13)",
      }}
    >
      <span style={dot} />
      Agent is working…
      <style>{keyframes}</style>
    </div>
  );
}

const dot: CSSProperties = {
  width: 8, height: 8, borderRadius: "var(--radius-full)",
  background: "var(--status-running)", animation: "ae-pulse 1.2s ease-in-out infinite",
};

const keyframes = `
@keyframes ae-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }
@media (prefers-reduced-motion: reduce) { [style*="ae-pulse"] { animation: none !important } }
`;

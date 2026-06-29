interface EmptyStateProps {
  heading: string;
  hint: string;
}

export function EmptyState({ heading, hint }: EmptyStateProps) {
  return (
    <div
      style={{
        height: "100%", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: "var(--space-2)",
        padding: "var(--space-6)", textAlign: "center",
      }}
    >
      <p style={{ margin: 0, color: "var(--text-primary)", fontSize: "var(--fs-16)", fontWeight: 500 }}>
        {heading}
      </p>
      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--fs-13)", maxWidth: "42ch" }}>
        {hint}
      </p>
    </div>
  );
}

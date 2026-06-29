import type { CSSProperties } from "react";

/**
 * Slim draggable window title bar. Pairs with macOS `titleBarStyle: "Overlay"`
 * (native traffic lights render over the left of this bar — hence the left
 * padding) and `data-tauri-drag-region` (made draggable via the CSS rule in
 * tokens.css + the `core:window:allow-start-dragging` capability).
 */
export function TitleBar() {
  return (
    <div data-tauri-drag-region style={bar}>
      <span data-tauri-drag-region style={brand}>
        agent-editor
      </span>
    </div>
  );
}

const bar: CSSProperties = {
  height: "var(--titlebar-h)",
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  // Clear the macOS traffic-light cluster (~70px) so the brand isn't hidden.
  paddingLeft: "78px",
  borderBottom: "1px solid var(--border-hairline)",
  background: "var(--bg-surface)",
};

const brand: CSSProperties = {
  fontSize: "var(--fs-13)",
  fontWeight: 600,
  color: "var(--text-primary)",
  letterSpacing: "0.01em",
};

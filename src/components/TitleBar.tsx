import { ThemeToggle } from "./ThemeToggle";

/**
 * Slim draggable window title bar. Pairs with macOS `titleBarStyle: "Overlay"`
 * (native traffic lights render over the left of this bar — hence the left
 * padding) and `data-tauri-drag-region` (made draggable via the CSS rule in
 * tokens.css + the `core:window:allow-start-dragging` capability).
 */
export function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      className="h-10 shrink-0 flex items-center border-b border-border bg-background pl-[78px] pr-2"
    >
      <span data-tauri-drag-region className="text-sm font-medium flex-1">
        agent-editor
      </span>
      {/* ThemeToggle must not be inside the drag region so it remains clickable. */}
      <span className="[-webkit-app-region:no-drag]">
        <ThemeToggle />
      </span>
    </div>
  );
}

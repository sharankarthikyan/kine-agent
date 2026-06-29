import { Asterisk, PanelLeft, SquareCode, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./ThemeToggle";
import { cn } from "@/lib/utils";

/**
 * Conductor-style 3-zone titlebar. Pairs with macOS `titleBarStyle: "Overlay"`
 * (native traffic lights render over the left of this bar — hence `pl-[78px]`)
 * and `data-tauri-drag-region` (made draggable via the CSS rule in index.css
 * + the `core:window:allow-start-dragging` capability).
 *
 * All props are optional so `<TitleBar />` continues to compile in App.tsx
 * until Milestone 6 wires up the real callbacks and state.
 */
export interface TitleBarProps {
  title?: string | null;
  repo?: string | null;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onOpenEditor?: () => void;
  onOpenTerminal?: () => void;
}

export function TitleBar({
  title = null,
  repo = null,
  sidebarCollapsed = false,
  onToggleSidebar = () => {},
  onOpenEditor = () => {},
  onOpenTerminal = () => {},
}: TitleBarProps) {
  const sidebarLabel = sidebarCollapsed ? "Show sidebar" : "Hide sidebar";

  return (
    <div
      data-tauri-drag-region
      className="h-10 shrink-0 flex items-center bg-background"
    >
      {/* LEFT zone: traffic-light inset + sidebar toggle */}
      <div className="flex items-center pl-[78px] shrink-0">
        <span className="[-webkit-app-region:no-drag]">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggleSidebar}
            aria-label={sidebarLabel}
          >
            <PanelLeft data-icon />
          </Button>
        </span>
      </div>

      {/* CENTER zone: session pill — draggable, non-interactive */}
      <div
        data-tauri-drag-region
        className="flex-1 flex items-center justify-center min-w-0"
      >
        <span
          className={cn(
            "flex items-center gap-1 text-sm text-muted-foreground truncate max-w-xs select-none"
          )}
        >
          <Asterisk data-icon aria-hidden className="size-3.5 shrink-0" />
          {title ?? "New Session"}
          {repo != null && ` · ${repo}`}
        </span>
      </div>

      {/* RIGHT zone: editor, terminal, theme toggle, inert stubs */}
      <div className="flex items-center pr-2 shrink-0">
        <span className="[-webkit-app-region:no-drag] flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenEditor}
            aria-label="Open in editor"
          >
            <SquareCode data-icon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenTerminal}
            aria-label="Open terminal"
          >
            <SquareTerminal data-icon />
          </Button>
          <ThemeToggle />
        </span>
      </div>
    </div>
  );
}

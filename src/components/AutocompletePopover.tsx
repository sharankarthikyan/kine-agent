import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bot, Command, File, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { matchRange, type Suggestion } from "@/lib/autocomplete";

interface AutocompletePopoverProps {
  open: boolean;
  items: Suggestion[];
  activeIndex: number;
  /** Current query, for match highlighting. */
  query: string;
  /** Anchored above this element (the composer), opening upward. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Shared id so the textarea can point `aria-controls`/`aria-activedescendant` here. */
  listboxId: string;
  onHover: (index: number) => void;
  onSelect: (item: Suggestion) => void;
}

/** Icon per suggestion kind — reuses lucide sizing from the rest of the UI. */
function KindIcon({ kind }: { kind: Suggestion["kind"] }) {
  const Icon =
    kind === "command" ? Command : kind === "agent" ? Bot : kind === "dir" ? Folder : File;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

/** Render a label with the matched query span emphasized. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const range = matchRange(text, query);
  if (!range) return <>{text}</>;
  const [s, e] = range;
  return (
    <>
      {text.slice(0, s)}
      <span className="font-semibold text-foreground">{text.slice(s, e)}</span>
      {text.slice(e)}
    </>
  );
}

/**
 * Caret-adjacent suggestion list for `@`/`/` autocomplete. Portaled to the body so the
 * composer's `overflow-hidden` footer can't clip it, and anchored to open UPWARD from the
 * input (the composer sits at the bottom of the pane). Focus stays in the textarea — this
 * is an ARIA listbox driven via `aria-activedescendant`, not a focus target.
 */
export function AutocompletePopover({
  open,
  items,
  activeIndex,
  query,
  anchorRef,
  listboxId,
  onHover,
  onSelect,
}: AutocompletePopoverProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // Track the anchor's position; recompute on open, on content change, and on scroll/resize.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setRect(anchorRef.current?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, items, anchorRef]);

  // Keep the active row visible as the user arrows through.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open || !rect || items.length === 0) return null;

  const GAP = 6;
  const width = Math.min(Math.max(rect.width, 260), 480);

  return createPortal(
    <div
      id={listboxId}
      role="listbox"
      aria-label="Suggestions"
      className="fixed z-50 max-h-64 overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{
        left: rect.left,
        bottom: window.innerHeight - rect.top + GAP,
        width,
      }}
    >
      {items.map((item, i) => {
        const active = i === activeIndex;
        return (
          <div
            key={item.id}
            ref={active ? activeRef : undefined}
            id={`${listboxId}-opt-${i}`}
            role="option"
            aria-selected={active}
            // Commit on pointerdown (before the textarea blurs) and keep focus in the input.
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
            onMouseMove={() => onHover(i)}
            className={cn(
              "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
              active && "bg-accent text-accent-foreground",
            )}
          >
            <KindIcon kind={item.kind} />
            <span className="min-w-0 flex-1 truncate">
              <Highlighted text={item.label} query={query} />
              {item.description && (
                <span className="ml-2 text-xs text-muted-foreground">{item.description}</span>
              )}
            </span>
            {item.detail && (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {item.detail}
              </span>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

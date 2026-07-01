import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  agentsToSuggestions,
  applySuggestion,
  commandsToSuggestions,
  detectTrigger,
  filterSuggestions,
  treeToFileSuggestions,
  type Suggestion,
  type TriggerContext,
} from "./autocomplete";
import { listCapabilities, type Capabilities } from "./inspect";
import { worktreeTree, type TreeEntry } from "./conductor";
import type { Mention } from "./mentions";

interface Options {
  text: string;
  setText: (t: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Active session id — required to fetch files/commands/agents. Absent ⇒ autocomplete is inert. */
  sessionId?: string;
  /** Session agent id; commands/agents only populate for agents that expose them (claude today). */
  agent: string;
}

/**
 * Wires `@` (files + agents) and `/` (commands) autocomplete onto a plain `<textarea>`.
 * Keeps the composer's `text` as the single source of truth (no rich editor), tracks a
 * mention registry so the caller can resolve mentions per agent on send, and returns the
 * state + handlers the composer and the `AutocompletePopover` need.
 */
export function usePromptAutocomplete({ text, setText, textareaRef, sessionId, agent }: Options) {
  const [trigger, setTrigger] = useState<TriggerContext | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [open, setOpen] = useState(false);

  const listboxId = useId();
  const mentionsRef = useRef<Mention[]>([]);
  const pendingCaretRef = useRef<number | null>(null);
  // Per-session cache of the raw source data (as promises, to dedupe concurrent loads).
  const cacheRef = useRef<{
    sessionId?: string;
    caps?: Promise<Capabilities>;
    files?: Promise<TreeEntry[]>;
  }>({});

  // Resolve the unfiltered suggestion list for a trigger, fetching + caching source data once.
  const suggestionsFor = useCallback(
    async (t: "@" | "/"): Promise<Suggestion[]> => {
      if (cacheRef.current.sessionId !== sessionId) cacheRef.current = { sessionId };
      if (!sessionId) return [];

      if (t === "/") {
        if (agent !== "claude") return []; // only claude exposes headless-invocable commands
        cacheRef.current.caps ??= listCapabilities(sessionId, agent);
        return commandsToSuggestions(await cacheRef.current.caps);
      }

      // "@": files (all agents) + agents (claude only), agents surfaced first.
      cacheRef.current.files ??= worktreeTree(sessionId);
      const files = treeToFileSuggestions(await cacheRef.current.files);
      if (agent !== "claude") return files;
      cacheRef.current.caps ??= listCapabilities(sessionId, agent);
      return [...agentsToSuggestions(await cacheRef.current.caps), ...files];
    },
    [sessionId, agent],
  );

  // Load + filter suggestions whenever the active trigger token changes.
  useEffect(() => {
    if (!trigger) {
      setOpen(false);
      setItems([]);
      return;
    }
    let cancelled = false;
    suggestionsFor(trigger.trigger)
      .then((raw) => {
        if (cancelled) return;
        const filtered = filterSuggestions(raw, trigger.query);
        setItems(filtered);
        setActiveIndex(0);
        setOpen(filtered.length > 0);
      })
      .catch(() => {
        if (cancelled) return;
        setItems([]);
        setOpen(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trigger, suggestionsFor]);

  // Apply a queued caret position after a programmatic text replacement.
  useLayoutEffect(() => {
    if (pendingCaretRef.current == null) return;
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current);
    }
    pendingCaretRef.current = null;
  }, [text, textareaRef]);

  /** Recompute the active trigger from the textarea's current value + caret. */
  const sync = useCallback((el: HTMLTextAreaElement) => {
    setTrigger(detectTrigger(el.value, el.selectionStart ?? el.value.length));
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setTrigger(null);
  }, []);

  const accept = useCallback(
    (item: Suggestion) => {
      if (!trigger) return;
      const next = applySuggestion(text, trigger, item.insertText);
      pendingCaretRef.current = next.caret;
      setText(next.text);
      if (item.kind === "file" || item.kind === "dir") {
        mentionsRef.current = [
          ...mentionsRef.current,
          { kind: "file", token: item.insertText, path: item.label },
        ];
      } else if (item.kind === "agent") {
        mentionsRef.current = [
          ...mentionsRef.current,
          { kind: "agent", token: item.insertText, name: item.label },
        ];
      }
      close();
    },
    [trigger, text, setText, close],
  );

  /** Intercept navigation keys while the menu is open. Returns true when it handled the key. */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || items.length === 0) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % items.length);
          return true;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + items.length) % items.length);
          return true;
        case "Enter":
        case "Tab":
          e.preventDefault();
          accept(items[activeIndex]);
          return true;
        case "Escape":
          e.preventDefault();
          close();
          return true;
        default:
          return false;
      }
    },
    [open, items, activeIndex, accept, close],
  );

  /** Clear transient state after a message is sent. */
  const reset = useCallback(() => {
    mentionsRef.current = [];
    close();
  }, [close]);

  return {
    open,
    items,
    activeIndex,
    query: trigger?.query ?? "",
    listboxId,
    activeOptionId: open && items.length > 0 ? `${listboxId}-opt-${activeIndex}` : undefined,
    mentionsRef,
    sync,
    accept,
    close,
    reset,
    handleKeyDown,
    setActiveIndex,
  };
}

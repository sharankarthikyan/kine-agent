import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  agentsToSuggestions,
  applySuggestion,
  commandsToSuggestions,
  detectTrigger,
  effectiveFilterQuery,
  entriesToPathSuggestions,
  filterSuggestions,
  parsePathQuery,
  treeToFileSuggestions,
  type Suggestion,
  type TriggerContext,
} from "./autocomplete";
import { listCapabilities, type Capabilities } from "./inspect";
import { listDir, worktreeTree, type TreeEntry } from "./conductor";
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

/** True when an `@` query addresses the filesystem (`@/…` or `@~/…`) rather than the repo. */
function isFilesystemQuery(trigger: TriggerContext | null): boolean {
  return !!trigger && trigger.trigger === "@" && parsePathQuery(trigger.query) !== null;
}

/**
 * Wires `@` (repo files + filesystem browse + agents) and `/` (commands) autocomplete onto a
 * plain `<textarea>`. Keeps the composer's `text` as the single source of truth, tracks a
 * mention registry for per-agent resolution on send, and returns the state + handlers the
 * composer and the `AutocompletePopover` need.
 */
export function usePromptAutocomplete({ text, setText, textareaRef, sessionId, agent }: Options) {
  const [trigger, setTrigger] = useState<TriggerContext | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [open, setOpen] = useState(false);

  const listboxId = useId();
  const mentionsRef = useRef<Mention[]>([]);
  const pendingCaretRef = useRef<number | null>(null);
  // Per-session cache of repo-scoped source data (as promises, to dedupe concurrent loads).
  // Filesystem listings are NOT cached — the directory changes as the user navigates.
  const cacheRef = useRef<{
    sessionId?: string;
    caps?: Promise<Capabilities>;
    files?: Promise<TreeEntry[]>;
  }>({});

  // Resolve the FILTERED suggestion list for the active trigger, fetching source data as needed.
  const suggestionsFor = useCallback(
    async (t: TriggerContext): Promise<Suggestion[]> => {
      if (cacheRef.current.sessionId !== sessionId) cacheRef.current = { sessionId };
      if (!sessionId) return [];

      const q = effectiveFilterQuery(t);

      if (t.trigger === "/") {
        if (agent !== "claude") return []; // only claude exposes headless-invocable commands
        cacheRef.current.caps ??= listCapabilities(sessionId, agent);
        return filterSuggestions(commandsToSuggestions(await cacheRef.current.caps), q);
      }

      // "@/…" or "@~/…" → live filesystem browsing (outside the repo, with caution).
      const pathQuery = parsePathQuery(t.query);
      if (pathQuery) {
        const entries = await listDir(pathQuery.dirPath);
        return filterSuggestions(entriesToPathSuggestions(pathQuery.insertPrefix, entries), q);
      }

      // "@" repo files (all agents) + agents (claude only), agents surfaced first.
      cacheRef.current.files ??= worktreeTree(sessionId);
      const files = treeToFileSuggestions(await cacheRef.current.files);
      if (agent !== "claude") return filterSuggestions(files, q);
      cacheRef.current.caps ??= listCapabilities(sessionId, agent);
      const agents = agentsToSuggestions(await cacheRef.current.caps);
      return filterSuggestions([...agents, ...files], q);
    },
    [sessionId, agent],
  );

  // Load + set suggestions whenever the active trigger token changes.
  useEffect(() => {
    if (!trigger) {
      setOpen(false);
      setItems([]);
      return;
    }
    let cancelled = false;
    suggestionsFor(trigger)
      .then((filtered) => {
        if (cancelled) return;
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
      const pathMode = isFilesystemQuery(trigger);
      // In filesystem mode, selecting a directory descends into it (no trailing space, menu stays open).
      const descend = pathMode && item.kind === "dir";
      const next = applySuggestion(text, trigger, item.insertText, { trailingSpace: !descend });
      pendingCaretRef.current = next.caret;
      setText(next.text);

      if (item.kind === "file") {
        // Filesystem file path is the token minus the leading `@`; repo file path is the label.
        const path = pathMode ? item.insertText.slice(1) : item.label;
        mentionsRef.current = [...mentionsRef.current, { kind: "file", token: item.insertText, path }];
      } else if (item.kind === "agent") {
        mentionsRef.current = [
          ...mentionsRef.current,
          { kind: "agent", token: item.insertText, name: item.label },
        ];
      } else if (item.kind === "dir" && !descend) {
        // Repo directory selected as context (not a descent).
        mentionsRef.current = [...mentionsRef.current, { kind: "file", token: item.insertText, path: item.label }];
      }

      if (descend) {
        setTrigger(detectTrigger(next.text, next.caret)); // re-list the entered directory
      } else {
        close();
      }
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
    query: trigger ? effectiveFilterQuery(trigger) : "",
    listboxId,
    activeOptionId: open && items.length > 0 ? `${listboxId}-opt-${activeIndex}` : undefined,
    /** Caution shown while browsing outside the repo. */
    notice: open && isFilesystemQuery(trigger) ? "Filesystem — outside the repo" : undefined,
    mentionsRef,
    sync,
    accept,
    close,
    reset,
    handleKeyDown,
    setActiveIndex,
  };
}

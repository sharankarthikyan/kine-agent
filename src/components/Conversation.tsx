import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentEvent } from "../lib/agent";
import { EventStream } from "./EventStream";
import { EmptyState } from "./EmptyState";
import { RunningIndicator } from "./RunningIndicator";
import { Button } from "@/components/ui/button";
import { ArrowDown, Loader2 } from "lucide-react";

export interface Turn {
  prompt: string;
  events: AgentEvent[];
}

interface ConversationProps {
  turns: Turn[];
  running: boolean;
  onOpenFile?: (path: string) => void;
  /** Answer a pending approval request raised in this session's live turn. */
  onApprovalRespond?: (requestId: string, selectedOptionId: string) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

const FOLLOW_BOTTOM_THRESHOLD = 96;

/** Kinds that never render their own row in EventStream — they feed other UI
 * (autocomplete, context panel) or decorate sibling events. A turn holding
 * only these must not show the "Agent" header above empty space (an ACP
 * turn's first event is often `commands`). */
const RENDER_NULL_KINDS: ReadonlySet<AgentEvent["kind"]> = new Set([
  "commands",
  "usage",
  "toolStatus",
  "approvalResolved",
]);

function hasRenderableEvents(events: AgentEvent[]): boolean {
  return events.some((event) => !RENDER_NULL_KINDS.has(event.kind));
}

export function Conversation({
  turns,
  running,
  onOpenFile,
  onApprovalRespond,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: ConversationProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const firstTurnKeyRef = useRef<string | null>(null);
  const followOutputRef = useRef(true);
  const [isFollowingOutput, setIsFollowingOutput] = useState(true);

  const scrollParent = useCallback((): HTMLElement | null => {
    const root = rootRef.current;
    if (!root) return null;
    let node: HTMLElement | null = root.parentElement;
    while (node) {
      const style = window.getComputedStyle(node);
      if (/(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`)) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }, []);

  const isNearBottom = useCallback((node: HTMLElement): boolean => {
    return node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_BOTTOM_THRESHOLD;
  }, []);

  const setFollowing = useCallback((next: boolean) => {
    followOutputRef.current = next;
    setIsFollowingOutput(next);
  }, []);

  const scrollToBottom = useCallback(() => {
    try {
      bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    } catch {
      /* jsdom: no-op */
    }
  }, []);

  useEffect(() => {
    const node = scrollParent();
    if (!node) return;
    setFollowing(isNearBottom(node));
    const onScroll = () => setFollowing(isNearBottom(node));
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [isNearBottom, scrollParent, setFollowing]);

  useLayoutEffect(() => {
    const first = turns[0];
    const firstTurnKey =
      first === undefined
        ? null
        : `${first.prompt}\0${first.events.length}\0${first.events[0]?.kind ?? ""}`;
    const insertedOlderContent =
      firstTurnKeyRef.current !== null && firstTurnKeyRef.current !== firstTurnKey;
    firstTurnKeyRef.current = firstTurnKey;
    if (insertedOlderContent) return;
    if (followOutputRef.current) scrollToBottom();
  }, [turns, running, scrollToBottom]);

  if (turns.length === 0 && !running) {
    return (
      <EmptyState
        heading="No activity yet."
        hint="Message the agent below to start a session."
      />
    );
  }

  const runningEvents = turns.length > 0 ? turns[turns.length - 1].events : [];

  return (
    // More space between turns than within a single turn (no divider lines).
    <div ref={rootRef} className="relative flex flex-col gap-6 p-4">
      {hasMore && onLoadMore && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="gap-2"
          >
            {loadingMore && (
              <Loader2
                aria-hidden="true"
                className="size-3.5 animate-spin motion-reduce:animate-none"
              />
            )}
            Load older
          </Button>
        </div>
      )}
      {turns.map((turn, i) => (
        <div key={i} className="flex flex-col gap-3">
          {/* User message: subtle muted bubble, contained (not full-width). */}
          {turn.prompt.trim() !== "" && (
            <section className="flex flex-col gap-2 items-end">
              <div className="text-xs font-medium text-muted-foreground">
                You
              </div>
              <div className="self-end min-w-0 max-w-prose [overflow-wrap:anywhere] rounded-lg bg-muted px-4 py-3 text-foreground whitespace-pre-wrap">
                {turn.prompt}
              </div>
            </section>
          )}
          {/* Agent output: plain on the canvas — room for prose, chips, code. */}
          {hasRenderableEvents(turn.events) && (
            <section className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                Agent
              </div>
              <EventStream
                events={turn.events}
                onOpenFile={onOpenFile}
                // Approvals are only answerable on the latest turn (the live run); older
                // turns' requests have already resolved, so they stay read-only.
                onApprovalRespond={
                  i === turns.length - 1 ? onApprovalRespond : undefined
                }
              />
            </section>
          )}
        </div>
      ))}
      {running && <RunningIndicator events={runningEvents} />}
      {!isFollowingOutput && (
        <div className="sticky bottom-3 z-10 flex justify-center pointer-events-none">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="pointer-events-auto gap-1.5 rounded-full border border-border/80 bg-background/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/75"
            onClick={() => {
              setFollowing(true);
              scrollToBottom();
            }}
          >
            <ArrowDown aria-hidden="true" className="size-3.5" />
            Latest
          </Button>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

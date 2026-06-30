import { useEffect, useRef } from "react";
import type { AgentEvent } from "../lib/agent";
import { EventStream } from "./EventStream";
import { EmptyState } from "./EmptyState";
import { RunningIndicator } from "./RunningIndicator";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export interface Turn {
  prompt: string;
  events: AgentEvent[];
}

interface ConversationProps {
  turns: Turn[];
  running: boolean;
  onOpenFile?: (path: string) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

export function Conversation({
  turns,
  running,
  onOpenFile,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: ConversationProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const firstTurnKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const first = turns[0];
    const firstTurnKey =
      first === undefined
        ? null
        : `${first.prompt}\0${first.events.length}\0${first.events[0]?.kind ?? ""}`;
    const insertedOlderContent =
      firstTurnKeyRef.current !== null && firstTurnKeyRef.current !== firstTurnKey;
    firstTurnKeyRef.current = firstTurnKey;
    if (insertedOlderContent) return;
    try {
      bottomRef.current?.scrollIntoView({ block: "end" });
    } catch {
      /* jsdom: no-op */
    }
  }, [turns, running]);

  if (turns.length === 0 && !running) {
    return (
      <EmptyState
        heading="No activity yet."
        hint="Message the agent below to start a session."
      />
    );
  }

  return (
    // More space between turns than within a single turn (no divider lines).
    <div className="flex flex-col gap-6 p-4">
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
          <section className="flex flex-col gap-2 items-end">
            <div className="text-xs font-medium text-muted-foreground">
              You
            </div>
            <div className="self-end max-w-prose rounded-lg bg-muted px-4 py-3 text-foreground whitespace-pre-wrap">
              {turn.prompt}
            </div>
          </section>
          {/* Agent output: plain on the canvas — room for prose, chips, code. */}
          {turn.events.length > 0 && (
            <section className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                Agent
              </div>
              <EventStream events={turn.events} onOpenFile={onOpenFile} />
            </section>
          )}
        </div>
      ))}
      {running && <RunningIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}

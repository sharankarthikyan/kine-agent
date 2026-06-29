import { useEffect, useRef } from "react";
import type { AgentEvent } from "../lib/agent";
import { EventStream } from "./EventStream";
import { EmptyState } from "./EmptyState";
import { RunningIndicator } from "./RunningIndicator";

export interface Turn {
  prompt: string;
  events: AgentEvent[];
}

interface ConversationProps {
  turns: Turn[];
  running: boolean;
}

export function Conversation({ turns, running }: ConversationProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
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
      {turns.map((turn, i) => (
        <div key={i} className="flex flex-col gap-3">
          {/* User message: subtle muted bubble, contained (not full-width). */}
          <section className="flex flex-col gap-2">
            <div className="text-xs font-medium text-muted-foreground">
              You
            </div>
            <div className="self-start max-w-prose rounded-lg bg-muted px-4 py-3 text-foreground whitespace-pre-wrap">
              {turn.prompt}
            </div>
          </section>
          {/* Agent output: plain on the canvas — room for prose, chips, code. */}
          {turn.events.length > 0 && (
            <section className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                Agent
              </div>
              <EventStream events={turn.events} />
            </section>
          )}
        </div>
      ))}
      {running && <RunningIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}

import { Layers, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { SessionStatus, SessionSummary } from "../lib/sessions";

interface SessionListProps {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

type StatusConfig = { label: string; color: string };

const STATUS_CONFIG: Record<SessionStatus, StatusConfig> = {
  running: { label: "Running", color: "var(--status-running)" },
  idle: { label: "Idle", color: "var(--status-success)" },
  error: { label: "Error", color: "var(--status-error)" },
};

const FALLBACK_CONFIG: StatusConfig = {
  label: "Unknown",
  color: "var(--muted-foreground)",
};

export function SessionList({ sessions, activeId, onSelect, onNew }: SessionListProps) {
  return (
    <nav
      className="flex flex-col h-full border-r border-border bg-background min-h-0"
      aria-label="Sessions"
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-2 gap-2">
        <span className="text-sm font-medium text-muted-foreground">Sessions</span>
        <Button type="button" variant="outline" size="sm" onClick={onNew}>
          <Plus data-icon="inline-start" />
          New session
        </Button>
      </div>

      {sessions.length === 0 ? (
        <Empty className="border-0">
          <EmptyMedia variant="icon">
            <Layers />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No sessions yet</EmptyTitle>
            <EmptyDescription>
              Start a new session to begin working with an agent.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="flex-1">
          <ul className="flex flex-col gap-1 px-2 py-1">
            {sessions.map((session) => {
              const active = session.id === activeId;
              const config = STATUS_CONFIG[session.status] ?? FALLBACK_CONFIG;
              return (
                <li key={session.id}>
                  <Button
                    type="button"
                    variant={active ? "secondary" : "ghost"}
                    className={cn(
                      "w-full justify-start h-auto py-2 px-3 gap-2",
                      active && "font-medium"
                    )}
                    aria-current={active ? true : undefined}
                    onClick={() => onSelect(session.id)}
                  >
                    <span
                      aria-hidden
                      className="size-2 rounded-full shrink-0"
                      style={{ background: config.color }}
                    />
                    <span className="truncate flex-1 text-left">{session.title}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {config.label}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </nav>
  );
}

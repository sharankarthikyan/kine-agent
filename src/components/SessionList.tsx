import { useState } from "react";
import { Bot, FileText, Layers, ListFilter, Plus, Search, Server, Webhook, Zap } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { SessionSummary, SessionStatus } from "../lib/sessions";
import type { CustomizationCounts, Diffstat } from "../lib/conductor";
import type { CustomizationSection } from "./CustomizationsDialog";
import { relativeTime } from "../lib/relativeTime";

interface SessionListProps {
  groups: { workspace: string; sessions: SessionSummary[] }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  counts: CustomizationCounts | null;
  diffstats: Record<string, Diffstat>;
  search: string;
  onSearchChange: (s: string) => void;
  onOpenCustomization: (section: CustomizationSection) => void;
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

const CUSTOMIZATION_ROWS = [
  { key: "agents" as const, section: "agents" as const, label: "Agents", Icon: Bot },
  { key: "skills" as const, section: "skills" as const, label: "Skills", Icon: Zap },
  { key: "instructions" as const, section: "instructions" as const, label: "Instructions", Icon: FileText },
  { key: "hooks" as const, section: "hooks" as const, label: "Hooks", Icon: Webhook },
  { key: "mcpServers" as const, section: "mcp" as const, label: "MCP Servers", Icon: Server },
];

export function SessionList({
  groups,
  activeId,
  onSelect,
  onNew,
  counts,
  diffstats,
  search,
  onSearchChange,
  onOpenCustomization,
}: SessionListProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const now = Date.now();
  const isEmpty = groups.length === 0;

  return (
    <nav
      className="flex flex-col h-full bg-background min-h-0"
      aria-label="Sessions"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2 gap-2">
        <span className="text-sm font-medium text-muted-foreground">Sessions</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setSearchOpen((v) => !v)}
            aria-label="Search sessions"
          >
            <Search className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Filter sessions"
            aria-disabled="true"
            tabIndex={-1}
          >
            <ListFilter className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-2.5"
            onClick={onNew}
          >
            <Plus data-icon="inline-start" />
            New
            <kbd className="ml-0.5 text-xs text-muted-foreground font-mono opacity-60">⌘N</kbd>
          </Button>
        </div>
      </div>

      {/* Search input (toggled) */}
      {searchOpen && (
        <div className="px-3 pb-2">
          <Input
            type="search"
            placeholder="Search sessions…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-7 text-sm"
            aria-label="Search sessions"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
        </div>
      )}

      {/* Body */}
      {isEmpty ? (
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
          <Button type="button" variant="outline" size="sm" onClick={onNew}>
            <Plus data-icon="inline-start" />
            New session
          </Button>
        </Empty>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <ul className="flex flex-col px-2 py-1">
            {groups.map((group) => (
              <li key={group.workspace}>
                {/* Workspace header — muted, normal-case */}
                <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground font-normal select-none truncate">
                  {group.workspace}
                </div>
                <ul className="flex flex-col gap-0.5">
                  {group.sessions.map((session) => {
                    const active = session.id === activeId;
                    const config = STATUS_CONFIG[session.status] ?? FALLBACK_CONFIG;
                    const stat = diffstats[session.id];
                    const additions = stat?.additions ?? 0;
                    const deletions = stat?.deletions ?? 0;
                    return (
                      <li key={session.id}>
                        <Button
                          type="button"
                          variant={active ? "secondary" : "ghost"}
                          className={cn(
                            "w-full justify-start h-auto py-2 px-3 gap-1 flex-col items-start",
                            active && "font-medium"
                          )}
                          aria-current={active ? "true" : undefined}
                          onClick={() => onSelect(session.id)}
                        >
                          {/* Top row: status dot + title + status label */}
                          <span className="flex items-center gap-2 w-full min-w-0">
                            <span
                              role="img"
                              aria-label={`Status: ${config.label}`}
                              title={config.label}
                              className="size-2 rounded-full shrink-0"
                              style={{ background: config.color }}
                            />
                            <span className="truncate flex-1 min-w-0 text-left text-sm">
                              {session.title}
                            </span>
                            {/* Label only for active/error — idle is conveyed by the dot. */}
                            {session.status !== "idle" && (
                              <span className="text-xs text-muted-foreground shrink-0">
                                {config.label}
                              </span>
                            )}
                          </span>
                          {/* Bottom row: diffstat + relative time */}
                          <span className="text-xs text-muted-foreground tabular-nums pl-4">
                            <span style={{ color: "var(--status-success)" }}>+{additions}</span>{" "}
                            <span style={{ color: "var(--status-error)" }}>−{deletions}</span>
                            {" · "}
                            {relativeTime(session.updatedAt, now)}
                          </span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}

      {/* Customizations section — always at the bottom when sessions are present */}
      {!isEmpty && (
        <>
          <Separator />
          <div className="px-3 py-2 flex flex-col gap-0.5 shrink-0">
            <span className="text-xs font-medium text-muted-foreground mb-1 select-none">
              Customizations
            </span>
            {CUSTOMIZATION_ROWS.map(({ key, section, label, Icon }) => (
              <Button
                key={key}
                type="button"
                variant="ghost"
                className="w-full justify-start h-auto py-0.5 px-2 gap-2 text-muted-foreground hover:text-foreground"
                onClick={() => onOpenCustomization(section)}
                aria-label={`Open ${label} customizations`}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="text-xs flex-1 text-left">{label}</span>
                <span className="text-xs tabular-nums font-mono ml-auto">
                  {counts !== null ? counts[key] : "—"}
                </span>
              </Button>
            ))}
          </div>
        </>
      )}
    </nav>
  );
}

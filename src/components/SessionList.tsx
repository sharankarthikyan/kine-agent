import { useEffect, useState } from "react";
import { Bot, ChevronRight, FileText, Layers, ListFilter, Plus, Search, Server, Webhook, Zap } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { AgentLogo } from "./AgentLogo";

/** Sidebar filter on session status. `"all"` disables the status filter. */
export type StatusFilter = "all" | SessionStatus;
/** Sidebar filter on session origin. `"all"` disables the source filter. */
export type SourceFilter = "all" | "kineloop" | "external";

interface SessionListProps {
  groups: { workspace: string; sessions: SessionSummary[] }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  counts: CustomizationCounts | null;
  diffstats: Record<string, Diffstat>;
  search: string;
  onSearchChange: (s: string) => void;
  statusFilter: StatusFilter;
  sourceFilter: SourceFilter;
  onStatusFilterChange: (f: StatusFilter) => void;
  onSourceFilterChange: (f: SourceFilter) => void;
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

function compactRelativeTime(ts: number, now: number): string {
  const diffSeconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSeconds < 60) return "now";

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

export function SessionList({
  groups,
  activeId,
  onSelect,
  onNew,
  counts,
  diffstats,
  search,
  onSearchChange,
  statusFilter,
  sourceFilter,
  onStatusFilterChange,
  onSourceFilterChange,
  onOpenCustomization,
}: SessionListProps) {
  const filterActive = statusFilter !== "all" || sourceFilter !== "all";
  const [searchOpen, setSearchOpen] = useState(false);
  // Workspaces collapsed by the user — tracked by name; absent means expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Re-render once a minute so relative timestamps ("2 min ago") stay current even when
  // the session list is otherwise idle.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const now = nowTick;
  const isEmpty = groups.length === 0;
  // Empty because a search/filter excluded everything (vs. genuinely no sessions)
  // — drives a "no matches / clear filters" empty state instead of the onboarding one.
  const narrowedToEmpty = isEmpty && (search.trim().length > 0 || filterActive);

  const toggleWorkspace = (workspace: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(workspace)) {
        next.delete(workspace);
      } else {
        next.add(workspace);
      }
      return next;
    });
  };

  return (
    <nav
      className="flex flex-col h-full bg-background min-h-0"
      aria-label="Sessions"
    >
      {/* Header — minimalist ghost controls; filter accents when active */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2 gap-1">
        <span className="text-sm font-medium text-muted-foreground">Sessions</span>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-foreground [&_svg]:size-4"
            onClick={() => setSearchOpen((v) => !v)}
            aria-pressed={searchOpen}
            aria-label="Search sessions"
          >
            <Search />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "size-8 [&_svg]:size-4",
                  filterActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-label={filterActive ? "Filter sessions (active)" : "Filter sessions"}
              >
                <ListFilter />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">
                Status
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={statusFilter}
                onValueChange={(v) => onStatusFilterChange(v as StatusFilter)}
              >
                <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="running">Running</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="idle">Idle</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="error">Error</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">
                Source
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sourceFilter}
                onValueChange={(v) => onSourceFilterChange(v as SourceFilter)}
              >
                <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="kineloop">Kineloop</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="external">CLI history</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-xs [&_svg]:size-4"
            onClick={onNew}
          >
            <Plus data-icon="inline-start" />
            New
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
        narrowedToEmpty ? (
          <Empty className="border-0">
            <EmptyMedia variant="icon">
              <ListFilter />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No matching sessions</EmptyTitle>
              <EmptyDescription>
                No sessions match the current search or filters.
              </EmptyDescription>
            </EmptyHeader>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onSearchChange("");
                onStatusFilterChange("all");
                onSourceFilterChange("all");
              }}
            >
              Clear filters
            </Button>
          </Empty>
        ) : (
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
        )
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <ul className="flex flex-col px-2 py-1">
            {groups.map((group) => {
              const isCollapsed = collapsed.has(group.workspace);
              return (
              <li key={group.workspace}>
                {/* Workspace header — collapsible, muted, normal-case */}
                <button
                  type="button"
                  onClick={() => toggleWorkspace(group.workspace)}
                  aria-expanded={!isCollapsed}
                  className="group flex w-full items-center gap-1 px-2 pt-2 pb-1 text-xs text-muted-foreground font-normal select-none hover:text-foreground"
                >
                  <ChevronRight
                    className={cn(
                      "size-3 shrink-0 transition-transform",
                      !isCollapsed && "rotate-90",
                    )}
                  />
                  <span className="truncate">{group.workspace}</span>
                </button>
                {!isCollapsed && (
                <ul className="flex flex-col gap-0.5">
                  {group.sessions.map((session) => {
                    const active = session.id === activeId;
                    const config = STATUS_CONFIG[session.status] ?? FALLBACK_CONFIG;
                    const stat = diffstats[session.id];
                    const additions = stat?.additions ?? 0;
                    const deletions = stat?.deletions ?? 0;
                    const externalMeta = [
                      session.turnCount !== null ? `${session.turnCount}t` : null,
                      session.toolCallCount !== null ? `${session.toolCallCount} tools` : null,
                      session.fileActionCount !== null ? `${session.fileActionCount}f` : null,
                    ].filter(Boolean);
                    const fullExternalMeta = [
                      session.turnCount !== null ? `${session.turnCount} turns` : null,
                      session.toolCallCount !== null ? `${session.toolCallCount} tools` : null,
                      session.fileActionCount !== null ? `${session.fileActionCount} files` : null,
                    ].filter(Boolean);
                    const fullTime = relativeTime(session.updatedAt, now);
                    const shortTime = compactRelativeTime(session.updatedAt, now);
                    const secondaryTitle =
                      session.source === "external"
                        ? `${fullExternalMeta.length > 0 ? fullExternalMeta.join(" · ") : "CLI history"} · ${fullTime}`
                        : `+${additions} −${deletions} · ${fullTime}`;
                    return (
                      <li key={session.id}>
                        <Button
                          type="button"
                          variant={active ? "secondary" : "ghost"}
                          className={cn(
                            "w-full justify-start h-auto py-2 px-3 gap-1 flex-col items-start overflow-hidden text-left",
                            active && "font-medium"
                          )}
                          aria-current={active ? "true" : undefined}
                          onClick={() => onSelect(session.id)}
                        >
                          {/* Top row: agent logo + status dot + title + status label */}
                          <span className="flex items-center gap-2 w-full min-w-0">
                            <AgentLogo agent={session.agent} className="size-4" />
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
                            <span className="text-xs text-muted-foreground shrink-0">
                              {session.source === "external" ? "CLI" : config.label}
                            </span>
                          </span>
                          {/* Bottom row: diffstat + relative time */}
                          <span
                            className="block w-full min-w-0 truncate text-xs text-muted-foreground tabular-nums pl-4"
                            title={secondaryTitle}
                          >
                            {session.source === "external" ? (
                              <span>{externalMeta.length > 0 ? externalMeta.join(" · ") : "CLI history"}</span>
                            ) : (
                              <>
                                <span style={{ color: "var(--status-success)" }}>+{additions}</span>{" "}
                                <span style={{ color: "var(--status-error)" }}>−{deletions}</span>
                              </>
                            )}
                            {" · "}
                            {shortTime}
                          </span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
                )}
              </li>
              );
            })}
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

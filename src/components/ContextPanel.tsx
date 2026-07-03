import { useState } from "react";
import {
  contextLoadTokens,
  type ContextFootprint,
  type SessionFile,
  type UsageData,
  type UsageSummary,
} from "@/lib/contextDerive";
import type { RuleFile, Capabilities } from "@/lib/inspect";
import type { ModelInfo } from "@/lib/models";
import { DEFAULT_PERMISSION_MODE, permissionModeLabel, type PermissionMode } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Activity, FileCode, FilePen, FilePlus, FileText } from "lucide-react";

export interface ContextPanelProps {
  usage: UsageData | null;
  usageSummary?: UsageSummary | null;
  files: SessionFile[];
  rules: RuleFile[];
  capabilities: Capabilities | null;
  model: ModelInfo | null;
  contextFootprint?: ContextFootprint | null;
  agent?: string;
  source?: "kineloop" | "external";
  permissionMode?: PermissionMode | null;
  sandboxTerminal?: boolean;
  sessionTurnCount?: number | null;
  sessionToolCallCount?: number | null;
  sessionFileActionCount?: number | null;
  transcriptComplete?: boolean;
  onOpenRule: (rule: RuleFile) => void;
  onOpenFile?: (path: string) => void;
}

// Maps each file action to a Lucide icon
const FILE_ACTION_ICON = {
  read: FileText,
  edited: FilePen,
  created: FilePlus,
} as const;

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>;
}

// Strip the per-session worktree prefix so a file reads relative to the repo
// root (e.g. "src/components/App.tsx") instead of the long absolute path.
// Normalizes Windows separators to `/` so the match works cross-platform.
function displayPath(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const match = norm.match(/\/(?:\.(?:kineloop|agent-editor)|Kineloop)\/worktrees\/[^/]+\/(.+)$/);
  return match ? match[1] : norm;
}

// Shared inset card wrapper for section bodies
function SectionCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      {children}
    </div>
  );
}

// ─── Window Usage ────────────────────────────────────────────────────────────

interface WindowUsageProps {
  usage: UsageData | null;
  summary: UsageSummary | null;
  model: ModelInfo | null;
  agent: string;
  conversationTurns?: number | null;
  transcriptComplete?: boolean;
}

function formatTokens(value: number): string {
  return value.toLocaleString();
}

function usageTelemetryCopy(agent: string): string {
  if (agent === "antigravity") {
    return "Antigravity does not emit token usage in the current headless print stream.";
  }
  return "Usage appears after the agent finishes a turn.";
}

function cacheCopy(agent: string): string {
  if (agent === "codex") {
    return "Cache read is included in Codex input; it is shown separately as reuse, not added to the window meter.";
  }
  return "Cache read/write is reported separately and counts as loaded input for Claude turns.";
}

function WindowUsage({
  usage,
  summary,
  model,
  agent,
  conversationTurns = null,
  transcriptComplete = true,
}: WindowUsageProps) {
  const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? null;
  const latestContextLoad = usage ? contextLoadTokens(usage, agent) : 0;
  const progressValue =
    usage !== null && contextWindow !== null
      ? Math.min(100, Math.round((100 * latestContextLoad) / contextWindow))
      : null;
  const totalGenerated = summary?.totals.outputTokens ?? 0;
  const totalCost = summary?.totals.costUsd ?? null;
  // codex over ACP reports only occupancy — no input/output/cache split. Zero
  // rows would read as measurements; hide the grid when no split was reported.
  const hasBreakdown =
    usage !== null &&
    (usage.inputTokens > 0 ||
      usage.outputTokens > 0 ||
      usage.cacheReadTokens > 0 ||
      usage.cacheCreationTokens > 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Context usage</p>
          <p className="text-xs text-muted-foreground">
            Latest model turn — local commands don't count
          </p>
        </div>
        <Badge variant={usage === null ? "outline" : "secondary"} className="shrink-0">
          {usage === null
            ? "Waiting"
            : `${summary?.eventCount ?? 1} usage ${(summary?.eventCount ?? 1) === 1 ? "sample" : "samples"}`}
        </Badge>
      </div>

      {usage === null ? (
        <div className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <Activity className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{usageTelemetryCopy(agent)}</span>
        </div>
      ) : (
        <>
          {progressValue !== null ? (
            <>
              <Progress value={progressValue} className="h-1.5" />
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground tabular-nums">
                <span>{progressValue}% of window</span>
                <span>
                  {formatTokens(latestContextLoad)} / {formatTokens(contextWindow!)}
                </span>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatTokens(latestContextLoad)} loaded input tokens
            </p>
          )}

          {hasBreakdown && (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">
                  {usage.contextUsed !== null ? "In context" : "Loaded input"}
                </span>
                <span className="tabular-nums text-right">{formatTokens(latestContextLoad)}</span>
                <span className="text-muted-foreground">Generated output</span>
                <span className="tabular-nums text-right">{formatTokens(usage.outputTokens)}</span>
                <span className="text-muted-foreground">Cache read</span>
                <span className="tabular-nums text-right">{formatTokens(usage.cacheReadTokens)}</span>
                <span className="text-muted-foreground">Cache written</span>
                <span className="tabular-nums text-right">{formatTokens(usage.cacheCreationTokens)}</span>
              </div>

              <p className="text-xs text-muted-foreground">{cacheCopy(agent)}</p>
            </>
          )}
        </>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-t border-border/60 pt-3 text-xs">
        {conversationTurns !== null && (
          <>
            <span className="text-muted-foreground">Conversation turns</span>
            <span className="tabular-nums text-right">{formatTokens(conversationTurns)}</span>
          </>
        )}
        <span className="text-muted-foreground">Context window</span>
        <span className="tabular-nums text-right">
          {contextWindow === null ? "Unknown" : formatTokens(contextWindow)}
        </span>
        {!transcriptComplete && (
          <>
            <span className="text-muted-foreground">Transcript range</span>
            <span className="text-right">Recent page</span>
          </>
        )}
        {summary !== null && summary.eventCount > 0 && totalGenerated > 0 && (
          <>
            <span className="text-muted-foreground">Session output</span>
            <span className="tabular-nums text-right">{formatTokens(totalGenerated)}</span>
          </>
        )}
        {summary !== null && summary.eventCount > 0 && totalCost !== null && (
          <>
            <span className="text-muted-foreground">Session cost</span>
            <span className="tabular-nums text-right font-medium">
              ${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function ContextFootprintView({ footprint }: { footprint: ContextFootprint | null | undefined }) {
  const maxTokens = Math.max(
    1,
    ...(footprint?.items.map((item) => item.tokens) ?? [1]),
  );

  if (!footprint || footprint.items.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-muted-foreground">
        No context sources observed yet.
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Estimated footprint</p>
          <p className="text-xs text-muted-foreground">
            Loaded or observed in this session
          </p>
        </div>
        <span className="shrink-0 text-sm font-medium tabular-nums">
          {formatTokens(footprint.totalTokens)}
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        {footprint.items.map((item) => {
          const width = Math.max(4, Math.round((100 * item.tokens) / maxTokens));
          return (
            <div key={item.id} className="min-w-0">
              <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0 truncate font-medium">{item.label}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatTokens(item.tokens)}
                </span>
              </div>
              <p className="truncate text-xs text-muted-foreground" title={item.detail}>
                {item.detail}
              </p>
              <div className="mt-1 h-1 rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-muted-foreground/40"
                  style={{ width: `${width}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Files this session ───────────────────────────────────────────────────────
// Developers care most about what *changed* (created/edited); reads are context.
// Show changed files up front, collapse reads behind a toggle.

interface FilesThisSessionProps {
  files: SessionFile[];
  onOpenFile?: (path: string) => void;
}

function FileRow({ file, onOpenFile }: { file: SessionFile; onOpenFile?: (path: string) => void }) {
  const Icon = FILE_ACTION_ICON[file.action];
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-auto w-full min-w-0 justify-start gap-2 overflow-hidden px-2 py-1 font-normal"
      onClick={() => onOpenFile?.(file.path)}
      title={file.path}
    >
      <Icon data-icon="inline-start" />
      <span className="flex-1 min-w-0 truncate text-left font-mono text-xs">
        {displayPath(file.path)}
      </span>
      <Badge variant="secondary" className="ml-auto">
        {file.action}
      </Badge>
    </Button>
  );
}

export function FilesThisSession({ files, onOpenFile }: FilesThisSessionProps) {
  const [showReads, setShowReads] = useState(false);
  const changed = files.filter((f) => f.action !== "read");
  const reads = files.filter((f) => f.action === "read");

  return (
    <div className="flex min-w-0 flex-col gap-0.5 p-1">
      {changed.map((file) => (
        <FileRow key={file.path} file={file} onOpenFile={onOpenFile} />
      ))}
      {reads.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowReads((v) => !v)}
            className="self-start px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showReads ? "Hide" : "Show"} {reads.length} read {reads.length === 1 ? "file" : "files"}
          </button>
          {showReads &&
            reads.map((file) => (
              <FileRow key={file.path} file={file} onOpenFile={onOpenFile} />
            ))}
        </>
      )}
    </div>
  );
}

// ─── ContextPanel ─────────────────────────────────────────────────────────────

export function ContextPanel({
  usage,
  usageSummary,
  files,
  rules,
  model,
  contextFootprint,
  agent,
  source = "kineloop",
  permissionMode = DEFAULT_PERMISSION_MODE,
  sandboxTerminal = false,
  sessionTurnCount = null,
  sessionToolCallCount = null,
  sessionFileActionCount = null,
  transcriptComplete = true,
  onOpenRule,
  onOpenFile,
}: ContextPanelProps) {
  const agentId = agent ?? model?.agent ?? "claude";
  const summary = usageSummary ?? {
    latest: usage,
    totals: usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: null,
      model: null,
      contextUsed: null,
      contextWindow: null,
    },
    eventCount: usage === null ? 0 : 1,
  };
  const existingRules = rules.filter((r) => r.exists);

  return (
    <ScrollArea className="h-full min-w-0">
      <div className="flex min-w-0 flex-col gap-4 p-3">
        {/* ── Window usage ─────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Context usage</SectionHeading>
          <SectionCard>
            <div className="p-3">
              <WindowUsage
                usage={usage}
                summary={summary}
                model={model}
                agent={agentId}
                conversationTurns={sessionTurnCount}
                transcriptComplete={transcriptComplete}
              />
            </div>
          </SectionCard>
        </section>

        <section className="flex flex-col gap-1.5">
          <SectionHeading>Context sources</SectionHeading>
          <SectionCard>
            <ContextFootprintView footprint={contextFootprint} />
          </SectionCard>
        </section>

        {/* ── Files this session ────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Files this session</SectionHeading>
          <SectionCard>
            {files.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No files yet</p>
            ) : (
              <FilesThisSession files={files} onOpenFile={onOpenFile} />
            )}
          </SectionCard>
        </section>

        {/* ── Rules & config ────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Rules & config</SectionHeading>
          <SectionCard>
            {existingRules.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No rules found</p>
            ) : (
              <div className="flex min-w-0 flex-col gap-0.5 p-1">
                {existingRules.map((rule) => (
                  <Button
                    key={rule.path}
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full min-w-0 justify-start gap-2 overflow-hidden px-2 py-1 font-normal"
                    onClick={() => onOpenRule(rule)}
                    title={rule.path}
                  >
                    <FileCode data-icon="inline-start" />
                    <span className="flex-1 min-w-0 truncate text-left text-xs">{rule.label}</span>
                    <Badge variant="outline" className="ml-auto">
                      {rule.scope}
                    </Badge>
                  </Button>
                ))}
              </div>
            )}
          </SectionCard>
        </section>

        {/* ── Settings ─────────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Settings</SectionHeading>
          <SectionCard className="p-3 flex flex-col gap-1 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground">Agent</span>
              <span className="min-w-0 truncate font-medium">{agentId}</span>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground">Model</span>
              <span className="min-w-0 truncate font-medium">
                {model?.label ?? usage?.model ?? "—"}
              </span>
            </div>
            {usage?.model &&
              usage.model !== model?.value &&
              usage.model !== model?.label && (
              <p className="text-xs text-muted-foreground">
                Reported by CLI: <span className="font-mono">{usage.model}</span>
              </p>
            )}
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground">Permission</span>
              <span className="min-w-0 truncate font-medium">
                {source === "external" ? "CLI history" : permissionModeLabel(permissionMode ?? DEFAULT_PERMISSION_MODE)}
              </span>
            </div>
            {sessionToolCallCount !== null && (
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-muted-foreground">Tool calls</span>
                <span className="min-w-0 truncate font-medium tabular-nums">
                  {formatTokens(sessionToolCallCount)}
                </span>
              </div>
            )}
            {sessionFileActionCount !== null && (
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-muted-foreground">Files observed</span>
                <span className="min-w-0 truncate font-medium tabular-nums">
                  {formatTokens(sessionFileActionCount)}
                </span>
              </div>
            )}
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground">Terminal sandbox</span>
              <span className="min-w-0 truncate font-medium">
                {sandboxTerminal ? "On" : "Off"}
              </span>
            </div>
          </SectionCard>
        </section>
      </div>
    </ScrollArea>
  );
}

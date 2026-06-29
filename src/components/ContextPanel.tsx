import type { SessionFile, UsageData } from "@/lib/contextDerive";
import type { RuleFile, Capabilities, Capability } from "@/lib/inspect";
import type { ModelInfo } from "@/lib/models";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { FileCode, FilePen, FilePlus, FileText } from "lucide-react";

export interface ContextPanelProps {
  usage: UsageData | null;
  files: SessionFile[];
  rules: RuleFile[];
  capabilities: Capabilities | null;
  model: ModelInfo | null;
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
function displayPath(path: string): string {
  const match = path.match(/\/\.agent-editor\/worktrees\/[^/]+\/(.+)$/);
  return match ? match[1] : path;
}

// Shared inset card wrapper for section bodies
function SectionCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-border bg-muted/20", className)}>
      {children}
    </div>
  );
}

// ─── Window Usage ────────────────────────────────────────────────────────────

interface WindowUsageProps {
  usage: UsageData;
  model: ModelInfo | null;
}

function WindowUsage({ usage, model }: WindowUsageProps) {
  const total = usage.inputTokens + usage.outputTokens;
  const contextWindow = model?.contextWindow ?? null;
  const progressValue =
    contextWindow !== null
      ? Math.min(100, Math.round((100 * total) / contextWindow))
      : null;

  return (
    <div className="flex flex-col gap-2">
      {progressValue !== null ? (
        <>
          <Progress value={progressValue} className="h-1.5" />
          <p className="text-xs text-muted-foreground tabular-nums">
            {total.toLocaleString()} / {contextWindow!.toLocaleString()} tokens
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground tabular-nums">
          {total.toLocaleString()} tokens
        </p>
      )}

      {/* Token breakdown grid */}
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <span className="text-muted-foreground">Input</span>
        <span className="tabular-nums text-right">
          {usage.inputTokens.toLocaleString()}
        </span>
        <span className="text-muted-foreground">Output</span>
        <span className="tabular-nums text-right">
          {usage.outputTokens.toLocaleString()}
        </span>
        <span className="text-muted-foreground">Cache read</span>
        <span className="tabular-nums text-right">
          {usage.cacheReadTokens.toLocaleString()}
        </span>
      </div>

      {usage.costUsd !== null && (
        <p className="text-xs tabular-nums font-medium">
          ${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)}
        </p>
      )}
    </div>
  );
}

// ─── Capability Subsection ────────────────────────────────────────────────────

interface CapabilitySubsectionProps {
  label: string;
  items: Capability[];
}

function CapabilitySubsection({ label, items }: CapabilitySubsectionProps) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      {items.map((cap) => (
        <div key={cap.name} className={cn("flex items-center gap-2 min-w-0 px-1 py-0.5 rounded-md")}>
          <span className="text-xs font-medium shrink-0">{cap.name}</span>
          {cap.description && (
            <span className="truncate text-xs text-muted-foreground flex-1 min-w-0">
              {cap.description}
            </span>
          )}
          <Badge variant="outline" className="ml-auto shrink-0 text-xs">
            {cap.source}
          </Badge>
        </div>
      ))}
    </div>
  );
}

// ─── ContextPanel ─────────────────────────────────────────────────────────────

export function ContextPanel({
  usage,
  files,
  rules,
  capabilities,
  model,
  onOpenRule,
  onOpenFile,
}: ContextPanelProps) {
  const existingRules = rules.filter((r) => r.exists);
  const hasCapabilities =
    capabilities !== null &&
    (capabilities.skills.length > 0 ||
      capabilities.subagents.length > 0 ||
      capabilities.commands.length > 0);

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-3">
        {/* ── Window usage ─────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Window usage</SectionHeading>
          <SectionCard>
            {usage === null ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">Usage unavailable</p>
            ) : (
              <div className="p-3">
                <WindowUsage usage={usage} model={model} />
              </div>
            )}
          </SectionCard>
        </section>

        {/* ── Files this session ────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Files this session</SectionHeading>
          <SectionCard>
            {files.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No files yet</p>
            ) : (
              <div className="p-1 flex flex-col gap-0.5">
                {files.map((file) => {
                  const Icon = FILE_ACTION_ICON[file.action];
                  return (
                    <Button
                      key={file.path}
                      variant="ghost"
                      size="sm"
                      className="h-auto w-full min-w-0 justify-start gap-2 px-2 py-1 font-normal"
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
                })}
              </div>
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
              <div className="p-1 flex flex-col gap-0.5">
                {existingRules.map((rule) => (
                  <Button
                    key={rule.path}
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full min-w-0 justify-start gap-2 px-2 py-1 font-normal"
                    onClick={() => onOpenRule(rule)}
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

        {/* ── Capabilities ──────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Capabilities</SectionHeading>
          <SectionCard>
            {!hasCapabilities ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No capabilities found</p>
            ) : (
              <div className="p-3 flex flex-col gap-3">
                {capabilities!.skills.length > 0 && (
                  <CapabilitySubsection label="Skills" items={capabilities!.skills} />
                )}
                {capabilities!.subagents.length > 0 && (
                  <CapabilitySubsection label="Subagents" items={capabilities!.subagents} />
                )}
                {capabilities!.commands.length > 0 && (
                  <CapabilitySubsection label="Commands" items={capabilities!.commands} />
                )}
              </div>
            )}
          </SectionCard>
        </section>

        {/* ── Settings ─────────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Settings</SectionHeading>
          <SectionCard className="p-3 flex flex-col gap-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Model</span>
              <span className="font-medium">{model?.label ?? "—"}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Autonomy: default · Sandbox: default
            </p>
          </SectionCard>
        </section>
      </div>
    </ScrollArea>
  );
}

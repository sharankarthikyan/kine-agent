import { useState } from "react";
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
// Normalizes Windows separators to `/` so the match works cross-platform.
function displayPath(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const match = norm.match(/\/\.(?:kineloop|agent-editor)\/worktrees\/[^/]+\/(.+)$/);
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

// Progressive disclosure: long capability lists collapse to a handful with a
// "Show all" toggle, so the panel stays scannable (research: don't dump
// everything; reveal complexity on demand).
const CAPABILITY_PREVIEW = 6;

function CapabilitySubsection({ label, items }: CapabilitySubsectionProps) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, CAPABILITY_PREVIEW);
  const hiddenCount = items.length - visible.length;

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">
        {label}{" "}
        <span className="tabular-nums opacity-60">{items.length}</span>
      </p>
      {visible.map((cap) => (
        <div
          key={cap.name}
          className="grid min-w-0 grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1 py-0.5"
        >
          <span className="min-w-0 truncate text-xs font-medium" title={cap.name}>
            {cap.name}
          </span>
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            title={cap.description ?? undefined}
          >
            {cap.description ?? ""}
          </span>
          <Badge variant="outline" className="ml-auto shrink-0 text-xs">
            {cap.source}
          </Badge>
        </div>
      ))}
      {items.length > CAPABILITY_PREVIEW && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="self-start px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          {showAll ? "Show less" : `Show all ${items.length}`}
          {!showAll && hiddenCount > 0 ? ` (+${hiddenCount})` : ""}
        </button>
      )}
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
    <ScrollArea className="h-full min-w-0">
      <div className="flex min-w-0 flex-col gap-4 p-3">
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

        {/* ── Capabilities ──────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Capabilities</SectionHeading>
          <SectionCard>
            {!hasCapabilities ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No capabilities found</p>
            ) : (
              <div className="flex min-w-0 flex-col gap-3 p-3">
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
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground">Model</span>
              <span className="min-w-0 truncate font-medium">{model?.label ?? "—"}</span>
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

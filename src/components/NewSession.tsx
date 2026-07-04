import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  FolderOpen,
  Paperclip,
  Settings2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PermissionModeSelect } from "@/components/PermissionModeSelect";
import { type PermissionMode } from "@/lib/permissions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type AgentInfo, type ModelInfo, isAgentSpawnable } from "@/lib/models";
import { type AgentPrefs, isAgentEnabled } from "@/lib/agentPrefs";
import { AgentLogo } from "./AgentLogo";

interface NewSessionProps {
  repo: string | null;
  recents: string[];
  agents: AgentInfo[];
  agent: AgentInfo | null;
  models: ModelInfo[];
  model: ModelInfo | null;
  permissionMode: PermissionMode;
  sandboxTerminal: boolean;
  running: boolean;
  /** User's per-agent enable/disable choices — gates which agents can start a session. */
  agentPrefs: AgentPrefs;
  onPickRepo: () => void;
  onPickRecent: (path: string) => void;
  onAgentChange: (a: AgentInfo) => void;
  onModelChange: (m: ModelInfo) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onSandboxTerminalChange: (v: boolean) => void;
  onStart: (text: string) => void;
  /** Open the Settings dialog (to enable/install the selected agent). */
  onOpenSettings: () => void;
}

/** Extract the last path segment for display. Works with both / and \ separators. */
function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Capitalize the first letter of an agent id for use as a group label. */
function agentGroupLabel(agentId: string): string {
  return agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

/** Group an array of ModelInfo by their agent field, preserving insertion order. */
function groupByAgent(models: ModelInfo[]): [string, ModelInfo[]][] {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const group = map.get(m.agent) ?? [];
    group.push(m);
    map.set(m.agent, group);
  }
  return [...map.entries()];
}

export function NewSession({
  repo,
  recents,
  agents,
  agent,
  models,
  model,
  permissionMode,
  sandboxTerminal,
  running,
  agentPrefs,
  onPickRepo,
  onPickRecent,
  onAgentChange,
  onModelChange,
  onPermissionModeChange,
  onSandboxTerminalChange,
  onStart,
  onOpenSettings,
}: NewSessionProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The selected agent must be installed, spawnable, AND enabled by the user before a
  // session can start. When it isn't, `agentHint` explains why and the composer routes
  // the user to Settings (to enable it, or install it if the CLI is missing).
  const agentHint: string | null =
    agent === null
      ? "No agent selected"
      : !agent.installed
        ? `${agent.label} isn't installed`
        : !isAgentSpawnable(agent.id)
          ? `${agent.label} isn't available yet`
          : !isAgentEnabled(agent.id, agentPrefs)
            ? `${agent.label} is disabled`
            : null;
  const agentReady = agentHint === null;
  const canSend =
    !running && repo !== null && text.trim().length > 0 && agentReady;

  // Auto-grow the textarea up to a compact height, then scroll.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = el.scrollHeight;
    if (next > 120) {
      el.style.height = "120px";
      el.style.overflowY = "auto";
    } else {
      el.style.height = `${next}px`;
      el.style.overflowY = "hidden";
    }
  }, [text]);

  function send() {
    if (!canSend) return;
    onStart(text.trim());
    setText("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Skip during IME composition so committing a CJK candidate doesn't send prematurely.
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const groups = groupByAgent(models);
  const hasModels = models.length > 0;

  return (
    <div className="flex min-h-full items-center justify-center p-4 min-[900px]:p-6">
      <div className="w-full max-w-2xl space-y-3">
        {/* Header line: New session in [repo] with [agent] */}
        <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <span>New session in</span>

          {/* Repo picker */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 px-2 text-foreground hover:text-foreground"
                aria-label={
                  repo ? `Repository: ${basename(repo)}` : "Choose a repository folder"
                }
              >
                <FolderOpen data-icon="inline-start" />
                <span>{repo ? basename(repo) : "Choose folder…"}</span>
                <ChevronDown data-icon="inline-end" className="opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-56">
              <DropdownMenuItem onSelect={onPickRepo}>
                <FolderOpen data-icon />
                <span>Choose folder…</span>
              </DropdownMenuItem>
              {recents.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  {recents.map((path) => (
	                    <DropdownMenuItem
	                      key={path}
	                      onSelect={() => onPickRecent(path)}
	                    >
                      <span>{basename(path)}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <span>with</span>

          {/* Agent picker */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 px-2 text-foreground hover:text-foreground"
                aria-label={`Agent: ${agent?.label ?? "No agents"}`}
              >
                <AgentLogo agent={agent?.id ?? "claude"} className="size-4" />
                <span>{agent?.label ?? "No agents"}</span>
                <ChevronDown data-icon="inline-end" className="opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              {agents.length > 0 ? (
                agents.map((a) => {
                  const spawnable = isAgentSpawnable(a.id);
                  const agentEnabled =
                    a.installed && spawnable && isAgentEnabled(a.id, agentPrefs);
                  return (
                    <DropdownMenuItem
                      key={a.id}
                      disabled={!agentEnabled}
                      onSelect={() => onAgentChange(a)}
                      className="gap-2"
                    >
                      <Check
                        data-icon
                        className={cn(
                          "shrink-0",
                          a.id === agent?.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="flex-1">{a.label}</span>
                      {!a.installed ? (
                        <span className="text-xs text-muted-foreground">not installed</span>
                      ) : !spawnable ? (
                        <span className="text-xs text-muted-foreground">coming soon</span>
                      ) : !isAgentEnabled(a.id, agentPrefs) ? (
                        <span className="text-xs text-muted-foreground">disabled</span>
                      ) : null}
                    </DropdownMenuItem>
                  );
                })
              ) : (
                <DropdownMenuItem disabled>No agents available</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Composer card */}
	        <div className="rounded-xl border bg-card shadow-sm p-3 flex flex-col gap-2 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
	            placeholder="Describe the task…"
            aria-label="Describe your feature"
            disabled={running}
            rows={2}
	            className="min-h-[64px] resize-none rounded-none border-0 bg-transparent p-0 shadow-none outline-none focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />

          {/* Bottom action row — wraps so the send button never overlaps the controls */}
          <div className="flex flex-wrap items-center gap-2">
            {/* LEFT: model + permission selectors, side by side */}
            <div className="flex min-w-0 flex-wrap items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                  aria-label={`Model: ${model?.label ?? "No models"}`}
                >
                  <AgentLogo agent={model?.agent ?? "claude"} className="size-4" />
                  <span className="text-sm">{model?.label ?? "No models"}</span>
                  <ChevronDown data-icon="inline-end" className="opacity-50" />
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="start" className="min-w-56">
                {hasModels ? (
                  groups.map(([agentId, agentModels], groupIndex) => (
                    <DropdownMenuGroup key={agentId}>
                      {groupIndex > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">
                        {agentGroupLabel(agentId)}
                      </DropdownMenuLabel>
                      {agentModels.map((m) => (
                        <DropdownMenuItem
                          key={m.value}
                          disabled={m.disabled}
                          onSelect={() => onModelChange(m)}
                          className="gap-2"
                        >
                          <Check
                            data-icon
                            className={cn(
                              "shrink-0",
                              m.value === model?.value ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <span className="flex-1">{m.label}</span>
                          {m.description && (
                            <span className="text-xs text-muted-foreground truncate max-w-32">
                              {m.description}
                            </span>
                          )}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  ))
                ) : (
                  <DropdownMenuGroup>
                    <DropdownMenuItem disabled>No models available</DropdownMenuItem>
                  </DropdownMenuGroup>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

              <PermissionModeSelect
                agent={agent?.id ?? "claude"}
                value={permissionMode}
                onChange={onPermissionModeChange}
                sandboxTerminal={sandboxTerminal}
                onSandboxTerminalChange={onSandboxTerminalChange}
              />

            </div>

            {/* RIGHT: attach (inert stub) + send */}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Attach"
                disabled
	                className="size-9"
              >
                <Paperclip data-icon />
              </Button>
              <Button
                size="icon"
                aria-label="Send"
                disabled={!canSend}
                onClick={send}
	                className="size-9 rounded-full"
              >
                <ArrowUp data-icon />
              </Button>
            </div>
          </div>
          {agentHint && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
            >
              <Settings2 className="size-3 shrink-0" />
              {agentHint} — open Settings
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

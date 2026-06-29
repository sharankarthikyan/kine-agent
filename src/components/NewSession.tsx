import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  FolderOpen,
  Lock,
  LockOpen,
  Paperclip,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type AgentInfo, type ModelInfo } from "@/lib/models";

interface NewSessionProps {
  repo: string | null;
  recents: string[];
  agents: AgentInfo[];
  agent: AgentInfo | null;
  models: ModelInfo[];
  model: ModelInfo | null;
  autoEdit: boolean;
  running: boolean;
  onPickRepo: () => void;
  onPickRecent: (path: string) => void;
  onAgentChange: (a: AgentInfo) => void;
  onModelChange: (m: ModelInfo) => void;
  onAutoEditChange: (v: boolean) => void;
  onStart: (text: string) => void;
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
  autoEdit,
  running,
  onPickRepo,
  onPickRecent,
  onAgentChange,
  onModelChange,
  onAutoEditChange,
  onStart,
}: NewSessionProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = !running && repo !== null && text.trim().length > 0;

  // Auto-grow the textarea up to 240px, then scroll.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = el.scrollHeight;
    if (next > 240) {
      el.style.height = "240px";
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
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-2xl space-y-4">
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
                      title={path}
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
                <Bot data-icon="inline-start" />
                <span>{agent?.label ?? "No agents"}</span>
                <ChevronDown data-icon="inline-end" className="opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              {agents.length > 0 ? (
                agents.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    disabled={!a.installed}
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
                    {!a.installed && (
                      <span className="text-xs text-muted-foreground">not installed</span>
                    )}
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem disabled>No agents available</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Composer card */}
        <div className="rounded-xl border bg-card shadow-sm p-3 flex flex-col gap-2">
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What feature are you dreaming up?"
            aria-label="Describe your feature"
            disabled={running}
            rows={4}
            className="min-h-[120px] resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />

          {/* Bottom action row */}
          <div className="flex items-center justify-between">
            {/* LEFT: model selector — same pattern as PromptBar */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                  aria-label={`Model: ${model?.label ?? "No models"}`}
                >
                  <Bot data-icon="inline-start" />
                  <span className="text-sm">{model?.label ?? "No models"}</span>
                  {model?.source === "fallback" && (
                    <Badge
                      variant="outline"
                      className="text-xs px-1.5 py-0 text-muted-foreground"
                    >
                      {model.source}
                    </Badge>
                  )}
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

            {/* RIGHT: attach (inert stub) + send */}
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Attach"
                disabled
                className="size-8"
              >
                <Paperclip data-icon />
              </Button>
              <Button
                size="icon"
                aria-label="Send"
                disabled={!canSend}
                onClick={send}
                className="size-8 rounded-full"
              >
                <ArrowUp data-icon />
              </Button>
            </div>
          </div>
        </div>

        {/* Edit automatically */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            id="auto-edit"
            checked={autoEdit}
            onCheckedChange={onAutoEditChange}
            aria-label="Edit automatically"
          />
          {autoEdit ? (
            <LockOpen className="size-4" />
          ) : (
            <Lock className="size-4" />
          )}
          <label htmlFor="auto-edit" className="cursor-pointer select-none">
            Edit automatically
          </label>
        </div>
      </div>
    </div>
  );
}

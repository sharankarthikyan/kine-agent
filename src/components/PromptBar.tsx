import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  Check,
  GitBranchPlus,
  Paperclip,
  Square,
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
import { type ModelInfo } from "@/lib/models";
import { AgentLogo } from "./AgentLogo";

interface PromptBarProps {
  onStart: (text: string, model: ModelInfo | null) => void;
  running: boolean;
  models: ModelInfo[];
  model: ModelInfo | null;
  onModelChange: (m: ModelInfo) => void;
  /** The session's agent, so the permission dropdown offers the right modes. */
  agent: string;
  /** The session's current permission mode. */
  permissionMode: PermissionMode;
  /** Called when the user picks a different permission mode. */
  onPermissionModeChange: (mode: PermissionMode) => void;
  /** Antigravity-only terminal sandbox toggle. */
  sandboxTerminal?: boolean;
  onSandboxTerminalChange?: (v: boolean) => void;
  /** Stop the in-flight run. When provided, a Stop button replaces Send while running. */
  onStop?: () => void;
  /** External CLI history is read-only; sending forks it into a writable continuation. */
  mode?: "default" | "external-continuation";
}

/** Capitalize the first letter of an agent id for use as a group label. */
function agentLabel(agentId: string): string {
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

export function PromptBar({
  onStart,
  running,
  models,
  model,
  onModelChange,
  agent,
  permissionMode,
  onPermissionModeChange,
  sandboxTerminal = false,
  onSandboxTerminalChange,
  onStop,
  mode = "default",
}: PromptBarProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = !running && text.trim().length > 0;
  const continuingExternal = mode === "external-continuation";
  const placeholder = continuingExternal
    ? "Continue this CLI history…"
    : "Message the agent…";
  const inputLabel = continuingExternal
    ? "Continue this CLI history"
    : "Message the agent";
  const sendLabel = continuingExternal ? "Continue in Kineloop" : "Send";

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
    onStart(text.trim(), model);
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
    <div className="px-4 py-3">
      <div className="rounded-xl border bg-card shadow-sm p-3 flex flex-col gap-2 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
        {/* Composer textarea — card is the visual frame; textarea strips its own border/bg */}
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={inputLabel}
          disabled={running}
          rows={1}
          className="min-h-0 resize-none rounded-none border-0 bg-transparent p-0 shadow-none outline-none focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />

        {continuingExternal && (
          <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
            <GitBranchPlus className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">
              Replies start a writable Kineloop continuation.
            </span>
          </div>
        )}

        {/* Bottom action row */}
        <div className="flex items-center justify-between gap-2">
          {/* LEFT: model + permission selectors, side by side */}
          <div className="flex min-w-0 items-center gap-1">
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
                groups.map(([groupAgent, agentModels], groupIndex) => (
                  <DropdownMenuGroup key={groupAgent}>
                    {groupIndex > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">
                      {agentLabel(groupAgent)}
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
              agent={agent}
              value={permissionMode}
              onChange={onPermissionModeChange}
              sandboxTerminal={sandboxTerminal}
              onSandboxTerminalChange={onSandboxTerminalChange}
            />
          </div>

          {/* RIGHT: attach + send */}
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Attach" className="size-9" disabled>
              <Paperclip data-icon />
            </Button>
            {running && onStop ? (
              <Button
                size="icon"
                variant="destructive"
                aria-label="Stop"
                onClick={onStop}
                className="size-9 rounded-full"
              >
                <Square data-icon />
              </Button>
            ) : (
              <Button
                size="icon"
                aria-label={sendLabel}
                disabled={!canSend}
                onClick={send}
                className="size-9 rounded-full"
              >
                <ArrowUp data-icon />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
